/**
 * WebAuthn as a second factor - 11.1 Identity & Access, for the 11.10 Client Portal.
 *
 * ADR-0024 named this as the stronger answer and did not build it, because there was no browser UI
 * to register a credential from. That is still true and is no longer a reason to leave the server
 * side missing: a UI cannot be written against an endpoint that does not exist.
 *
 * **The property worth having is phishing resistance.** TOTP is a shared secret and six digits, and
 * a proxy site relays those six digits to the real one inside their thirty-second window while the
 * client sees a normal sign-in. A WebAuthn signature covers the ORIGIN it was produced at, so an
 * assertion made at `evil.example` says `evil.example` and this module refuses it. Nothing the
 * client does at the proxy produces a signature the portal accepts.
 *
 * **Verification is delegated to `@simplewebauthn/server`, and that is not a contradiction of
 * `totp.ts` being hand-rolled.** The strength of that file is not its size; it is that RFC 6238
 * publishes vectors, so an off-by-one cannot hide. WebAuthn has no equivalent to check a
 * hand-rolled verifier against, and a verifier tested only by the signer written alongside it
 * agrees with itself perfectly and proves nothing.
 *
 * @see docs/adr/0028-phishing-resistance-is-the-property.md
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { verifyPassword } from './credentials.js';
import { activeFactorsFor } from './mfa.js';

/** How long a ceremony challenge lives. Long enough to touch a key, short enough not to sit around. */
export const WEBAUTHN_CHALLENGE_MINUTES = 5;

/**
 * The relying party.
 *
 * Taken as a value from configuration and never from a request. An RP ID a caller could choose is a
 * caller choosing the scope of the credential; an origin a caller could choose is the phishing
 * resistance switched off by the party it exists to stop. Both failures look like a working system.
 */
export interface RelyingParty {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
}

export interface RegistrationChallenge {
  /** Passed to `navigator.credentials.create()` by the browser. */
  readonly options: Record<string, unknown>;
}

export interface AuthenticationChallenge {
  /** Passed to `navigator.credentials.get()` by the browser. */
  readonly options: Record<string, unknown>;
}

export interface RegisteredKey {
  readonly factorId: string;
  readonly label: string;
  readonly credentialId: string;
}

export interface AssertedKey {
  readonly factorId: string;
  readonly credentialId: string;
  readonly userVerified: boolean;
}

/**
 * Options for registering a key.
 *
 * `excludeCredentials` carries the credentials this account already holds, so an authenticator that
 * is already registered declines rather than silently creating a second credential the client
 * cannot tell apart from the first.
 */
export const beginWebauthnRegistration = async (input: {
  tenantId: string;
  clientUserId: string;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<RegistrationChallenge>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);
  if (user.enrolledAt === null || user.disabledAt !== null) {
    return refused('This account cannot register a key.', 'Blueprint 11.1 - identity and access');
  }

  const existing = await activeFactorsFor(input.tenantId, user.id);

  const options = await generateRegistrationOptions({
    rpID: input.rp.id,
    rpName: input.rp.name,
    userName: user.email,
    userDisplayName: user.displayName,
    // `none` because attestation identifies the authenticator MODEL, which matters to a firm that
    // mandates particular hardware. This one does not, and asking for attestation it will not check
    // is collecting a certificate to ignore it.
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'discouraged',
      // Preferred rather than required: this is a SECOND factor, presented after a password, so a
      // key without a PIN still adds what it is here to add. Required would exclude those keys
      // entirely for a property the password already supplies.
      userVerification: 'preferred',
    },
    excludeCredentials: existing
      .filter((factor) => factor.credentialId !== null)
      .map((factor) => ({ id: factor.credentialId as string })),
  });

  await storeChallenge({
    tenantId: input.tenantId,
    clientUserId: user.id,
    challenge: options.challenge,
    ceremony: 'registration',
    now,
  });

  return ok({ options: options as unknown as Record<string, unknown> });
};

/**
 * Finish registering a key.
 *
 * Takes the **password**, as every credential change does (ADR-0024): a key added from a stolen
 * session alone is a key the thief holds and the owner does not know about.
 */
