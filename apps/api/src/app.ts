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
 * Every route acting on a client still goes through the middleware chain, because the chain is
 * where authority, tenancy, the Firewall, the compliance gate and event emission are enforced.
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
import { grant as grantConsent, type ConsentKind } from '@bwc/consent';
import { status as firewallStatus, trigger as triggerFirewall } from '@bwc/firewall';
import {
  authenticateStaff,
  findActor,
  resolveStaffSession,
  revokeStaffSession,
} from '@bwc/identity';
import { read as readLedger, verifyIntegrity } from '@bwc/ledger';
import { openFor } from '@bwc/notifications';
import { systemHealth } from '@bwc/observability';
import { requestRecommendation } from '@bwc/placement';
import { activeListing, timelineFor } from '@bwc/risk';
import { openObligations } from '@bwc/calls';
import { VENDOR_GATES, isActivated, mode, outstandingPreconditions } from '@bwc/integration';
import { failed, isComplianceState, noData, ok, refused, type ComplianceState } from '@bwc/core';
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

  // --- Clients ------------------------------------------------------------

  app.post(
    '/api/clients',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const body = req.body as { legalName?: unknown };
      if (typeof body.legalName !== 'string' || body.legalName.trim() === '') {
        send(res, refused('legalName is required.', 'Input validation'));
        return;
      }

      const client = await createClient(actor.tenantId, body.legalName.trim(), {
        id: actor.id,
        kind: actor.kind,
      });
      send(res, ok(client));
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
      const actor = await requireStaff(req, res);
      if (!actor) return;

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
          tenantId: actor.tenantId,
          clientId: param(req, 'clientId'),
          to: body.to as ComplianceState,
          reason: body.reason,
          findings: body.findings ?? [],
          actor: { id: actor.id, kind: actor.kind },
        }),
      );
    }),
  );

  // --- Consent (1.5) ------------------------------------------------------

  app.post(
    '/api/clients/:clientId/consents',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

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
          tenantId: actor.tenantId,
          clientId: param(req, 'clientId'),
          kind: body.kind as ConsentKind,
          scope: body.scope,
          actor: { id: actor.id, kind: actor.kind },
        }),
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
      const actor = await requireStaff(req, res);
      if (!actor) return;
      const body = req.body as { reason?: unknown };
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        send(res, refused('reason is required to trigger the Firewall.', 'Principle 7'));
        return;
      }
      send(
        res,
        ok(
          await triggerFirewall(actor.tenantId, param(req, 'clientId'), body.reason, {
            id: actor.id,
            kind: actor.kind,
          }),
        ),
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

      const body = req.body as { applicationRef?: unknown };
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

      const { result, trace } = await requestRecommendation({
        actorId: actor.id,
        tenantId: actor.tenantId,
        clientId: param(req, 'clientId'),
        applicationRef: body.applicationRef,
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
