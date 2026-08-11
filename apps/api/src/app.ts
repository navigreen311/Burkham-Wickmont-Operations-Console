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
  authenticateStaff,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  findActor,
  inviteStaff,
  resolveStaffSession,
  revokeStaffSession,
} from '@bwc/identity';
import { read as readLedger, verifyIntegrity } from '@bwc/ledger';
import { findByWorkflowTask, openFor } from '@bwc/notifications';
import { systemHealth } from '@bwc/observability';
import { chain, type StepTrace } from '@bwc/middleware';
import { requestRecommendation } from '@bwc/placement';
import { CAPITAL_NEEDS, type CapitalNeed } from '@bwc/lenders';
import { activeListing, timelineFor } from '@bwc/risk';
import { openObligations } from '@bwc/calls';
import {
  breachedSlas,
  find as findWorkflowTask,
  findInstance,
  forInstance as tasksForInstance,
} from '@bwc/workflow';
import {
  buildFeeExhibit,
  contractsForClient,
  contractsOnSupersededTemplates,
  findContract,
  hashDocument,
  staleContracts,
  unresolvedPlaceholders,
  verifyStoredHash,
  type ContractDocument,
} from '@bwc/contracts';
import {
  MINIMUM_LEVEL_TO_READ,
  accessLog,
  forClient as documentsForClient,
  type DocumentKind,
} from '@bwc/vault';
import {
  availableCredit,
  balanceOf,
  engagementsForClient,
  exhibitInputFor,
  findEngagement,
  formatMoney,
  ladder,
  recordsFor,
  refundsDue,
  totalAvailableCredit,
} from '@bwc/billing';
import { workbench } from '@bwc/workbench';
import { VENDOR_GATES, isActivated, mode, outstandingPreconditions } from '@bwc/integration';
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

  // --- 2.4 Human Approval Console -----------------------------------------

  /**
   * The approval queue, and the checkpoints that have run out of time.
   *
   * **This surface has no verb, and that is a finding rather than an omission.** Resolving a
   * checkpoint means `completeExternalTask`, which is a write - and `decideAuthority` refuses any
   * action absent from `ACTION_MINIMUM_LEVEL`, where no action for it exists. Adding one is an edit
   * to `packages/core/src/authority.ts`, which this slice does not own. ADR-0037 lists what is
   * needed and why the reading half shipped anyway.
   *
   * `queue` is an operator input rather than a served vocabulary, and that is the one place this
   * page departs from ADR-0035's rule. Queue names are authored inside playbooks
   * (`HumanCheckpointNode.queue`) and nothing enumerates them, so there is no closed set to serve.
   * A select filled from a list this file invented would be the exact failure ADR-0035 describes,
   * pointed the other way.
   */
  app.get(
    '/api/console/approvals',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const queue = typeof query['queue'] === 'string' ? query['queue'].trim() : '';

      // `breachedSlas` is the module's own answer to "what has run out of time". The alternative -
      // comparing `slaDueAt` against the clock here - would be a second implementation of a rule
      // 2.2 already owns, and the two would disagree the first time either moved.
      const breached = (await breachedSlas(now(), config.tenantId)).filter(
        (task) => task.kind === 'human_checkpoint',
      );

      // Open items need a queue to ask about; the breach list does not. Reported as an empty list
      // with the reason rather than as a refusal: "nobody named a queue" and "that queue is empty"
      // are different answers and an operator arriving here has asked neither.
      const items =
        queue === ''
          ? []
          : (await openFor(config.tenantId, queue)).filter(
              (item) => item.kind === 'human_checkpoint',
            );

      send(
        res,
        ok({
          queue,
          queueAsked: queue !== '',
          items: items.map((item) => ({
            id: item.id,
            workflowTaskId: item.workflowTaskId,
            clientId: item.clientId,
            assignedTo: item.assignedTo,
            kind: item.kind,
            summary: item.summary,
            status: item.status,
            slaDueAt: item.slaDueAt === null ? null : item.slaDueAt.toISOString(),
          })),
          total: items.length,
          breached: breached.map((task) => ({
            id: task.id,
            instanceId: task.instanceId,
            nodeKey: task.nodeKey,
            kind: task.kind,
            status: task.status,
            department: task.department,
            slaDueAt: task.slaDueAt === null ? null : task.slaDueAt.toISOString(),
            escalatedAt: task.escalatedAt === null ? null : task.escalatedAt.toISOString(),
          })),
          breachedTotal: breached.length,
        }),
      );
    }),
  );

  /**
   * One checkpoint, with the workflow it is holding up.
   *
   * **The tenant is checked here rather than trusted from the module.** `find`, `findInstance` and
   * `forInstance` in `@bwc/workflow` are all keyed by id alone with no tenant filter - correct for
   * an engine that has already resolved its own scope, and not something a route taking an id from
   * a browser may rely on. A Console operator pasting another tenant's task id would otherwise read
   * another tenant's workflow. ADR-0039.
   */
  app.get(
    '/api/console/approvals/:taskId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const taskId = param(req, 'taskId');

      const task = await findWorkflowTask(taskId);
      // One sentence for both causes. "No such task" and "that task is another tenant's" are the
      // same answer to somebody who is not entitled to know which.
      if (!task || task.tenantId !== config.tenantId) {
        send(res, noData('No such workflow task in this tenant.'));
        return;
      }

      /**
       * Checked again on the instance, and the redundancy is deliberate.
       *
       * **Mutation testing showed this second check alone passes the cross-tenant test**, because
       * `start` creates a task and its instance in one tenant, so no reachable state has them
       * disagreeing. That makes either check sufficient today and neither of them the one the test
       * proves - removing both is what fails it.
       *
       * Both stay because the invariant they lean on is not enforced anywhere: nothing in the
       * schema or the types says a task and its instance share a tenant. A guard that is correct
       * only because of an unstated invariant is a guard waiting for the invariant to change.
       */
      const instance = await findInstance(task.instanceId);
      if (!instance || instance.tenantId !== config.tenantId) {
        send(res, noData('No such workflow task in this tenant.'));
        return;
      }

      const [siblings, raised] = await Promise.all([
        tasksForInstance(task.instanceId),
        findByWorkflowTask(config.tenantId, task.id),
      ]);

      send(
        res,
        ok({
          task: {
            id: task.id,
            nodeKey: task.nodeKey,
            kind: task.kind,
            status: task.status,
            department: task.department,
            attempts: task.attempts,
            maxAttempts: task.maxAttempts,
            lastError: task.lastError,
            slaDueAt: task.slaDueAt === null ? null : task.slaDueAt.toISOString(),
            escalatedAt: task.escalatedAt === null ? null : task.escalatedAt.toISOString(),
          },
          instance: {
            id: instance.id,
            playbookKey: instance.playbookKey,
            playbookVersion: instance.playbookVersion,
            status: instance.status,
            clientId: instance.clientId,
            currentNodeKey: instance.currentNodeKey,
          },
          siblings: siblings.map((sibling) => ({
            id: sibling.id,
            nodeKey: sibling.nodeKey,
            kind: sibling.kind,
            status: sibling.status,
          })),
          siblingsTotal: siblings.length,
          notifications: raised.map((item) => ({
            id: item.id,
            assignedTo: item.assignedTo,
            summary: item.summary,
            status: item.status,
          })),
          notificationsTotal: raised.length,
          /**
           * Named rather than left to be inferred from the absence of a button.
           *
           * A page that simply had no control here would read as a page somebody had not finished.
           * This says the act exists, names what blocks it, and is asserted by a transport test so
           * it cannot quietly become false once the action is added.
           */
          resolution: {
            available: false,
            reason:
              'Resolving a checkpoint calls completeExternalTask, which needs an action in ACTION_MINIMUM_LEVEL. No action for it exists, and decideAuthority refuses an action absent from the catalogue. See ADR-0037.',
            requiredAction: 'resolve_human_checkpoint',
          },
        }),
      );
    }),
  );

  // --- 7.3 Contract & Disclosure Builder ----------------------------------

  /**
   * Every document issued to a client, oldest first.
   *
   * The full content model is deliberately NOT in the list. A page that rendered every section of
   * every contract to show a client had four of them would be shipping the whole library to draw a
   * table of contents - and each of these is a binding document, so the smaller the number of
   * places its text travels the better.
   */
  app.get(
    '/api/console/clients/:clientId/contracts',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const issued = await contractsForClient(config.tenantId, param(req, 'clientId'));

      send(
        res,
        ok({
          contracts: issued.map((record) => ({
            id: record.id,
            kind: record.kind,
            templateKey: record.templateKey,
            templateVersion: record.templateVersion,
            state: record.state,
            stateModuleVersion: record.stateModuleVersion,
            contentHash: record.contentHash,
            clauseKeys: record.clauseKeys,
            disclosureKeys: record.disclosureKeys,
            issuedAt: record.issuedAt,
          })),
          total: issued.length,
        }),
      );
    }),
  );

  /**
   * One issued document, with the two questions worth asking about it.
   *
   * **Is it still what we sent?** `verifyStoredHash` recomputes the digest over the stored content
   * model. A mismatch is the most serious integrity failure available here - the document is the
   * only evidence of what was agreed (ADR-0010) - so it travels as a first-class field rather than
   * as something a reader has to go and check.
   *
   * **Did anything fail to resolve?** `unresolvedPlaceholders` names substitutions the generator
   * left in place. A contract carrying a literal placeholder went out with a blank in it.
   */
  app.get(
    '/api/console/contracts/:contractId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const contractId = param(req, 'contractId');

      const record = await findContract(config.tenantId, contractId);
      if (!record) {
        send(res, noData('No such contract in this tenant.'));
        return;
      }

      const integrity = await verifyStoredHash(config.tenantId, contractId, (content) =>
        hashDocument(content as ContractDocument),
      );
      const placeholders = unresolvedPlaceholders(record.content);

      send(
        res,
        ok({
          id: record.id,
          clientId: record.clientId,
          kind: record.kind,
          state: record.state,
          issuedAt: record.issuedAt,
          contentHash: record.contentHash,
          integrity,
          unresolvedPlaceholders: placeholders,
          unresolvedPlaceholdersTotal: placeholders.length,
          document: {
            title: record.content.title,
            offerTier: record.content.offerTier,
            channel: record.content.channel,
            provenance: record.content.provenance,
            sections: record.content.sections.map((section) => ({
              heading: section.heading,
              body: section.body,
              clauses: section.clauses,
              disclosures: section.disclosures,
            })),
            sectionsTotal: record.content.sections.length,
          },
        }),
      );
    }),
  );

  /**
   * Documents the world has moved out from under.
   *
   * Two lists rather than one total, because the remedy differs: a stale state module means the law
   * moved, a superseded template means we changed our own words. An operator triaging the two makes
   * different calls, and a combined count would hide which they were looking at.
   *
   * **Nothing here reissues anything.** An issued contract is frozen (ADR-0010); this is a report.
   */
  app.get(
    '/api/console/contract-staleness',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const [stale, superseded] = await Promise.all([
        staleContracts(config.tenantId),
        contractsOnSupersededTemplates(config.tenantId),
      ]);

      send(
        res,
        ok({
          stale,
          staleTotal: stale.length,
          onSupersededTemplates: superseded,
          onSupersededTemplatesTotal: superseded.length,
        }),
      );
    }),
  );

  // --- 3.2 Secure Document Vault (metadata and access log only) -----------

  /**
   * What documents exist on a client's file, and nothing of what is in them.
   *
   * **No route here returns document bytes, and that is the design rather than a stage.** `read`
   * exists in `@bwc/vault`, it decrypts, and it watermarks an export - and putting it behind a page
   * would make every staff session a download button for tax returns, government IDs and credit
   * reports. The Vault's own gates would still run; the objection is not that they would fail, it
   * is that a console is an invitation (ADR-0032) and this is the data class where an invitation
   * costs the most.
   *
   * `minimumLevelToRead` is the module's own constant, surfaced so the page can say what a document
   * would need. It is deliberately NOT resolved into a boolean: `read` gates on tenant, level, scan
   * status and legal hold in a fixed order, and a `readable: true` computed here would be a second
   * implementation of that gate which could only ever drift from it.
   */
  app.get(
    '/api/console/clients/:clientId/documents',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const documents = await documentsForClient(config.tenantId, param(req, 'clientId'));

      send(
        res,
        ok({
          documents: documents.map((document) => ({
            id: document.id,
            kind: document.kind,
            filename: document.filename,
            contentType: document.contentType,
            byteSize: document.byteSize,
            sha256: document.sha256,
            // `pending` and `scan_unavailable` are distinct from `clean` and neither means clean.
            // The page writes the word out; nothing here is rendered as a colour alone.
            scanStatus: document.scanStatus,
            legalHold: document.legalHold,
            retainUntil: document.retainUntil === null ? null : document.retainUntil.toISOString(),
            minimumLevelToRead: MINIMUM_LEVEL_TO_READ[document.kind as DocumentKind],
          })),
          total: documents.length,
          /** So the page can say "you hold 1" beside "this needs 3" without deciding anything. */
          actorAuthorityLevel: actor.authorityLevel,
          bytesAvailableHere: false,
        }),
      );
    }),
  );

  /**
   * Who looked, who was turned away, and why.
   *
   * **The refusals are the reason this has a page.** `logAccess` records a denied read as carefully
   * as a granted one, and a pattern of cross-tenant or below-level attempts against one client's
   * file is exactly the signal an audit wants - it exists only if somebody can see it. A log
   * showing successes alone would answer the less interesting half.
   */
  app.get(
    '/api/console/documents/:documentId/access-log',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const entries = await accessLog(config.tenantId, param(req, 'documentId'));
      const refused = entries.filter((entry) => !entry.granted);

      send(
        res,
        ok({
          entries: entries.map((entry) => ({
            actorId: entry.actorId,
            action: entry.action,
            granted: entry.granted,
            reason: entry.reason,
            watermarked: entry.watermarked,
            at: entry.at.toISOString(),
          })),
          total: entries.length,
          grantedTotal: entries.length - refused.length,
          refusedTotal: refused.length,
        }),
      );
    }),
  );

  // --- 1.4 Pricing, Billing & Offer Management ----------------------------

  /** The offer ladder, entry rung first. Money is integer cents; `display` is 1.4's own renderer. */
  app.get(
    '/api/console/offers',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const offers = await ladder(config.tenantId);

      send(
        res,
        ok({
          offers: offers.map((offer) => ({
            key: offer.key,
            version: offer.version,
            name: offer.name,
            rung: offer.rung,
            retainerCents: offer.retainerCents,
            retainerDisplay: formatMoney(offer.retainerCents),
            monthlyCents: offer.monthlyCents,
            monthlyDisplay: formatMoney(offer.monthlyCents),
            successFeeBasisPoints: offer.successFeeBasisPoints,
            minimumCents: offer.minimumCents,
            minimumDisplay: formatMoney(offer.minimumCents),
            committedMonths: offer.committedMonths,
          })),
          total: offers.length,
        }),
      );
    }),
  );

  /**
   * A client's commercial position: every engagement, and what they have paid that is unspent.
   *
   * The unresolved-refund count travels per engagement because 1.4 derives entitlement rather than
   * storing it - there is no column to count, and the default in that module is to PAY. An
   * entitlement nobody has looked at is money owed that has not moved.
   */
  app.get(
    '/api/console/clients/:clientId/billing',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const clientId = param(req, 'clientId');
      const at = now();

      const engagements = await engagementsForClient(config.tenantId, clientId);

      const rows = await Promise.all(
        engagements.map(async (engagement) => {
          const [balance, refunds] = await Promise.all([
            balanceOf(config.tenantId, engagement.id),
            refundsDue(config.tenantId, engagement.id, at),
          ]);
          return {
            id: engagement.id,
            offerId: engagement.offerId,
            status: engagement.status,
            startedOn: engagement.startedOn,
            committedThrough: engagement.committedThrough,
            annualPrepay: engagement.annualPrepay,
            cancelledOn: engagement.cancelledOn,
            outstandingCents: balance.status === 'ok' ? balance.value.outstanding : null,
            outstandingDisplay:
              balance.status === 'ok' ? formatMoney(balance.value.outstanding) : null,
            meetsMinimum: balance.status === 'ok' ? balance.value.meetsMinimum : null,
            unresolvedRefundTotal: refunds.filter((refund) => refund.resolved === null).length,
            refundTotal: refunds.length,
          };
        }),
      );

      const [sources, total] = await Promise.all([
        availableCredit(config.tenantId, clientId),
        totalAvailableCredit(config.tenantId, clientId),
      ]);

      send(
        res,
        ok({
          engagements: rows,
          total: rows.length,
          credit: {
            sources: sources.map((source) => ({
              recordId: source.recordId,
              engagementId: source.engagementId,
              paidCents: source.paidCents,
              paidDisplay: formatMoney(source.paidCents),
              alreadyDrawnCents: source.alreadyDrawnCents,
              alreadyDrawnDisplay: formatMoney(source.alreadyDrawnCents),
              availableCents: source.availableCents,
              availableDisplay: formatMoney(source.availableCents),
              occurredOn: source.occurredOn,
            })),
            sourcesTotal: sources.length,
            availableCents: total,
            availableDisplay: formatMoney(total),
          },
        }),
      );
    }),
  );

  /**
   * One engagement: the four numbers behind a balance, the ledger of what was charged, the refund
   * entitlements, and the all-in fee exhibit.
   *
   * **The balance travels as its components, never as one net figure.** "You owe $4,200" answers
   * less than the four numbers that produced it, and a client disputing an invoice is asking about
   * one of the four.
   *
   * **The exhibit's amounts are DOLLARS while everything else here is cents.** That is 7.3's
   * convention and 1.4 converts once at its edge (`exhibitInputFor`); the two are one field apart
   * on this response, so both are named for what they carry. A contingent line has `amount: null`
   * and the page writes "contingent" - a null success fee is not a fee of zero.
   */
  app.get(
    '/api/console/engagements/:engagementId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const engagementId = param(req, 'engagementId');

      const engagement = await findEngagement(config.tenantId, engagementId);
      if (engagement.status !== 'ok') {
        send(res, engagement);
        return;
      }

      const at = now();
      const [balance, records, refunds, exhibitInput] = await Promise.all([
        balanceOf(config.tenantId, engagementId),
        recordsFor(config.tenantId, engagementId),
        refundsDue(config.tenantId, engagementId, at),
        exhibitInputFor({ tenantId: config.tenantId, engagementId }),
      ]);

      // No `approvedCreditLimitCents` is passed, deliberately. 1.4 presents the success fee as
      // contingent when no approval exists rather than estimating it - and there is nowhere on the
      // input to put a REQUESTED limit, which is the Seek Capital lesson expressed as a type.
      const exhibit =
        exhibitInput.status === 'ok' ? buildFeeExhibit(exhibitInput.value) : exhibitInput;

      send(
        res,
        ok({
          engagement: {
            id: engagement.value.id,
            clientId: engagement.value.clientId,
            offerId: engagement.value.offerId,
            status: engagement.value.status,
            startedOn: engagement.value.startedOn,
            committedThrough: engagement.value.committedThrough,
            annualPrepay: engagement.value.annualPrepay,
            cancelledOn: engagement.value.cancelledOn,
          },
          balance:
            balance.status === 'ok'
              ? {
                  chargedCents: balance.value.charged,
                  chargedDisplay: formatMoney(balance.value.charged),
                  paidCents: balance.value.paid,
                  paidDisplay: formatMoney(balance.value.paid),
                  refundedCents: balance.value.refunded,
                  refundedDisplay: formatMoney(balance.value.refunded),
                  creditedCents: balance.value.credited,
                  creditedDisplay: formatMoney(balance.value.credited),
                  outstandingCents: balance.value.outstanding,
                  outstandingDisplay: formatMoney(balance.value.outstanding),
                  meetsMinimum: balance.value.meetsMinimum,
                  minimumCents: balance.value.minimumCents,
                  minimumDisplay: formatMoney(balance.value.minimumCents),
                }
              : null,
          // Every non-`ok` variant of `Outcome` carries a `reason`, so the reason is forwarded
          // unchanged rather than reworded. Translating a refusal is where reasons get lost.
          balanceUnavailableReason: balance.status === 'ok' ? null : balance.reason,
          records: records.map((record) => ({
            id: record.id,
            kind: record.kind,
            amountCents: record.amountCents,
            amountDisplay: formatMoney(record.amountCents),
            description: record.description,
            // The APPROVED limit, never the requested one. There is no field for a requested limit
            // anywhere in 1.4, which is the invariant expressed as an absence.
            approvedCreditLimitCents: record.approvedCreditLimitCents,
            approvedCreditLimitDisplay:
              record.approvedCreditLimitCents === null
                ? null
                : formatMoney(record.approvedCreditLimitCents),
            occurredOn: record.occurredOn,
          })),
          recordsTotal: records.length,
          refunds: refunds.map((refund) => ({
            trigger: refund.trigger,
            amountCents: refund.amountCents,
            amountDisplay: formatMoney(refund.amountCents),
            basis: refund.basis,
            resolved: refund.resolved,
          })),
          refundsTotal: refunds.length,
          unresolvedRefundTotal: refunds.filter((refund) => refund.resolved === null).length,
          exhibit:
            exhibit.status === 'ok'
              ? {
                  lines: exhibit.value.lines,
                  linesTotal: exhibit.value.lines.length,
                  knownTotalDollars: exhibit.value.knownTotal,
                  contingentLines: exhibit.value.contingentLines,
                  contingentLinesTotal: exhibit.value.contingentLines.length,
                  summary: exhibit.value.summary,
                }
              : null,
          exhibitUnavailableReason: exhibit.status === 'ok' ? null : exhibit.reason,
        }),
      );
    }),
  );

  // --- 11.11 Founder / Executive Workbench --------------------------------

  /**
   * What only a founder can decide, and the portfolio numbers behind it.
   *
   * 11.11 stores nothing and this route adds nothing to it. The whole surface is assembly, and the
   * one thing worth saying about the transport is that it does not reduce anything: the decision
   * queue's `costOfInaction` travels whole, because it is what makes this a queue rather than a
   * feed, and the rollup's `withheld` list travels whole, because a portfolio view without its gaps
   * reads as complete.
   */
  app.get(
    '/api/console/workbench',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const assembled = await workbench({ tenantId: config.tenantId, now: now() });
      if (assembled.status !== 'ok') {
        send(res, assembled);
        return;
      }

      const view = assembled.value;
      send(
        res,
        ok({
          generatedAt: view.generatedAt,
          decisions: view.decisions.map((decision) => ({
            key: decision.key,
            kind: decision.kind,
            summary: decision.summary,
            costOfInaction: decision.costOfInaction,
            urgency: decision.urgency,
            dueAt: decision.dueAt,
            resolveIn: decision.resolveIn,
          })),
          decisionsTotal: view.decisions.length,
          overdueTotal: view.decisions.filter((decision) => decision.urgency === 'overdue').length,
          rollup: {
            periodFrom: view.rollup.periodFrom,
            periodTo: view.rollup.periodTo,
            periodPartial: view.rollup.periodPartial,
            clients: view.rollup.clients,
            complianceCounts: view.rollup.complianceCounts,
            healthyShare: view.rollup.healthyShare,
            meetsComplianceTarget: view.rollup.meetsComplianceTarget,
            placementApprovalRate: view.rollup.placementApprovalRate,
            revenuePerClientCents: view.rollup.revenuePerClientCents,
            openCorrectionObligations: view.rollup.openCorrectionObligations,
            // Carried whole. A metric with no value is reported as withheld with its note, never
            // as zero - 9.1's `null` is not `0`, and this is the surface where that matters most.
            withheld: view.rollup.withheld,
            withheldTotal: view.rollup.withheld.length,
          },
          health: {
            overall: view.health.overall,
            detail: view.health.detail,
            checkedAt: view.health.checkedAt,
            counts: view.health.counts,
            components: view.health.components.map((component) => ({
              key: component.key,
              label: component.label,
              state: component.state,
              detail: component.detail,
            })),
            componentsTotal: view.health.components.length,
          },
          crossDepartment: view.crossDepartment.map((entry) => ({
            department: entry.department,
            status: entry.status,
          })),
          crossDepartmentTotal: view.crossDepartment.length,
        }),
      );
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
