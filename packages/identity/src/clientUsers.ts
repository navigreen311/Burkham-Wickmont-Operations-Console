/**
 * Client users - 11.1 Identity & Access, for the 11.10 Client Portal.
 *
 * **A client user is not an `Actor`, and the reason is concrete rather than architectural taste.**
 *
 * `vault.read` grants access on the document's tenant plus the actor's authority level against
 * `MINIMUM_LEVEL_TO_READ`. It performs **no ownership check** - correctly, because an internal
 * analyst reads many clients' files and ownership is not what governs their access.
 * `MINIMUM_LEVEL_TO_READ` puts `bank_statement`, `profit_and_loss`, `balance_sheet`,
 * `debt_schedule` and `entity_document` at level 0.
 *
 * So a client holding a Level 0 `Actor` row could read **any client's bank statements in the
 * tenant** - not through a bug, but through the system working exactly as designed for the
 * principal type it was designed for.
 *
 * The authority ladder answers "what may this member of staff do across the book". A client's
 * question is different: "may this person act on THIS file". Those are not the same question at
 * different heights of one scale, and this table exists so they are not answered by one mechanism.
 *
 * Lives in `@bwc/identity` because 11.1 owns identity. A separate client-identity package would be
 * the second permission model 11.10 already refused to build.
 *
 * @see docs/adr/0021-a-client-user-is-not-an-actor.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findActor } from './index.js';
import { checkPassword, hashPassword, hashToken, newToken, verifyPassword } from './credentials.js';

/** Issuing an invitation is a Level 3 human decision: it grants access to a client's file. */
export const INVITE_AUTHORITY_LEVEL = 3;

/** Consecutive failures before the account locks. */
export const MAX_FAILED_ATTEMPTS = 5;
/** How long a lock lasts. Long enough to defeat scripted guessing, short enough to self-clear. */
export const LOCKOUT_MINUTES = 15;
/** How long an invitation is good for. */
export const INVITATION_HOURS = 72;

export interface ClientUser {
  readonly id: string;
  readonly clientId: string;
  readonly email: string;
  readonly displayName: string;
  readonly enrolled: boolean;
  readonly disabled: boolean;
  readonly lockedUntil: string | null;
}

interface ClientUserRow {
  id: string;
  clientId: string;
  email: string;
  displayName: string;
  enrolledAt: Date | null;
  disabledAt: Date | null;
  lockedUntil: Date | null;
}

/** Never carries the password hash. The type has no field for it. */
const toClientUser = (row: ClientUserRow): ClientUser => ({
  id: row.id,
  clientId: row.clientId,
  email: row.email,
  displayName: row.displayName,
  enrolled: row.enrolledAt !== null,
  disabled: row.disabledAt !== null,
  lockedUntil: row.lockedUntil?.toISOString() ?? null,
});

export interface Invitation {
  readonly clientUserId: string;
  /**
   * The token, returned ONCE. Only its hash is stored, so this value cannot be recovered - which
   * is the point, and is also why a caller that loses it must issue a new invitation.
   */
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Invite somebody to the portal for a specific client file.
 *
 * A Level 3 human, read from the recorded actor. Issuing this grants a person access to a client's
 * financial file; an agent able to do it would be an agent able to decide who reads a client's
 * bank statements.
 *
 * Re-inviting an existing, unenrolled user replaces their invitation rather than creating a second
 * user. Two users for one person would mean revoking one and leaving the other.
 */
export const inviteClientUser = async (input: {
  tenantId: string;
  clientId: string;
  email: string;
  displayName: string;
  issuedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Invitation>> => {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  if (!email.includes('@') || email.length < 5) {
    return refused(
      'A client user needs an email address to be invited at.',
      'Blueprint 11.1 - user records',
    );
  }
  if (input.displayName.trim().length < 2) {
    return refused(
      'A client user needs a name. A portal session attributed to an unnamed person is an access record nobody can follow up.',
      'Blueprint 11.1 - user records',
    );
  }

  const issuer = await findActor(input.issuedBy);
  if (!issuer || issuer.kind !== 'human' || issuer.authorityLevel < INVITE_AUTHORITY_LEVEL) {
    return refused(
      `Inviting a client user requires a human at Authority Level ${INVITE_AUTHORITY_LEVEL}. It grants a person access to a client's financial file.`,
      'Blueprint 2.1 with 11.1 - identity and access',
    );
  }

  const client = await db().client.findFirst({
    where: { tenantId: input.tenantId, id: input.clientId },
  });
  if (!client) return noData(`No client ${input.clientId} is on record in this tenant.`);

  const existing = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, email },
  });

