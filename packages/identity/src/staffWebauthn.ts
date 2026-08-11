/**
 * WebAuthn for staff - 11.1 Identity & Access, for the internal Console.
 *
 * ## The property, and why "add passkey support" would not have delivered it
 *
 * ADR-0032 gave staff a password and a TOTP code. **TOTP is not phishing resistant**: a proxy puts
 * up a copy of the sign-in page, takes the password and the six digits, and presents both to the
 * real Console inside the code's thirty-second window. Everything the replay guard does is
 * downstream of a code somebody typed into the wrong site.
 *
 * ADR-0029 settled what to do about that, on the client side, and the sentence generalises:
 * **an account is as strong as the weakest method it will accept.** A staff key registered beside a
 * live password is never asked for by the proxy, so its resistance is never engaged. The feature is
 * not "sign in with a key". It is "sign in with a key and turn the other way off", and everything
 * here follows from that.
 *
 * ## One kind of staff key, and the flag that could have been got wrong does not exist
 *
 * A client may register a key as a second factor OR as a passkey, and `discoverable` keeps them
 * apart so a second-factor credential is never promoted into a password replacement by a later flag
 * (ADR-0029 Decision 1). **Staff keys exist to remove the password**, so every one is registered
 * `residentKey: 'required'` and `userVerification: 'required'`, verified with
 * `requireUserVerification: true` at registration and at every assertion afterwards.
 *
 * There is no second-factor mode, so there is no column keeping two modes apart, so there is no way
 * for a credential to end up on the wrong side of it. The safest version of a distinction is the one
 * that cannot be drawn.
 *
 * ## What is different from the client, and it is the recovery path
 *
 * ADR-0030's passwordless client needed two keys **and** an email channel to recover through. Staff
 * have no email provider (ADR-0036 records that gap) and no self-service reset at all.
 *
 * They have something the client does not: **a Level 3 colleague who is already authenticated inside
 * the firm.** `restoreStaffPasswordSignIn` is that route - one recorded act with a stated basis,
 * which is precisely ADR-0029's second permitted route rather than its forbidden first one. The
 * email channel is what that ADR refuses to let re-open the door; a named human is what it allows.
 *
 * So the password hash and the TOTP secret are **left in place** rather than destroyed. ADR-0030
 * destroys a client's because a reset can mint a new one; nothing here can, so destroying it would
 * turn every recovery into rebuilding a credential from nothing over a telephone.
 *
 * @see docs/adr/0059-a-staff-key-that-sits-beside-a-password-is-decoration.md
 * @see docs/adr/0028-phishing-resistance-is-the-property.md
 * @see docs/adr/0029-a-passkey-beside-a-password-is-a-convenience.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type AuthorityLevel, type Outcome } from '@bwc/core';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { findActor } from './index.js';
import { hashToken, newToken, verifyPassword } from './credentials.js';
import {
  STAFF_ENROLMENT_AUTHORITY_LEVEL,
  STAFF_SESSION_ABSOLUTE_HOURS,
  type StaffAuthentication,
} from './staff.js';
import type { RelyingParty } from './webauthn.js';

export type { RelyingParty };

/** Long enough to touch a key, short enough not to sit around. Same as the portal's. */
export const STAFF_WEBAUTHN_CHALLENGE_MINUTES = 5;

/**
 * How many keys an account must hold before it may stop accepting a password.
 *
 * Two, for ADR-0029's reason: switching it off with one key is one lost object away from having no
 * way in at all. The remedy for that is a colleague, and a control whose failure mode is "telephone
 * somebody" is a control people turn off.
 */
export const STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD = 2;

/**
 * One sentence for every sign-in failure, matching `staff.ts` word for word.
 *
 * **Including the failure that says an account is passkey-only.** A distinct message would be an
 * oracle telling an attacker which addresses to stop phishing and which to keep trying - ADR-0029
 * Decision 2, and the same reasoning ADR-0023 gives the reset endpoint.
 */
const SIGN_IN_REFUSAL = () =>
  refused(
    'Those details are not valid.',
    'Blueprint 11.1 - identity and access; failures are indistinguishable by design',
  );

