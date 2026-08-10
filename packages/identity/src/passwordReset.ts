/**
 * Password reset for client users - 11.1 Identity & Access, for the 11.10 Client Portal.
 *
 * **This is the most dangerous endpoint in the system**, and the reason is worth stating plainly:
 * every other write path starts with somebody proving who they are, and this one starts with an
 * anonymous person typing an email address into a form. What it produces is a credential.
 *
 * Three properties hold it together, and each of them is a decision that could reasonably have gone
 * the other way.
 *
 * **A reset link is a credential in transit, so it does not go through 4.1.** `send` writes the
 * message body into `Communication.body` - a table staff read, and one 7.1 assembles into the
 * compliance evidence file. It also runs the middleware chain (so recovery would be gated on a
 * regulatory activation), the preference gate (so a client who opted out of email could never
 * recover their account) and the compliance scanner (which exists for marketing claims). Right for a
 * communication, wrong for account recovery. Delivery is `deliverPasswordResetLink` below.
 *
 * **Requesting a reset changes nothing about the account.** Not the password - otherwise anybody who
 * knows a client's email address ends their access by typing it into a form. Not the lockout -
 * clearing it reads as helpful and is a lockout bypass, because an attacker who has burned five
 * guesses would reset the counter and keep going.
 *
 * **Completing a reset ends every session.** The reason a person resets a password is often that
 * somebody else has it, and a reset that left sessions running would leave the attacker holding a
 * valid cookie for twelve hours while the client believed they had shut them out.
 *
 * @see docs/adr/0023-a-reset-link-is-a-credential-in-transit.md
 */

import { db, type Prisma } from '@bwc/db';
import { append } from '@bwc/ledger';
import { notBuilt, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findActor } from './index.js';
import { checkPassword, hashPassword, hashToken, newToken, verifyPassword } from './credentials.js';

/**
 * How long a reset token is good for.
 *
 * An hour, against the invitation's seventy-two. An invitation is expected to sit in an inbox until
 * somebody has time; a reset is used within minutes of being asked for, and every extra hour is an
 * hour a forwarded or intercepted email stays live.
 */
export const PASSWORD_RESET_MINUTES = 60;

/** Issuing a reset on a client's behalf is a Level 3 human decision, as inviting one is. */
export const RESET_AUTHORITY_LEVEL = 3;

/** Enough that somebody had to describe what they actually did. */
const MINIMUM_VERIFICATION_BASIS = 10;

export interface PasswordResetAcknowledgement {
  readonly acknowledged: true;
  readonly detail: string;
}

export interface IssuedPasswordReset {
  readonly clientUserId: string;
  /** Returned once. Only the hash is stored, so a caller who loses it must issue another. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface CompletedPasswordReset {
  readonly clientUserId: string;
  /**
   * How many live sessions were ended. Reported because it is the part a client cares about after
   * resetting a password they think somebody else had.
   */
  readonly sessionsRevoked: number;
}

/**
 * The one answer the self-service request gives.
 *
 * Identical for an enrolled user, an unenrolled one, a disabled one, a locked one and an address
 * that is not a user at all. Anything else makes the endpoint an oracle that tells an attacker
 * which addresses are clients of this firm, which is itself the disclosure.
 */
const ACKNOWLEDGEMENT =
  'If that address has a portal account, a reset link has been prepared for it.';

/**
 * Hand a reset link to the client.
 *
 * **The seam that must never persist, log or return the token.** It takes one, because a real
 * implementation needs one and a signature that hid that would be a lie about what this does.
 *
 * Named for the single thing it carries. A general `sendSecurityEmail` would be the door somebody
 * routes a newsletter through in eighteen months, and the newsletter would then bypass 4.1's
 * preference gate.
 */
export const deliverPasswordResetLink = async (input: {
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}): Promise<Outcome<never>> => {
  // Referenced so the signature is honest rather than decorative: these are the inputs a provider
  // would take, and the token is not written anywhere on the way past.
  void input;

  return notBuilt(
    '11.5 Integration Layer - email provider',
    'A reset link cannot be delivered: no email provider is gated in. Until one is, a client who cannot sign in is recovered through the Concierge Desk, which issues a reset against a recorded verification of who they are.',
  );
};

/**
 * Ask for a reset, unauthenticated.
 *
 * Returns the same value whatever the address turns out to be. Today that value is `not_built`,
 * because the link has nowhere to go - which is truthful, uniform, and exactly what this returns
 * once a provider is gated in, minus the `not_built`.
 *
 * The residual timing difference between a known and an unknown address is one row insert. Stated
 * rather than papered over: the lookup and the token derivation happen either way, and the real
 * defence is that the answer is identical and no email arrives.
 */
