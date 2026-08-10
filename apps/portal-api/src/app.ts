/**
 * The Client Portal's HTTP surface - 11.10, over the wire.
 *
 * **A separate app from `apps/api`, and that is the point rather than a packaging preference.**
 *
 * `apps/api` resolves the acting staff member from an `x-actor-id` request header. Its own comment
 * calls that "a development seam, not authentication". A public surface in that process is a
 * public surface with that header: a client who could reach any internal route would send
 * `x-actor-id: <any Level 3 actor id>` and act as staff - approve their own Do Not Fund override,
 * activate a state, invite a client user onto somebody else's file.
 *
 * So this process imports `@bwc/portal` and `@bwc/identity` and nothing that serves internal
 * capability. The isolation is structural: there is no route to get wrong, because the code is not
 * here to route to.
 *
 * The two also want opposite defaults - a trusted network wants a permissive body limit and no rate
 * limiting, and the public internet wants the reverse.
 *
 * No business logic lives here. Every handler resolves a principal and calls `@bwc/portal`, which
 * calls the module that owns the gate. The transport's own jobs are: the session cookie, the rate
 * limit, the body limits, and turning an `Outcome` into a status code.
 */

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import {
  clientRoom,
  downloadDocument,
  principalFromToken,
  sendMessage,
  signDisclosure,
  signIn,
  signOut,
  uploadDocument,
  type ClientPrincipal,
} from '@bwc/portal';
import { refused, type Outcome } from '@bwc/core';
import type { ConsentKind } from '@bwc/consent';
import type { DocumentKind, VaultConfig } from '@bwc/vault';
import { send } from '@bwc/http';
import { readConfig, type PortalConfig } from './config.js';
import { createRateLimiter, rateLimitKey, type RateLimiter } from './limiter.js';

export interface PortalAppDeps {
  readonly config?: PortalConfig;
  readonly vault: VaultConfig;
  /** Injectable so a test can drive the window without waiting five minutes. */
  readonly limiter?: RateLimiter;
  readonly now?: () => Date;
}

/**
 * Read the session token from the cookie.
 *
 * Parsed here rather than with a cookie-parser dependency: one cookie, read one way, and a
 * dependency for `split(';')` is a dependency to keep patched.
 *
 * The token is never accepted from a query string or a header. A token in a URL ends up in access
 * logs, browser history and `Referer`, and one accepted from a header would let a page a client
 * visited attach it.
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
  config: PortalConfig,
  token: string,
  expiresAt: Date,
): void => {
  res.cookie(config.cookieName, token, {
    // Not reachable from script, so an XSS in the portal cannot exfiltrate the session.
    httpOnly: true,
    // Required over plaintext. `config.ts` refuses to default this.
    secure: config.cookieSecure,
    // The CSRF control. A cross-site form post carries no cookie at all under Strict, so a
    // state-changing route cannot be driven from another origin.
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
};

const clearSessionCookie = (res: Response, config: PortalConfig): void => {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
  });
};

/**
 * The refusal for anything without a valid session.
 *
 * One sentence for every cause - no session, expired, idle, revoked, disabled user. 11.1 already
 * refuses to distinguish them, and re-describing them here would undo that.
 */
const NO_SESSION = (): Outcome<never> =>
  refused('Sign in to continue.', 'Blueprint 11.1 - identity and access');

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };

