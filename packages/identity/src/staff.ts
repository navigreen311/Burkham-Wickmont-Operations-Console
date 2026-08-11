/**
 * Staff credentials and staff sessions - 11.1 Identity & Access, for the internal Console.
 *
 * Until this file existed the internal API answered "who is acting" by reading an `x-actor-id`
 * request header. Its own comment called that a development seam rather than authentication, and it
 * was right: an `Actor` row carries a tenant, an Authority Level and a department, and **nothing at
 * all that a person has to know or hold**. Anybody who could reach the port was any actor they
 * cared to name.
 *
 * That was survivable while the only caller was a test. It stops being survivable the moment there
 * is a page, because a page is an invitation to use it.
 *
 * ## Bound to the Actor, not beside it
 *
 * There is no `StaffUser` here. The credential hangs off the existing `Actor`, because the Actor is
 * already the thing the Ledger names in every event, the thing the middleware chain reads an
 * Authority Level from, and the thing a Do Not Fund override records as its approver. A parallel
 * staff identity would give sign-in and the audit trail two different answers to "who did this",
 * and keeping them in step would be somebody's job forever.
 *
 * **An Actor with no credential row cannot sign in.** Absence is not permission - the same
 * structural default as ADR-0007 (a provider the board never saw has no governance row) and
 * ADR-0009 (a state nobody activated is not active). Village agents have no row and are not meant
 * to have one: they act through the worker, which holds no session.
 *
 * ## The granter never holds the other person's credential
 *
 * The first version of this file had `beginStaffEnrolment`: the granter passed the subject's
 * password and received the subject's TOTP secret. **That hands one person both factors of somebody
 * else's account**, and nothing downstream can tell a session opened by the subject from one opened
 * by whoever enrolled them.
 *
 * It is replaced by the shape 11.1 already uses for clients: `inviteStaff` issues a single-use
 * token, and `enrolStaffFromInvitation` is where the SUBJECT sets their own password and receives
 * their own secret. The granter holds a token that can only be spent to set a credential, never to
 * use one - and one that expires and cannot be spent twice.
 *
 * **What that does not fix, stated plainly:** whoever holds an unspent token can spend it, and with
 * no email provider gated the token is handed back to the granter to pass on. Delivering it to the
 * subject is what closes the gap. See ADR-0036.
 *
 * ## A second factor is a precondition, not a setting
 *
 * A client's second factor is optional (11.10, ADR-0028): they may decide how much friction their
 * own file is worth. A staff member's is mandatory and there is no route that turns it off, because
 * a staff session opens **every** client file in the tenant. `enrolledAt` is null until a code from
 * the authenticator has verified, and an unenrolled credential cannot authenticate at all - it is
 * not an account that signs in with one factor.
 *
 * @see docs/adr/0032-a-console-is-what-makes-a-missing-credential-exploitable.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { EnvKekProvider, decryptField, encryptField, type KekProvider } from '@bwc/crypto';
import { noData, ok, refused, type AuthorityLevel, type Outcome } from '@bwc/core';
import { randomBytes } from 'node:crypto';
import { findActor, type Actor } from './index.js';
import { checkPassword, hashPassword, hashToken, newToken, verifyPassword } from './credentials.js';
import { MFA_ISSUER, MFA_SECRET_KEY_VARIABLE } from './mfa.js';
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from './totp.js';

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1. Same as a client factor. */
const SECRET_BYTES = 20;

/**
 * A staff session ends this long after it was issued, however active it has been.
 *
 * Shorter than a client's twelve hours, and the reason is not that staff are less trusted. It is
 * that a client session reaches one file and a staff session reaches all of them, so the same
 * stolen token is worth more here. Eight hours covers a working day and ends before the next one.
 */
export const STAFF_SESSION_ABSOLUTE_HOURS = 8;