export const completeWebauthnRegistration = async (input: {
  tenantId: string;
  clientUserId: string;
  password: string;
  label: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<RegisteredKey>> => {
  const now = input.now ?? new Date();

  const user = await db().clientUser.findFirst({
    where: { tenantId: input.tenantId, id: input.clientUserId },
  });
  if (!user) return noData(`No client user ${input.clientUserId} is on record.`);

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    return refused(
      'That password is not correct.',
      'Blueprint 11.1 - a credential change needs a credential',
    );
  }

  const label = input.label.trim();
  if (label.length < 2) {
    // Two keys are indistinguishable without one, and a factor a client cannot identify is one they
    // will not dare remove.
    return refused(
      'A key needs a name you will recognise.',
      'Blueprint 11.1 - identity and access',
    );
  }

  const challenge = await spendChallenge({
    tenantId: input.tenantId,
    clientUserId: user.id,
    ceremony: 'registration',
    now,
  });
  if (challenge === null) {
    return refused(
      'That registration has expired. Start again.',
      'Blueprint 11.1 - identity and access',
    );
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as never,
      expectedChallenge: challenge,
      // From configuration. A response that was produced anywhere else fails here, which is the
      // entire reason to prefer this over a shared secret.
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      requireUserVerification: false,
    });
  } catch {
    // The library throws on a malformed or mismatched response. A refusal rather than a 500: the
    // caller supplied it, and the detail belongs in neither the body nor the log.
    return refused('That key could not be registered.', 'Blueprint 11.1 - identity and access');
  }

  if (!verification.verified || !verification.registrationInfo) {
    return refused('That key could not be registered.', 'Blueprint 11.1 - identity and access');
  }

  const credential = verification.registrationInfo.credential;

  if (await credentialTaken(credential.id)) {
    return refused('That key is already registered.', 'Blueprint 11.1 - identity and access');
  }

  const factor = await db().clientMfaFactor.create({
    data: {
      tenantId: input.tenantId,
      clientUserId: user.id,
      kind: 'webauthn',
      // No secret at all. That is the point: a leaked database yields the value that VERIFIES a
      // signature, never the one that produces it.
      secretCiphertext: null,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      signCount: credential.counter,
      transports: credential.transports?.join(',') ?? null,
      label,
      // Registered and confirmed in one step, unlike TOTP: the ceremony IS the proof that the
      // authenticator works, so there is no unproved state to leave the client in.
      confirmedAt: now,
      createdAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'identity.client_user.mfa_enrolled',
    actor: { id: user.id, kind: 'client' },
    clientId: user.clientId,
    payload: { clientUserId: user.id, factorId: factor.id, kind: 'webauthn', label },
  });

  return ok({ factorId: factor.id, label, credentialId: credential.id });
};

/** Options for signing in with a key. */
export const beginWebauthnAuthentication = async (input: {
  tenantId: string;
  clientUserId: string;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<AuthenticationChallenge>> => {
  const now = input.now ?? new Date();

  const factors = (await activeFactorsFor(input.tenantId, input.clientUserId)).filter(
    (factor) => factor.kind === 'webauthn' && factor.credentialId !== null,
  );
  if (factors.length === 0) {
    return refused('This account has no security key.', 'Blueprint 11.1 - identity and access');
  }

  const options = await generateAuthenticationOptions({
    rpID: input.rp.id,
    userVerification: 'preferred',
    allowCredentials: factors.map((factor) => ({
      id: factor.credentialId as string,
      ...(factor.transports !== null ? { transports: factor.transports.split(',') as never } : {}),
    })),
  });

  await storeChallenge({
    tenantId: input.tenantId,
    clientUserId: input.clientUserId,
    challenge: options.challenge,
    ceremony: 'authentication',
    now,
  });

  return ok({ options: options as unknown as Record<string, unknown> });
};

/**
 * Verify an assertion.
 *
 * The origin check is the load-bearing one. Everything else here - the challenge being ours and
 * spent, the counter not going backwards - protects against replay and cloning; the origin is what
 * makes a phishing proxy useless.
 */
export const verifyWebauthnAssertion = async (input: {
  tenantId: string;
  clientUserId: string;
  response: Record<string, unknown>;
  rp: RelyingParty;
  now?: Date;
}): Promise<Outcome<AssertedKey>> => {
  const now = input.now ?? new Date();

  const generic = refused(
    'That security key could not be used.',
    'Blueprint 11.1 - identity and access',
  );

  const credentialId = typeof input.response['id'] === 'string' ? input.response['id'] : '';
  const factor = await db().clientMfaFactor.findFirst({
    where: {
      tenantId: input.tenantId,
      clientUserId: input.clientUserId,
      kind: 'webauthn',
      credentialId,
      removedAt: null,
      confirmedAt: { not: null },
    },
  });
  if (!factor || factor.publicKey === null || factor.credentialId === null) return generic;

  const challenge = await spendChallenge({
    tenantId: input.tenantId,
    clientUserId: input.clientUserId,
    ceremony: 'authentication',
    now,
  });
  if (challenge === null) return generic;

  const stored = factor.signCount ?? 0;

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response as never,
      expectedChallenge: challenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      requireUserVerification: false,
      credential: {
        id: factor.credentialId,
        publicKey: new Uint8Array(Buffer.from(factor.publicKey, 'base64url')),
        // **The stored counter is handed to the verifier**, which is what makes it enforce that the
        // value advances. A counter that does not advance means two authenticators are answering
        // for one credential - a clone - and the verifier refuses it there rather than here.
        counter: stored,
        ...(factor.transports !== null
          ? { transports: factor.transports.split(',') as never }
          : {}),
      },
    });
  } catch {
    // The refusal has already happened. This only CLASSIFIES it, so that a clone produces a signal
    // somebody can act on rather than looking like a mistyped touch. The counter is read from bytes
    // the signature check just rejected, which is acceptable for exactly this reason: it decides
    // what to write down, never what to allow.
    if (stored > 0 && presentedCounter(input.response) <= stored) {
      await append({
        tenantId: input.tenantId,
        type: 'identity.client_user.mfa_challenge_failed',
        actor: { id: input.clientUserId, kind: 'client' },
        payload: {
          clientUserId: input.clientUserId,
          attempts: 1,
          abandoned: true,
          reason: 'signature_counter_did_not_advance',
        },
      });
      return refused(
        'That security key could not be used. Contact the Concierge Desk.',
        'Blueprint 11.1 - a signature counter that does not advance indicates a cloned authenticator',
      );
    }
    return generic;
  }

  if (!verification.verified) return generic;

  const presented = verification.authenticationInfo.newCounter;

  await db().clientMfaFactor.update({
    where: { id: factor.id },
    data: { signCount: presented },
  });

  return ok({
    factorId: factor.id,
    credentialId: factor.credentialId,
    userVerified: verification.authenticationInfo.userVerified,
  });
};