export const requestPasswordReset = async (input: {
  tenantId: string;
  email: string;
  now?: Date;
}): Promise<Outcome<PasswordResetAcknowledgement>> => {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const user = await db().clientUser.findFirst({ where: { tenantId: input.tenantId, email } });

  // Generated either way. It costs a few microseconds and keeps the two paths the same shape.
  const token = newToken();
  const tokenHash = await hashToken(token);

  // An unenrolled user is deliberately not a candidate: enrolment is what the invitation is for,
  // and a reset here would be a second enrolment path that bypasses the invitation's expiry. A
  // disabled one is not a candidate either. Neither is told so.
  const eligible = user !== null && user.enrolledAt !== null && user.disabledAt === null;

  if (!eligible) {
    return notBuilt('11.5 Integration Layer - email provider', ACKNOWLEDGEMENT);
  }

  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60 * 1000);

  await db().$transaction(async (tx) => {
    await supersedeOutstanding(tx, user.id, now);
    await tx.clientPasswordReset.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: user.id,
        tokenHash,
        source: 'self_service',
        // Null, not a service-account id. 6.4's reasoning: a name in the field a reviewer reads is
        // a fiction indistinguishable from a real approval.
        issuedBy: null,
        requestedAt: now,
        expiresAt,
      },
    });
  });

  // NOTHING about the account changes here. Not the password: an unauthenticated caller must not be
  // able to end a client's access by typing their address. Not `failedAttempts` or `lockedUntil`:
  // clearing a lock on an unauthenticated request is a lockout bypass, and it clears on completion
  // instead, where the caller has proved they hold the token.
  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_reset_requested',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    // No token, no hash. The hash is not a credential, but it is the thing a reset is looked up by,
    // and the Ledger is readable by more people than the identity schema.
    payload: { clientUserId: user.id, source: 'self_service', expiresAt: expiresAt.toISOString() },
  });

  const delivery = await deliverPasswordResetLink({ email, token, expiresAt });

  // The delivery seam's answer, with the uniform acknowledgement as the detail. A caller cannot
  // tell this apart from the branch above.
  return delivery.status === 'not_built'
    ? notBuilt(delivery.module, ACKNOWLEDGEMENT)
    : ok({ acknowledged: true, detail: ACKNOWLEDGEMENT });
};

/**
 * Issue a reset on a client's behalf, from inside the Console.
 *
 * The route that works today, because email is not gated in. Same shape as the invitation that
 * enrolled them: a Level 3 human, a token returned once, conveyed out of band.
 *
 * **A verification basis is required.** The attack on helpdesk password reset is social engineering,
 * not cryptography - somebody phones, sounds convincing, and leaves with an account. A field nobody
 * can leave blank is the only part of that a system can enforce, and it puts a name against the
 * judgement afterwards.
 *
 * **This does not expand what Level 3 can already do.** The same person can invite a client user at
 * an address they control onto any client's file. This makes an existing power auditable rather than
 * adding a new one - worth saying because the opposite reading is the intuitive one.
 */
export const issuePasswordReset = async (input: {
  tenantId: string;
  clientUserId: string;
  issuedBy: string;
  verificationBasis: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<IssuedPasswordReset>> => {
  const now = input.now ?? new Date();

  if (input.verificationBasis.trim().length < MINIMUM_VERIFICATION_BASIS) {
    return refused(
      "A reset issued on a client's behalf needs a record of how you verified who you were speaking to. The attack on this path is somebody phoning up and sounding convincing.",
      'Blueprint 11.1 - identity and access',
    );
  }

  const issuer = await findActor(input.issuedBy);
  if (!issuer || issuer.kind !== 'human' || issuer.authorityLevel < RESET_AUTHORITY_LEVEL) {
    return refused(
      `Issuing a password reset requires a human at Authority Level ${RESET_AUTHORITY_LEVEL}. It hands somebody the ability to set the password on a client's portal account.`,
      'Blueprint 2.1 with 11.1 - identity and access',
    );
  }

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) {
    return refused(
      'That client user cannot be sent a reset.',
      'Blueprint 11.1 - identity and access',
    );
  }
  if (user.enrolledAt === null) {
    return refused(
      'That client user has never enrolled. They need an invitation, which is a different act: a reset here would be a second enrolment path that bypasses the invitation window.',
      'Blueprint 11.1 - enrolment is by invitation',
    );
  }
  if (user.disabledAt !== null) {
    return refused(
      'That client user is disabled. Restoring access is a decision about whether they should have it, not a password problem.',
      'Blueprint 11.1 - access reviews',
    );
  }

  const token = newToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60 * 1000);

  await db().$transaction(async (tx) => {
    await supersedeOutstanding(tx, user.id, now);
    await tx.clientPasswordReset.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: user.id,
        tokenHash,
        source: 'staff_assisted',
        issuedBy: input.issuedBy,
        verificationBasis: input.verificationBasis.trim(),
        requestedAt: now,
        expiresAt,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_reset_issued',
    actor: input.actor,
    clientId: user.clientId,
    payload: {
      clientUserId: user.id,
      issuedBy: input.issuedBy,
      // The basis is in the event as well as the row. It is the part somebody would want to read
      // back when asking how an account was taken over, and the Ledger is the record that cannot
      // be edited afterwards.
      verificationBasis: input.verificationBasis.trim(),
      expiresAt: expiresAt.toISOString(),
    },
  });

  return ok({ clientUserId: user.id, token, expiresAt: expiresAt.toISOString() });
};

