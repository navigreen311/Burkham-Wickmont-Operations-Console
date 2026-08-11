/**
 * Multi-factor authentication for client users - 11.1 Identity & Access, for the 11.10 Client Portal.
 *
 * Until now a stolen password was the account. Password reset closed the recovery gap and, read
 * carelessly, widened this one: whoever controls a client's inbox controls the account, because the
 * inbox was the only thing between an attacker and a password of their choosing.
 *
 * **The half-authenticated state is not a session.** The tempting build issues the session cookie
 * after the password and marks it unsatisfied, then checks the flag on each route - and the route
 * that forgets is a complete bypass, invisible until somebody goes looking. Here a password
 * produces a `ClientMfaChallenge`: its own table, its own token, no principal. `issueSession` is not
 * reached until a code verifies, so there is no way to express a half-authenticated session.
 *
 * **A session is not a credential.** Enrolling a factor or removing one are credential changes, and
 * a credential change made from a session alone is a credential change made by whoever stole the
 * session - so both take the password as well, and removal takes a current code too.
 *
 * **The secret must be recoverable, unlike a password.** Codes are computed from it, so it is
 * field-encrypted under a key that is not in this database.
 *
 * @see docs/adr/0024-the-half-authenticated-state-is-not-a-session.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { EnvKekProvider, decryptField, encryptField, type KekProvider } from '@bwc/crypto';
import { failed, noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { randomBytes } from 'node:crypto';
import { findActor } from './index.js';
import { hashToken, newToken } from './credentials.js';
import { confirmIdentity, type Confirmation } from './confirmation.js';
import type { RelyingParty } from './webauthn.js';
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from './totp.js';

/** The key protecting TOTP secrets. Separate from `VAULT_KEK`: one key for both would mean a
 * compromise of either reaches the other. */
export const MFA_SECRET_KEY_VARIABLE = 'MFA_SECRET_KEY';

/** What an authenticator app shows above the account name. */
export const MFA_ISSUER = 'Burkham Wickmont';

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1. */
const SECRET_BYTES = 20;

/** How long a challenge lives. It exists only for as long as reading six digits off a phone takes. */
export const MFA_CHALLENGE_MINUTES = 5;

/** Wrong codes before the challenge dies and the caller is thrown back to the password. */
export const MFA_MAX_CHALLENGE_ATTEMPTS = 5;

/** How many recovery codes an enrolment produces. */
export const RECOVERY_CODE_COUNT = 8;

/** Removing a factor on a client's behalf is a Level 3 human decision, as a reset is. */
export const MFA_REMOVAL_AUTHORITY_LEVEL = 3;

const MINIMUM_VERIFICATION_BASIS = 10;

const kek = (): KekProvider => new EnvKekProvider(MFA_SECRET_KEY_VARIABLE);

export interface EnrolmentOffer {
  readonly factorId: string;
  /** For manual entry. Returned once; afterwards only the ciphertext exists. */
  readonly secret: string;
  /** For the QR code. */
  readonly otpauthUri: string;
}

export interface ConfirmedEnrolment {
  readonly factorId: string;
  /**
   * Shown once and never again - only hashes are kept. A client who does not write them down and
   * then loses their phone is back to a phone call to the firm, which is the path this exists to
   * avoid.
   */
  readonly recoveryCodes: readonly string[];
}

export interface MfaStatus {
  readonly enrolled: boolean;
  readonly pendingEnrolment: boolean;
  readonly recoveryCodesRemaining: number;
}

export interface MfaChallenge {
  readonly challengeId: string;
  /** Returned once. Not a session token, and not accepted as one. */
  readonly token: string;
  readonly expiresAt: string;
}

export interface ActiveFactor {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly secretCiphertext: string | null;
  readonly lastUsedStep: bigint | null;
  readonly credentialId: string | null;
  readonly transports: string | null;
}

/**
 * Every factor an account holds.
 *
 * **More than one is allowed, and that changed with WebAuthn.** One factor was right when the only
 * factor was an authenticator app; it is wrong for a security key, because a key with no second key
 * and no app is one lost object away from a lockout whose only remedy is a phone call to the firm.
 */
