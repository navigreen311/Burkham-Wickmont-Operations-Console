/**
 * Moving the address a client's account lives at - 11.1 Identity & Access, for the 11.10 Client
 * Portal.
 *
 * **The strongest of the three credential operations, and the reason is one sentence: the email
 * address is where a reset link goes.**
 *
 * Changing a password changes what an attacker must know. Changing this changes where recovery
 * GOES, and that is permanent - an attacker who moves it keeps the account after the real client
 * resets their password, because the reset arrives in the attacker's inbox.
 *
 * Three consequences, each of which could reasonably have gone the other way:
 *
 * **The address moves when the new one answers, not when the request is made.** A change to an
 * unreachable address moves recovery to a mailbox nobody reads - not a typo, a lockout the client
 * discovers on the day they need to get back in.
 *
 * **A staff-assisted change is a different fact and the column says so.** A token read to a client
 * over the phone proves the PERSON and proves nothing about the address, which is the whole point
 * of the token.
 *
 * **This revokes nothing.** Sessions and outstanding resets both survive - see `completeEmailChange`.
 *
 * @see docs/adr/0027-the-address-is-where-recovery-goes.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, notBuilt, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findActor } from './index.js';
import { hashToken, newToken } from './credentials.js';
import { confirmIdentity, type Confirmation } from './confirmation.js';
import type { RelyingParty } from './webauthn.js';
import { hasActiveFactor, verifySecondFactor } from './mfa.js';

/** How long a verification token is good for. Same reasoning as a reset: minutes, not days. */
export const EMAIL_CHANGE_MINUTES = 60;

/** Changing an address on a client's behalf is a Level 3 human decision. */
export const EMAIL_CHANGE_AUTHORITY_LEVEL = 3;

const MINIMUM_VERIFICATION_BASIS = 10;

export interface EmailChangeAcknowledgement {
  readonly acknowledged: true;
  readonly detail: string;
}

export interface IssuedEmailChange {
  readonly changeId: string;
  /** Returned once. Only the hash is stored. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface CompletedEmailChange {
  readonly clientUserId: string;
  readonly previousEmail: string;
  readonly newEmail: string;
  /** Whether the old address could be told. Today it cannot, and that is the gap that matters. */
  readonly oldAddressNotified: boolean;
}

export interface PendingEmailChange {
  readonly id: string;
  readonly newEmail: string;
  readonly source: string;
  readonly expiresAt: string;
}

const normalise = (email: string): string => email.trim().toLowerCase();

const looksLikeEmail = (email: string): boolean => email.includes('@') && email.length >= 5;

/**
 * Deliver the verification token to the NEW address.
 *
 * The seam that makes the whole design work, because presenting a token that arrived there is what
 * proves the address is reachable. Persists nothing, logs nothing, returns nothing - the same
 * contract as `deliverPasswordResetLink`, for the same reason: this is a credential in transit and
 * 4.1's log is not where credentials go (ADR-0023).
 */
export type EmailChangeDelivery = (input: {
  readonly newEmail: string;
  readonly token: string;
  readonly expiresAt: Date;
}) => Promise<Outcome<never>>;

export const deliverEmailChangeVerification: EmailChangeDelivery = async (input) => {
  void input;
  return notBuilt(
    '11.5 Integration Layer - email provider',
    'A verification link cannot be delivered: no email provider is gated in. Until one is, an address can only be moved by the Concierge Desk, and the record will say the address was never proved reachable.',
  );
};

/**
 * Tell the OLD address that the account's address has moved.
 *
 * **The control that matters most here and the one that is missing.** The old address is the only
 * channel the legitimate owner still holds after a hijack, so a notification to it is how the hijack
 * is noticed at all. It reports `not_built`, and `completeEmailChange` carries that fact out to its
 * caller rather than swallowing it - a change that reported success while nobody was told would be
 * the most misleading answer available.
 */
export const notifyPreviousAddress = async (input: {
  readonly previousEmail: string;
  readonly newEmail: string;
}): Promise<Outcome<never>> => {
  void input;
  return notBuilt(
    '11.5 Integration Layer - email provider',
    'The previous address cannot be told that this account moved. That notification is how a client discovers an address change they did not make, so until a provider is gated in, a change should be confirmed with the client by another channel.',
  );
};

