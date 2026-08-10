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

import {
  resolveSession,
  activeFactorFor,
  answerMfaChallenge,
  authenticateClientUser,
  beginMfaChallenge,
  completePasswordReset,
  issueSession,
  requestPasswordReset,
  revokeSession,
  type CompletedPasswordReset,
  type PasswordResetAcknowledgement,
} from '@bwc/identity';
import { ok, type Outcome } from '@bwc/core';
import type { ClientPrincipal } from './views.js';

export interface SessionIssued {
  readonly kind: 'session';
  readonly token: string;
  readonly expiresAt: string;
  readonly displayName: string;
}

export interface MfaRequired {
  readonly kind: 'mfa_required';
  /** A CHALLENGE token. Not a session token, and `principalFromToken` will not resolve it. */
  readonly challengeToken: string;
  readonly expiresAt: string;
}

/**
 * What a correct password gets you.
 *
 * A union rather than a `mfaSatisfied` field, so **every call site is a compile error until it
 * handles the second factor**. A boolean would have let the transport keep working and quietly
 * treat a half-authenticated caller as signed in, which is precisely the bug the design is
 * avoiding.
 */
export type SignInResult = SessionIssued | MfaRequired;

/**
 * Sign in.
 *
 * Authenticate, then either open a challenge or issue a session. **A session is never issued to a
 * caller who still owes a second factor** - not marked unsatisfied, not issued at all - so there is
 * no route that has to remember to check.
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

  if ((await activeFactorFor(input.tenantId, authenticated.value.clientUserId)) !== null) {
    const challenge = await beginMfaChallenge({
      tenantId: input.tenantId,
      clientUserId: authenticated.value.clientUserId,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (challenge.status !== 'ok') return challenge as Outcome<never>;

    return ok({
      kind: 'mfa_required',
      challengeToken: challenge.value.token,
      expiresAt: challenge.value.expiresAt,
    });
  }

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
    kind: 'session',
    token: session.value.token,
    expiresAt: session.value.expiresAt,
    displayName: principal.value.displayName,
  });
};

/**
 * Answer the challenge, and only then get a session.
 *
 * The second half of sign-in. `answerMfaChallenge` refuses a spent time step, so a code observed
 * inside its thirty-second window cannot be replayed here.
 */
export const completeSignInMfa = async (input: {
  tenantId: string;
  challengeToken: string;
  code: string;
  now?: Date;
}): Promise<
  Outcome<SessionIssued & { usedRecoveryCode: boolean; recoveryCodesRemaining: number }>
> => {
  const answered = await answerMfaChallenge({
    tenantId: input.tenantId,
    token: input.challengeToken,
    code: input.code,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (answered.status !== 'ok') return answered as Outcome<never>;

  const session = await issueSession({
    tenantId: input.tenantId,
    clientUserId: answered.value.clientUserId,
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
    kind: 'session',
    token: session.value.token,
    expiresAt: session.value.expiresAt,
    displayName: principal.value.displayName,
    usedRecoveryCode: answered.value.usedRecoveryCode,
    recoveryCodesRemaining: answered.value.recoveryCodesRemaining,
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
    sessionId: resolved.value.sessionId,
  });
};

/**
 * Ask for a password reset.
 *
 * Passed through to 11.1 untouched, and the pass-through is the design. The value of this endpoint
 * is that it says the same thing to every address, and the way that property dies is somebody in a
 * transport or wrapper layer adding a helpful distinction - "we couldn't find that address" - which
 * turns it into a list of who banks with us.
 *
 * There is deliberately no signed-in variant here. A client who knows their password and wants a new
 * one is doing something else: that needs the current password, not a token mailed to an inbox that
 * may itself be the thing that was compromised.
 */
export const requestReset = async (input: {
  tenantId: string;
  email: string;
  now?: Date;
}): Promise<Outcome<PasswordResetAcknowledgement>> => requestPasswordReset(input);

/**
 * Set a new password with a reset token.
 *
 * Every live session ends here, including the one held by whoever the client is resetting against.
 */
export const completeReset = async (input: {
  tenantId: string;
  token: string;
  password: string;
  now?: Date;
}): Promise<Outcome<CompletedPasswordReset>> => completePasswordReset(input);

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