/** The keys on an account, for a settings screen. Carries no key material a page should not show. */
export const registeredKeys = async (
  tenantId: string,
  clientUserId: string,
): Promise<readonly { factorId: string; label: string; registeredAt: string }[]> => {
  const factors = await db().clientMfaFactor.findMany({
    where: {
      tenantId,
      clientUserId,
      kind: 'webauthn',
      removedAt: null,
      confirmedAt: { not: null },
    },
    orderBy: { createdAt: 'asc' },
  });

  return factors.map((factor) => ({
    factorId: factor.id,
    label: factor.label ?? 'Security key',
    registeredAt: factor.createdAt.toISOString(),
  }));
};

const storeChallenge = async (input: {
  tenantId: string;
  clientUserId: string;
  challenge: string;
  ceremony: 'registration' | 'authentication';
  now: Date;
}): Promise<void> => {
  await db().$transaction(async (tx) => {
    // One live challenge per ceremony. Two would mean an assertion could answer whichever one it
    // happened to match, which is the property a stored challenge exists to remove.
    await tx.clientWebauthnChallenge.updateMany({
      where: {
        clientUserId: input.clientUserId,
        ceremony: input.ceremony,
        consumedAt: null,
      },
      data: { consumedAt: input.now },
    });
    await tx.clientWebauthnChallenge.create({
      data: {
        tenantId: input.tenantId,
        clientUserId: input.clientUserId,
        challenge: input.challenge,
        ceremony: input.ceremony,
        issuedAt: input.now,
        expiresAt: new Date(input.now.getTime() + WEBAUTHN_CHALLENGE_MINUTES * 60 * 1000),
      },
    });
  });
};

/**
 * Take the live challenge and spend it.
 *
 * Spent before the response is verified, not after. A challenge released only on success would let
 * a caller retry a failed ceremony against the same value, and one value answered twice is one
 * signature that can be replayed.
 */
const spendChallenge = async (input: {
  tenantId: string;
  clientUserId: string;
  ceremony: 'registration' | 'authentication';
  now: Date;
}): Promise<string | null> => {
  const row = await db().clientWebauthnChallenge.findFirst({
    where: {
      tenantId: input.tenantId,
      clientUserId: input.clientUserId,
      ceremony: input.ceremony,
      consumedAt: null,
      expiresAt: { gt: input.now },
    },
    orderBy: { issuedAt: 'desc' },
  });
  if (!row) return null;

  const spent = await db().clientWebauthnChallenge.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: input.now },
  });
  // The conditional update is what makes it single use under concurrency: two callers race, one
  // updates a row, the other updates none.
  if (spent.count !== 1) return null;

  return row.challenge;
};

/**
 * The counter an assertion claims, read straight from `authenticatorData`.
 *
 * Bytes 33-36, big-endian, after the 32-byte RP ID hash and the flags. **Unverified** - it is only
 * ever used to explain a refusal that has already been decided, never to permit anything.
 */
const presentedCounter = (response: Record<string, unknown>): number => {
  try {
    const encoded = (response['response'] as { authenticatorData: string }).authenticatorData;
    return Buffer.from(encoded, 'base64url').readUInt32BE(33);
  } catch {
    return 0;
  }
};

const credentialTaken = async (credentialId: string): Promise<boolean> =>
  (await db().clientMfaFactor.count({ where: { credentialId, removedAt: null } })) > 0;