/**
 * A staff session ends this long after it was last used.
 *
 * Fifteen minutes rather than the portal's thirty. The case this bounds is an unlocked screen in an
 * office - which is the ordinary way an internal console is used by somebody it was not issued to,
 * and far more common than a stolen token.
 */
export const STAFF_SESSION_IDLE_MINUTES = 15;

/** Consecutive failures before the credential locks. Matches the client figure; the reasoning is
 * the same and two numbers would invite drift. */
export const STAFF_MAX_FAILED_ATTEMPTS = 5;

/** How long a locked staff credential stays locked. */
export const STAFF_LOCKOUT_MINUTES = 15;

/** Enrolling somebody as staff is a Level 3 human decision. It grants sight of every client file. */
export const STAFF_ENROLMENT_AUTHORITY_LEVEL: AuthorityLevel = 3;

/**
 * How long a staff invitation lives.
 *
 * Shorter than the client's 72 hours. A client is invited into their own file and may take a few
 * days to get to it; a colleague being given sight of every file in the firm is starting on Monday,
 * and an unspent token is the one thing in this flow anybody else can use.
 */
export const STAFF_INVITATION_HOURS = 24;

const kek = (): KekProvider => new EnvKekProvider(MFA_SECRET_KEY_VARIABLE);

/** A stored hash that cannot verify. Written at invite, replaced when the subject enrols. */
const UNENROLLED = 'unenrolled';

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/**
 * The one refusal every sign-in failure returns.
 *
 * A wrong password, an unknown address, a disabled account, an unenrolled one and a locked one are
 * indistinguishable from outside. Anything more specific tells somebody enumerating addresses which
 * of them are staff.
 */
const SIGN_IN_REFUSAL = () =>
  refused(
    'Those details are not valid.',
    'Blueprint 11.1 - identity and access; failures are indistinguishable by design',
  );

export interface StaffInvitation {
  readonly actorId: string;
  readonly email: string;
  /** Returned once. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface StaffEnrolmentOffer {
  readonly actorId: string;
  readonly email: string;
  /** The TOTP secret, base32, shown once so it can be typed into an authenticator. */
  readonly secret: string;
  /** `otpauth://` URI for a QR code. Carries the same secret. */
  readonly uri: string;
}

/**
 * Invite an Actor to take up a Console credential.
 *
 * **No password crosses this call and no secret comes back.** The granter names who and at what
 * address; everything a session is opened with is chosen by the subject in
 * `enrolStaffFromInvitation`.
 *
 * Re-inviting somebody mid-enrolment is allowed and spends the earlier token, so a re-invite does
 * not leave two live ones. Inviting somebody already enrolled is REFUSED: getting a colleague back
 * in is a credential reset, which is a different act with a different threat model, and a path that
 * quietly became the other one is how an invitation ends up being a way to take over an account.
 */
