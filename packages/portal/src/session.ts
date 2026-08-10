/**
 * Signing in to the Client Portal - the gap 11.10 shipped with.
 *
 * `clientRoom`, `uploadDocument`, `signDisclosure` and `sendMessage` all take a `ClientPrincipal`.
 * Until now, whoever called them decided which client they were. This is what turns a credential
 * into that principal.
 *
 * The portal still decides nothing: authentication, sessions and enrolment all live in
 * `@bwc/identity`, because **11.1 owns identity**. What is here is the two-line bridge between a
 * session token and the principal shape the portal's own functions already take - and the
 * `ClientPrincipal` interface is unchanged, so nothing else in 11.10 had to move.
 *
 * **`actorId` on the principal is the CLIENT USER's id, not an internal actor's.** That is the
 * whole point of ADR-0021: a client acts as themselves, and every event and access record they
 * generate is attributed to them rather than to a service account that would make a hundred
 * different people look like one.
 */

import { resolveSession, authenticateClientUser, issueSession, revokeSession } from '@bwc/identity';
import { ok, type Outcome } from '@bwc/core';
import type { ClientPrincipal } from './views.js';

export interface SignInResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly displayName: string;
}

/**
 * Sign in.
 *
 * Authenticate, then issue. Two steps rather than one because they fail for different reasons and
 * only the first is on an unauthenticated path - a caller that wanted to authenticate without
 * minting a session (a re-authentication prompt before a sensitive action) should not have to
 * create and discard one.
 *
 * The refusal from `authenticateClientUser` is passed through unchanged. It is deliberately the
 * same sentence for a wrong password, an unknown email, an unenrolled user and a disabled one;
 * rewording it here would undo that.
 */
export const signIn = async (input: {
  tenantId: string;
  email: string;
  password: string;
  now?: Date;
}): Promise<Outcome<SignInResult>> => {
  const authenticated = await authenticateClientUser(input);
  if (authenticated.status !== 'ok') return authenticated as Outcome<never>;

  const session = await issueSession({
    tenantId: input.tenantId,
    clientUserId: authenticated.value.clientUserId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (session.status !== 'ok') return session as Outcome<never>;

  const principal = await resolveSession({
    tenantId: input.tenantId,
    token: session.value.token,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (principal.status !== 'ok') return principal as Outcome<never>;

  return ok({
    token: session.value.token,
    expiresAt: session.value.expiresAt,
    displayName: principal.value.displayName,
  });
};

/**
 * Turn a session token into the principal every portal function takes.
 *
 * Called on **every** request. The session's expiries and the user's standing are both re-checked
 * by `resolveSession` each time, so a disabled account stops working on the next request rather
 * than when its session happens to lapse.
 */
export const principalFromToken = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<ClientPrincipal>> => {
  const resolved = await resolveSession(input);
  if (resolved.status !== 'ok') return resolved as Outcome<never>;

  return ok({
    tenantId: resolved.value.tenantId,
    clientId: resolved.value.clientId,
    // The client user's own id. Not a service account: a hundred clients sharing one actor id
    // would make every access record say the same thing.
    actorId: resolved.value.clientUserId,
  });
};

/** Sign out. */
export const signOut = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<{ sessionId: string }>> => {
  const resolved = await resolveSession(input);
  if (resolved.status !== 'ok') return resolved as Outcome<never>;

  return revokeSession({
    tenantId: input.tenantId,
    sessionId: resolved.value.sessionId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
};
