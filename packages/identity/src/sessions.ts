/**
 * Client sessions - 11.1 Identity & Access.
 *
 * Two expiries, both checked on every resolve:
 *
 *   ABSOLUTE  the session ends at this point however active it has been. A session that renewed
 *             itself forever would mean a credential stolen once is a credential held permanently.
 *   IDLE      the session ends if unused for this long. A laptop left open in a coffee shop is the
 *             case this covers, and it is the more common one.
 *
 * The token is 256 bits of `randomBytes`, returned once, and stored only as a SHA-256. A leaked
 * database yields session hashes, which are not session tokens.
 *
 * `resolveSession` re-reads the USER on every call rather than trusting what was true at sign-in.
 * Disabling an account otherwise takes effect whenever the session happens to expire, which is the
 * wrong answer to "revoke this person's access now".
 *
 * `issueSession` is also where a tenant's second-factor mandate is enforced (ADR-0046), because it
 * is the one place every route into a session passes through. It is deliberately NOT enforced on
 * `resolveSession`: turning the mandate on raises the bar for the next sign-in rather than ejecting
 * clients who are mid-session, and the exposure is bounded by SESSION_ABSOLUTE_HOURS.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import { hashToken, newToken } from './credentials.js';
import { hasActiveFactor } from './mfa.js';
import { clientMfaRequired } from './mfaPolicy.js';

/** A session ends this long after it was issued, active or not. */
export const SESSION_ABSOLUTE_HOURS = 12;
/** A session ends this long after it was last used. */
export const SESSION_IDLE_MINUTES = 30;

export interface IssuedSession {
  readonly sessionId: string;
  /** Returned once. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: string;
}

export const issueSession = async (input: {
  tenantId: string;
  clientUserId: string;
  now?: Date;
}): Promise<Outcome<IssuedSession>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.disabledAt !== null || user.enrolledAt === null) {
    return refused(
      'This client user cannot hold a session.',
      'Blueprint 11.1 - identity and access',
    );
  }

  // The tenant may require a second factor of every client user (ADR-0046). The check is HERE, at
  // the single point a full session is minted, rather than on the sign-in path, for two reasons.
  //
  // `authenticateClientUser` answers "are these the right details", and every one of its refusals
  // is deliberately the same sentence so the endpoint cannot be used to discover which addresses
  // are clients of this firm. A mandate refusal there would be a different sentence, on a correct
  // password, and would undo that.
  //
  // And it is not an argument the caller passes. ADR-0033: an option is a thing a caller can pass,
  // and the first caller who wants it out of the way will pass it. Every route into a session -
  // password, answered challenge, passkey - goes through this function, so there is no path that
  // has to remember to check.
  //
  // A passkey IS an active factor (`kind: 'webauthn'`), so a passwordless account is already
  // holding what the mandate asks for and is unaffected.
  if (await clientMfaRequired(input.tenantId)) {
    if (!(await hasActiveFactor(input.tenantId, user.id))) {
      // ADR-0033's rule: the gate must not block the act that clears it. Enrolment takes the
      // password and a code from the new authenticator, and neither `beginMfaEnrolment` nor
      // `confirmMfaEnrolment` needs a session - so the way out is open to exactly the person who
      // has just proved they own this account, and the refusal says so rather than leaving them
      // to guess.
      return refused(
        'This firm requires a second factor on every client sign-in, and this account does not have one yet. Enrol an authenticator or a security key first: that takes this password and a code from the new authenticator, and does not need a session.',
        'Blueprint 11.7 with ADR-0046 - client MFA required by tenant policy',
      );
    }
  }

  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000);

  const row = await db().clientSession.create({
    data: {
      tenantId: input.tenantId,
      clientUserId: user.id,
      tokenHash: await hashToken(token),
      issuedAt: now,
      expiresAt,
      lastSeenAt: now,
    },
  });

  return ok({ sessionId: row.id, token, expiresAt: expiresAt.toISOString() });
};

export interface ResolvedClientSession {
  readonly sessionId: string;
  readonly clientUserId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly displayName: string;
}

/**
 * Turn a session token into a principal.
 *
 * The function the portal depends on. Everything it checks is checked on THIS call:
 *
 *   the token matches a session      - by hash, so a leaked table is not a set of tokens
 *   the session is not revoked
 *   the session is inside both expiries
 *   the USER is still enrolled and not disabled
 *
 * The last is the one that would be tempting to skip, because it was true at sign-in. Skipping it
 * means disabling an account takes effect whenever the session happens to lapse, and "revoke this
 * person's access" is a request that means now.
 *
 * Every failure returns the same refusal. A caller cannot tell an expired session from a revoked
 * one from a token that never existed, which is what stops the endpoint confirming that a token
 * was once real.
 */
export const resolveSession = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<ResolvedClientSession>> => {
  const now = input.now ?? new Date();

  const generic = refused(
    'That session is not valid. Sign in again.',
    'Blueprint 11.1 - identity and access',
  );

  const tokenHash = await hashToken(input.token);
  const session = await db().clientSession.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
    include: { clientUser: true },
  });

  if (!session) return generic;
  if (session.revokedAt !== null) return generic;
  if (session.expiresAt.getTime() <= now.getTime()) return generic;

  const idleDeadline = session.lastSeenAt.getTime() + SESSION_IDLE_MINUTES * 60 * 1000;
  if (now.getTime() > idleDeadline) return generic;

  const user = session.clientUser;
  if (user.disabledAt !== null || user.enrolledAt === null) return generic;

  // Slide the idle window. Written on every resolve, which is the cost of having an idle window
  // at all - a session whose lastSeenAt only moved on some reads would expire while in use.
  await db().clientSession.update({
    where: { id: session.id },
    data: { lastSeenAt: now },
  });

  return ok({
    sessionId: session.id,
    clientUserId: user.id,
    tenantId: session.tenantId,
    clientId: user.clientId,
    displayName: user.displayName,
  });
};

/** End a session. Idempotent: signing out twice is not an error worth reporting. */
export const revokeSession = async (input: {
  tenantId: string;
  sessionId: string;
  now?: Date;
}): Promise<Outcome<{ sessionId: string }>> => {
  const now = input.now ?? new Date();

  const session = await db().clientSession.findFirst({
    where: { tenantId: input.tenantId, id: input.sessionId },
  });
  if (!session) return noData(`No session ${input.sessionId} is on record.`);

  if (session.revokedAt === null) {
    await db().clientSession.update({
      where: { id: session.id },
      data: { revokedAt: now },
    });

    await append({
      tenantId: input.tenantId,
      type: 'identity.client_session.revoked',
      actor: { id: session.clientUserId, kind: 'client' },
      payload: { sessionId: session.id },
    });
  }

  return ok({ sessionId: session.id });
};

/** Live sessions for a user. What an access review reads, and what a client sees as "signed in on". */
export const activeSessions = async (
  tenantId: string,
  clientUserId: string,
  now: Date = new Date(),
): Promise<readonly { sessionId: string; issuedAt: string; lastSeenAt: string }[]> => {
  const rows = await db().clientSession.findMany({
    where: { tenantId, clientUserId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
  });

  return rows
    .filter((row) => now.getTime() <= row.lastSeenAt.getTime() + SESSION_IDLE_MINUTES * 60 * 1000)
    .map((row) => ({
      sessionId: row.id,
      issuedAt: row.issuedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
};
