/**
 * Changing a password you still know - 11.1 Identity & Access, for the 11.10 Client Portal.
 *
 * Named as out of scope three slices running, because it is a different act from reset with a
 * different threat model. Without it, a client who simply wants a different password has to pretend
 * they have forgotten the one they have - which routes routine hygiene through the recovery path,
 * and teaches people that "I want a new password" and "I have lost access" are the same request.
 * They are not, and their consequences are not.
 *
 * **A credential change needs a credential** (ADR-0024). The current password is definitional; a
 * current code is required wherever a factor is enrolled, because an attacker holding a session and
 * a shoulder-surfed password is exactly the case a second factor exists for.
 *
 * **Every OTHER session ends; this one survives.** Reset revokes everything because the requester
 * might be anybody. Here they have proved a live session, the current password, and a code where one
 * exists - and signing them out of the action they just took teaches people to avoid the button.
 * The two paths differ because they know different things about who is asking.
 *
 * @see docs/adr/0026-a-change-is-not-a-reset.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import { checkPassword, hashPassword, verifyPassword } from './credentials.js';
import { activeFactorFor, verifySecondFactor } from './mfa.js';
import { supersedeOutstanding } from './passwordReset.js';

export interface PasswordChanged {
  readonly clientUserId: string;
  /**
   * How many other sessions were ended. Surfaced because it is the client's own answer to "was
   * anybody else signed in as me", and a number nobody sees is a number nobody acts on.
   */
  readonly otherSessionsRevoked: number;
  /** True when a reset the client had asked for was spent by this change. */
  readonly outstandingResetSpent: boolean;
}

/**
 * Change the password on a signed-in account.
 *
 * `sessionId` is the caller's own session, resolved from their cookie rather than supplied as a
 * value - the portal wrapper passes what `principalFromToken` returned. It is the one session that
 * survives, so accepting it from a caller who could name any session would let them keep somebody
 * else's alive.
 */
export const changeClientPassword = async (input: {
  tenantId: string;
  clientUserId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  /** A TOTP or recovery code. Required only where a factor is enrolled. */
  code?: string;
  now?: Date;
}): Promise<Outcome<PasswordChanged>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  // Re-checked rather than trusted from the session that got here: a session resolves against
  // standing on every request, and this is a request.
  if (user.enrolledAt === null || user.disabledAt !== null) {
    return refused(
      'This account cannot change its password.',
      'Blueprint 11.1 - identity and access',
    );
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    return refused(
      'That is not your current password.',
      'Blueprint 11.1 - a credential change needs a credential',
    );
  }

  const strength = checkPassword(input.newPassword);
  if (!strength.acceptable) {
    return refused(strength.detail, 'Blueprint 11.1 - identity and access');
  }

  // Same rule as the reset path: setting the current password back accomplishes nothing while
  // looking like it accomplished something.
  if (input.newPassword === input.currentPassword) {
    return refused(
      'That is the password this account already has. A change exists to change it.',
      'Blueprint 11.1 - identity and access',
    );
  }

  // Where a factor is enrolled it is one of the credentials this account has, so a change needs it.
  // Where none is, there is no code to ask for and asking would be a refusal nobody can satisfy.
  if ((await activeFactorFor(input.tenantId, user.id)) !== null) {
    const presented = await verifySecondFactor({
      tenantId: input.tenantId,
      clientUserId: user.id,
      code: input.code ?? '',
      now,
    });
    if (presented.status !== 'ok') return presented as Outcome<never>;
  }

  const passwordHash = await hashPassword(input.newPassword);

  const { otherSessionsRevoked, outstandingResetSpent } = await db().$transaction(async (tx) => {
    const outstanding = await tx.clientPasswordReset.count({
      where: { clientUserId: user.id, consumedAt: null, supersededAt: null },
    });

    // THE INTERACTION NOTHING ELSE WOULD CATCH. A client who asked for a reset and then changed
    // their password from the portal instead would otherwise leave a live token in an inbox, and
    // that token sets a password of the holder's choosing over the one just chosen.
    await supersedeOutstanding(tx, user.id, now);

    const revoked = await tx.clientSession.updateMany({
      where: { clientUserId: user.id, revokedAt: null, id: { not: input.sessionId } },
      data: { revokedAt: now },
    });

    await tx.clientUser.update({
      where: { id: user.id },
      // The lock clears for the same reason it clears on a reset: the password being guessed no
      // longer exists.
      data: { passwordHash, failedAttempts: 0, lockedUntil: null },
    });

    return { otherSessionsRevoked: revoked.count, outstandingResetSpent: outstanding > 0 };
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_changed',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, otherSessionsRevoked, outstandingResetSpent },
  });

  return ok({ clientUserId: user.id, otherSessionsRevoked, outstandingResetSpent });
};