export const inviteStaff = async (input: {
  tenantId: string;
  actorId: string;
  email: string;
  /** The Level 3 human granting internal access. */
  invitedBy: string;
  now?: Date;
}): Promise<Outcome<StaffInvitation>> => {
  const now = input.now ?? new Date();

  const actor = await findActor(input.actorId);
  if (!actor || actor.tenantId !== input.tenantId) {
    return noData(`No actor ${input.actorId} is on record for this tenant.`);
  }
  if (actor.kind !== 'human') {
    return refused(
      'Only a human actor can hold a Console credential. A Village agent acts through the worker, which holds no session.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const inviter = await findActor(input.invitedBy);
  if (!inviter || inviter.tenantId !== input.tenantId) {
    return noData(`No actor ${input.invitedBy} is on record for this tenant.`);
  }
  if (inviter.kind !== 'human' || inviter.authorityLevel < STAFF_ENROLMENT_AUTHORITY_LEVEL) {
    return refused(
      `Granting internal Console access requires a Level ${STAFF_ENROLMENT_AUTHORITY_LEVEL} human. It grants sight of every client file in the tenant.`,
      'Principle 4 - Authority Levels enforced by middleware',
    );
  }

  const email = normaliseEmail(input.email);
  if (email === '' || !email.includes('@')) {
    return refused('An email address is required to sign in.', 'Input validation');
  }

  const existing = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: actor.id },
  });
  if (existing && existing.enrolledAt !== null) {
    return refused(
      'That actor already holds a Console credential. Getting them back in is a credential reset, not an invitation - a path that quietly became the other one would be a way to take over an account that already exists.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const clash = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, email, NOT: { actorId: actor.id } },
  });
  if (clash) {
    return refused(
      'That address already belongs to another Console credential in this tenant.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const token = newToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(now.getTime() + STAFF_INVITATION_HOURS * 60 * 60 * 1000);

  await db().$transaction(async (tx) => {
    if (existing) {
      // A restarted enrolment. Any password or pending secret from a previous attempt is cleared,
      // because two live secrets for one account would both open it.
      await tx.actorCredential.update({
        where: { id: existing.id },
        data: {
          email,
          passwordHash: UNENROLLED,
          totpSecretCiphertext: null,
          totpLastUsedStep: null,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
    } else {
      await tx.actorCredential.create({
        data: {
          actorId: actor.id,
          tenantId: input.tenantId,
          email,
          // A placeholder that cannot verify: `verifyPassword` needs six `$`-separated parts
          // beginning `scrypt`, and this is not that. An invited actor cannot sign in even if
          // somebody guesses the empty string.
          passwordHash: UNENROLLED,
          createdAt: now,
        },
      });
    }

    // Any earlier unspent invitation is spent, so a re-invite does not leave two live tokens.
    await tx.actorInvitation.updateMany({
      where: { actorId: actor.id, acceptedAt: null },
      data: { expiresAt: now },
    });
    await tx.actorInvitation.create({
      data: {
        tenantId: input.tenantId,
        actorId: actor.id,
        tokenHash,
        issuedBy: inviter.id,
        issuedAt: now,
        expiresAt,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.invited',
    actor: { id: inviter.id, kind: 'human' },
    payload: {
      subjectActorId: actor.id,
      issuedBy: inviter.id,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return ok({ actorId: actor.id, email, token, expiresAt: expiresAt.toISOString() });
};

/**
 * Spend an invitation: set a password, and receive an authenticator secret.
 *
 * **The subject runs this, and it is the only place either factor is chosen.** The secret is
 * returned once and never again - losing it before `confirmStaffEnrolment` means asking for a fresh
 * invitation, which is deliberate: re-issuing a secret to whoever asks would be a way to replace a
 * colleague's second factor with your own.
 *
 * Enrolment is still not finished here. `enrolledAt` stays null until a code from the new
 * authenticator has verified, and an unenrolled credential cannot sign in at all.
 */
export const enrolStaffFromInvitation = async (input: {
  tenantId: string;
  token: string;
  password: string;
  now?: Date;
}): Promise<Outcome<StaffEnrolmentOffer>> => {
  const now = input.now ?? new Date();

  const strength = checkPassword(input.password);
  if (!strength.acceptable) {
    return refused(strength.detail, 'Blueprint 11.1 - credential quality');
  }

  const tokenHash = await hashToken(input.token);
  const invitation = await db().actorInvitation.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
  });

  // One sentence for a token that never existed, one already spent, and one expired - a caller
  // cannot learn from this which of the three it was.
  const generic = refused(
    'That invitation is not valid. Ask for a new one.',
    'Blueprint 11.1 - identity and access',
  );

  if (!invitation) return generic;
  if (invitation.acceptedAt !== null) return generic;
  if (invitation.expiresAt.getTime() <= now.getTime()) return generic;

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: invitation.actorId },
  });
  if (!credential) return generic;
  if (credential.enrolledAt !== null) return generic;
  if (credential.disabledAt !== null) return generic;

  const secret = base32Encode(randomBytes(SECRET_BYTES));
  const secretCiphertext = await encryptField(secret, kek());
  const passwordHash = await hashPassword(input.password);

  await db().$transaction(async (tx) => {
    await tx.actorInvitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: now },
    });
    await tx.actorCredential.update({
      where: { id: credential.id },
      data: {
        passwordHash,
        totpSecretCiphertext: secretCiphertext,
        totpLastUsedStep: null,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.enrolment_started',
    // The SUBJECT acts here, not the granter. Recording the granter would say somebody set a
    // password they never saw.
    actor: { id: invitation.actorId, kind: 'human' },
    payload: { actorId: invitation.actorId },
  });

  return ok({
    actorId: invitation.actorId,
    email: credential.email,
    secret,
    uri: otpauthUri({ issuer: MFA_ISSUER, account: credential.email, secretBase32: secret }),
  });
};

/**
 * Finish enrolment by proving the authenticator works.
 *
 * Takes the password as well as the code. The offer was handed to somebody; this call is what says
 * the person holding the authenticator is the person who was given the password, and without it a
 * pending enrolment intercepted in transit could be completed by whoever intercepted it.
 */
export const confirmStaffEnrolment = async (input: {
  tenantId: string;
  actorId: string;
  password: string;
  code: string;
  now?: Date;
}): Promise<Outcome<{ actorId: string; enrolledAt: string }>> => {
  const now = input.now ?? new Date();

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential) return noData('No pending Console enrolment for that actor.');
  if (credential.enrolledAt !== null) {
    return refused('That enrolment is already complete.', 'Blueprint 11.1 - identity and access');
  }
  if (!credential.totpSecretCiphertext) {
    return refused(
      'That enrolment has no authenticator secret. Start it again.',
      'Blueprint 11.1 - identity and access',
    );
  }

  if (!(await verifyPassword(input.password, credential.passwordHash))) return SIGN_IN_REFUSAL();

  const secret = base32Decode(await decryptField(credential.totpSecretCiphertext, kek()));
  if (!secret) {
    return refused(
      'That enrolment secret cannot be read. Start it again.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const verification = verifyTotp({ secret, code: input.code, at: now });
  if (!verification.valid) {
    return refused('That code is not valid.', 'Blueprint 11.1 - identity and access');
  }

  await db().actorCredential.update({
    where: { id: credential.id },
    data: { enrolledAt: now, totpLastUsedStep: verification.step },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.enrolled',
    actor: { id: input.actorId, kind: 'human' },
    payload: { actorId: input.actorId },
  });

  return ok({ actorId: input.actorId, enrolledAt: now.toISOString() });
};

export interface StaffAuthentication {
  readonly actor: Actor;
  readonly sessionId: string;
  /** Returned once. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Sign a staff member in.
 *
 * **One call takes both factors.** The portal splits them - a password produces an MFA challenge
 * with no principal attached, and a session is unreachable until a code verifies (ADR-0024) - and
 * that split exists because the portal has to hold a state between two HTTP requests. Here there is
 * no state to hold: the password and the code arrive together, so there is no half-authenticated
 * moment to model and nothing to accidentally treat as a session.
 *
 * Everything below is checked on every attempt, and every failure returns the same sentence:
 *
 *   the credential exists            - by (tenant, email)
 *   it is not disabled
 *   it is enrolled                   - a pending enrolment cannot sign in
 *   it is not locked out
 *   the password verifies
 *   the code verifies AND its step has not been spent
 *
 * The step check is what stops a code being replayed inside its own thirty seconds - by somebody
 * reading it over a shoulder, which on an internal console is the realistic case.
 */
export const authenticateStaff = async (input: {
  tenantId: string;
  email: string;
  password: string;
  code: string;
  now?: Date;
}): Promise<Outcome<StaffAuthentication>> => {
  const now = input.now ?? new Date();
  const email = normaliseEmail(input.email);

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, email },
  });
  if (!credential) return SIGN_IN_REFUSAL();
  if (credential.disabledAt !== null) return SIGN_IN_REFUSAL();
  if (credential.enrolledAt === null) return SIGN_IN_REFUSAL();
  if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > now.getTime()) {
    await append({
      tenantId: input.tenantId,
      type: 'identity.staff.sign_in_blocked',
      actor: { id: credential.actorId, kind: 'human' },
      payload: { reason: 'locked_out' },
    });
    return SIGN_IN_REFUSAL();
  }

  const recordFailure = async (reason: string): Promise<Outcome<StaffAuthentication>> => {
    const attempts = credential.failedAttempts + 1;
    const locked = attempts >= STAFF_MAX_FAILED_ATTEMPTS;
    await db().actorCredential.update({
      where: { id: credential.id },
      data: {
        failedAttempts: locked ? 0 : attempts,
        lockedUntil: locked
          ? new Date(now.getTime() + STAFF_LOCKOUT_MINUTES * 60 * 1000)
          : credential.lockedUntil,
      },
    });
    await append({
      tenantId: input.tenantId,
      type: 'identity.staff.sign_in_failed',
      actor: { id: credential.actorId, kind: 'human' },
      payload: { reason, locked },
    });
    return SIGN_IN_REFUSAL();
  };

  if (!(await verifyPassword(input.password, credential.passwordHash))) {
    return recordFailure('password');
  }

  if (!credential.totpSecretCiphertext) return recordFailure('no_factor');
  const secret = base32Decode(await decryptField(credential.totpSecretCiphertext, kek()));
  if (!secret) return recordFailure('unreadable_factor');

  const verification = verifyTotp({ secret, code: input.code, at: now });
  if (!verification.valid) return recordFailure('code');

  // A step at or below the last accepted one is a replay, even though the code itself is correct.
  if (
    credential.totpLastUsedStep !== null &&
    verification.step !== null &&
    verification.step <= credential.totpLastUsedStep
  ) {
    return recordFailure('code_replayed');
  }

  const actor = await findActor(credential.actorId);
  if (!actor) return SIGN_IN_REFUSAL();

  const token = newToken();
  const expiresAt = new Date(now.getTime() + STAFF_SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000);

  const session = await db().actorSession.create({
    data: {
      tenantId: input.tenantId,
      actorId: actor.id,
      tokenHash: await hashToken(token),
      issuedAt: now,
      expiresAt,
      lastSeenAt: now,
    },
  });

  await db().actorCredential.update({
    where: { id: credential.id },
    data: {
      failedAttempts: 0,
      lockedUntil: null,
      lastSignInAt: now,
      totpLastUsedStep: verification.step ?? credential.totpLastUsedStep,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.signed_in',
    actor: { id: actor.id, kind: 'human' },
    payload: { sessionId: session.id },
  });

  return ok({
    actor,
    sessionId: session.id,
    token,
    expiresAt: expiresAt.toISOString(),
  });
};

export interface ResolvedStaffSession {
  readonly sessionId: string;
  readonly actor: Actor;
}

/**
 * Turn a staff session token into an Actor.
 *
 * The function every Console route depends on, and it re-reads the CREDENTIAL as well as the
 * session. Disabling a staff account otherwise takes effect whenever their session happens to
 * lapse, and "revoke this person's access" is a request that means now - which on an internal
 * console is usually said about somebody who has just left.
 *
 * The Actor is re-read too, so an Authority Level lowered this morning is the level in force this
 * afternoon rather than the one that was true at sign-in.
 */
export const resolveStaffSession = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<ResolvedStaffSession>> => {
  const now = input.now ?? new Date();
  const generic = refused(
    'That session is not valid. Sign in again.',
    'Blueprint 11.1 - identity and access',
  );

  const tokenHash = await hashToken(input.token);
  const session = await db().actorSession.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
  });

  if (!session) return generic;
  if (session.revokedAt !== null) return generic;
  if (session.expiresAt.getTime() <= now.getTime()) return generic;
  if (now.getTime() > session.lastSeenAt.getTime() + STAFF_SESSION_IDLE_MINUTES * 60 * 1000) {
    return generic;
  }

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: session.actorId },
  });
  if (!credential) return generic;
  if (credential.disabledAt !== null) return generic;
  if (credential.enrolledAt === null) return generic;

  const actor = await findActor(session.actorId);
  if (!actor || actor.tenantId !== input.tenantId) return generic;

  await db().actorSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });

  return ok({ sessionId: session.id, actor });
};