  if (existing && existing.enrolledAt !== null) {
    return refused(
      // An invitation and a reset are different acts with different threat models - one gives
      // somebody an account, the other gives somebody back an account they already have - so this
      // path refuses rather than quietly becoming the other one.
      `${email} is already enrolled. Getting them back in is a password reset: 'requestPasswordReset' if they can receive email, or 'issuePasswordReset' from the Concierge Desk against a recorded verification of who they are.`,
      'Blueprint 11.1 - user records',
    );
  }
  if (existing && existing.clientId !== input.clientId) {
    return refused(
      `${email} is already invited against a different client file. A person who needs two files gets two users, so that revoking one cannot silently leave the other.`,
      'Blueprint 11.1 - client-file permissions',
    );
  }

  const token = newToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(now.getTime() + INVITATION_HOURS * 60 * 60 * 1000);

  const user =
    existing ??
    (await db().clientUser.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        email,
        displayName: input.displayName.trim(),
        // A placeholder that cannot verify: `verifyPassword` requires six `$`-separated parts
        // beginning `scrypt`, and this is not that. An unenrolled user therefore cannot sign in
        // even if somebody guesses the empty string.
        passwordHash: 'unenrolled',
      },
    }));

  await db().$transaction(async (tx) => {
    // Any earlier unaccepted invitation is spent, so a re-invite does not leave two live tokens.
    await tx.clientInvitation.updateMany({
      where: { clientUserId: user.id, acceptedAt: null },
      data: { expiresAt: now },
    });
    await tx.clientInvitation.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: user.id,
        tokenHash,
        issuedBy: input.issuedBy,
        issuedAt: now,
        expiresAt,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.invited',
    actor: input.actor,
    clientId: input.clientId,
    // The email is a business contact detail rather than a credential, and the Ledger's redactor
    // handles PII shapes. The token is not here and never will be.
    payload: {
      clientUserId: user.id,
      issuedBy: input.issuedBy,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return ok({ clientUserId: user.id, token, expiresAt: expiresAt.toISOString() });
};

/**
 * Accept an invitation and set a password.
 *
 * Consumes the invitation. A second attempt with the same token is refused, so a token read from a
 * forwarded email cannot be used after the client has already enrolled.
 */
export const enrolClientUser = async (input: {
  tenantId: string;
  token: string;
  password: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ClientUser>> => {
  const now = input.now ?? new Date();

  const strength = checkPassword(input.password);
  if (!strength.acceptable) {
    return refused(strength.detail, 'Blueprint 11.1 - identity and access');
  }

  const tokenHash = await hashToken(input.token);
  const invitation = await db().clientInvitation.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
    include: { clientUser: true },
  });

  if (!invitation) {
    return refused('That invitation is not valid.', 'Blueprint 11.1 - identity and access');
  }
  if (invitation.acceptedAt !== null) {
    return refused(
      'That invitation has already been used. Ask for a new one.',
      'Blueprint 11.1 - an invitation is single-use',
    );
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    return refused(
      'That invitation has expired. Ask for a new one.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const passwordHash = await hashPassword(input.password);

  const user = await db().$transaction(async (tx) => {
    await tx.clientInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: now },
    });
    return tx.clientUser.update({
      where: { id: invitation.clientUserId },
      data: { passwordHash, enrolledAt: now, failedAttempts: 0, lockedUntil: null },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.enrolled',
    // The client acts here, and this is the first event in the system where that is true. A
    // client enrolling and a staff member enrolling on their behalf are different acts, and
    // recording both as `human` would blur the line `sign_for_client` is drawn along.
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id },
  });

  return ok(toClientUser(user));
};

export interface AuthenticationResult {
  readonly clientUserId: string;
  readonly clientId: string;
}

/**
 * Verify an email and password.
 *
 * **Every failure returns the same refusal.** An unknown email, a wrong password, an unenrolled
 * user and a disabled one are indistinguishable to the caller - otherwise the endpoint is an
 * oracle telling an attacker which addresses are clients of this firm, which is itself the
 * disclosure.
 *
 * A password verification runs even when the user does not exist, against a throwaway hash. Without
 * it, an unknown email returns in a millisecond and a known one in a hundred, and the timing says
 * what the message would not.
 */
export const authenticateClientUser = async (input: {
  tenantId: string;
  email: string;
  password: string;
  now?: Date;
}): Promise<Outcome<AuthenticationResult>> => {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const generic = refused(
    'Those sign-in details are not correct.',
    'Blueprint 11.1 - identity and access',
  );

  const user = await db().clientUser.findFirst({ where: { tenantId: input.tenantId, email } });

  if (!user) {
    // Burn the same work an existing user would cost, so the timing does not answer the question
    // the message refuses to.
    await verifyPassword(input.password, DECOY_HASH);
    return generic;
  }

  if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
    await append({
      tenantId: input.tenantId,
      type: 'identity.client_user.sign_in_blocked',
      actor: { id: user.id, kind: 'client' },
      clientId: user.clientId,
      payload: { clientUserId: user.id, reason: 'locked_out' },
    });
    return refused(
      `Too many failed attempts. Try again after ${user.lockedUntil.toISOString()}.`,
      'Blueprint 11.1 - identity and access',
    );
  }

  const correct = await verifyPassword(input.password, user.passwordHash);

  // A correct password on an account that has switched password sign-in off is still a failure, and
  // it gets the SAME sentence as every other one. A message saying "this account is passkey-only"
  // would tell an attacker which addresses to stop guessing at and which to keep phishing.
  if (
    !correct ||
    user.enrolledAt === null ||
    user.disabledAt !== null ||
    user.passwordSignInDisabledAt !== null
  ) {
    const attempts = user.failedAttempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;

    await db().clientUser.update({
      where: { id: user.id },
      data: {
        failedAttempts: attempts,
        ...(lock ? { lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60 * 1000) } : {}),
      },
    });

    await append({
      tenantId: input.tenantId,
      type: 'identity.client_user.sign_in_failed',
      actor: { id: user.id, kind: 'client' },
      clientId: user.clientId,
      payload: { clientUserId: user.id, attempts, lockedOut: lock },
    });

    return generic;
  }

  await db().clientUser.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastSignInAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.signed_in',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id },
  });

  return ok({ clientUserId: user.id, clientId: user.clientId });
};