const GENERIC_KEY_REFUSAL = () =>
  refused('That security key could not be used.', 'Blueprint 11.1 - identity and access');

export interface StaffKey {
  readonly keyId: string;
  readonly label: string;
  readonly registeredAt: string;
  readonly lastUsedAt: string | null;
}

export interface StaffSecurityPosture {
  readonly keys: readonly StaffKey[];
  readonly keyTotal: number;
  /** False once the account has stopped accepting a password and a code. */
  readonly passwordSignInEnabled: boolean;
  readonly passwordSignInDisabledAt: string | null;
  /** How many more keys are needed before the password may be switched off. */
  readonly keysNeededToDisablePassword: number;
  readonly phishingResistant: boolean;
}

/**
 * How a staff member proves it is them, for an act that changes their credentials.
 *
 * **One union and one function**, for ADR-0030 Decision 1's reason: a gate asks whether the caller
 * confirmed themselves, it does not decide what confirmation is. Four gates here take one, and if
 * each grew its own idea of a good answer, the one added in a hurry next year would accept less.
 *
 * A live session is deliberately NOT enough. A key added from a stolen session alone is a key the
 * thief holds and the owner does not know about (ADR-0024).
 */
export type StaffConfirmation =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'passkey'; readonly response: Record<string, unknown> };

/**
 * Verify a confirmation.
 *
 * The password while the account still accepts one, an assertion otherwise - and an assertion is
 * accepted either way, because an account holding keys should be able to use them.
 *
 * **A password is refused once password sign-in is off, and that is the difference from the client.**
 * ADR-0029 kept a client's hash so the gates could still take it, then ADR-0030 destroyed it. This
 * module keeps the hash deliberately - it is what makes recovery one recorded act - so the hash
 * cannot also be allowed to confirm: a phishable secret that can still register a NEW key would undo
 * the switch in one call. Same end state as ADR-0030, reached by refusing rather than destroying,
 * because the recovery paths differ.
 */
const confirmStaffIdentity = async (input: {
  tenantId: string;
  actorId: string;
  confirmation: StaffConfirmation;
  rp: RelyingParty;
  now: Date;
}): Promise<Outcome<{ readonly method: 'password' | 'passkey' }>> => {
  if (input.confirmation.kind === 'passkey') {
    const asserted = await verifyStaffReauthentication({
      tenantId: input.tenantId,
      actorId: input.actorId,
      response: input.confirmation.response,
      rp: input.rp,
      now: input.now,
    });
    if (asserted.status !== 'ok') return asserted as Outcome<never>;
    return ok({ method: 'passkey' as const });
  }

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential || credential.disabledAt !== null || credential.enrolledAt === null) {
    return refused('That password is not valid.', 'Blueprint 11.1 - identity and access');
  }
  if (credential.passwordSignInDisabledAt !== null) {
    return refused(
      'This account confirms with a security key. Present one instead of a password.',
      'ADR-0059 - a phishable secret must not be able to register a new key on a passkey-only account',
    );
  }

  if (!(await verifyPassword(input.confirmation.password, credential.passwordHash))) {
    return refused('That password is not valid.', 'Blueprint 11.1 - identity and access');
  }

  return ok({ method: 'password' as const });
};

// --- registration ---------------------------------------------------------

/**
 * Options for registering a staff key.
 *
 * `excludeCredentials` carries what this account already holds, so an authenticator that is already
 * registered declines rather than quietly creating a second credential nobody can tell from the
 * first.
 */