/**
 * Ask to move the address, from a signed-in session.
 *
 * Writes a PENDING row and changes nothing about the account. Takes the current password, and a code
 * where a factor is enrolled: a session is not a credential (ADR-0024), and this is a stronger act
 * than changing a password.
 */
export const requestEmailChange = async (input: {
  tenantId: string;
  clientUserId: string;
  newEmail: string;
  /** The password, or a passkey where the account has none. */
  confirmation: Confirmation;
  /** Needed to accept a passkey confirmation. */
  rp?: RelyingParty;
  code?: string;
  /**
   * Where the token goes.
   *
   * A seam rather than a hard call, for the reason PR #9 recorded: the defect that cost a CI run was
   * a KEK provider constructed inside the function that used it. A provider is injected here when
   * one is gated in, and a test can watch the one place the token legitimately travels to.
   */
  deliver?: EmailChangeDelivery;
  now?: Date;
}): Promise<Outcome<EmailChangeAcknowledgement>> => {
  const now = input.now ?? new Date();
  const newEmail = normalise(input.newEmail);

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.enrolledAt === null || user.disabledAt !== null) {
    return refused(
      'This account cannot change its address.',
      'Blueprint 11.1 - identity and access',
    );
  }

  if (!looksLikeEmail(newEmail)) {
    return refused('That does not look like an email address.', 'Blueprint 11.1 - user records');
  }
  if (newEmail === user.email) {
    return refused(
      'That is the address this account already uses.',
      'Blueprint 11.1 - user records',
    );
  }

  const confirmed = await confirmIdentity({
    tenantId: input.tenantId,
    clientUserId: user.id,
    confirmation: input.confirmation,
    ...(input.rp !== undefined ? { rp: input.rp } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  // **A passkey confirmation already IS the second factor.** It is possession and user verification
  // in one act (ADR-0029), so asking for a code on top would be asking the same category twice - and
  // for a key-only account it would be asking for something that does not exist, which is how a
  // client ends up unable to change their own address.
  if (
    confirmed.value.confirmedWith !== 'passkey' &&
    (await hasActiveFactor(input.tenantId, user.id))
  ) {
    const presented = await verifySecondFactor({
      tenantId: input.tenantId,
      clientUserId: user.id,
      code: input.code ?? '',
      now,
    });
    if (presented.status !== 'ok') return presented as Outcome<never>;
  }

  const taken = await addressTaken(input.tenantId, newEmail);
  if (taken) {
    // Deliberately does not say why. The caller is authenticated, but confirming that an address
    // belongs to somebody is still a fact about a third party this firm holds.
    return refused('That address cannot be used.', 'Blueprint 11.1 - user records');
  }

  const token = newToken();
  const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_MINUTES * 60 * 1000);

  await db().$transaction(async (tx) => {
    await tx.clientEmailChange.updateMany({
      where: { clientUserId: user.id, consumedAt: null, cancelledAt: null },
      data: { cancelledAt: now, cancelledReason: 'A newer request replaced it.' },
    });
    await tx.clientEmailChange.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: user.id,
        newEmail,
        tokenHash: await hashToken(token),
        source: 'self_service',
        requestedBy: null,
        requestedAt: now,
        expiresAt,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.email_change_requested',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    // The address is a business contact detail rather than a credential, and knowing which address
    // an account was asked to move to is the first thing an investigation wants.
    payload: { clientUserId: user.id, newEmail, source: 'self_service' },
  });

  const deliver = input.deliver ?? deliverEmailChangeVerification;
  const delivery = await deliver({ newEmail, token, expiresAt });
  const detail =
    'A verification link has been prepared for the new address. The address does not move until it is used.';

  return delivery.status === 'not_built'
    ? notBuilt(delivery.module, detail)
    : ok({ acknowledged: true, detail });
};

/**
 * Move a client's address on their behalf, from inside the Console.
 *
 * **This is not the same act as a staff-issued password reset, and the difference is the point.**
 * There, a token read to the client over the phone works because it proves the person. Here the
 * token's job is to prove the ADDRESS is reachable, and a human reading it out proves nothing about
 * that at all.
 *
 * So this route does not hand out a token. It moves the address on a Level 3 human's assertion, and
 * records `staff_assertion` against it - permanently, in a column, so that a later reviewer asking
 * how the recovery channel moved gets an answer rather than an inference.
 */
export const changeEmailForClient = async (input: {
  tenantId: string;
  clientUserId: string;
  newEmail: string;
  changedBy: string;
  verificationBasis: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<CompletedEmailChange>> => {
  const now = input.now ?? new Date();
  const newEmail = normalise(input.newEmail);

  if (input.verificationBasis.trim().length < MINIMUM_VERIFICATION_BASIS) {
    return refused(
      "Moving a client's address needs a record of how you verified who you were speaking to. This changes where their account recovery goes, so it is the strongest thing anybody can do to their account from outside it.",
      'Blueprint 11.1 - identity and access',
    );
  }
  if (!looksLikeEmail(newEmail)) {
    return refused('That does not look like an email address.', 'Blueprint 11.1 - user records');
  }

  const changer = await findActor(input.changedBy);
  if (
    !changer ||
    changer.kind !== 'human' ||
    changer.authorityLevel < EMAIL_CHANGE_AUTHORITY_LEVEL
  ) {
    return refused(
      `Moving a client's address requires a human at Authority Level ${EMAIL_CHANGE_AUTHORITY_LEVEL}. It changes where their account recovery goes.`,
      'Blueprint 2.1 with 11.1 - identity and access',
    );
  }

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (newEmail === user.email) {
    return refused(
      'That is the address this account already uses.',
      'Blueprint 11.1 - user records',
    );
  }
  if (await addressTaken(input.tenantId, newEmail)) {
    return refused('That address cannot be used.', 'Blueprint 11.1 - user records');
  }

  const previousEmail = user.email;

  await db().$transaction(async (tx) => {
    await tx.clientEmailChange.updateMany({
      where: { clientUserId: user.id, consumedAt: null, cancelledAt: null },
      data: {
        cancelledAt: now,
        cancelledReason: 'The address was moved by the Concierge Desk instead.',
      },
    });
    await tx.clientEmailChange.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: user.id,
        newEmail,
        previousEmail,
        // A token that is never delivered and never accepted. The row needs one because the column
        // is unique, and this records honestly that nothing was verified by email.
        tokenHash: await hashToken(newToken()),
        source: 'staff_assisted',
        verifiedBy: 'staff_assertion',
        requestedBy: input.changedBy,
        verificationBasis: input.verificationBasis.trim(),
        requestedAt: now,
        expiresAt: now,
        consumedAt: now,
      },
    });
    await tx.clientUser.update({ where: { id: user.id }, data: { email: newEmail } });
  });

  const notified = await notifyPreviousAddress({ previousEmail, newEmail });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.email_changed',
    actor: input.actor,
    clientId: user.clientId,
    payload: {
      clientUserId: user.id,
      previousEmail,
      newEmail,
      verifiedBy: 'staff_assertion',
      changedBy: input.changedBy,
      verificationBasis: input.verificationBasis.trim(),
      oldAddressNotified: notified.status === 'ok',
    },
  });

  return ok({
    clientUserId: user.id,
    previousEmail,
    newEmail,
    oldAddressNotified: notified.status === 'ok',
  });
};

