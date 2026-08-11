/**
 * Staff security keys, and the switch that makes them worth having - ADR-0059.
 *
 * ## Two unauthenticated routes, and why they are the interesting ones
 *
 * `/sign-in/passkey/options` and `/sign-in/passkey` take no session, because a person signing in has
 * none. They are on the sign-in rate limiter for the reason the enrolment routes are: they are
 * reachable by anybody, and an unlimited endpoint that mints sessions is one somebody hammers.
 *
 * The options route names no account and takes no email. That is what discoverable means - the
 * authenticator offers one of its own resident credentials - and it is also why the route reveals
 * nothing: there is no input to enumerate with.
 *
 * ## The rest sit behind the session and take a confirmation as well
 *
 * A live session is not enough to add or remove a key. ADR-0024's rule, and the concrete failure it
 * prevents is a key added from a stolen session that the owner never hears about.
 *
 * ## What this file does NOT do
 *
 * It does not decide anything. Every rule - two keys before the switch, user verification on every
 * assertion, a Level 3 human for a restore - lives in `@bwc/identity/staffWebauthn`. The transport
 * owns the cookie, the limiter and the shape of the reply.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import {
  STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD,
  beginStaffKeyRegistration,
  beginStaffPasskeySignIn,
  beginStaffReauthentication,
  completeStaffKeyRegistration,
  completeStaffPasskeySignIn,
  disableStaffPasswordSignIn,
  removeStaffKey,
  restoreStaffPasswordSignIn,
  staffSecurityPosture,
  type RelyingParty,
  type StaffConfirmation,
} from '@bwc/identity';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface StaffKeysRouteContext {
  readonly app: Express;
  readonly tenantId: string;
  readonly rp: RelyingParty;
  readonly now: () => Date;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly jsonBody: RequestHandler;
  /** The sign-in limiter, shared with the password path. */
  readonly rateLimited: (message: string) => RequestHandler;
  /** Owned by the host, because the cookie is the host's business. */
  readonly setSessionCookie: (res: Response, token: string, expiresAt: Date) => void;
}

/**
 * Read a confirmation off the body.
 *
 * **A union, so a caller cannot supply neither** - and cannot supply both and leave the module to
 * pick which it prefers (ADR-0030 Decision 1). One reader here means a route cannot accidentally
 * accept less than its neighbour.
 */
const confirmationFrom = (body: Record<string, unknown>): StaffConfirmation | null => {
  const passkey = body['passkey'];
  if (passkey !== undefined && passkey !== null && typeof passkey === 'object') {
    return { kind: 'passkey', response: passkey as Record<string, unknown> };
  }
  const password = body['password'];
  if (typeof password === 'string' && password !== '') {
    return { kind: 'password', password };
  }
  return null;
};

const NEEDS_CONFIRMATION = () =>
  refused(
    'This change needs a confirmation: your password, or an assertion from a key you already hold. A live session is not enough - a key added from a stolen session is a key the thief holds and you never hear about.',
    'ADR-0024 with ADR-0059 - a credential change confirms itself',
  );