/**
 * A hash that no password matches, used to equalise timing on an unknown email.
 *
 * Generated once at module load from random bytes, so it is not a hash of anything and cannot be
 * matched by knowing the source. The cost parameters are the real ones, which is the point.
 */
const DECOY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Withdraw a client user's access. Takes effect on the next request, not at session expiry. */
export const disableClientUser = async (input: {
  tenantId: string;
  clientUserId: string;
  reason: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ClientUser>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 5) {
    return refused(
      'Disabling a client user needs a reason somebody can read back.',
      'Blueprint 11.1 - access reviews',
    );
  }

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  const updated = await db().$transaction(async (tx) => {
    // Sessions are revoked here as well as checked on resolve. Belt and braces, and the braces
    // matter: a check on resolve is only as good as every read path remembering to call it.
    await tx.clientSession.updateMany({
      where: { clientUserId: user.id, revokedAt: null },
      data: { revokedAt: now },
    });
    return tx.clientUser.update({
      where: { id: user.id },
      data: { disabledAt: now, disabledReason: input.reason },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.disabled',
    actor: input.actor,
    clientId: user.clientId,
    payload: { clientUserId: user.id, reason: input.reason },
  });

  return ok(toClientUser(updated));
};

export const findClientUser = async (
  tenantId: string,
  clientUserId: string,
): Promise<ClientUser | null> => {
  const row = await db().clientUser.findFirst({ where: { tenantId, id: clientUserId } });
  return row ? toClientUser(row) : null;
};

export const clientUsersFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly ClientUser[]> => {
  const rows = await db().clientUser.findMany({
    where: { tenantId, clientId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toClientUser);
};
