/**
 * The internal Console: its Express host, and the page it serves.
 *
 * ## What changed here, and why it had to
 *
 * Until this file grew a sign-in, the acting staff member arrived as an `x-actor-id` request
 * header. Its own comment called that "a development seam, not authentication", ADR-0022 called
 * fixing it "necessary anyway", and it stayed because the only callers were tests and a worker.
 *
 * **A page is what turns that from a known gap into an exploitable one.** Not because the header
 * became weaker - it was always a UUID typed by whoever was asking - but because a console is an
 * invitation to use it, and the reach is total: a client session opens one file, a staff session
 * opens every file in the firm, plus the Firewall trigger, the compliance transition and the
 * placement path. Shipping the surface without the credential would have been shipping the reach
 * without the check.
 *
 * So the header is now off unless `CONSOLE_DEV_ACTOR_HEADER=true`, the config refuses to hold that
 * setting in production, and the real route is a session cookie issued by `authenticateStaff`
 * against a password and a TOTP code (`@bwc/identity/staff`).
 *
 * ## What the transport does and does not do
 *
 * The same division as the portal (ADR-0022): the transport owns the cookie, the rate limit, the
 * headers and the page; **every decision belongs to the module that owns it.** A route that
 * consulted a rule directly would be a rule with two homes.
 *
 * **Every write now goes through the middleware chain, and until this slice none of them did.** The
 * sentence that stood here claimed otherwise and was simply wrong: `chain()` ran in exactly two
 * places in the whole system, and the compliance transition, the Firewall trigger and the consent
 * grant called their modules directly with no Authority Level checked at all. See `authorised`.
 *
 * @see docs/adr/0032-a-console-is-what-makes-a-missing-credential-exploitable.md
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import {
  create as createClient,
  find as findClient,
  listClients,
  openFindings,
  transitionComplianceState,
} from '@bwc/clients';
import { CONSENT_KINDS, grant as grantConsent, type ConsentKind } from '@bwc/consent';
import { status as firewallStatus, trigger as triggerFirewall } from '@bwc/firewall';
import {
  assertPasswordSignInPermitted,
  authenticateStaff,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  findActor,
  inviteStaff,
  resolveStaffSession,
  revokeStaffSession,
} from '@bwc/identity';
import { read as readLedger, verifyIntegrity } from '@bwc/ledger';
import { openFor } from '@bwc/notifications';
import { systemHealth } from '@bwc/observability';
import { chain, type StepTrace } from '@bwc/middleware';
import { requestRecommendation } from '@bwc/placement';
import { CAPITAL_NEEDS, type CapitalNeed } from '@bwc/lenders';
import { activeListing, timelineFor } from '@bwc/risk';
import { openObligations } from '@bwc/calls';
import { VENDOR_GATES, isActivated, mode, outstandingPreconditions } from '@bwc/integration';
import { registerIntegrationRoutes } from './routes/integrations.js';
import {
  ACTION_MINIMUM_LEVEL,
  failed,
  isComplianceState,
  noData,
  ok,
  refused,
  type ComplianceState,
} from '@bwc/core';
import {
  createRateLimiter,
  createSharedRateLimiter,
  rateLimitKey,
  send,
  type RateLimiter,
} from '@bwc/http';
import type { Actor } from '@bwc/identity';
import { readConsoleConfig, type ConsoleConfig } from './config.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCapitalRoutes } from './routes/capital.js';
import { registerDashboardRoutes } from './routes/dashboards.js';
import { registerDeliverableRoutes } from './routes/deliverables.js';
import { registerGraphRoutes } from './routes/graph.js';
import { registerIntelligenceRoutes } from './routes/intelligence.js';
import { registerInterventureRoutes } from './routes/interventure.js';
import { registerPartnerRoutes } from './routes/partners.js';
import { registerSalesRoutes } from './routes/sales.js';
import { registerWarehouseRoutes } from './routes/warehouse.js';
// The five modules that had no surface until now: 1.4, 7.3, 3.2, 11.11, 2.2/2.4.
import { registerBillingRoutes } from './routes/billing.js';
import { registerContractRoutes } from './routes/contracts.js';
import { registerVaultRoutes } from './routes/vault.js';
import { registerWorkbenchRoutes } from './routes/workbench.js';
import { registerWorkflowRoutes } from './routes/workflow.js';
// The last two modules with no surface: 5.5 and 7.5.
import { registerOutcomeRoutes } from './routes/outcomes.js';
import { registerRetentionRoutes } from './routes/retention.js';
// Staff security keys and the passkey-only switch (ADR-0059).
import { registerStaffKeyRoutes } from './routes/staffKeys.js';
// Compliance and governance surfaces (7.1, 7.2, 7.4, 5.4, 4.5). Each module registers its own
// routes against the context built at the bottom of `createApp`.
import { registerComplianceRoutes } from './routes/compliance.js';
import { registerRegulatoryRoutes } from './routes/regulatory.js';
import { registerGovernanceRoutes } from './routes/governance.js';
import { registerMarketingRoutes } from './routes/marketing.js';

export interface ConsoleAppDeps {
  readonly config?: ConsoleConfig;
  /** Injected by tests. Built from `config.rateLimitStore` otherwise. */
  readonly limiter?: RateLimiter;
  readonly now?: () => Date;
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Read the session token from the cookie.
 *
 * Parsed here rather than with a cookie-parser dependency, and never accepted from a query string
 * or a header: a token in a URL ends up in access logs, browser history and `Referer`.
 */