export const beginStaffKeyRegistration = async (input: {
  tenantId: string;
  actorId: string;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ options: Record<string, unknown> }>> => {
  const now = input.now ?? new Date();

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential) return noData('That actor holds no Console credential.');
  if (credential.disabledAt !== null || credential.enrolledAt === null) {
    return refused('This account cannot register a key.', 'Blueprint 11.1 - identity and access');
  }

  const existing = await db().actorWebauthnCredential.findMany({
    where: { tenantId: input.tenantId, actorId: input.actorId, removedAt: null },
  });

  const options = await generateRegistrationOptions({
    rpID: input.rp.id,
    rpName: input.rp.name,
    userName: credential.email,
    userDisplayName: credential.email,
    // Attestation identifies the authenticator MODEL, which matters to a firm that mandates
    // particular hardware. This one does not, and collecting a certificate in order to ignore it is
    // theatre.
    attestationType: 'none',
    // The user handle the authenticator stores and returns, which is how an assertion says whose
    // account it is with nothing typed. The Actor id: already opaque, already in the Ledger, and
    // already what the middleware chain reads an Authority Level from.
    userID: new Uint8Array(Buffer.from(input.actorId, 'utf8')),
    authenticatorSelection: {
      // Both required, always. A staff key is a password replacement or it is nothing, and standing
      // alone it must carry possession AND verification in one gesture.
      residentKey: 'required',
      userVerification: 'required',
    },
    excludeCredentials: existing.map((key) => ({ id: key.credentialId })),
  });

  await storeChallenge({
    tenantId: input.tenantId,
    actorId: input.actorId,
    challenge: options.challenge,
    ceremony: 'registration',
    now,
  });

  return ok({ options: options as unknown as Record<string, unknown> });
};

/**
 * Finish registering a key.
 *
 * Takes a confirmation as well as a session, for ADR-0024's reason: a key added from a stolen
 * session alone is a key the thief holds and the owner never hears about.
 */
