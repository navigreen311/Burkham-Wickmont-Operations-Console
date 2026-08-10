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
  completeReset,
  completeSignInMfa,
  confirmAuthenticator,
  downloadDocument,
  mfaSettings,
  newRecoveryCodes,
  principalFromToken,
  removeAuthenticator,
  requestReset,
  sendMessage,
  signDisclosure,
  signIn,
  signOut,
  startAuthenticatorEnrolment,
  uploadDocument,
  type ClientPrincipal,
} from '@bwc/portal';
import { refused, type Outcome } from '@bwc/core';
import type { ConsentKind } from '@bwc/consent';
import type { DocumentKind, VaultConfig } from '@bwc/vault';
import { send } from '@bwc/http';
import { readConfig, type PortalConfig } from './config.js';
import {
  createRateLimiter,
  createSharedRateLimiter,
  rateLimitKey,
  type RateLimiter,
} from './limiter.js';

export interface PortalAppDeps {
  readonly config?: PortalConfig;
  readonly vault: VaultConfig;
  /** Injectable so a test can drive the window without waiting five minutes. */
  readonly limiter?: RateLimiter;
  /** The password-reset path counts separately - see `DEFAULT_RESET_WINDOW_SECONDS`. */
  readonly resetLimiter?: RateLimiter;
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

/**
 * The name of the cookie carrying an unanswered MFA challenge.
 *
 * A different cookie from the session, deliberately. One cookie carrying "either a session or a
 * half-authentication, depending" is the shape that ends with a route reading the wrong one - and
 * the challenge token is not a session token: `principalFromToken` looks in a different table and
 * will not resolve it.
 */
const challengeCookieName = (config: PortalConfig): string => `${config.cookieName}_mfa`;

const setChallengeCookie = (
  res: Response,
  config: PortalConfig,
  token: string,
  expiresAt: Date,
): void => {
  res.cookie(challengeCookieName(config), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
};

const clearChallengeCookie = (res: Response, config: PortalConfig): void => {
  res.clearCookie(challengeCookieName(config), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
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
  /**
   * One factory, chosen by configuration rather than by the call site.
   *
   * The two limiters differ in budget and must not differ in where they count: a deployment with
   * one shared and one per-process would be enforcing two different things and reporting neither.
   */
  const buildLimiter = (scope: string, windowSeconds: number, maxAttempts: number): RateLimiter =>
    config.rateLimitStore === 'shared'
      ? createSharedRateLimiter({ scope, windowSeconds, maxAttempts })
      : createRateLimiter({ windowSeconds, maxAttempts });

  const limiter =
    deps.limiter ??
    buildLimiter('portal.sign_in', config.signInWindowSeconds, config.signInMaxAttempts);
  const resetLimiter =
    deps.resetLimiter ??
    buildLimiter('portal.password_reset', config.resetWindowSeconds, config.resetMaxAttempts);

  /**
   * Per-IP limiting, in front of an unauthenticated route.
   *
   * Runs BEFORE the body parser on every route that uses it. A limiter that parsed first would be
   * doing the attacker's work for them.
   */
  const limitBy =
    (which: RateLimiter, reason: string) =>
    (req: Request, res: Response, next: NextFunction): void => {
      which
        .check(rateLimitKey(req.ip), now())
        .then((verdict) => {
          if (!verdict.allowed) {
            res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
            send(
              res,
              refused(
                reason,
                'Portal transport - per-IP rate limiting on the unauthenticated path',
              ),
            );
            return;
          }
          next();
        })
        // A store that cannot be reached is refused, not waved through. It is the same database
        // sign-in needs to read the user and issue a session, so failing closed here costs nothing
        // that was not already lost - which is why Postgres rather than Redis (ADR-0025).
        .catch(next);
    };

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
  app.post(
    '/portal/sign-in',
    limitBy(limiter, 'Too many sign-in attempts from this address. Try again shortly.'),
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

      if (result.value.kind === 'mfa_required') {
        // NO session cookie. The password was right and that is not enough, so nothing that any
        // authenticated route would accept is issued here.
        setChallengeCookie(
          res,
          config,
          result.value.challengeToken,
          new Date(result.value.expiresAt),
        );
        send(res, {
          status: 'ok',
          value: { mfaRequired: true, expiresAt: result.value.expiresAt },
        });
        return;
      }

      setSessionCookie(res, config, result.value.token, new Date(result.value.expiresAt));
      // The token is NOT in the body. It is in an httpOnly cookie precisely so script cannot read
      // it, and returning it here would hand it back to script.
      send(res, {
        status: 'ok',
        value: {
          mfaRequired: false,
          displayName: result.value.displayName,
          expiresAt: result.value.expiresAt,
        },
      });
    }),
  );

  /**
   * The second step.
   *
   * On the sign-in limiter rather than a third one: this is the same act, and an attacker who could
   * open unlimited challenges to get unlimited code attempts would have found the way round the
   * per-challenge cap.
   */
  app.post(
    '/portal/sign-in/mfa',
    limitBy(limiter, 'Too many sign-in attempts from this address. Try again shortly.'),
    express.json({ limit: config.maxJsonBytes }),
    asyncRoute(async (req, res) => {
      const body = req.body as { code?: unknown };
      const challengeToken = tokenFrom(req, challengeCookieName(config));

      if (challengeToken === undefined || typeof body?.code !== 'string') {
        send(res, refused('That code is not correct.', 'Blueprint 11.1'));
        return;
      }

      const result = await completeSignInMfa({
        tenantId: config.tenantId,
        challengeToken,
        code: body.code,
        now: now(),
      });

      if (result.status !== 'ok') {
        send(res, result);
        return;
      }

      clearChallengeCookie(res, config);
      setSessionCookie(res, config, result.value.token, new Date(result.value.expiresAt));
      send(res, {
        status: 'ok',
        value: {
          displayName: result.value.displayName,
          expiresAt: result.value.expiresAt,
          // Surfaced so a client who has just spent one of eight knows how many are left. A count
          // nobody sees is a count nobody acts on.
          usedRecoveryCode: result.value.usedRecoveryCode,
          recoveryCodesRemaining: result.value.recoveryCodesRemaining,
        },
      });
    }),
  );

  // --- Password reset ------------------------------------------------------
  //
  // Unauthenticated, and the only route here that produces a credential. Its own limiter, so a
  // reset flood cannot exhaust the sign-in budget and lock out clients behind the same address.
  app.post(
    '/portal/password-reset',
    limitBy(resetLimiter, 'Too many reset requests from this address. Try again shortly.'),
    express.json({ limit: config.maxJsonBytes }),
    asyncRoute(async (req, res) => {
      const body = req.body as { email?: unknown };

      if (typeof body?.email !== 'string') {
        // The same shape of answer a real address gets, for the same reason sign-in gives one
        // sentence: the endpoint must not report anything about the address it was handed.
        send(
          res,
          refused(
            'A reset needs the email address on the account.',
            'Blueprint 11.1 - identity and access',
          ),
        );
        return;
      }

      // 11.1 answers identically for a known address, an unknown one, an unenrolled user and a
      // disabled one. Nothing here inspects the result to be more helpful.
      send(res, await requestReset({ tenantId: config.tenantId, email: body.email, now: now() }));
    }),
  );

  app.post(
    '/portal/password-reset/complete',
    limitBy(resetLimiter, 'Too many reset attempts from this address. Try again shortly.'),
    express.json({ limit: config.maxJsonBytes }),
    asyncRoute(async (req, res) => {
      const body = req.body as { token?: unknown; password?: unknown };

      if (typeof body?.token !== 'string' || typeof body?.password !== 'string') {
        send(
          res,
          refused(
            'That reset link is not valid. Ask for a new one.',
            'Blueprint 11.1 - identity and access',
          ),
        );
        return;
      }

      // The token arrives in the BODY, never a query string. The link a client clicks carries it in
      // a URL because email leaves no alternative, but the URL a browser then posts from is not the
      // one this server logs.
      const result = await completeReset({
        tenantId: config.tenantId,
        token: body.token,
        password: body.password,
        now: now(),
      });

      // Every session for that user has just been revoked, including this browser's if it held one.
      // Clearing the cookie stops the next request looking like a session that expired on its own.
      if (result.status === 'ok') clearSessionCookie(res, config);

      send(res, result);
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
      // An abandoned challenge goes too. Leaving it would mean a browser that walked away
      // mid-sign-in still carries a half-authentication it can finish later.
      clearChallengeCookie(res, config);

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

  // --- Managing the second factor ------------------------------------------
  //
  // Behind a session, and every one that changes a credential takes the password as well. A session
  // is not a credential: enrolment or removal from a session alone is enrolment or removal by
  // whoever stole the session.
  app.get(
    '/portal/mfa',
    withPrincipal(async (principal, _req, res) => {
      send(res, { status: 'ok', value: await mfaSettings(principal) });
    }),
  );

  app.post(
    '/portal/mfa/enrol',
    withPrincipal(async (principal, _req, res) => {
      // The secret leaves here exactly once, to be scanned. After this only the ciphertext exists,
      // and it authenticates nothing until a code confirms it.
      send(res, await startAuthenticatorEnrolment(principal));
    }),
  );

  app.post(
    '/portal/mfa/enrol/confirm',
    express.json({ limit: config.maxJsonBytes }),
    withPrincipal(async (principal, req, res) => {
      const body = req.body as { password?: unknown; code?: unknown };
      if (typeof body?.password !== 'string' || typeof body?.code !== 'string') {
        send(
          res,
          refused(
            'Confirming an authenticator needs your password and a code from it.',
            'Blueprint 11.1 - a credential change needs a credential',
          ),
        );
        return;
      }

      send(
        res,
        await confirmAuthenticator({ principal, password: body.password, code: body.code }),
      );
    }),
  );

  app.post(
    '/portal/mfa/remove',
    express.json({ limit: config.maxJsonBytes }),
    withPrincipal(async (principal, req, res) => {
      const body = req.body as { password?: unknown; code?: unknown };
      if (typeof body?.password !== 'string' || typeof body?.code !== 'string') {
        send(
          res,
          refused(
            'Removing an authenticator needs your password and a current code, or a recovery code.',
            'Blueprint 11.1 - a credential change needs a credential',
          ),
        );
        return;
      }

      send(res, await removeAuthenticator({ principal, password: body.password, code: body.code }));
    }),
  );

  app.post(
    '/portal/mfa/recovery-codes',
    express.json({ limit: config.maxJsonBytes }),
    withPrincipal(async (principal, req, res) => {
      const body = req.body as { password?: unknown };
      if (typeof body?.password !== 'string') {
        send(
          res,
          refused(
            'New recovery codes need your password.',
            'Blueprint 11.1 - a credential change needs a credential',
          ),
        );
        return;
      }

      send(res, await newRecoveryCodes({ principal, password: body.password }));
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