const tokenFrom = (req: Request, cookieName: string): string | undefined => {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    const value = part.slice(eq + 1).trim();
    return value === '' ? undefined : decodeURIComponent(value);
  }
  return undefined;
};

const setSessionCookie = (
  res: Response,
  config: ConsoleConfig,
  token: string,
  expiresAt: Date,
): void => {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    // The CSRF control. A cross-site form post carries no cookie at all under Strict, so a
    // state-changing route cannot be driven from another origin - which on this surface means
    // triggering a Firewall or moving a compliance state.
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
};

const clearSessionCookie = (res: Response, config: ConsoleConfig): void => {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
  });
};

/** One sentence for every cause - no session, expired, idle, revoked, credential disabled. */
const NO_SESSION = () => refused('Sign in to continue.', 'Blueprint 11.1 - identity and access');

/** Express 5 types a route param as `string | string[]`; none of these paths repeat one. */
const param = (req: Request, name: string): string => {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
};

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => {
      send(
        res,
        failed(
          'Unhandled error while processing the request.',
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  };

/**
 * The writes this page offers, and the only actions `authorised` is ever called with.
 *
 * A list rather than a lookup over the whole catalogue: most of `ACTION_MINIMUM_LEVEL` is agent
 * work with no button, and reporting `may_submit_lender_packet: true` to a page that cannot submit
 * one would be describing a capability that does not exist here.
 */
const CONSOLE_WRITES = [
  'create_client_record',
  'transition_compliance_state',
  'record_client_consent',
  'trigger_firewall',
  // Placement is `draft_recommendation` - Level 1, because asking for a recommendation is
  // preparing work rather than submitting it. What stops a recommendation becoming a submission is
  // `submit_application` at Level 3, which this Console does not offer.
  'draft_recommendation',
] as const satisfies readonly (keyof typeof ACTION_MINIMUM_LEVEL)[];

const positiveInteger = (raw: unknown, fallback: number): number => {
  if (typeof raw !== 'string') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

export const createApp = (deps: ConsoleAppDeps = {}): Express => {
  const config = deps.config ?? readConsoleConfig();
  const now = deps.now ?? (() => new Date());

  const limiter =
    deps.limiter ??
    (config.rateLimitStore === 'shared'
      ? createSharedRateLimiter({
          scope: 'console_sign_in',
          windowSeconds: config.signInWindowSeconds,
          maxAttempts: config.signInMaxAttempts,
        })
      : createRateLimiter({
          windowSeconds: config.signInWindowSeconds,
          maxAttempts: config.signInMaxAttempts,
        }));

  const app = express();
  app.set('trust proxy', config.trustProxy);

  /**
   * A path id that is not a UUID is `no_data`, not a 500 - and not before the session is checked.
   *
   * Every route passes a path id straight into a Prisma `where` against an `@db.Uuid` column.
   * Postgres raises on a malformed one, `asyncRoute` catches it, and the caller gets a 500 with a
   * database error string for the ordinary act of typing an id wrong.
   *
   * **The param callback records the fault; it does not answer.** Answering here would answer
   * BEFORE authentication - an anonymous caller would learn that an id was malformed instead of
   * being told to sign in, which is a fact about the request leaking past the session check. The
   * first version of this did exactly that and four existing suites caught it.
   *
   * `requireStaff` is where the two are ordered, because every guarded route already calls it
   * first. Session, then shape.
   *
   * Registered per PARAMETER rather than per route: there are twenty-one route modules and about
   * thirty id parameters, and a helper each of them had to remember is one the next route forgets.
   * Any future route with `:clientId` in its path inherits this.
   *
   * `state` and `clauseKey` are deliberately absent - a two-letter code and a clause key are not
   * UUIDs, and their own routes validate them.
   */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

  for (const name of [
    'clientId',
    'documentId',
    'engagementId',
    'instanceId',
    'providerId',
    'partnerId',
    'leadId',
    'keyId',
    'exportId',
    'deliverableId',
  ]) {
    app.param(name, (_req, res, next, value) => {
      if (typeof value !== 'string' || !UUID.test(value)) {
        (res as Response & { locals: Record<string, unknown> }).locals['malformedId'] = true;
      }
      next();
    });
  }

  /**
   * The API's policy: nothing, from anywhere.
   *
   * `useDefaults: false` for the reason the portal records - helmet merges its own defaults under
   * whatever is named, so a policy that says `default-src 'none'` and nothing else is not the
   * policy that gets sent.
   */
  const apiHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });

  /** The page's policy: this origin, and nothing inline. No `'unsafe-inline'`, no nonce. */
  const pageHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'none'"],
        objectSrc: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });

  app.use('/api', apiHelmet);

  /**
   * Count one attempt against the source address before anything expensive runs.
   *
   * Ahead of the body parser, so an unauthenticated flood is refused before the JSON is read - the
   * same ordering the portal uses and for the same reason.
   */
  const rateLimited =
    (message: string) =>
    (req: Request, res: Response, next: NextFunction): void => {
      limiter
        .check(rateLimitKey(req.ip), now())
        .then((verdict) => {
          if (!verdict.allowed) {
            res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
            send(res, refused(message, 'Blueprint 11.1 - rate limiting counts the source'));
            return;
          }
          next();
        })
        .catch((error: unknown) => {
          send(
            res,
            failed(
              'Unhandled error while processing the request.',
              error instanceof Error ? error.message : String(error),
            ),
          );
        });
    };

  const jsonBody = express.json({ limit: config.maxJsonBytes });

  /**
   * Who is acting.
   *
   * The session cookie first, and the development header ONLY if the deployment turned it on. The
   * order matters less than the flag: with `devActorHeader` false there is no path from a header to
   * an Actor, and that is the property the rest of this file relies on.
   */
  const staffFrom = async (req: Request): Promise<Actor | undefined> => {
    const token = tokenFrom(req, config.cookieName);
    if (token !== undefined) {
      const resolved = await resolveStaffSession({
        tenantId: config.tenantId,
        token,
        now: now(),
      });
      if (resolved.status === 'ok') return resolved.value.actor;
      return undefined;
    }

    if (!config.devActorHeader) return undefined;

    const header = req.header('x-actor-id');
    const actorId = header && header.trim() !== '' ? header.trim() : undefined;
    if (actorId === undefined) return undefined;

    const actor = await findActor(actorId);
    // Tenant-checked even on the development path. A seam that reached across tenants would be a
    // different and worse defect from the one it is a seam for.
    return actor && actor.tenantId === config.tenantId ? actor : undefined;
  };

  /** A route that needs a staff principal. Returns undefined and has already replied if there is none. */
  const requireStaff = async (req: Request, res: Response): Promise<Actor | undefined> => {
    const actor = await staffFrom(req);
    if (!actor) {
      send(res, NO_SESSION());
      return undefined;
    }

    // Session first, then shape. A malformed id is flagged by the param callback above and
    // answered only once the caller has proved who they are - otherwise "that is not an id" is a
    // fact about the request that escapes past the session check.
    //
    // The answer is the one a well-formed id that belongs to nothing gets: from outside, "no such
    // id" and "that is not an id" are the same fact, and two answers would invite somebody to
    // probe which.
    if ((res as Response & { locals: Record<string, unknown> }).locals['malformedId'] === true) {
      send(res, noData('No such record in this tenant.'));
      return undefined;
    }

    return actor;
  };

  // --- Health -------------------------------------------------------------

  /**
   * Liveness. Unauthenticated and deliberately almost empty.
   *
   * The detail 11.8 produces - which component is degraded, which vendor is unmonitored - is behind
   * a session at `/api/console/health`. An unauthenticated health page that named its failing parts
   * would be a reconnaissance surface.
   */
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', data: { service: 'bwc-console-api', version: '0.1.0' } });
  });

  /**
   * Vendor activation gates - Specification v2 section 11.4.
   *
   * **Now behind a session.** It names every vendor this firm has not cleared and what each is
   * waiting on, which is a map of where the controls are not yet in place.
   */
  app.get(
    '/api/health/integrations',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      res.json({
        status: 'ok',
        data: {
          mode: mode(),
          vendors: Object.values(VENDOR_GATES).map((gate) => ({
            vendor: gate.vendor,
            activated: isActivated(gate.vendor),
            outstanding: outstandingPreconditions(gate.vendor),
          })),
        },
      });
    }),
  );

  // 11.5 vendor activation surface - ADR-0065. Registered from its own module; this composer
  // gains one line rather than another two hundred.
  registerIntegrationRoutes({ app, asyncRoute, requireStaff });

  // --- Sign in ------------------------------------------------------------

  /**
   * Password and code together.
   *
   * The portal splits its two factors across two requests because it has to hold a state between
   * them (ADR-0024). Here both arrive at once, so there is no half-authenticated state to model and
   * no way to mistake one for a session.
   */
  app.post(
    '/api/console/sign-in',
    rateLimited('Too many sign-in attempts from this address. Try again shortly.'),
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as { email?: unknown; password?: unknown; code?: unknown };
      if (
        typeof body.email !== 'string' ||
        typeof body.password !== 'string' ||
        typeof body.code !== 'string'
      ) {
        // The same sentence a wrong password gets. A message naming the missing field would let a
        // caller learn which of the three this account actually needs.
        send(res, refused('Those details are not valid.', 'Blueprint 11.1 - identity and access'));
        return;
      }

      /**
       * **An account that has stopped accepting a password is refused here, before anything is
       * verified** - and with the same sentence a wrong password gets.
       *
       * Without this line the switch would be a column nothing reads, which is the shape of every
       * security feature that turns out to be a setting. ADR-0059.
       */
      const permitted = await assertPasswordSignInPermitted({
        tenantId: config.tenantId,
        email: body.email,
        now: now(),
      });
      if (permitted.status !== 'ok') {
        send(res, permitted);
        return;
      }

      const outcome = await authenticateStaff({
        tenantId: config.tenantId,
        email: body.email,
        password: body.password,
        code: body.code,
        now: now(),
      });

      if (outcome.status !== 'ok') {
        send(res, outcome);
        return;
      }

      setSessionCookie(res, config, outcome.value.token, new Date(outcome.value.expiresAt));
      // The token is NOT in the body. It is in an httpOnly cookie precisely so script cannot read
      // it, and returning it here would undo that in one line.
      send(
        res,
        ok({
          actorId: outcome.value.actor.id,
          label: outcome.value.actor.label,
          authorityLevel: outcome.value.actor.authorityLevel,
          department: outcome.value.actor.department,
          expiresAt: outcome.value.expiresAt,
        }),
      );
    }),
  );

  app.post(
    '/api/console/sign-out',
    asyncRoute(async (req, res) => {
      const token = tokenFrom(req, config.cookieName);
      if (token !== undefined) {
        const resolved = await resolveStaffSession({
          tenantId: config.tenantId,
          token,
          now: now(),
        });
        if (resolved.status === 'ok') {
          await revokeStaffSession({
            tenantId: config.tenantId,
            sessionId: resolved.value.sessionId,
            now: now(),
          });
        }
      }
      // Cleared whatever happened. A sign-out that left the cookie on a session it could not
      // resolve would leave the browser looking signed in.
      clearSessionCookie(res, config);
      send(res, ok({ signedOut: true }));
    }),
  );

  /**
   * Invite a colleague to take up a Console credential.
   *
   * **A Level 3 human, and the check is in the module rather than here** - the transport does not
   * decide who may grant internal access.
   *
   * What comes back is a token, and the granter necessarily sees it because there is nobody else to
   * hand it to yet. That is weaker than what the first version of this flow gave them - a password
   * they chose and a TOTP secret they could keep - and it is not nothing. Delivering the invitation
   * to the subject is what closes the gap, and delivery needs the email provider (ADR-0036).
   */
  app.post(
    '/api/console/invitations',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const body = req.body as { actorId?: unknown; email?: unknown };
      if (typeof body.actorId !== 'string' || typeof body.email !== 'string') {
        send(res, refused('actorId and email are both required.', 'Input validation'));
        return;
      }

      send(
        res,
        await inviteStaff({
          tenantId: config.tenantId,
          actorId: body.actorId,
          email: body.email,
          invitedBy: actor.id,
          now: now(),
        }),
      );
    }),
  );

  /**
   * Spend an invitation: the subject sets their own password and receives their own secret.
   *
   * **Unauthenticated, because the person using it has no credential yet** - that is what they are
   * here to create. On the sign-in limiter for the same reason the sign-in is: it takes a bearer
   * token from an anonymous caller, and a token nobody rate-limited is a token somebody guesses.
   */
  app.post(
    '/api/console/enrolment',
    rateLimited('Too many attempts from this address. Try again shortly.'),
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as { token?: unknown; password?: unknown };
      if (typeof body.token !== 'string' || typeof body.password !== 'string') {
        // The same sentence a bad token gets. Naming the missing field tells a caller what the
        // endpoint wants, and this endpoint is reachable by anybody.
        send(
          res,
          refused(
            'That invitation is not valid. Ask for a new one.',
            'Blueprint 11.1 - identity and access',
          ),
        );
        return;
      }

      send(
        res,
        await enrolStaffFromInvitation({
          tenantId: config.tenantId,
          token: body.token,
          password: body.password,
          now: now(),
        }),
      );
    }),
  );

  /**
   * Prove the authenticator works, which is what finishes enrolment.
   *
   * Unauthenticated and limited, as above: an account with an unconfirmed factor cannot sign in, so
   * there is no session to do this from.
   */
  app.post(
    '/api/console/enrolment/confirm',
    rateLimited('Too many attempts from this address. Try again shortly.'),
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as { actorId?: unknown; password?: unknown; code?: unknown };
      if (
        typeof body.actorId !== 'string' ||
        typeof body.password !== 'string' ||
        typeof body.code !== 'string'
      ) {
        send(res, refused('That code is not valid.', 'Blueprint 11.1 - identity and access'));
        return;
      }

      send(
        res,
        await confirmStaffEnrolment({
          tenantId: config.tenantId,
          actorId: body.actorId,
          password: body.password,
          code: body.code,
          now: now(),
        }),
      );
    }),
  );

  app.get(
    '/api/console/me',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      send(
        res,
        ok({
          actorId: actor.id,
          label: actor.label,
          authorityLevel: actor.authorityLevel,
          department: actor.department,
          /**
           * The writes this actor's level permits.
           *
           * **A courtesy to the page, never the enforcement.** The chain refuses regardless of what
           * was offered, and the tests assert that directly rather than through the page - a UI that
           * hid a button would otherwise be indistinguishable from a UI that had a gate behind it.
           *
           * Offering an action that will certainly be refused is its own small harm, though: it
           * teaches people that refusals are noise.
           */
          mayWrite: Object.fromEntries(
            CONSOLE_WRITES.map((action) => [
              action,
              actor.authorityLevel >= ACTION_MINIMUM_LEVEL[action],
            ]),
          ),
        }),
      );
    }),
  );

  // --- Console reads ------------------------------------------------------

  /**
   * What needs a person today.
   *
   * Deliberately an assembly of things other modules own, and it stores nothing - the same shape
   * 9.1 and 6.5 chose. **Every count is a real count**: there is no place here for a figure that
   * reads as zero because nothing produced it, which is why the health summary travels whole rather
   * than being reduced to a colour.
   */
  app.get(
    '/api/console/overview',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const at = now();
      const [health, queue, obligations, clients] = await Promise.all([
        systemHealth(config.tenantId, at),
        openFor(config.tenantId, actor.id),
        openObligations(config.tenantId, at),
        listClients({ tenantId: config.tenantId, limit: 1 }),
      ]);

      send(
        res,
        ok({
          health,
          myOpenTasks: queue.length,
          openObligations: obligations.length,
          overdueObligations: obligations.filter((o) => o.overdue).length,
          clients: clients.status === 'ok' ? clients.value.total : null,
        }),
      );
    }),
  );

  /**
   * The closed vocabularies the page has to offer choices from.
   *
   * Served rather than written into the page, because a hard-coded list drifts the moment somebody
   * adds a value - and the failure is a Console offering a choice the system will refuse, with a
   * message about an unrecognised value that reads like a bug in the Console.
   *
   * Unauthenticated would be harmless (it is a compile-time constant naming no client) and it is
   * behind the session anyway: everything else on this surface is, and one exception is a thing to
   * explain rather than a thing to have.
   */
  app.get(
    '/api/console/vocabulary',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(res, ok({ consentKinds: CONSENT_KINDS, capitalNeeds: CAPITAL_NEEDS }));
    }),
  );

  app.get(
    '/api/console/health',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(res, ok(await systemHealth(config.tenantId, now())));
    }),
  );

  app.get(
    '/api/console/queue',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      // Assigned to the signed-in actor. A console that showed everybody's queue by default would
      // be a console where nobody's queue is theirs.
      send(res, ok(await openFor(config.tenantId, actor.id)));
    }),
  );

  app.get(
    '/api/console/obligations',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(res, ok(await openObligations(config.tenantId, now())));
    }),
  );

  app.get(
    '/api/console/clients',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const query = req.query as Record<string, unknown>;
      const search = typeof query['search'] === 'string' ? query['search'] : '';
      send(
        res,
        await listClients({
          tenantId: config.tenantId,
          limit: positiveInteger(query['limit'], 25),
          offset: positiveInteger(query['offset'], 0),
          // Spread rather than passed as `undefined`: `exactOptionalPropertyTypes` treats an
          // explicit undefined as a value, and an absent search is not a search for nothing.
          ...(search === '' ? {} : { search }),
        }),
      );
    }),
  );

  /**
   * A client's file, as much of it as this Console has surfaces for.
   *
   * Assembled from the owning modules on every read. The Do Not Fund listing travels beside the
   * compliance state rather than below it, because a listed client is the one fact a person opening
   * this page must not have to scroll to find.
   */
  app.get(
    '/api/console/clients/:clientId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const clientId = param(req, 'clientId');

      const client = await findClient(config.tenantId, clientId);
      if (client.status !== 'ok') {
        send(res, client);
        return;
      }

      const at = now();
      const [findings, firewall, listing] = await Promise.all([
        openFindings(clientId),
        firewallStatus(clientId),
        activeListing(config.tenantId, clientId, at),
      ]);

      send(res, ok({ client: client.value, findings, firewall, doNotFund: listing }));
    }),
  );

  app.get(
    '/api/console/clients/:clientId/risk',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(res, ok(await timelineFor(config.tenantId, param(req, 'clientId'), {}, now())));
    }),
  );

  // --- Writes -------------------------------------------------------------

  /**
   * Every write goes through the middleware chain, and until this slice **none of them did**.
   *
   * The header of this file used to claim otherwise. `chain()` ran in exactly two places in the
   * whole system - `@bwc/placement` and `@bwc/comms` - while the compliance transition, the
   * Firewall trigger and the consent grant called their modules directly. **No Authority Level was
   * checked on any of them**, so a Level 0 observer with a session could move a client to `pass`.
   *
   * That was reachable only with `curl` while there were no buttons. Adding buttons is what makes
   * it one click, which is the same shape as the credential this Console was given last slice: the
   * page does not create the gap, it collects on it.
   *
   * `eventType` is `authority.action_authorised` rather than the action's own event. The chain
   * records that the actor was ALLOWED to try; the module that performs the action still writes
   * what happened. Two different facts, and passing the module's own event here would write it
   * twice - once before the work and once after.
   */
  const authorised = async (
    req: Request,
    res: Response,
    input: { action: keyof typeof ACTION_MINIMUM_LEVEL; clientId?: string },
  ): Promise<{ actor: Actor; trace: readonly StepTrace[] } | undefined> => {
    const actor = await requireStaff(req, res);
    if (!actor) return undefined;

    const { result, trace } = await chain({
      actorId: actor.id,
      tenantId: config.tenantId,
      action: input.action,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      eventType: 'authority.action_authorised',
      eventPayload: { action: input.action },
    });

    if (result.status !== 'ok') {
      // The trace travels with the refusal, refusals included - "which step blocked this" is the
      // first question anyone asks, and on a page it is the difference between a dead end and an
      // instruction.
      send(res, result, { trace });
      return undefined;
    }

    return { actor, trace };
  };

  app.post(
    '/api/clients',
    jsonBody,
    asyncRoute(async (req, res) => {
      // Authorised BEFORE the body is inspected. A caller with no session who was told
      // "legalName is required" would have learned that the route exists and what it wants.
      const permitted = await authorised(req, res, { action: 'create_client_record' });
      if (!permitted) return;

      const body = req.body as { legalName?: unknown };
      if (typeof body.legalName !== 'string' || body.legalName.trim() === '') {
        send(res, refused('legalName is required.', 'Input validation'));
        return;
      }

      const client = await createClient(config.tenantId, body.legalName.trim(), {
        id: permitted.actor.id,
        kind: permitted.actor.kind,
      });
      send(res, ok(client), { trace: permitted.trace });
    }),
  );

  app.get(
    '/api/clients/:clientId',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      send(res, await findClient(actor.tenantId, param(req, 'clientId')));
    }),
  );

  /** Compliance state transition - Decision E. Findings travel with the transition. */
  app.post(
    '/api/clients/:clientId/compliance',
    jsonBody,
    asyncRoute(async (req, res) => {
      const clientId = param(req, 'clientId');
      const permitted = await authorised(req, res, {
        action: 'transition_compliance_state',
        clientId,
      });
      if (!permitted) return;

      const body = req.body as {
        to?: unknown;
        reason?: unknown;
        findings?: { code: string; summary: string }[];
      };

      if (!isComplianceState(body.to)) {
        send(
          res,
          refused(
            'to must be one of: pending_assessment, pass, pass_with_findings, needs_review, fail. Compliance state is categorical, never numeric (Decision E).',
            'Decision E - categorical compliance state',
          ),
        );
        return;
      }
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        send(res, refused('reason is required for a compliance state transition.', 'Decision E'));
        return;
      }

      send(
        res,
        await transitionComplianceState({
          tenantId: config.tenantId,
          clientId,
          to: body.to as ComplianceState,
          reason: body.reason,
          findings: body.findings ?? [],
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  // --- Consent (1.5) ------------------------------------------------------

  app.post(
    '/api/clients/:clientId/consents',
    jsonBody,
    asyncRoute(async (req, res) => {
      const clientId = param(req, 'clientId');
      const permitted = await authorised(req, res, {
        action: 'record_client_consent',
        clientId,
      });
      if (!permitted) return;

      const body = req.body as { kind?: unknown; scope?: unknown };
      if (typeof body.kind !== 'string' || typeof body.scope !== 'string') {
        send(
          res,
          refused('kind and scope are both required.', 'Blueprint 1.5 - per-event consent'),
        );
        return;
      }

      send(
        res,
        await grantConsent({
          tenantId: config.tenantId,
          clientId,
          kind: body.kind as ConsentKind,
          scope: body.scope,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  // --- Firewall (6.2) -----------------------------------------------------

  app.get(
    '/api/clients/:clientId/firewall',
    asyncRoute(async (req, res) => {
      // Behind a session now. It used to be the one route here that asked for no actor at all.
      if (!(await requireStaff(req, res))) return;
      send(res, ok(await firewallStatus(param(req, 'clientId'))));
    }),
  );

  app.post(
    '/api/clients/:clientId/firewall/trigger',
    jsonBody,
    asyncRoute(async (req, res) => {
      const clientId = param(req, 'clientId');
      const permitted = await authorised(req, res, { action: 'trigger_firewall', clientId });
      if (!permitted) return;

      const body = req.body as { reason?: unknown };
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        send(res, refused('reason is required to trigger the Firewall.', 'Principle 7'));
        return;
      }

      send(
        res,
        ok(
          await triggerFirewall(config.tenantId, clientId, body.reason, {
            id: permitted.actor.id,
            kind: permitted.actor.kind,
          }),
        ),
        { trace: permitted.trace },
      );
    }),
  );

  // --- Placement (5.3) ----------------------------------------------------

  app.post(
    '/api/clients/:clientId/placements',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const body = req.body as {
        applicationRef?: unknown;
        need?: unknown;
        requestedAmount?: unknown;
      };

      if (typeof body.applicationRef !== 'string' || body.applicationRef.trim() === '') {
        send(
          res,
          refused(
            'applicationRef is required. Authorization is scoped to a specific application, never blanket.',
            'Blueprint 1.5 - per-application authorization',
          ),
        );
        return;
      }

      /**
       * **`need` and `requestedAmount` are required, and that is a fix rather than an addition.**
       *
       * `requestRecommendation` defaults them to `working_capital` and **zero**. Eligibility
       * compares the requested amount against each offering's minimum, so a request carrying the
       * default rejects every offering that has one - with the reason "Requested $0 is below the
       * $25,000 minimum", which is true, useless, and produced by nobody having been asked.
       *
       * A default `need` is worse than a default amount, because suitability is assessed against
       * it: a client borrowing to buy equipment, silently assessed as needing working capital, gets
       * a confident recommendation for the wrong product. **The Console does not guess what a
       * client is borrowing for.**
       *
       * Amounts here are whole dollars, which is what `@bwc/lenders` stores - 5.2 predates
       * ADR-0011's integer-cents rule and its boxes are round numbers a lender publishes, not sums
       * anybody adds up.
       */
      if (
        typeof body.need !== 'string' ||
        !(CAPITAL_NEEDS as readonly string[]).includes(body.need)
      ) {
        send(
          res,
          refused(
            `need is required and must be one of: ${CAPITAL_NEEDS.join(', ')}. Suitability is assessed against it, so a default would be a confident recommendation for a purpose nobody stated.`,
            'Blueprint 5.2 - suitability is separate from eligibility',
          ),
        );
        return;
      }

      const requestedAmount = body.requestedAmount;
      if (
        typeof requestedAmount !== 'number' ||
        !Number.isInteger(requestedAmount) ||
        requestedAmount <= 0
      ) {
        send(
          res,
          refused(
            "requestedAmount is required and must be a positive whole number of dollars. Eligibility compares it against each offering's minimum, so an absent amount rejects every provider that has one.",
            'Blueprint 5.2 - eligibility is assessed against the amount actually sought',
          ),
        );
        return;
      }

      const { result, trace } = await requestRecommendation({
        actorId: actor.id,
        tenantId: actor.tenantId,
        clientId: param(req, 'clientId'),
        applicationRef: body.applicationRef,
        need: body.need as CapitalNeed,
        requestedAmount,
      });

      // The trace accompanies every response, refusal included: "which step blocked this" should
      // not require reconstructing the chain from logs.
      send(res, result, { trace });
    }),
  );

  // --- Module surfaces -----------------------------------------------------
  //
  // 5.1/5.6, 9.1/9.2, 1.2, 1.3, 8.1/8.3 and 11.7, 3.1, 3.3, 10.1, 11.6.

  /**
   * Ten read surfaces, each in its own file.
   *
   * Registered rather than written inline because this file is already a thousand lines and the ten
   * have nothing to say to each other - they share the session, the clock and the tenant, and that
   * is the whole of the contract each one declares for itself.
   *
   * **Every one of them is reads only**, and not because reads were the easy half. Each of 1.2,
   * 1.3, 8.1, 11.7, 3.1, 3.3 and 10.1 has working write functions that emit Ledger events, and
   * every one must pass `chain()` with a declared action - which `ACTION_MINIMUM_LEVEL` has for
   * none of them. Each surface reports its own blocked writes in `writes.blocked` rather than
   * showing a button that cannot work or an absence that reads as "not built".
   *
   * See ADR-0051 for the rule and ADR-0063 for the case it does not cover: a conflict-disclosure
   * acknowledgement is absent because the acknowledging party is not us, which no declared action
   * would change.
   *
   * One context for all ten. The five in ADR-0063's batch declare a narrower shape than this
   * object carries, which TypeScript accepts for a variable - excess-property checking applies to
   * object literals, not to a value passed by name.
   */
  // `authorised` and `jsonBody` travel on the shared object now that route modules carry writes.
  // A module that only reads simply never destructures them - and the excess-property check the
  // comment above describes does not apply to a value passed by name, which is what makes one
  // object serve both.
  const routeContext = {
    app,
    requireStaff,
    authorised,
    asyncRoute,
    jsonBody,
    param,
    tenantId: config.tenantId,
    now,
  };
  registerCapitalRoutes({ ...routeContext, jsonBody });
  registerDashboardRoutes(routeContext);
  registerGraphRoutes(routeContext);
  registerSalesRoutes(routeContext);
  registerPartnerRoutes(routeContext);
  registerAdminRoutes(routeContext);
  registerDeliverableRoutes(routeContext);
  registerIntelligenceRoutes(routeContext);
  registerInterventureRoutes(routeContext);
  registerWarehouseRoutes(routeContext);

  // Compliance and governance (7.1, 7.2, 7.4, 5.4, 4.5). These carry write forms - activating a
  // state is a write - so they take `jsonBody`, the way capital does.
  registerComplianceRoutes({ ...routeContext, jsonBody });
  registerRegulatoryRoutes({ ...routeContext, jsonBody });
  registerGovernanceRoutes({ ...routeContext, jsonBody });
  registerMarketingRoutes({ ...routeContext, jsonBody });

  // Billing, contracts and vault carry Batch A writes now; workbench, workflow and outcomes are
  // still reads, and each says so in its own `blocked` list rather than leaving a page to wonder.
  registerBillingRoutes(routeContext);
  registerContractRoutes(routeContext);
  registerVaultRoutes(routeContext);
  registerWorkbenchRoutes(routeContext);
  registerWorkflowRoutes(routeContext);
  registerOutcomeRoutes(routeContext);

  // Batch A. Retention holds and deletion decisions are the irreversible end of the seventeen
  // capabilities that had a module function and no declared action, so they take `authorised` and
  // a body parser. `place_legal_hold`, `release_legal_hold` and `decide_deletion_request` are
  // governance-classified: a hold is placed on exactly the client middleware step 4 refuses.
  registerRetentionRoutes(routeContext);

  // --- Event Ledger (11.3) ------------------------------------------------

  app.get(
    '/api/clients/:clientId/ledger',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      const events = await readLedger({
        tenantId: actor.tenantId,
        clientId: param(req, 'clientId'),
      });
      send(res, events.length > 0 ? ok(events) : noData('No ledger events for this client.'));
    }),
  );

  app.get(
    '/api/ledger/integrity',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      send(res, ok(await verifyIntegrity(actor.tenantId)));
    }),
  );

  // --- Composed route modules ---------------------------------------------

  registerStaffKeyRoutes({
    app,
    tenantId: config.tenantId,
    rp: { id: config.rpId, name: config.rpName, origin: config.origin },
    now,
    requireStaff,
    asyncRoute,
    param,
    jsonBody,
    rateLimited,
    setSessionCookie: (res, token, expiresAt) => {
      setSessionCookie(res, config, token, expiresAt);
    },
  });

  // --- The page -----------------------------------------------------------

  /**
   * Served by this process, because the session cookie is `SameSite=Strict` - a page on another
   * origin sends no cookie at all with a cross-site request, which is the CSRF control.
   *
   * ADR-0031 covers the reasoning; the only thing that differs here is which process. Note that
   * this being the same process as the internal API is exactly what ADR-0022 forbids for the
   * CLIENT portal and requires for this one: the Console page and the Console API are the same
   * trust boundary, and a client is on neither side of it.
   */
  app.use(
    '/console',
    pageHelmet,
    express.static(join(currentDirectory, '..', 'public'), {
      index: 'index.html',
      extensions: ['html'],
      dotfiles: 'ignore',
    }),
  );

  app.get('/', (_req, res) => {
    res.redirect(302, '/console/');
  });

  app.use((_req, res) => {
    send(res, noData('No such route.'));
  });

  return app;
};
