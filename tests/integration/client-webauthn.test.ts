/**
 * WebAuthn as a second factor, end to end.
 *
 * **The property this file exists to assert is phishing resistance.** TOTP is six digits, and a
 * proxy site relays them to the real one inside their thirty-second window while the client sees a
 * normal sign-in. A WebAuthn signature covers the origin it was produced at, so an assertion made at
 * `https://evil.example` says so and is refused - and the test says exactly that.
 *
 * The ceremony bytes come from a software authenticator in `tests/helpers/authenticator.ts`: a real
 * P-256 key, real `clientDataJSON`, real `authenticatorData`, a real DER signature.
 * `@simplewebauthn/server` is what decides whether they are valid, so **the library is the external
 * reference** - the thing `totp.ts` gets from RFC 6238 and a hand-rolled verifier could get from
 * nowhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  MFA_SECRET_KEY_VARIABLE,
  byPassword,
  TOTP_STEP_SECONDS,
  WEBAUTHN_CHALLENGE_MINUTES,
  activeFactorsFor,
  base32Decode,
  beginMfaEnrolment,
  beginWebauthnAuthentication,
  beginWebauthnRegistration,
  completeWebauthnRegistration,
  confirmMfaEnrolment,
  enrolClientUser,
  hasActiveFactor,
  inviteClientUser,
  mfaStatus,
  registeredKeys,
  totp,
  verifyWebauthnAssertion,
  type RelyingParty,
} from '@bwc/identity';
import { completeSignInMfa, completeSignInWithKey, signIn, signInKeyOptions } from '@bwc/portal';
import { softwareAuthenticator, type SoftwareAuthenticator } from '../helpers/authenticator.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-17T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

const RP: RelyingParty = {
  id: 'portal.example.com',
  name: 'Burkham Wickmont',
  origin: 'https://portal.example.com',
};

beforeAll(async () => {
  fx = await makeFixture('client-webauthn');
  clientId = (await createClient(fx.tenant.id, 'Key Test LLC', HUMAN())).id;
  process.env[MFA_SECRET_KEY_VARIABLE] ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddee00';
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const enrol = async (email: string): Promise<string> => {
  const invited = await inviteClientUser({
    tenantId: fx.tenant.id,
    clientId,
    email,
    displayName: 'A Client Person',
    issuedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (invited.status !== 'ok') throw new Error('setup: invite');

  const enrolled = await enrolClientUser({
    tenantId: fx.tenant.id,
    token: invited.value.token,
    password: PASSWORD,
    actor: HUMAN(),
    now: NOW,
  });
  if (enrolled.status !== 'ok') throw new Error('setup: enrol');
  return enrolled.value.id;
};

/** The challenge the module just stored, as the browser would receive it. */
const challengeFrom = (options: Record<string, unknown>): string =>
  (options as { challenge: string }).challenge;

/** Register a key against an account, returning the authenticator. */
const registerKey = async (
  userId: string,
  label = 'Yubikey on my keyring',
  authenticator: SoftwareAuthenticator = softwareAuthenticator(),
  at = NOW,
): Promise<SoftwareAuthenticator> => {
  const offer = await beginWebauthnRegistration({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    rp: RP,
    now: at,
  });
  if (offer.status !== 'ok') throw new Error(`begin failed: ${offer.status}`);

  const done = await completeWebauthnRegistration({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    confirmation: byPassword(PASSWORD),
    label,
    response: authenticator.register({
      challenge: challengeFrom(offer.value.options),
      origin: RP.origin,
      rpId: RP.id,
    }),
    rp: RP,
    now: at,
  });
  if (done.status !== 'ok') throw new Error(`register failed: ${done.status}`);

  return authenticator;
};

/** Sign in with a password and get the challenge token. */
const openChallenge = async (email: string, at = NOW): Promise<string> => {
  const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: at });
  if (signedIn.status !== 'ok' || signedIn.value.kind !== 'mfa_required') {
    throw new Error('expected a challenge');
  }
  return signedIn.value.challengeToken;
};