export const completeStaffKeyRegistration = async (input: {
  tenantId: string;
  actorId: string;
  confirmation: StaffConfirmation;
  label: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<StaffKey>> => {
  const now = input.now ?? new Date();

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential) return noData('That actor holds no Console credential.');
  if (credential.disabledAt !== null || credential.enrolledAt === null) {
    return refused('This account cannot register a key.', 'Blueprint 11.1 - identity and access');
  }

  const label = input.label.trim();
  if (label.length < 2) {
    // Two keys are indistinguishable without one, and a key somebody cannot identify is one they
    // will not dare remove.
    return refused(
      'A key needs a name you will recognise.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const confirmed = await confirmStaffIdentity({
    tenantId: input.tenantId,
    actorId: input.actorId,
    confirmation: input.confirmation,
    rp: input.rp,
    now,
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  const challenge = await spendChallenge({
    tenantId: input.tenantId,
    actorId: input.actorId,
    ceremony: 'registration',
    now,
  });
  if (challenge === null) {
    return refused('That registration has expired. Start again.', 'Blueprint 11.1');
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as never,
      expectedChallenge: challenge,
      // From configuration, never from the request. A response produced anywhere else fails here,
      // which is the entire reason to prefer this over a shared secret.
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      // Always. A staff key stands alone, so it must have verified the user at registration too -
      // otherwise it is a key the owner could not have proved they were present for.
      requireUserVerification: true,
    });
  } catch {
    return refused('That key could not be registered.', 'Blueprint 11.1 - identity and access');
  }

  if (!verification.verified || !verification.registrationInfo) {
    return refused('That key could not be registered.', 'Blueprint 11.1 - identity and access');
  }

  const registered = verification.registrationInfo.credential;

  const taken = await db().actorWebauthnCredential.count({
    where: { credentialId: registered.id, removedAt: null },
  });
  if (taken > 0) {
    return refused('That key is already registered.', 'Blueprint 11.1 - identity and access');
  }

  const row = await db().actorWebauthnCredential.create({
    data: {
      tenantId: input.tenantId,
      actorId: input.actorId,
      credentialId: registered.id,
      publicKey: Buffer.from(registered.publicKey).toString('base64url'),
      signCount: registered.counter,
      transports: registered.transports?.join(',') ?? null,
      label,
      registeredAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.key_registered',
    actor: { id: input.actorId, kind: 'human' },
    payload: {
      actorId: input.actorId,
      keyId: row.id,
      label,
      confirmedWith: confirmed.value.method,
    },
  });

  return ok(toStaffKey(row));
};

// --- sign-in --------------------------------------------------------------

/**
 * Options for signing in with a key and nothing else.
 *
 * **No account is named**, which is the point: the authenticator offers one of its resident
 * credentials, so nothing is typed and nothing is revealed by asking. The challenge row therefore
 * belongs to no actor, and the column admits it.
 */
export const beginStaffPasskeySignIn = async (input: {
  tenantId: string;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ options: Record<string, unknown> }>> => {
  const now = input.now ?? new Date();

  const options = await generateAuthenticationOptions({
    rpID: input.rp.id,
    // Required, never preferred. Standing alone a key has to be possession AND verification in one
    // act; without user verification it is possession alone, which is not a password replacement.
    userVerification: 'required',
    allowCredentials: [],
  });

  await storeChallenge({
    tenantId: input.tenantId,
    actorId: null,
    challenge: options.challenge,
    ceremony: 'authentication',
    now,
  });

  return ok({ options: options as unknown as Record<string, unknown> });
};

/**
 * Verify a staff assertion and mint a session.
 *
 * The `userHandle` says whose account this is. Beyond the signature, the account must still be one
 * that may hold a session at all: a withdrawn credential does not sign in with a key any more than
 * it does with a password, and that check is here rather than left to the session resolver because
 * a session that exists for one request is a session.
 */
export const completeStaffPasskeySignIn = async (input: {
  tenantId: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<StaffAuthentication>> => {
  const now = input.now ?? new Date();

  const assertion = input.response['response'] as { userHandle?: string } | undefined;
  const handle = assertion?.userHandle;
  if (typeof handle !== 'string' || handle === '') return SIGN_IN_REFUSAL();

  const actorId = Buffer.from(handle, 'base64url').toString('utf8');
  const credentialId = typeof input.response['id'] === 'string' ? input.response['id'] : '';

  const key = await db().actorWebauthnCredential.findFirst({
    where: { tenantId: input.tenantId, actorId, credentialId, removedAt: null },
  });
  if (!key) return SIGN_IN_REFUSAL();

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId },
  });
  if (!credential || credential.disabledAt !== null || credential.enrolledAt === null) {
    return SIGN_IN_REFUSAL();
  }

  const challenge = await spendChallenge({
    tenantId: input.tenantId,
    actorId: null,
    ceremony: 'authentication',
    now,
  });
  if (challenge === null) return SIGN_IN_REFUSAL();

  const verified = await verifyAssertion({
    tenantId: input.tenantId,
    actorId,
    key,
    response: input.response,
    challenge,
    rp: input.rp,
    now,
  });
  if (verified.status !== 'ok') return SIGN_IN_REFUSAL();

  const actor = await findActor(actorId);
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
    data: { failedAttempts: 0, lockedUntil: null, lastSignInAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.signed_in',
    actor: { id: actor.id, kind: 'human' },
    // The method is what makes the two sign-in paths tellable apart in an audit, and only one of
    // them is phishing resistant.
    payload: { actorId: actor.id, method: 'passkey', keyId: key.id },
  });

  return ok({
    actor,
    sessionId: session.id,
    token,
    expiresAt: expiresAt.toISOString(),
  });
};

/**
 * Whether a password and a code may still sign this account in.
 *
 * **The Console's sign-in route calls this BEFORE `authenticateStaff`.** Without it the switch would
 * be a column nothing reads, which is the shape of every security feature that is really a setting.
 *
 * The refusal is the same sentence a wrong password gets, and it appends `sign_in_blocked` rather
 * than `sign_in_failed`: nothing was wrong with what was presented, and an audit reading a run of
 * these should see an account refusing a retired method rather than somebody guessing.
 */
export const assertPasswordSignInPermitted = async (input: {
  tenantId: string;
  email: string;
  now?: Date;
}): Promise<Outcome<{ readonly permitted: true }>> => {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, email },
  });

  // No account, or an account that still takes a password: say nothing either way and let
  // `authenticateStaff` produce the answer it would have produced.
  if (!credential || credential.passwordSignInDisabledAt === null) return ok({ permitted: true });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.sign_in_blocked',
    actor: { id: credential.actorId, kind: 'human' },
    payload: { reason: 'password_sign_in_disabled', at: now.toISOString() },
  });

  return SIGN_IN_REFUSAL();
};