/**
 * Present the token that arrived at the new address.
 *
 * **Nothing is revoked here, and that is deliberate rather than an omission.**
 *
 * Change-password revokes every other session because the caller knows the new password and the
 * other sessions do not. Nothing about authentication changes here, so revoking sessions would
 * remove the legitimate owner's access and leave an attacker - who is the one holding the session
 * doing the changing - exactly where they were. **It is a control that helps the wrong party.**
 *
 * The same reasoning leaves outstanding password resets alone: a reset in flight went to the OLD
 * address, which an attacker does not have, so it is the legitimate owner's way back.
 */
export const completeEmailChange = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<CompletedEmailChange>> => {
  const now = input.now ?? new Date();

  const generic = refused(
    'That verification link is not valid. Ask for a new one.',
    'Blueprint 11.1 - identity and access',
  );

  const tokenHash = await hashToken(input.token);
  const pending = await db().clientEmailChange.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
    include: { clientUser: true },
  });

  if (!pending) return generic;
  if (pending.consumedAt !== null) return generic;
  if (pending.cancelledAt !== null) return generic;
  if (pending.expiresAt.getTime() <= now.getTime()) return generic;

  const user = pending.clientUser;
  if (user.enrolledAt === null || user.disabledAt !== null) return generic;

  // Re-checked at completion, not only at request: an address free an hour ago may not be now, and
  // the column is unique, so the alternative is a database error the caller cannot read.
  if (await addressTaken(input.tenantId, pending.newEmail)) {
    return refused('That address cannot be used.', 'Blueprint 11.1 - user records');
  }

  const previousEmail = user.email;

  await db().$transaction(async (tx) => {
    await tx.clientEmailChange.update({
      where: { id: pending.id },
      data: { consumedAt: now, previousEmail, verifiedBy: 'email' },
    });
    await tx.clientUser.update({ where: { id: user.id }, data: { email: pending.newEmail } });
  });

  const notified = await notifyPreviousAddress({ previousEmail, newEmail: pending.newEmail });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.email_changed',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: {
      clientUserId: user.id,
      previousEmail,
      newEmail: pending.newEmail,
      verifiedBy: 'email',
      // Carried out rather than swallowed: a change recorded as done while nobody was told is the
      // most misleading answer available, and the old address is the only channel the legitimate
      // owner still holds after a hijack.
      oldAddressNotified: notified.status === 'ok',
    },
  });

  return ok({
    clientUserId: user.id,
    previousEmail,
    newEmail: pending.newEmail,
    oldAddressNotified: notified.status === 'ok',
  });
};