export const activeFactorsFor = async (
  tenantId: string,
  clientUserId: string,
): Promise<readonly ActiveFactor[]> => {
  const factors = await db().clientMfaFactor.findMany({
    where: { tenantId, clientUserId, removedAt: null, confirmedAt: { not: null } },
    orderBy: { confirmedAt: 'asc' },
  });

  return factors.map((factor) => ({
    id: factor.id,
    kind: factor.kind,
    label: factor.label,
    secretCiphertext: factor.secretCiphertext,
    lastUsedStep: factor.lastUsedStep,
    credentialId: factor.credentialId,
    transports: factor.transports,
  }));
};

/** Whether a user must present a second factor at all. Read on the sign-in path. */
export const hasActiveFactor = async (tenantId: string, clientUserId: string): Promise<boolean> =>
  (await activeFactorsFor(tenantId, clientUserId)).length > 0;

/**
 * The account's authenticator-app factor, if it has one.
 *
 * Named for the kind rather than for "the factor", because since WebAuthn there may be several and
 * only this one has a secret to compute codes from.
 */
export const activeTotpFactor = async (
  tenantId: string,
  clientUserId: string,
): Promise<{ id: string; secretCiphertext: string; lastUsedStep: bigint | null } | null> => {
  const factor = await db().clientMfaFactor.findFirst({
    where: {
      tenantId,
      clientUserId,
      kind: 'totp',
      removedAt: null,
      confirmedAt: { not: null },
      secretCiphertext: { not: null },
    },
    orderBy: { confirmedAt: 'desc' },
  });
  return factor
    ? {
        id: factor.id,
        secretCiphertext: factor.secretCiphertext as string,
        lastUsedStep: factor.lastUsedStep,
      }
    : null;
};

export const mfaStatus = async (tenantId: string, clientUserId: string): Promise<MfaStatus> => {
  const [active, pending, codes] = await Promise.all([
    activeFactorsFor(tenantId, clientUserId),
    db().clientMfaFactor.count({
      where: { tenantId, clientUserId, removedAt: null, confirmedAt: null },
    }),
    db().clientRecoveryCode.count({
      where: { tenantId, clientUserId, usedAt: null, supersededAt: null },
    }),
  ]);

  return {
    enrolled: active.length > 0,
    pendingEnrolment: pending > 0,
    recoveryCodesRemaining: codes,
  };
};

/**
 * Start enrolling an authenticator.
 *
 * Stores the secret **unconfirmed**. Nothing about authentication changes until a code from the new
 * authenticator verifies, because a secret saved on trust is a lockout the client discovers at their
 * next sign-in - by which point the person who could fix it is the one locked out.
 */
export const beginMfaEnrolment = async (input: {
  tenantId: string;
  clientUserId: string;
  now?: Date;
}): Promise<Outcome<EnrolmentOffer>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.enrolledAt === null || user.disabledAt !== null) {
    return refused(
      'This client user cannot enrol a second factor.',
      'Blueprint 11.1 - identity and access',
    );
  }

  if ((await activeTotpFactor(input.tenantId, user.id)) !== null) {
    // One authenticator APP. A security key alongside it is allowed and encouraged - it is what
    // stops a lost phone being a lockout - but two apps holding two secrets for one account is a
    // second thing to keep in sync for no gain.
    return refused(
      'This account already has an authenticator app. Remove the existing one first - which needs the password and a current code, so that adding a second cannot be done from a stolen session alone.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const secret = randomBytes(SECRET_BYTES);
  const secretBase32 = base32Encode(secret);

  let secretCiphertext: string;
  try {
    secretCiphertext = await encryptField(secretBase32, kek());
  } catch {
    // The key is missing or malformed. Storing the secret in the clear instead would be worse than
    // refusing, because nobody would know it had happened.
    return failed(
      `A second factor cannot be enrolled: ${MFA_SECRET_KEY_VARIABLE} is not set or is not a 32-byte hex key. The TOTP secret has to be recoverable to compute codes, so it is encrypted under a key held outside the database.`,
    );
  }

  const factor = await db().$transaction(async (tx) => {
    // Any abandoned half-enrolment is cleared, so a QR code somebody scanned last week and never
    // confirmed cannot be completed later.
    await tx.clientMfaFactor.updateMany({
      where: { clientUserId: user.id, confirmedAt: null, removedAt: null },
      data: { removedAt: now },
    });
    return tx.clientMfaFactor.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: user.id,
        kind: 'totp',
        secretCiphertext,
        createdAt: now,
      },
    });
  });

  return ok({
    factorId: factor.id,
    secret: secretBase32,
    otpauthUri: otpauthUri({ issuer: MFA_ISSUER, account: user.email, secretBase32 }),
  });
};