describe('registering a key', () => {
  it('records a factor with a public key and no secret', async () => {
    const userId = await enrol('registers@example.com');
    const authenticator = await registerKey(userId);

    const factors = await activeFactorsFor(fx.tenant.id, userId);
    expect(factors).toHaveLength(1);
    expect(factors[0]?.kind).toBe('webauthn');
    expect(factors[0]?.credentialId).toBe(authenticator.credentialId);

    const row = await db().clientMfaFactor.findFirstOrThrow({
      where: { clientUserId: userId, kind: 'webauthn' },
    });
    // No shared secret at all - that is the point of it, and the reason a leaked database yields
    // nothing usable for a key.
    expect(row.secretCiphertext).toBeNull();
    expect(row.publicKey).not.toBeNull();
    expect(row.label).toBe('Yubikey on my keyring');

    expect(await hasActiveFactor(fx.tenant.id, userId)).toBe(true);
    expect((await mfaStatus(fx.tenant.id, userId)).enrolled).toBe(true);
  });

  it('takes the password, as every credential change does', async () => {
    const userId = await enrol('needs-password@example.com');

    const offer = await beginWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      rp: RP,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');

    const attempt = await completeWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword('not-the-right-password'),
      label: 'A key',
      response: softwareAuthenticator().register({
        challenge: challengeFrom(offer.value.options),
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    expect(await hasActiveFactor(fx.tenant.id, userId)).toBe(false);
  });

  it('needs a name, so two keys can be told apart', async () => {
    const userId = await enrol('needs-label@example.com');

    const offer = await beginWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      rp: RP,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');

    const attempt = await completeWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      label: ' ',
      response: softwareAuthenticator().register({
        challenge: challengeFrom(offer.value.options),
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });

  it('refuses a registration built for another origin', async () => {
    const userId = await enrol('wrong-origin-register@example.com');

    const offer = await beginWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      rp: RP,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');

    const attempt = await completeWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      label: 'A key',
      response: softwareAuthenticator().register({
        challenge: challengeFrom(offer.value.options),
        origin: 'https://evil.example',
        rpId: RP.id,
      }),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });

  it('allows a key ALONGSIDE an authenticator app', async () => {
    const userId = await enrol('both-factors@example.com');

    const offer = await beginMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('setup: begin totp');
    const secret = base32Decode(offer.value.secret) as Buffer;
    const confirmed = await confirmMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      rp: RP,
      code: totp(secret, NOW),
      now: NOW,
    });
    if (confirmed.status !== 'ok') throw new Error('setup: confirm totp');

    // A key with no second key and no app is one lost object away from a lockout whose only remedy
    // is a phone call to the firm. One factor was right when the only factor was an app.
    await registerKey(userId, 'Backup key');

    const factors = await activeFactorsFor(fx.tenant.id, userId);
    expect(factors.map((factor) => factor.kind).sort()).toEqual(['totp', 'webauthn']);
  });

  it('refuses the same key on a second account', async () => {
    const first = await enrol('first-owner@example.com');
    const second = await enrol('second-owner@example.com');
    const authenticator = await registerKey(first, 'Shared key');

    const offer = await beginWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: second,
      rp: RP,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');

    const attempt = await completeWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: second,
      confirmation: byPassword(PASSWORD),
      label: 'Same key again',
      response: authenticator.register({
        challenge: challengeFrom(offer.value.options),
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });
});

describe('signing in with a key', () => {
  it('answers the challenge and issues a session', async () => {
    const userId = await enrol('signs-in@example.com');
    const authenticator = await registerKey(userId);

    const challengeToken = await openChallenge('signs-in@example.com');

    const options = await signInKeyOptions({
      tenantId: fx.tenant.id,
      challengeToken,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('options failed');

    const done = await completeSignInWithKey({
      tenantId: fx.tenant.id,
      challengeToken,
      response: authenticator.assert({
        challenge: challengeFrom(options.value.options),
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      now: NOW,
    });

    expect(done.status).toBe('ok');
    if (done.status !== 'ok') throw new Error('unreachable');
    expect(done.value.kind).toBe('session');
    expect(done.value.usedRecoveryCode).toBe(false);
  });

  it('REFUSES an assertion produced at another origin', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A phishing proxy relays the ceremony and gets a signature
    // that says the proxy's origin. TOTP has no equivalent of this check, which is why six digits
    // relayed through a proxy are six digits that work.
    const userId = await enrol('phished@example.com');
    const authenticator = await registerKey(userId);
    const challengeToken = await openChallenge('phished@example.com');

    const options = await signInKeyOptions({
      tenantId: fx.tenant.id,
      challengeToken,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('options failed');

    const done = await completeSignInWithKey({
      tenantId: fx.tenant.id,
      challengeToken,
      response: authenticator.assert({
        challenge: challengeFrom(options.value.options),
        origin: 'https://portal.example.com.evil.example',
        rpId: RP.id,
      }),
      rp: RP,
      now: NOW,
    });

    expect(done.status).toBe('refused');
  });

  it('refuses an assertion signed for another relying party', async () => {
    const userId = await enrol('wrong-rp@example.com');
    const authenticator = await registerKey(userId);
    const challengeToken = await openChallenge('wrong-rp@example.com');

    const options = await signInKeyOptions({
      tenantId: fx.tenant.id,
      challengeToken,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('options failed');

    const done = await completeSignInWithKey({
      tenantId: fx.tenant.id,
      challengeToken,
      response: authenticator.assert({
        challenge: challengeFrom(options.value.options),
        origin: RP.origin,
        rpId: 'evil.example',
      }),
      rp: RP,
      now: NOW,
    });

    expect(done.status).toBe('refused');
  });

  it('spends the ceremony challenge, so one assertion cannot be presented twice', async () => {
    const userId = await enrol('replayed-key@example.com');
    // A COUNTERLESS authenticator, deliberately. With a counting one the replay is refused because
    // the counter did not advance, and this test would pass whether or not the challenge were ever
    // spent - which is exactly what a mutation showed it doing.
    const authenticator = await registerKey(userId, 'Passkey', softwareAuthenticator(0));

    // Against `verifyWebauthnAssertion` directly, and deliberately so. Driving it through two
    // sign-ins would pass for a third wrong reason: opening a second sign-in issues a new
    // challenge, so the old assertion would fail to match it.
    const options = await beginWebauthnAuthentication({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('options failed');

    const assertion = authenticator.assert({
      challenge: challengeFrom(options.value.options),
      origin: RP.origin,
      rpId: RP.id,
    });

    const first = await verifyWebauthnAssertion({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      response: assertion,
      rp: RP,
      now: NOW,
    });
    expect(first.status).toBe('ok');

    // THE ASSERTION. The same signature, the same challenge, and the challenge is gone.
    const second = await verifyWebauthnAssertion({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      response: assertion,
      rp: RP,
      now: NOW,
    });
    expect(second.status).toBe('refused');
  });

  it('refuses an expired challenge', async () => {
    const userId = await enrol('expired-key@example.com');
    const authenticator = await registerKey(userId);
    const challengeToken = await openChallenge('expired-key@example.com');

    const options = await signInKeyOptions({
      tenantId: fx.tenant.id,
      challengeToken,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('options failed');

    const late = new Date(NOW.getTime() + (WEBAUTHN_CHALLENGE_MINUTES + 1) * 60 * 1000);
    const done = await completeSignInWithKey({
      tenantId: fx.tenant.id,
      challengeToken,
      response: authenticator.assert({
        challenge: challengeFrom(options.value.options),
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      now: late,
    });
    expect(done.status).toBe('refused');
  });

  it('lets either factor answer when a client holds both', async () => {
    const userId = await enrol('either-factor@example.com');

    const offer = await beginMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('setup: begin totp');
    const secret = base32Decode(offer.value.secret) as Buffer;
    const confirmed = await confirmMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      rp: RP,
      code: totp(secret, NOW),
      now: NOW,
    });
    if (confirmed.status !== 'ok') throw new Error('setup: confirm totp');

    const authenticator = await registerKey(userId, 'Backup key');

    // The key.
    const keyChallenge = await openChallenge('either-factor@example.com');
    const options = await signInKeyOptions({
      tenantId: fx.tenant.id,
      challengeToken: keyChallenge,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('options failed');
    expect(
      (
        await completeSignInWithKey({
          tenantId: fx.tenant.id,
          challengeToken: keyChallenge,
          response: authenticator.assert({
            challenge: challengeFrom(options.value.options),
            origin: RP.origin,
            rpId: RP.id,
          }),
          rp: RP,
          now: NOW,
        })
      ).status,
    ).toBe('ok');

    // The app.
    const at = new Date(NOW.getTime() + 5 * TOTP_STEP_SECONDS * 1000);
    const codeChallenge = await openChallenge('either-factor@example.com', at);
    expect(
      (
        await completeSignInMfa({
          tenantId: fx.tenant.id,
          challengeToken: codeChallenge,
          code: totp(secret, at),
          now: at,
        })
      ).status,
    ).toBe('ok');
  });
});

describe('the signature counter', () => {
  it('refuses a counter that does not advance, which is a cloned authenticator', async () => {
    const userId = await enrol('cloned@example.com');
    const authenticator = await registerKey(userId, 'Counting key', softwareAuthenticator(1));

    const signInOnce = async (counter?: number): Promise<string> => {
      const challengeToken = await openChallenge('cloned@example.com');
      const options = await signInKeyOptions({
        tenantId: fx.tenant.id,
        challengeToken,
        rp: RP,
        now: NOW,
      });
      if (options.status !== 'ok') throw new Error('options failed');

      const done = await completeSignInWithKey({
        tenantId: fx.tenant.id,
        challengeToken,
        response: authenticator.assert({
          challenge: challengeFrom(options.value.options),
          origin: RP.origin,
          rpId: RP.id,
          ...(counter !== undefined ? { counter } : {}),
        }),
        rp: RP,
        now: NOW,
      });
      return done.status;
    };

    expect(await signInOnce()).toBe('ok');
    expect(await signInOnce()).toBe('ok');

    // A second authenticator answering for one credential reports a counter behind the real one.
    expect(await signInOnce(1)).toBe('refused');

    // And it is RECORDED as a clone rather than looking like a mistyped touch. A surviving mutation
    // found this: the counter check itself lives in the verifier, so the branch here has only one
    // job - classifying a refusal that has already happened - and a test that asserted the refusal
    // alone could not tell whether that job was being done at all.
    const events = await read(fx.tenant.id);
    const flagged = events.find(
      (event) =>
        event.type === 'identity.client_user.mfa_challenge_failed' &&
        (event.payload as { clientUserId?: string; reason?: string }).clientUserId === userId,
    );
    expect((flagged?.payload as { reason?: string }).reason).toBe(
      'signature_counter_did_not_advance',
    );
  });

  it('accepts an authenticator that always reports zero', async () => {
    // Every passkey and every Touch ID credential. Refusing a non-advancing counter unconditionally
    // would reject all of them.
    const userId = await enrol('counterless@example.com');
    const authenticator = await registerKey(userId, 'Passkey', softwareAuthenticator(0));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const challengeToken = await openChallenge('counterless@example.com');
      const options = await signInKeyOptions({
        tenantId: fx.tenant.id,
        challengeToken,
        rp: RP,
        now: NOW,
      });
      if (options.status !== 'ok') throw new Error('options failed');

      const done = await completeSignInWithKey({
        tenantId: fx.tenant.id,
        challengeToken,
        response: authenticator.assert({
          challenge: challengeFrom(options.value.options),
          origin: RP.origin,
          rpId: RP.id,
        }),
        rp: RP,
        now: NOW,
      });
      expect(done.status).toBe('ok');
    }
  });
});

describe('the settings view', () => {
  it('lists keys by the name the client gave them', async () => {
    const userId = await enrol('lists-keys@example.com');
    await registerKey(userId, 'Desk key');
    await registerKey(userId, 'Travel key', softwareAuthenticator());

    const keys = await registeredKeys(fx.tenant.id, userId);
    expect(keys.map((key) => key.label)).toEqual(['Desk key', 'Travel key']);
  });
});