/** End a staff session. Idempotent: signing out twice is not an error worth reporting. */
export const revokeStaffSession = async (input: {
  tenantId: string;
  sessionId: string;
  now?: Date;
}): Promise<Outcome<{ sessionId: string }>> => {
  const now = input.now ?? new Date();

  const session = await db().actorSession.findFirst({
    where: { tenantId: input.tenantId, id: input.sessionId },
  });
  if (!session) return noData(`No session ${input.sessionId} is on record.`);

  if (session.revokedAt === null) {
    await db().actorSession.update({ where: { id: session.id }, data: { revokedAt: now } });
    await append({
      tenantId: input.tenantId,
      type: 'identity.staff_session.revoked',
      actor: { id: session.actorId, kind: 'human' },
      payload: { sessionId: session.id },
    });
  }

  return ok({ sessionId: session.id });
};

/**
 * Withdraw a staff member's Console access.
 *
 * Revokes every live session in the same call rather than leaving them to expire. A disabled
 * credential already fails `resolveStaffSession`, so this is belt and braces - but the sessions are
 * also what an access review reads, and leaving them open would misreport who is signed in.
 */
export const disableStaffCredential = async (input: {
  tenantId: string;
  actorId: string;
  reason: string;
  disabledBy: string;
  now?: Date;
}): Promise<Outcome<{ actorId: string; sessionsRevoked: number }>> => {
  const now = input.now ?? new Date();

  const disabler = await findActor(input.disabledBy);
  if (!disabler || disabler.tenantId !== input.tenantId) {
    return noData(`No actor ${input.disabledBy} is on record for this tenant.`);
  }
  if (disabler.kind !== 'human' || disabler.authorityLevel < STAFF_ENROLMENT_AUTHORITY_LEVEL) {
    return refused(
      `Withdrawing Console access requires a Level ${STAFF_ENROLMENT_AUTHORITY_LEVEL} human.`,
      'Principle 4 - Authority Levels enforced by middleware',
    );
  }
  if (input.reason.trim() === '') {
    return refused(
      'A reason is required to withdraw Console access.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential) return noData('That actor holds no Console credential.');

  if (credential.disabledAt === null) {
    await db().actorCredential.update({
      where: { id: credential.id },
      data: { disabledAt: now, disabledReason: input.reason.trim() },
    });
  }

  const revoked = await db().actorSession.updateMany({
    where: { tenantId: input.tenantId, actorId: input.actorId, revokedAt: null },
    data: { revokedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.disabled',
    actor: { id: disabler.id, kind: 'human' },
    payload: { subjectActorId: input.actorId, sessionsRevoked: revoked.count },
  });

  return ok({ actorId: input.actorId, sessionsRevoked: revoked.count });
};

/** Live staff sessions. What an access review reads. Never a route's authorisation check. */
export const activeStaffSessions = async (
  tenantId: string,
  actorId: string,
  now: Date = new Date(),
): Promise<readonly { sessionId: string; issuedAt: string; lastSeenAt: string }[]> => {
  const rows = await db().actorSession.findMany({
    where: { tenantId, actorId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
  });

  return rows
    .filter(
      (row) => now.getTime() <= row.lastSeenAt.getTime() + STAFF_SESSION_IDLE_MINUTES * 60 * 1000,
    )
    .map((row) => ({
      sessionId: row.id,
      issuedAt: row.issuedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    }));
};