// --- reauthentication -----------------------------------------------------

/** Options for an assertion presented to authorise a change rather than to sign in. */
export const beginStaffReauthentication = async (input: {
  tenantId: string;
  actorId: string;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<{ options: Record<string, unknown> }>> => {
  const now = input.now ?? new Date();

  const keys = await db().actorWebauthnCredential.findMany({
    where: { tenantId: input.tenantId, actorId: input.actorId, removedAt: null },
  });
  if (keys.length === 0) {
    return refused('This account has no security key.', 'Blueprint 11.1 - identity and access');
  }

  const options = await generateAuthenticationOptions({
    rpID: input.rp.id,
    // Required. This stands in for the password a gate would otherwise have taken, and a touch
    // without a PIN is less than that password (ADR-0030 Decision 2).
    userVerification: 'required',
    allowCredentials: keys.map((key) => ({
      id: key.credentialId,
      ...(key.transports !== null ? { transports: key.transports.split(',') as never } : {}),
    })),
  });

  await storeChallenge({
    tenantId: input.tenantId,
    actorId: input.actorId,
    challenge: options.challenge,
    ceremony: 'authentication',
    now,
  });

  return ok({ options: options as unknown as Record<string, unknown> });
};

export interface AssertedStaffKey {
  readonly keyId: string;
  readonly credentialId: string;
  readonly userVerified: boolean;
}

/**
 * Verify an assertion for an account already in hand.
 *
 * **User verification required**, exactly as a real passkey sign-in is. A surviving mutation on the
 * client side found this property implemented and unwatched (ADR-0030 Decision 2); the equivalent
 * mutation is run against this function too.
 */
export const verifyStaffReauthentication = async (input: {
  tenantId: string;
  actorId: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<AssertedStaffKey>> => {
  const now = input.now ?? new Date();

  const credentialId = typeof input.response['id'] === 'string' ? input.response['id'] : '';
  const key = await db().actorWebauthnCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId, credentialId, removedAt: null },
  });
  if (!key) return GENERIC_KEY_REFUSAL();

  const challenge = await spendChallenge({
    tenantId: input.tenantId,
    actorId: input.actorId,
    ceremony: 'authentication',
    now,
  });
  if (challenge === null) return GENERIC_KEY_REFUSAL();

  return verifyAssertion({
    tenantId: input.tenantId,
    actorId: input.actorId,
    key,
    response: input.response,
    challenge,
    rp: input.rp,
    now,
  });
};

// --- the switch -----------------------------------------------------------

/**
 * Stop accepting a password and a code.
 *
 * **The point of the whole slice.** Three things are required and each removes a different way for
 * this to become a lockout or a lie:
 *
 *   two keys        one is one lost object away from no way in at all
 *   an assertion    proving a key that could let them back in works RIGHT NOW, not that one is on
 *                   record - ADR-0029 refuses to let somebody close the door on the strength of a
 *                   credential they cannot demonstrate
 *   a live session  which is the Console's own gate, applied by the route
 *
 * The confirmation must be a **passkey**, not a code. A code would prove the retiring factor still
 * works, which is the opposite of what needs proving.
 */
export const disableStaffPasswordSignIn = async (input: {
  tenantId: string;
  actorId: string;
  /** Must be `passkey`. A code proves the wrong thing. */
  confirmation: StaffConfirmation;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<StaffSecurityPosture>> => {
  const now = input.now ?? new Date();

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential) return noData('That actor holds no Console credential.');
  if (credential.passwordSignInDisabledAt !== null) {
    return ok(await staffSecurityPosture(input.tenantId, input.actorId));
  }

  if (input.confirmation.kind !== 'passkey') {
    return refused(
      'Turning password sign-in off takes a security key, not a password. A password would prove the factor being retired still works, which is not what needs proving.',
      'ADR-0059 - the switch is proved with the credential that has to carry the account afterwards',
    );
  }

  const keys = await db().actorWebauthnCredential.count({
    where: { tenantId: input.tenantId, actorId: input.actorId, removedAt: null },
  });
  if (keys < STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD) {
    return refused(
      `Turning password sign-in off needs ${STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD} registered keys; this account has ${keys}. With one key, losing it means no way into the Console at all, and the way back is a colleague at Authority Level ${STAFF_ENROLMENT_AUTHORITY_LEVEL}.`,
      'ADR-0059 - two keys, because the remedy for a lockout here is a person',
    );
  }

  const confirmed = await confirmStaffIdentity({
    tenantId: input.tenantId,
    actorId: input.actorId,
    confirmation: input.confirmation,
    rp: input.rp,
    now,
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  await db().actorCredential.update({
    where: { id: credential.id },
    data: { passwordSignInDisabledAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.password_sign_in_disabled',
    actor: { id: input.actorId, kind: 'human' },
    payload: { actorId: input.actorId, keyCount: keys },
  });

  return ok(await staffSecurityPosture(input.tenantId, input.actorId));
};

/**
 * Put password sign-in back, because somebody lost their keys.
 *
 * **This is the lockout answer, and it is a person rather than a channel.** ADR-0029 refuses to let
 * a password reset re-open the door because the email channel can be taken; it permits exactly this
 * - a Level 3 human with a recorded verification basis - and staff have the second without having
 * the first at all.
 *
 * It is deliberately not self-service and deliberately not the subject's own act: somebody who has
 * lost every key cannot prove anything, so the proof is a colleague's judgement, written down.
 */
export const restoreStaffPasswordSignIn = async (input: {
  tenantId: string;
  /** Whose sign-in is being restored. */
  actorId: string;
  /** Who decided. A human at Level 3, checked against the recorded actor. */
  restoredBy: string;
  /** How they satisfied themselves it was really them. Recorded, never blank. */
  verificationBasis: string;
  now?: Date;
}): Promise<Outcome<StaffSecurityPosture>> => {
  const basis = input.verificationBasis.trim();
  if (basis.length < 10) {
    return refused(
      'Restoring password sign-in needs a recorded basis: how you satisfied yourself that the person asking is who they say. This re-opens the phishable path the account deliberately closed.',
      'ADR-0059 with ADR-0029 - a named human and a recorded basis, never a channel',
    );
  }

  // Read from the database, never from what the caller said about themselves. A gate that believes
  // its caller about whether the caller is allowed through is not a gate (ADR-0009).
  const restorer = await findActor(input.restoredBy);
  if (
    restorer === null ||
    restorer.kind !== 'human' ||
    restorer.tenantId !== input.tenantId ||
    restorer.authorityLevel < (STAFF_ENROLMENT_AUTHORITY_LEVEL as AuthorityLevel)
  ) {
    return refused(
      `Restoring password sign-in requires a human at Authority Level ${STAFF_ENROLMENT_AUTHORITY_LEVEL}. It puts a phishable factor back on an account that removed it.`,
      'ADR-0059 - the same authority that grants Console access in the first place',
    );
  }
  if (restorer.id === input.actorId) {
    // Somebody who still holds a key does not need this route; somebody who does not cannot be
    // signed in to use it. A self-restore is therefore either unnecessary or impossible, and
    // allowing it would make the recorded basis a note somebody wrote about themselves.
    return refused(
      'Restoring your own password sign-in is not a route. Ask a colleague at Authority Level 3.',
      'ADR-0059 - the basis is a second person’s judgement',
    );
  }

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  if (!credential) return noData('That actor holds no Console credential.');
  if (credential.passwordSignInDisabledAt === null) {
    return ok(await staffSecurityPosture(input.tenantId, input.actorId));
  }

  await db().actorCredential.update({
    where: { id: credential.id },
    data: { passwordSignInDisabledAt: null },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.password_sign_in_restored',
    actor: { id: restorer.id, kind: 'human' },
    payload: { actorId: input.actorId, restoredBy: restorer.id, verificationBasis: basis },
  });

  return ok(await staffSecurityPosture(input.tenantId, input.actorId));
};

// --- keys on an account ---------------------------------------------------

export const staffSecurityPosture = async (
  tenantId: string,
  actorId: string,
): Promise<StaffSecurityPosture> => {
  const [rows, credential] = await Promise.all([
    db().actorWebauthnCredential.findMany({
      where: { tenantId, actorId, removedAt: null },
      orderBy: [{ registeredAt: 'asc' }, { id: 'asc' }],
    }),
    db().actorCredential.findFirst({ where: { tenantId, actorId } }),
  ]);

  const disabledAt = credential?.passwordSignInDisabledAt ?? null;

  return {
    keys: rows.map(toStaffKey),
    keyTotal: rows.length,
    passwordSignInEnabled: disabledAt === null,
    passwordSignInDisabledAt: disabledAt?.toISOString() ?? null,
    keysNeededToDisablePassword: Math.max(0, STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD - rows.length),
    /**
     * The one honest summary.
     *
     * Registering keys does NOT make an account phishing resistant while a password still signs it
     * in - that is ADR-0029's whole sentence, and a page that showed "2 keys registered" as a green
     * state would be telling an operator they had a property they do not have.
     */
    phishingResistant: disabledAt !== null && rows.length > 0,
  };
};

/**
 * Remove a key.
 *
 * Refuses the last key on an account that no longer takes a password: that is not removing a key,
 * it is locking somebody out of the firm in one call.
 */
export const removeStaffKey = async (input: {
  tenantId: string;
  actorId: string;
  keyId: string;
  confirmation: StaffConfirmation;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<StaffSecurityPosture>> => {
  const now = input.now ?? new Date();

  const key = await db().actorWebauthnCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId, id: input.keyId, removedAt: null },
  });
  if (!key) return noData('No such key on this account.');

  const credential = await db().actorCredential.findFirst({
    where: { tenantId: input.tenantId, actorId: input.actorId },
  });
  const remaining = await db().actorWebauthnCredential.count({
    where: { tenantId: input.tenantId, actorId: input.actorId, removedAt: null },
  });

  if (credential?.passwordSignInDisabledAt !== null && credential !== null && remaining <= 1) {
    return refused(
      'This is the only key on an account that no longer accepts a password. Removing it would leave no way in at all; restore password sign-in first, through a colleague at Authority Level 3.',
      'ADR-0059 - a removal that produces a lockout is not a removal',
    );
  }

  const confirmed = await confirmStaffIdentity({
    tenantId: input.tenantId,
    actorId: input.actorId,
    confirmation: input.confirmation,
    rp: input.rp,
    now,
  });
  if (confirmed.status !== 'ok') return confirmed as Outcome<never>;

  await db().actorWebauthnCredential.update({
    where: { id: key.id },
    data: { removedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.staff.key_removed',
    actor: { id: input.actorId, kind: 'human' },
    payload: { actorId: input.actorId, keyId: key.id, label: key.label },
  });

  return ok(await staffSecurityPosture(input.tenantId, input.actorId));
};

// --- shared internals -----------------------------------------------------

interface KeyRow {
  id: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string | null;
  label: string;
  registeredAt: Date;
  lastUsedAt: Date | null;
}

const toStaffKey = (row: KeyRow): StaffKey => ({
  keyId: row.id,
  label: row.label,
  registeredAt: row.registeredAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

/**
 * Verify a signature against a stored key, and classify the refusal if it fails.
 *
 * **The counter branch is on the FAILURE path and that is not a stylistic choice.** The verifier is
 * given the stored counter and enforces that the value advances, so a check written after it could
 * never run - it would sit below a call that has already returned. A surviving mutation found
 * exactly that on the client side (ADR-0028 Decision 5): the test asserting "a stale counter is
 * refused" passed because the library refused it, and the branch underneath was dead.
 *
 * So this branch reads the counter from bytes the signature check has just rejected, and uses it
 * only to decide what to write down. Never what to allow.
 */
const verifyAssertion = async (input: {
  tenantId: string;
  actorId: string;
  key: KeyRow;
  response: Record<string, unknown>;
  challenge: string;
  rp: RelyingParty;
  now: Date;
}): Promise<Outcome<AssertedStaffKey>> => {
  const stored = input.key.signCount;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response as never,
      expectedChallenge: input.challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      // Every staff assertion, without exception: sign-in, reauthentication and the switch. There
      // is no position in this module where a staff key is a second factor, so there is no position
      // where possession alone is enough.
      requireUserVerification: true,
      credential: {
        id: input.key.credentialId,
        publicKey: new Uint8Array(Buffer.from(input.key.publicKey, 'base64url')),
        // Handed to the verifier, which is what makes it enforce that the value advances.
        counter: stored,
        ...(input.key.transports !== null
          ? { transports: input.key.transports.split(',') as never }
          : {}),
      },
    });
  } catch {
    if (stored > 0 && presentedCounter(input.response) <= stored) {
      await db().actorWebauthnCredential.update({
        where: { id: input.key.id },
        data: { clonedAt: input.now },
      });
      await append({
        tenantId: input.tenantId,
        type: 'identity.staff.sign_in_failed',
        actor: { id: input.actorId, kind: 'human' },
        payload: { reason: 'signature_counter_did_not_advance', keyId: input.key.id },
      });
      return refused(
        'That security key could not be used. Report it: the counter did not advance, which means two authenticators are answering for one credential.',
        'Blueprint 11.1 - a signature counter that does not advance indicates a cloned authenticator',
      );
    }
    return GENERIC_KEY_REFUSAL();
  }

  if (!verification.verified) return GENERIC_KEY_REFUSAL();

  await db().actorWebauthnCredential.update({
    where: { id: input.key.id },
    data: { signCount: verification.authenticationInfo.newCounter, lastUsedAt: input.now },
  });

  return ok({
    keyId: input.key.id,
    credentialId: input.key.credentialId,
    userVerified: verification.authenticationInfo.userVerified,
  });
};

const storeChallenge = async (input: {
  tenantId: string;
  actorId: string | null;
  challenge: string;
  ceremony: 'registration' | 'authentication';
  now: Date;
}): Promise<void> => {
  await db().$transaction(async (tx) => {
    // One live challenge per ceremony. Two would mean an assertion could answer whichever it
    // happened to match, which is the property a stored challenge exists to remove.
    await tx.actorWebauthnChallenge.updateMany({
      where: { actorId: input.actorId, ceremony: input.ceremony, consumedAt: null },
      data: { consumedAt: input.now },
    });
    await tx.actorWebauthnChallenge.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        challenge: input.challenge,
        ceremony: input.ceremony,
        issuedAt: input.now,
        expiresAt: new Date(input.now.getTime() + STAFF_WEBAUTHN_CHALLENGE_MINUTES * 60 * 1000),
      },
    });
  });
};

/**
 * Take the live challenge and spend it.
 *
 * Spent before the response is verified, not after: a challenge released only on success would let
 * a caller retry a failed ceremony against the same value, and one value answered twice is one
 * signature that can be replayed.
 */
const spendChallenge = async (input: {
  tenantId: string;
  actorId: string | null;
  ceremony: 'registration' | 'authentication';
  now: Date;
}): Promise<string | null> => {
  const row = await db().actorWebauthnChallenge.findFirst({
    where: {
      tenantId: input.tenantId,
      actorId: input.actorId,
      ceremony: input.ceremony,
      consumedAt: null,
      expiresAt: { gt: input.now },
    },
    orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
  });
  if (!row) return null;

  const spent = await db().actorWebauthnChallenge.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: input.now },
  });
  // The conditional update is what makes it single use under concurrency: two callers race, one
  // updates a row and the other updates none.
  if (spent.count !== 1) return null;

  return row.challenge;
};

/**
 * The counter an assertion claims, read straight from `authenticatorData`.
 *
 * Bytes 33-36, big-endian, after the 32-byte RP ID hash and the flags. **Unverified** - it only ever
 * explains a refusal that has already been decided, and never permits anything.
 */
const presentedCounter = (response: Record<string, unknown>): number => {
  try {
    const encoded = (response['response'] as { authenticatorData: string }).authenticatorData;
    return Buffer.from(encoded, 'base64url').readUInt32BE(33);
  } catch {
    return 0;
  }
};