export const createPortalApp = (deps: PortalAppDeps): Express => {
  const config = deps.config ?? readConfig();
  const now = deps.now ?? ((): Date => new Date());
  const limiter =
    deps.limiter ??
    createRateLimiter({
      windowSeconds: config.signInWindowSeconds,
      maxAttempts: config.signInMaxAttempts,
    });

  const app = express();

  // Set BEFORE anything reads `req.ip`. `config.ts` refuses to guess it - unset behind a load
  // balancer makes every request look like it came from the balancer, and the rate limiter then
  // counts the balancer.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // Nothing here serves a document, so the strictest CSP costs nothing and is one fewer thing
      // to weaken later when somebody adds a page.
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  /**
   * Liveness. Unauthenticated and deliberately empty.
   *
   * A health endpoint that reported which components were degraded would be an unauthenticated
   * reconnaissance surface. 11.8 has that detail, behind the internal app.
   */
  app.get('/portal/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // --- Sign in -------------------------------------------------------------
  //
  // The only unauthenticated route that touches the database, and therefore the only one that is
  // rate limited. The limit runs BEFORE the body is parsed: a limiter that parsed first would be
  // doing the attacker's work for them.
  app.post(
    '/portal/sign-in',
    (req: Request, res: Response, next: NextFunction) => {
      const verdict = limiter.check(rateLimitKey(req.ip), now());
      if (!verdict.allowed) {
        res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
        send(
          res,
          refused(
            'Too many sign-in attempts from this address. Try again shortly.',
            'Portal transport - per-IP rate limiting on the unauthenticated path',
          ),
        );
        return;
      }
      next();
    },
    express.json({ limit: config.maxJsonBytes }),
    asyncRoute(async (req, res) => {
      const body = req.body as { email?: unknown; password?: unknown };

      if (typeof body?.email !== 'string' || typeof body?.password !== 'string') {
        // Same sentence a wrong password gets. A validation error that differed would say whether
        // the address was even well-formed enough to look up.
        send(res, refused('Those sign-in details are not correct.', 'Blueprint 11.1'));
        return;
      }

      const result = await signIn({
        tenantId: config.tenantId,
        email: body.email,
        password: body.password,
        now: now(),
      });

      if (result.status !== 'ok') {
        send(res, result);
        return;
      }

      setSessionCookie(res, config, result.value.token, new Date(result.value.expiresAt));
      // The token is NOT in the body. It is in an httpOnly cookie precisely so script cannot read
      // it, and returning it here would hand it back to script.
      send(res, {
        status: 'ok',
        value: { displayName: result.value.displayName, expiresAt: result.value.expiresAt },
      });
    }),
  );

  // --- Everything below requires a session ---------------------------------
  //
  // `principalFromToken` re-checks both session expiries AND the user's standing on every call, so
  // a disabled account stops working here on the next request rather than at session expiry.
  const withPrincipal = (
    handler: (principal: ClientPrincipal, req: Request, res: Response) => Promise<void>,
  ) =>
    asyncRoute(async (req, res) => {
      const token = tokenFrom(req, config.cookieName);
      if (token === undefined) {
        send(res, NO_SESSION());
        return;
      }

      const principal = await principalFromToken({
        tenantId: config.tenantId,
        token,
        now: now(),
      });

      if (principal.status !== 'ok') {
        clearSessionCookie(res, config);
        send(res, NO_SESSION());
        return;
      }

      await handler(principal.value, req, res);
    });

  app.post(
    '/portal/sign-out',
    asyncRoute(async (req, res) => {
      const token = tokenFrom(req, config.cookieName);
      clearSessionCookie(res, config);

      if (token === undefined) {
        // Signing out without a session is not an error worth reporting to somebody who is, by
        // definition, already signed out.
        send(res, { status: 'ok', value: { signedOut: true } });
        return;
      }

      await signOut({ tenantId: config.tenantId, token, now: now() });
      send(res, { status: 'ok', value: { signedOut: true } });
    }),
  );

  app.get(
    '/portal/room',
    withPrincipal(async (principal, _req, res) => {
      send(res, await clientRoom(principal));
    }),
  );

  app.get(
    '/portal/documents/:documentId',
    withPrincipal(async (principal, req, res) => {
      const raw = (req.params as Record<string, string | string[] | undefined>)['documentId'];
      const documentId = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
      const action = req.query['action'] === 'export' ? 'export' : 'view';

      const result = await downloadDocument({
        principal,
        documentId,
        action,
        vaultConfig: deps.vault,
        now: now(),
      });

      if (result.status !== 'ok') {
        send(res, result);
        return;
      }

      res.setHeader('Content-Type', result.value.contentType);
      // `attachment` for both actions. A PDF rendered inline is a PDF the browser may cache to
      // disk and hand to a plugin, and the document is the client's financial file.
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.value.filename.replace(/["\r\n]/g, '')}"`,
      );
      res.setHeader('X-Watermarked', String(result.value.watermarked));
      res.status(200).send(result.value.content);
    }),
  );

  app.post(
    '/portal/documents',
    // Raw bytes rather than multipart or base64. Multipart needs a parser dependency; base64
    // inflates a document by a third for no gain when the metadata fits in a query string.
    express.raw({ type: '*/*', limit: config.maxUploadBytes }),
    withPrincipal(async (principal, req, res) => {
      const kind = String(req.query['kind'] ?? '');
      const filename = String(req.query['filename'] ?? '');
      const contentType = req.header('content-type') ?? 'application/octet-stream';

      if (filename.trim() === '') {
        send(res, refused('A file needs a name.', 'Blueprint 11.10 - document upload'));
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        send(res, refused('No file content was received.', 'Blueprint 3.2 - input validation'));
        return;
      }

      send(
        res,
        await uploadDocument({
          principal,
          // Validated by `@bwc/portal` against the kinds a client may supply. Passed through
          // rather than checked here, so there is one list.
          kind: kind as DocumentKind,
          filename,
          contentType,
          content: req.body,
          vaultConfig: deps.vault,
        }),
      );
    }),
  );

  app.post(
    '/portal/disclosures',
    express.json({ limit: config.maxJsonBytes }),
    withPrincipal(async (principal, req, res) => {
      const body = req.body as { kind?: unknown; scope?: unknown };

      if (typeof body?.kind !== 'string' || typeof body?.scope !== 'string') {
        send(
          res,
          refused(
            'A signature needs the kind of authorization and the scope being agreed to.',
            'Blueprint 1.5 - authorization is per-event, never blanket',
          ),
        );
        return;
      }

      send(
        res,
        await signDisclosure({
          principal,
          kind: body.kind as ConsentKind,
          scope: body.scope,
        }),
      );
    }),
  );

  app.post(
    '/portal/messages',
    express.json({ limit: config.maxJsonBytes }),
    withPrincipal(async (principal, req, res) => {
      const body = req.body as { subject?: unknown; body?: unknown };

      if (typeof body?.body !== 'string') {
        send(res, refused('A message needs a body.', 'Blueprint 4.1'));
        return;
      }

      send(
        res,
        await sendMessage({
          principal,
          ...(typeof body.subject === 'string' ? { subject: body.subject } : {}),
          body: body.body,
          receivedAt: now(),
        }),
      );
    }),
  );

  /**
   * Anything else is a 404 with no detail.
   *
   * Not a list of what exists. An error page naming the routes it does not serve is a map.
   */
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'no_data', reason: 'Not found.' });
  });

  /**
   * The error handler.
   *
   * A thrown error becomes a 500 with **no cause in the body**. The internal app includes one
   * because its callers are staff; here the caller is the public internet, and a stack trace or a
   * database message is reconnaissance. The cause goes to stderr, which 11.8 would route to a sink
   * that scrubs PII before it lands.
   */
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isPayloadTooLarge =
      typeof error === 'object' &&
      error !== null &&
      (error as { type?: string }).type === 'entity.too.large';

    if (isPayloadTooLarge) {
      send(
        res,
        refused(
          `That file is larger than this portal accepts (${config.maxUploadBytes} bytes).`,
          'Portal transport - bounded request bodies',
        ),
      );
      return;
    }

    console.error('[portal] unhandled error', error);
    res.status(500).json({ status: 'failed', reason: 'Something went wrong.' });
  });

  return app;
};