/**
 * Cancel every pending move for a user.
 *
 * **Called when a client recovers their account** - completing a password reset, or changing a
 * password. Without it: an attacker with a session requests a move to their own address, the client
 * notices something is wrong and resets their password, and the attacker then presents the
 * verification token and takes the recovery channel anyway - after the client believes they have
 * dealt with it.
 */
export const cancelPendingEmailChanges = async (input: {
  tenantId: string;
  clientUserId: string;
  reason: string;
  now: Date;
}): Promise<number> => {
  const cancelled = await db().clientEmailChange.updateMany({
    where: {
      tenantId: input.tenantId,
      clientUserId: input.clientUserId,
      consumedAt: null,
      cancelledAt: null,
    },
    data: { cancelledAt: input.now, cancelledReason: input.reason },
  });

  return cancelled.count;
};

/** Pending moves for a user. What an access review reads; carries no token material. */
export const pendingEmailChanges = async (
  tenantId: string,
  clientUserId: string,
  now: Date = new Date(),
): Promise<readonly PendingEmailChange[]> => {
  const rows = await db().clientEmailChange.findMany({
    where: {
      tenantId,
      clientUserId,
      consumedAt: null,
      cancelledAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { requestedAt: 'desc' },
  });

  return rows.map((row) => ({
    id: row.id,
    newEmail: row.newEmail,
    source: row.source,
    expiresAt: row.expiresAt.toISOString(),
  }));
};

/**
 * Every address this account has had, most recent first.
 *
 * The consumed rows are the history. `verifiedBy` is the column that matters: it says whether each
 * move was proved reachable or vouched for.
 */
export const emailHistory = async (
  tenantId: string,
  clientUserId: string,
): Promise<
  readonly {
    at: string;
    previousEmail: string | null;
    newEmail: string;
    verifiedBy: string | null;
  }[]
> => {
  const rows = await db().clientEmailChange.findMany({
    where: { tenantId, clientUserId, consumedAt: { not: null } },
    orderBy: { consumedAt: 'desc' },
  });

  return rows.map((row) => ({
    at: (row.consumedAt as Date).toISOString(),
    previousEmail: row.previousEmail,
    newEmail: row.newEmail,
    verifiedBy: row.verifiedBy,
  }));
};

/** Whether an address already belongs to a user in this tenant. */
const addressTaken = async (tenantId: string, email: string): Promise<boolean> =>
  (await db().clientUser.count({ where: { tenantId, email } })) > 0;