/**
 * Set a new password with a reset token.
 *
 * Every check that mattered at issue is made again here, because the gap between the two is exactly
 * where an account changes standing: a user disabled while the email sat in an inbox must not be
 * able to complete.
 *
 * **Every live session ends.** Including one held by whoever the client is resetting against.
 */
export const completePasswordReset = async (input: {
  tenantId: string;
  token: string;
  password: string;
  now?: Date;
}): Promise<Outcome<CompletedPasswordReset>> => {
  const now = input.now ?? new Date();

  const generic = refused(
    'That reset link is not valid. Ask for a new one.',
    'Blueprint 11.1 - identity and access',
  );

  const strength = checkPassword(input.password);
  if (!strength.acceptable) {
    return refused(strength.detail, 'Blueprint 11.1 - identity and access');
  }

  const tokenHash = await hashToken(input.token);
  const reset = await db().clientPasswordReset.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
    include: { clientUser: true },
  });

  // Consumed, superseded, expired and never-existed all answer the same way. Distinguishing them
  // would confirm that a token was once real, which is what somebody holding a stale one wants to
  // know.
  if (!reset) return generic;
  if (reset.consumedAt !== null) return generic;
  if (reset.supersededAt !== null) return generic;
  if (reset.expiresAt.getTime() <= now.getTime()) return generic;

  const user = reset.clientUser;
  if (user.enrolledAt === null || user.disabledAt !== null) return generic;

  // The reason to reset a password is often that somebody else has it, and setting the same one
  // back accomplishes nothing while looking like it accomplished something. Costs one verification
  // on a path that is already hashing.
  if (await verifyPassword(input.password, user.passwordHash)) {
    return refused(
      'That is the password this account already has. A reset exists to change it.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const passwordHash = await hashPassword(input.password);

  const sessionsRevoked = await db().$transaction(async (tx) => {
    await tx.clientPasswordReset.update({
      where: { id: reset.id },
      data: { consumedAt: now },
    });
    // Any other outstanding reset dies with it. A second live token after a password change is a
    // second way in that the client does not know about.
    await supersedeOutstanding(tx, user.id, now);

    const revoked = await tx.clientSession.updateMany({
      where: { clientUserId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });

    await tx.clientUser.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // Cleared HERE and not at request. The password being guessed no longer exists, so keeping
        // the lock would punish the client for the attacker's behaviour - but clearing it on an
        // unauthenticated request would hand the attacker a way to keep guessing.
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    return revoked.count;
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.password_reset_completed',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, source: reset.source, sessionsRevoked },
  });

  return ok({ clientUserId: user.id, sessionsRevoked });
};

/** Outstanding resets for a user, for an access review. Carries no token material. */
export const pendingPasswordResets = async (
  tenantId: string,
  clientUserId: string,
  now: Date = new Date(),
): Promise<
  readonly { id: string; source: string; issuedBy: string | null; expiresAt: string }[]
> => {
  const rows = await db().clientPasswordReset.findMany({
    where: {
      tenantId,
      clientUserId,
      consumedAt: null,
      supersededAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { requestedAt: 'desc' },
  });

  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    issuedBy: row.issuedBy,
    expiresAt: row.expiresAt.toISOString(),
  }));
};

/**
 * Spend every outstanding reset for a user.
 *
 * Called before issuing, again on completion, and by the password-change path - **exported for that
 * third caller**, because a client who requested a reset and then changed their password from the
 * portal instead would otherwise leave a live token in an inbox that sets a password of the
 * holder's choosing over the one they just chose.
 *
 * One live token at a time: two would mean revoking one and leaving the other, which is the same
 * mistake `inviteClientUser` avoids.
 */
export const supersedeOutstanding = async (
  tx: Prisma.TransactionClient,
  clientUserId: string,
  now: Date,
): Promise<void> => {
  await tx.clientPasswordReset.updateMany({
    where: { clientUserId, consumedAt: null, supersededAt: null },
    data: { supersededAt: now },
  });
};
