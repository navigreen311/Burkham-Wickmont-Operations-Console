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
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import { hashToken, newToken } from './credentials.js';

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
    orderBy: { issuedAt: 'desc' },
  });

  return rows
    .filter((row) => now.getTime() <= row.lastSeenAt.getTime() + SESSION_IDLE_MINUTES * 60 * 1000)
    .map((row) => ({
      sessionId: row.id,
      issuedAt: row.issuedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
};