/**
 * Finish enrolling, by proving the authenticator works.
 *
 * Takes the **password** as well as a code. A session is not a credential: enrolment made from a
 * session alone is enrolment by whoever stole the session, and a factor added to somebody else's
 * account locks its owner out of their own file.
 */
export const confirmMfaEnrolment = async (input: {
  tenantId: string;
  clientUserId: string;
  /** The password, or a passkey where the account has none. */
  confirmation: Confirmation;
  /** Needed to accept a passkey confirmation. */
  rp?: RelyingParty;
  code: string;
  now?: Date;
}): Promise<Outcome<ConfirmedEnrolment>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  const confirmed = await confirmIdentity({
    tenantId: input.tenantId,
    clientUserId: user.id,
    confirmation: input.confirmation,
    ...(input.rp !== undefined ? { rp: input.rp } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  const pending = await db().clientMfaFactor.findFirst({
    where: {
      tenantId: input.tenantId,
      clientUserId: user.id,
      confirmedAt: null,
      removedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });
  // `secretCiphertext` is nullable since WebAuthn, which has no shared secret. A pending factor
  // without one is not an authenticator app waiting to be confirmed.
  if (!pending || pending.secretCiphertext === null) {
    return refused(
      'There is no authenticator waiting to be confirmed. Start again.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const secret = await readSecret(pending.secretCiphertext);
  if (secret === null) return failed('The stored authenticator secret could not be read.');

  const verification = verifyTotp({ secret, code: input.code, at: now });
  if (!verification.valid) {
    return refused(
      'That code is not correct. Check the time on the device running your authenticator - a clock more than a minute out will produce codes that never match.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => recoveryCode());

  await db().$transaction(async (tx) => {
    await tx.clientMfaFactor.update({
      where: { id: pending.id },
      data: { confirmedAt: now, lastUsedStep: verification.step },
    });
    // Any earlier set is retired, so a printout the client has replaced cannot still open the
    // account.
    await tx.clientRecoveryCode.updateMany({
      where: { clientUserId: user.id, usedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
    await tx.clientRecoveryCode.createMany({
      data: await Promise.all(
        codes.map(async (code) => ({
          tenantId: input.tenantId,
          clientUserId: user.id,
          codeHash: await hashToken(code),
          issuedAt: now,
        })),
      ),
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.mfa_enrolled',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, factorId: pending.id, kind: 'totp' },
  });

  return ok({ factorId: pending.id, recoveryCodes: codes });
};

/**
 * Open a challenge after a correct password.
 *
 * Called by the sign-in path when the user has an active factor. Returns a token that is **not** a
 * session token and is not accepted as one - different table, different lookup, no principal.
 */
export const beginMfaChallenge = async (input: {
  tenantId: string;
  clientUserId: string;
  now?: Date;
}): Promise<Outcome<MfaChallenge>> => {
  const now = input.now ?? new Date();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_MINUTES * 60 * 1000);

  const challenge = await db().$transaction(async (tx) => {
    // One live challenge at a time, for the same reason there is one live reset.
    await tx.clientMfaChallenge.updateMany({
      where: { clientUserId: input.clientUserId, satisfiedAt: null, abandonedAt: null },
      data: { abandonedAt: now },
    });
    return tx.clientMfaChallenge.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: input.clientUserId,
        tokenHash: await hashToken(token),
        issuedAt: now,
        expiresAt,
      },
    });
  });

  return ok({ challengeId: challenge.id, token, expiresAt: expiresAt.toISOString() });
};

export interface SatisfiedChallenge {
  readonly clientUserId: string;
  /** True when a recovery code was spent rather than an authenticator code. */
  readonly usedRecoveryCode: boolean;
  readonly recoveryCodesRemaining: number;
}

/**
 * Answer a challenge with a code from the authenticator, or with a recovery code.
 *
 * **A spent time step is refused**, so a code observed over a shoulder or through a phishing proxy
 * cannot be replayed inside the thirty seconds it stays valid, and the same code cannot open two
 * sessions.
 *
 * Failures are counted against **the challenge**, which dies at five. Not the account: killing the
 * challenge throws the caller back to the password, which is rate limited at the transport and
 * locks out at 11.1 - so the brute-force defence for six digits is that failing them costs a
 * password attempt.
 */
export const answerMfaChallenge = async (input: {
  tenantId: string;
  token: string;
  code: string;
  now?: Date;
}): Promise<Outcome<SatisfiedChallenge>> => {
  const now = input.now ?? new Date();

  const generic = refused('That code is not correct.', 'Blueprint 11.1 - identity and access');

  const tokenHash = await hashToken(input.token);
  const challenge = await db().clientMfaChallenge.findFirst({
    where: { tenantId: input.tenantId, tokenHash },
    include: { clientUser: true },
  });

  if (!challenge) return generic;
  if (challenge.satisfiedAt !== null || challenge.abandonedAt !== null) return generic;
  if (challenge.expiresAt.getTime() <= now.getTime()) return generic;
  if (challenge.failedAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS) return generic;

  const user = challenge.clientUser;
  // Re-checked here, not trusted from the password step: the gap between the two is small and it is
  // still a gap.
  if (user.enrolledAt === null || user.disabledAt !== null) return generic;

  const factor = await activeTotpFactor(input.tenantId, user.id);
  if (!factor) return generic;

  const secret = await readSecret(factor.secretCiphertext);
  if (secret === null) return failed('The stored authenticator secret could not be read.');

  const verification = verifyTotp({
    secret,
    code: input.code,
    at: now,
    lastUsedStep: factor.lastUsedStep,
  });

  if (verification.valid) {
    await db().$transaction(async (tx) => {
      await tx.clientMfaFactor.update({
        where: { id: factor.id },
        data: { lastUsedStep: verification.step },
      });
      await tx.clientMfaChallenge.update({
        where: { id: challenge.id },
        data: { satisfiedAt: now },
      });
    });

    return ok({
      clientUserId: user.id,
      usedRecoveryCode: false,
      recoveryCodesRemaining: await remainingRecoveryCodes(input.tenantId, user.id),
    });
  }

  // A recovery code is the other acceptable answer, and it is what a client with a lost phone has.
  const spent = await spendRecoveryCode(input.tenantId, user.id, input.code, now);
  if (spent) {
    await db().clientMfaChallenge.update({
      where: { id: challenge.id },
      data: { satisfiedAt: now },
    });

    const remaining = await remainingRecoveryCodes(input.tenantId, user.id);

    await append({
      tenantId: input.tenantId,
      type: 'identity.client_user.mfa_recovery_code_used',
      actor: { id: user.id, kind: 'client' },
      clientId: user.clientId,
      // Recorded because a recovery code is what an attacker who has phished a printout uses, and a
      // run of them is the signal. It does NOT disable the factor: it satisfies one sign-in.
      payload: { clientUserId: user.id, remaining },
    });

    return ok({ clientUserId: user.id, usedRecoveryCode: true, recoveryCodesRemaining: remaining });
  }

  const attempts = challenge.failedAttempts + 1;
  await db().clientMfaChallenge.update({
    where: { id: challenge.id },
    data: {
      failedAttempts: attempts,
      ...(attempts >= MFA_MAX_CHALLENGE_ATTEMPTS ? { abandonedAt: now } : {}),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.mfa_challenge_failed',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, attempts, abandoned: attempts >= MFA_MAX_CHALLENGE_ATTEMPTS },
  });

  return generic;
};

/**
 * Check a code against the account's active factor, and spend it.
 *
 * The one place a second factor is presented outside the sign-in challenge: removing a factor and
 * changing a password both need one, and three copies of these ten lines is how one of them stops
 * spending the step.
 *
 * **Spending is the point.** A code that authorised a credential change and could then still open a
 * session would be a code used twice, which is precisely what `lastUsedStep` exists to prevent.
 *
 * A recovery code is accepted in its place - it is the answer for the client whose phone is gone,
 * which is the commonest reason to be doing either of these things.
 */
export const verifySecondFactor = async (input: {
  tenantId: string;
  clientUserId: string;
  code: string;
  now: Date;
}): Promise<Outcome<{ usedRecoveryCode: boolean }>> => {
  const factor = await activeTotpFactor(input.tenantId, input.clientUserId);
  if (!factor) {
    return refused('This account has no authenticator.', 'Blueprint 11.1 - identity and access');
  }

  const secret = await readSecret(factor.secretCiphertext);
  if (secret === null) return failed('The stored authenticator secret could not be read.');

  const verification = verifyTotp({
    secret,
    code: input.code,
    at: input.now,
    lastUsedStep: factor.lastUsedStep,
  });

  if (verification.valid) {
    await db().clientMfaFactor.update({
      where: { id: factor.id },
      data: { lastUsedStep: verification.step },
    });
    return ok({ usedRecoveryCode: false });
  }

  if (await spendRecoveryCode(input.tenantId, input.clientUserId, input.code, input.now)) {
    return ok({ usedRecoveryCode: true });
  }

  return refused('That code is not correct.', 'Blueprint 11.1 - identity and access');
};

/**
 * Who an unanswered sign-in challenge belongs to, without answering it.
 *
 * The WebAuthn path needs this: to offer the right credentials it has to know whose account is
 * being signed into, and the only thing the caller holds at that point is the challenge token.
 * Deliberately does NOT satisfy anything - naming the user is not proof of anything about them.
 */
export const clientUserForMfaChallenge = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<{ clientUserId: string }>> => {
  const now = input.now ?? new Date();
  const generic = refused('That code is not correct.', 'Blueprint 11.1 - identity and access');

  const challenge = await db().clientMfaChallenge.findFirst({
    where: { tenantId: input.tenantId, tokenHash: await hashToken(input.token) },
  });

  if (!challenge) return generic;
  if (challenge.satisfiedAt !== null || challenge.abandonedAt !== null) return generic;
  if (challenge.expiresAt.getTime() <= now.getTime()) return generic;
  if (challenge.failedAttempts >= MFA_MAX_CHALLENGE_ATTEMPTS) return generic;

  return ok({ clientUserId: challenge.clientUserId });
};

/**
 * Mark a sign-in challenge answered.
 *
 * Used by the WebAuthn path once an assertion has verified. Separate from `answerMfaChallenge`
 * because the composition lives in `@bwc/portal`: this module cannot import the WebAuthn verifier
 * without a cycle, and a cycle broken by a dynamic import is a cycle nobody sees.
 *
 * The update is conditional on the challenge still being unanswered, so two assertions racing for
 * one challenge produce one session.
 */
export const satisfyMfaChallenge = async (input: {
  tenantId: string;
  token: string;
  now?: Date;
}): Promise<Outcome<{ clientUserId: string }>> => {
  const now = input.now ?? new Date();
  const generic = refused('That code is not correct.', 'Blueprint 11.1 - identity and access');

  const challenge = await db().clientMfaChallenge.findFirst({
    where: { tenantId: input.tenantId, tokenHash: await hashToken(input.token) },
  });
  if (!challenge) return generic;

  const satisfied = await db().clientMfaChallenge.updateMany({
    where: {
      id: challenge.id,
      satisfiedAt: null,
      abandonedAt: null,
      expiresAt: { gt: now },
    },
    data: { satisfiedAt: now },
  });
  if (satisfied.count !== 1) return generic;

  return ok({ clientUserId: challenge.clientUserId });
};

/**
 * Remove your own authenticator.
 *
 * The password **and** a current code, because either alone is one of the two things the factor
 * exists to require. A password-only removal would mean a stolen password removes the factor and
 * then uses it; a code-only removal would mean a borrowed phone does.
 *
 * A recovery code is accepted in place of an authenticator code - it is the answer for the client
 * whose phone is gone, which is the commonest reason to be removing a factor at all.
 */
export const disableMfa = async (input: {
  tenantId: string;
  clientUserId: string;
  /** The password, or a passkey where the account has none. */
  confirmation: Confirmation;
  /** Needed to accept a passkey confirmation. */
  rp?: RelyingParty;
  code: string;
  now?: Date;
}): Promise<Outcome<{ factorId: string }>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  const confirmed = await confirmIdentity({
    tenantId: input.tenantId,
    clientUserId: user.id,
    confirmation: input.confirmation,
    ...(input.rp !== undefined ? { rp: input.rp } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  const factor = await activeTotpFactor(input.tenantId, user.id);
  if (!factor) {
    return refused(
      'This account has no authenticator to remove.',
      'Blueprint 11.1 - identity and access',
    );
  }

  // **A passkey confirmation already IS the second factor.** It is possession and user verification
  // in one act (ADR-0029), so asking for a code on top would be asking the same category twice - and
  // for a key-only account it would be asking for something that does not exist, which is how a
  // client ends up unable to change their own address.
  if (confirmed.value.confirmedWith !== 'passkey') {
    const presented = await verifySecondFactor({
      tenantId: input.tenantId,
      clientUserId: user.id,
      code: input.code,
      now,
    });
    if (presented.status !== 'ok') return presented as Outcome<never>;
  }

  await db().$transaction(async (tx) => {
    await tx.clientMfaFactor.update({
      where: { id: factor.id },
      data: { removedAt: now, removedBy: user.id },
    });
    // The codes went with the factor. Leaving them live would leave a way past a factor that is no
    // longer there to be got past, and they would silently apply to the next one.
    await tx.clientRecoveryCode.updateMany({
      where: { clientUserId: user.id, usedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.mfa_removed',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, factorId: factor.id, byStaff: false },
  });

  return ok({ factorId: factor.id });
};

/**
 * Remove a client's authenticator on their behalf.
 *
 * The client who lost their phone and their recovery codes. A Level 3 human and a recorded
 * verification basis, exactly as a staff-issued reset - the attack is the same phone call.
 *
 * **It signs nobody in.** The client still needs their password afterwards, so this alone is not a
 * takeover. Combined with a staff-issued reset it would be, which is a property of what Level 3
 * already holds rather than one this adds, and it is why both acts carry a basis into the Ledger.
 */
export const removeMfaForClient = async (input: {
  tenantId: string;
  clientUserId: string;
  removedBy: string;
  verificationBasis: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ factorId: string }>> => {
  const now = input.now ?? new Date();

  if (input.verificationBasis.trim().length < MINIMUM_VERIFICATION_BASIS) {
    return refused(
      "Removing a client's authenticator needs a record of how you verified who you were speaking to. The attack on this path is somebody phoning up and sounding convincing.",
      'Blueprint 11.1 - identity and access',
    );
  }

  const remover = await findActor(input.removedBy);
  if (
    !remover ||
    remover.kind !== 'human' ||
    remover.authorityLevel < MFA_REMOVAL_AUTHORITY_LEVEL
  ) {
    return refused(
      `Removing a client's second factor requires a human at Authority Level ${MFA_REMOVAL_AUTHORITY_LEVEL}. It takes away the control that stands between a stolen password and their financial file.`,
      'Blueprint 2.1 with 11.1 - identity and access',
    );
  }

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  const factor = await activeTotpFactor(input.tenantId, user.id);
  if (!factor) {
    return refused(
      'This account has no authenticator to remove.',
      'Blueprint 11.1 - identity and access',
    );
  }

  await db().$transaction(async (tx) => {
    await tx.clientMfaFactor.update({
      where: { id: factor.id },
      data: {
        removedAt: now,
        removedBy: input.removedBy,
        removalVerificationBasis: input.verificationBasis.trim(),
      },
    });
    await tx.clientRecoveryCode.updateMany({
      where: { clientUserId: user.id, usedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
    // Any live challenge dies with the factor it was asking about.
    await tx.clientMfaChallenge.updateMany({
      where: { clientUserId: user.id, satisfiedAt: null, abandonedAt: null },
      data: { abandonedAt: now },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.mfa_removed',
    actor: input.actor,
    clientId: user.clientId,
    payload: {
      clientUserId: user.id,
      factorId: factor.id,
      byStaff: true,
      removedBy: input.removedBy,
      verificationBasis: input.verificationBasis.trim(),
    },
  });

  return ok({ factorId: factor.id });
};

/** Issue a fresh set of recovery codes, retiring the old ones. Needs the password. */
export const regenerateRecoveryCodes = async (input: {
  tenantId: string;
  clientUserId: string;
  /** The password, or a passkey where the account has none. */
  confirmation: Confirmation;
  /** Needed to accept a passkey confirmation. */
  rp?: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ recoveryCodes: readonly string[] }>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  const confirmed = await confirmIdentity({
    tenantId: input.tenantId,
    clientUserId: user.id,
    confirmation: input.confirmation,
    ...(input.rp !== undefined ? { rp: input.rp } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  if (!(await hasActiveFactor(input.tenantId, user.id))) {
    return refused(
      'Recovery codes exist to get past an authenticator, and this account has none.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => recoveryCode());

  await db().$transaction(async (tx) => {
    await tx.clientRecoveryCode.updateMany({
      where: { clientUserId: user.id, usedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
    await tx.clientRecoveryCode.createMany({
      data: await Promise.all(
        codes.map(async (code) => ({
          tenantId: input.tenantId,
          clientUserId: user.id,
          codeHash: await hashToken(code),
          issuedAt: now,
        })),
      ),
    });
  });

  return ok({ recoveryCodes: codes });
};

/**
 * A recovery code.
 *
 * 80 bits in base32, grouped for reading aloud. Long enough that guessing is hopeless and short
 * enough that somebody will actually write it down - a code nobody records is a lockout with extra
 * steps.
 */
const recoveryCode = (): string => {
  const raw = base32Encode(randomBytes(10));
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
};

const remainingRecoveryCodes = async (tenantId: string, clientUserId: string): Promise<number> =>
  db().clientRecoveryCode.count({
    where: { tenantId, clientUserId, usedAt: null, supersededAt: null },
  });

/**
 * Spend a recovery code if it matches a live one.
 *
 * Marked used in a conditional update rather than read-then-write, so the same code presented twice
 * at once cannot be spent twice.
 */
const spendRecoveryCode = async (
  tenantId: string,
  clientUserId: string,
  code: string,
  now: Date,
): Promise<boolean> => {
  const normalised = code.trim().toUpperCase().replace(/\s+/gu, '');
  if (normalised === '') return false;

  const codeHash = await hashToken(normalised);
  const spent = await db().clientRecoveryCode.updateMany({
    where: { tenantId, clientUserId, codeHash, usedAt: null, supersededAt: null },
    data: { usedAt: now },
  });

  return spent.count === 1;
};

/** Decrypt a stored secret. Returns null rather than throwing, so a missing key is an Outcome. */
const readSecret = async (ciphertext: string): Promise<Buffer | null> => {
  try {
    return base32Decode(await decryptField(ciphertext, kek()));
  } catch {
    return null;
  }
};