export const registerStaffKeyRoutes = (context: StaffKeysRouteContext): void => {
  const {
    app,
    tenantId,
    rp,
    now,
    requireStaff,
    asyncRoute,
    param,
    jsonBody,
    rateLimited,
    setSessionCookie,
  } = context;

  // --- signing in with a key ----------------------------------------------

  /**
   * Options for a passkey sign-in.
   *
   * Takes nothing. Names nobody. Reveals nothing.
   */
  app.post(
    '/api/console/sign-in/passkey/options',
    rateLimited('Too many sign-in attempts from this address. Try again shortly.'),
    asyncRoute(async (_req, res) => {
      send(res, await beginStaffPasskeySignIn({ tenantId, rp, now: now() }));
    }),
  );

  /**
   * Sign in with a key and nothing else.
   *
   * The origin the assertion was produced at is checked against `CONSOLE_ORIGIN`, which is the
   * property this whole path exists for: nothing a person can be persuaded to do at a proxy
   * produces a signature this route accepts.
   */
  app.post(
    '/api/console/sign-in/passkey',
    rateLimited('Too many sign-in attempts from this address. Try again shortly.'),
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as { response?: unknown };
      if (
        body.response === undefined ||
        body.response === null ||
        typeof body.response !== 'object'
      ) {
        // The same sentence a bad assertion gets. A message naming the missing field would tell a
        // caller what this endpoint wants, and this endpoint is reachable by anybody.
        send(
          res,
          refused(
            'Those details are not valid.',
            'Blueprint 11.1 - identity and access; failures are indistinguishable by design',
          ),
        );
        return;
      }

      const outcome = await completeStaffPasskeySignIn({
        tenantId,
        response: body.response as Record<string, unknown>,
        rp,
        now: now(),
      });
      if (outcome.status !== 'ok') {
        send(res, outcome);
        return;
      }

      setSessionCookie(res, outcome.value.token, new Date(outcome.value.expiresAt));
      // The token is NOT in the body, for the reason the password path gives: it is in an httpOnly
      // cookie precisely so script cannot read it.
      send(
        res,
        ok({
          actorId: outcome.value.actor.id,
          label: outcome.value.actor.label,
          authorityLevel: outcome.value.actor.authorityLevel,
          department: outcome.value.actor.department,
          expiresAt: outcome.value.expiresAt,
          method: 'passkey',
        }),
      );
    }),
  );

  // --- managing keys, behind the session ----------------------------------

  app.get(
    '/api/console/security',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const posture = await staffSecurityPosture(tenantId, actor.id);
      send(
        res,
        ok({
          keys: posture.keys,
          keyTotal: posture.keyTotal,
          passwordSignInEnabled: posture.passwordSignInEnabled,
          passwordSignInDisabledAt: posture.passwordSignInDisabledAt,
          keysNeededToDisablePassword: posture.keysNeededToDisablePassword,
          keysRequiredToDisablePassword: STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD,
          /**
           * The one honest summary, computed by the module.
           *
           * Registering keys does not make an account phishing resistant while a password still
           * signs it in. A page that showed "2 keys registered" as a finished state would be telling
           * an operator they hold a property they do not.
           */
          phishingResistant: posture.phishingResistant,
          posture: posture.phishingResistant
            ? 'Phishing resistant: this account signs in with a security key only.'
            : posture.keyTotal === 0
              ? 'Not phishing resistant: this account signs in with a password and a code, which a proxy can collect together.'
              : `Not phishing resistant yet: ${posture.keyTotal} key(s) registered, and a password and a code still sign this account in. A key beside a live password is never the thing a proxy asks for.`,
        }),
      );
    }),
  );

  app.post(
    '/api/console/security/keys/registration',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      send(res, await beginStaffKeyRegistration({ tenantId, actorId: actor.id, rp, now: now() }));
    }),
  );

  app.post(
    '/api/console/security/keys',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const body = req.body as Record<string, unknown>;
      const confirmation = confirmationFrom(body);
      if (confirmation === null) {
        send(res, NEEDS_CONFIRMATION());
        return;
      }
      if (typeof body['label'] !== 'string' || body['response'] === undefined) {
        send(res, refused('label and response are both required.', 'Input validation'));
        return;
      }

      send(
        res,
        await completeStaffKeyRegistration({
          tenantId,
          actorId: actor.id,
          confirmation,
          label: body['label'],
          response: body['response'] as Record<string, unknown>,
          rp,
          now: now(),
        }),
      );
    }),
  );

  /** Options for proving a key you already hold, to authorise a change. */
  app.post(
    '/api/console/security/reauthentication',
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;
      send(res, await beginStaffReauthentication({ tenantId, actorId: actor.id, rp, now: now() }));
    }),
  );

  app.post(
    '/api/console/security/keys/:keyId/removal',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const confirmation = confirmationFrom(req.body as Record<string, unknown>);
      if (confirmation === null) {
        send(res, NEEDS_CONFIRMATION());
        return;
      }

      send(
        res,
        await removeStaffKey({
          tenantId,
          actorId: actor.id,
          keyId: param(req, 'keyId'),
          confirmation,
          rp,
          now: now(),
        }),
      );
    }),
  );

  // --- the switch ---------------------------------------------------------

  /**
   * Stop accepting a password and a code.
   *
   * The module requires two keys and an assertion; this route requires a session and passes them
   * through. It deliberately does not pre-check the key count - a transport that decided when the
   * switch was safe would be a second copy of the rule, and the two would drift.
   */
  app.post(
    '/api/console/security/password-sign-in/disable',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const confirmation = confirmationFrom(req.body as Record<string, unknown>);
      if (confirmation === null) {
        send(res, NEEDS_CONFIRMATION());
        return;
      }

      send(
        res,
        await disableStaffPasswordSignIn({
          tenantId,
          actorId: actor.id,
          confirmation,
          rp,
          now: now(),
        }),
      );
    }),
  );

  /**
   * Put password sign-in back for a colleague who lost their keys.
   *
   * **Somebody else's account, always.** The subject cannot reach this route: if they still hold a
   * key they do not need it, and if they do not they cannot sign in to call it. The module refuses a
   * self-restore for that reason and this route does not second-guess it.
   */
  app.post(
    '/api/console/security/password-sign-in/restore',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const body = req.body as { actorId?: unknown; verificationBasis?: unknown };
      if (typeof body.actorId !== 'string' || typeof body.verificationBasis !== 'string') {
        send(
          res,
          refused(
            'actorId and verificationBasis are both required. The basis is how you satisfied yourself that the person asking is who they say.',
            'ADR-0059 - a named human and a recorded basis',
          ),
        );
        return;
      }

      send(
        res,
        await restoreStaffPasswordSignIn({
          tenantId,
          actorId: body.actorId,
          restoredBy: actor.id,
          verificationBasis: body.verificationBasis,
          now: now(),
        }),
      );
    }),
  );
};
