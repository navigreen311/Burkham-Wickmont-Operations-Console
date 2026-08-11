/**
 * Staff security keys - the properties, not the plumbing. ADR-0059.
 *
 * Four things carry this file, and each is a sentence somebody could reasonably have got wrong.
 *
 * **A key beside a live password is not phishing resistance.** `phishingResistant` stays false while
 * a password still signs the account in, however many keys are registered. That is ADR-0029's whole
 * argument expressed as an assertion, and it is the one a page would otherwise quietly contradict by
 * showing a key count as a finished state.
 *
 * **Every staff assertion requires user verification.** Sign-in, reauthentication and the switch. A
 * mutation that drops `requireUserVerification` is run against this file and must fail it - on the
 * client side the equivalent property was implemented and unwatched until a surviving mutation found
 * it (ADR-0030 Decision 2).
 *
 * **The counter check classifies a refusal it did not cause.** The verifier is handed the stored
 * counter and does the refusing; the branch underneath reads bytes that were already rejected and
 * decides only what to write down. A mutation that moves it above the verifier - where it would be
 * dead code - is run too.
 *
 * **The origin is the load-bearing check.** An assertion produced at another origin is refused, and
 * that is the entire reason to prefer a key over six digits.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { read as readLedger } from '@bwc/ledger';
import {
  MFA_SECRET_KEY_VARIABLE,
  STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD,
  assertPasswordSignInPermitted,
  base32Decode,
  beginStaffKeyRegistration,
  beginStaffPasskeySignIn,
  beginStaffReauthentication,
  completeStaffKeyRegistration,
  completeStaffPasskeySignIn,
  confirmStaffEnrolment,
  createActor,
  disableStaffPasswordSignIn,
  enrolStaffFromInvitation,
  inviteStaff,
  removeStaffKey,
  restoreStaffPasswordSignIn,
  staffSecurityPosture,
  totp,
  verifyStaffReauthentication,
  type RelyingParty,
} from '@bwc/identity';
import { generateKek } from '@bwc/crypto';
import { softwareAuthenticator, type SoftwareAuthenticator } from '../helpers/authenticator.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

/** The configured relying party. Never a request value - that is the whole point. */
const RP: RelyingParty = {
  id: 'localhost',
  name: 'Burkham Wickmont Console',
  origin: 'http://localhost',
};
const PASSWORD = 'a-long-enough-console-password';

/**
 * A clock this file moves forward.
 *
 * A TOTP code is spent when accepted, and a confirmation uses one. Two registrations inside thirty
 * seconds would present the same step twice, which is a replay rather than a test.
 */
let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);
const step = (): Date => {
  offsetMs += 31_000;
  return at();
};

interface StaffAccount {
  readonly actorId: string;
  readonly email: string;
  readonly secret: Buffer;
}

/** Invite, enrol and confirm - the whole of what ADR-0032 requires before an account exists. */
const makeStaff = async (
  label: string,
  authorityLevel: 0 | 1 | 2 | 3 = 3,
): Promise<StaffAccount> => {
  const actor = await createActor({
    tenantId: fx.tenant.id,
    kind: 'human',
    label,
    authorityLevel,
    department: 'operations',
  });
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}@example.com`;

  // The clock is threaded through every call. It runs ahead of real time - each registration below
  // spends a TOTP step - and a module left on its own `new Date()` would be checking a code minted
  // minutes in its future.
  const now = at();

  const invitation = await inviteStaff({
    tenantId: fx.tenant.id,
    actorId: actor.id,
    email,
    invitedBy: fx.human.id,
    now,
  });
  if (invitation.status !== 'ok') throw new Error(`invite: ${invitation.status}`);

  const offer = await enrolStaffFromInvitation({
    tenantId: fx.tenant.id,
    token: invitation.value.token,
    password: PASSWORD,
    now,
  });
  if (offer.status !== 'ok') throw new Error(`enrol: ${offer.status}`);

  const secret = base32Decode(offer.value.secret);
  if (!secret) throw new Error('unreadable secret');

  const confirmed = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: actor.id,
    password: PASSWORD,
    code: totp(secret, now),
    now,
  });
  if (confirmed.status !== 'ok') throw new Error(`confirm: ${confirmed.status}`);

  return { actorId: actor.id, email, secret };
};

/** Register a key, confirming with a fresh code. */
const registerKey = async (
  account: StaffAccount,
  label: string,
  authenticator: SoftwareAuthenticator = softwareAuthenticator(),
): Promise<SoftwareAuthenticator> => {
  const now = step();

  const options = await beginStaffKeyRegistration({
    tenantId: fx.tenant.id,
    actorId: account.actorId,
    rp: RP,
    now,
  });
  if (options.status !== 'ok') throw new Error(`begin: ${options.status}`);

  const completed = await completeStaffKeyRegistration({
    tenantId: fx.tenant.id,
    actorId: account.actorId,
    confirmation: { kind: 'password', password: PASSWORD },
    label,
    response: authenticator.register({
      challenge: (options.value.options as { challenge: string }).challenge,
      origin: RP.origin,
      rpId: RP.id,
    }),
    rp: RP,
    now,
  });
  if (completed.status !== 'ok') {
    throw new Error(
      `register: ${completed.status} ${'reason' in completed ? completed.reason : ''}`,
    );
  }
  return authenticator;
};

/** Answer a reauthentication challenge with a key. */
const assertReauth = async (
  account: StaffAccount,
  authenticator: SoftwareAuthenticator,
  options: { userVerified?: boolean; origin?: string } = {},
): Promise<Record<string, unknown>> => {
  const now = at();
  const challenge = await beginStaffReauthentication({
    tenantId: fx.tenant.id,
    actorId: account.actorId,
    rp: RP,
    now,
  });
  if (challenge.status !== 'ok') throw new Error(`begin reauth: ${challenge.status}`);

  return authenticator.assert({
    challenge: (challenge.value.options as { challenge: string }).challenge,
    origin: options.origin ?? RP.origin,
    rpId: RP.id,
    userHandle: Buffer.from(account.actorId, 'utf8').toString('base64url'),
    ...(options.userVerified !== undefined ? { userVerified: options.userVerified } : {}),
  });
};

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('staff-webauthn');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('registering a staff key', () => {
  it('records it, names it, and stores a public key rather than a secret', async () => {
    const account = await makeStaff('Key Owner');
    await registerKey(account, 'Yubikey on my keyring');

    const posture = await staffSecurityPosture(fx.tenant.id, account.actorId);
    expect(posture.keyTotal).toBe(1);
    expect(posture.keys[0]?.label).toBe('Yubikey on my keyring');

    const row = await db().actorWebauthnCredential.findFirst({
      where: { tenantId: fx.tenant.id, actorId: account.actorId },
    });
    // A leaked database yields the value that VERIFIES a signature, never the one that produces
    // it. There is no secret column here at all, and that is the point.
    expect(row?.publicKey).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('privateKey');
  });

  it('refuses a registration with no confirmation beyond the session', async () => {
    // ADR-0024: a key added from a stolen session is a key the thief holds and the owner never
    // hears about. A wrong code stands in for "no confirmation".
    const account = await makeStaff('Needs Confirmation');
    const now = step();

    const options = await beginStaffKeyRegistration({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      rp: RP,
      now,
    });
    if (options.status !== 'ok') throw new Error('begin');

    const completed = await completeStaffKeyRegistration({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      confirmation: { kind: 'password', password: 'not-the-right-password' },
      label: 'Should not exist',
      response: softwareAuthenticator().register({
        challenge: (options.value.options as { challenge: string }).challenge,
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      now,
    });

    expect(completed.status).toBe('refused');
    expect((await staffSecurityPosture(fx.tenant.id, account.actorId)).keyTotal).toBe(0);
  });

  it('refuses a key registered at another origin', async () => {
    // **THE LOAD-BEARING CHECK.** A registration produced at a proxy says the proxy.
    const account = await makeStaff('Origin Checked');
    const now = step();

    const options = await beginStaffKeyRegistration({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      rp: RP,
      now,
    });
    if (options.status !== 'ok') throw new Error('begin');

    const completed = await completeStaffKeyRegistration({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      confirmation: { kind: 'password', password: PASSWORD },
      label: 'Phished key',
      response: softwareAuthenticator().register({
        challenge: (options.value.options as { challenge: string }).challenge,
        origin: 'http://evil.example',
        rpId: RP.id,
      }),
      rp: RP,
      now,
    });

    expect(completed.status).toBe('refused');
  });

  it('offers the keys already held so one authenticator cannot register twice', async () => {
    const account = await makeStaff('Excludes Duplicates');
    const key = await registerKey(account, 'First key');

    const options = await beginStaffKeyRegistration({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      rp: RP,
      now: step(),
    });
    if (options.status !== 'ok') throw new Error('begin');

    const excluded = (options.value.options as { excludeCredentials: { id: string }[] })
      .excludeCredentials;
    expect(excluded.map((entry) => entry.id)).toContain(key.credentialId);
  });
});

describe('a key beside a live password', () => {
  it('is NOT phishing resistance, and the posture says so', async () => {
    // **ADR-0029's sentence, as an assertion.** An account is as strong as the weakest method it
    // will accept, so two keys change nothing while a password and a code still sign in.
    const account = await makeStaff('Still Phishable');
    await registerKey(account, 'Key one');
    await registerKey(account, 'Key two');

    const posture = await staffSecurityPosture(fx.tenant.id, account.actorId);
    expect(posture.keyTotal).toBe(2);
    expect(posture.passwordSignInEnabled).toBe(true);
    expect(posture.phishingResistant).toBe(false);

    // And the password path is still open, which is exactly the problem.
    const permitted = await assertPasswordSignInPermitted({
      tenantId: fx.tenant.id,
      email: account.email,
      now: at(),
    });
    expect(permitted.status).toBe('ok');
  });
});

describe('every staff assertion requires user verification', () => {
  it('refuses a reauthentication from a key that did not verify the user', async () => {
    // **MUTATION TARGET.** Dropping `requireUserVerification` from the assertion path must fail
    // here. A touch without a PIN is possession alone, and on this surface possession alone is what
    // the password was supposed to be paired with.
    const account = await makeStaff('Verifies Reauth');
    const key = await registerKey(account, 'PIN-less key');

    const response = await assertReauth(account, key, { userVerified: false });
    const verified = await verifyStaffReauthentication({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      response,
      rp: RP,
      now: at(),
    });

    expect(verified.status).toBe('refused');
  });

  it('accepts one that did', async () => {
    const account = await makeStaff('Verifies Properly');
    const key = await registerKey(account, 'Verifying key');

    const response = await assertReauth(account, key);
    const verified = await verifyStaffReauthentication({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      response,
      rp: RP,
      now: at(),
    });

    expect(verified.status).toBe('ok');
    if (verified.status === 'ok') expect(verified.value.userVerified).toBe(true);
  });

  it('refuses a sign-in assertion that did not verify the user', async () => {
    const account = await makeStaff('Signs In Verified');
    const key = await registerKey(account, 'Sign-in key');

    const options = await beginStaffPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: at() });
    if (options.status !== 'ok') throw new Error('begin');

    const signedIn = await completeStaffPasskeySignIn({
      tenantId: fx.tenant.id,
      response: key.assert({
        challenge: (options.value.options as { challenge: string }).challenge,
        origin: RP.origin,
        rpId: RP.id,
        userHandle: Buffer.from(account.actorId, 'utf8').toString('base64url'),
        userVerified: false,
      }),
      rp: RP,
      now: at(),
    });

    expect(signedIn.status).toBe('refused');
  });
});

describe('signing in with a key', () => {
  it('mints a session and records the method', async () => {
    const account = await makeStaff('Passkey Signs In');
    const key = await registerKey(account, 'Sign-in key');

    const options = await beginStaffPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: at() });
    if (options.status !== 'ok') throw new Error('begin');

    const signedIn = await completeStaffPasskeySignIn({
      tenantId: fx.tenant.id,
      response: key.assert({
        challenge: (options.value.options as { challenge: string }).challenge,
        origin: RP.origin,
        rpId: RP.id,
        userHandle: Buffer.from(account.actorId, 'utf8').toString('base64url'),
      }),
      rp: RP,
      now: at(),
    });

    expect(signedIn.status).toBe('ok');
    if (signedIn.status !== 'ok') return;
    expect(signedIn.value.actor.id).toBe(account.actorId);
    expect(signedIn.value.token.length).toBeGreaterThan(20);

    // The method is what makes the two sign-in paths tellable apart in an audit, and only one of
    // them is phishing resistant.
    const events = await readLedger({ tenantId: fx.tenant.id });
    const signIn = events.find(
      (event) =>
        event.type === 'identity.staff.signed_in' &&
        (event.payload as { actorId?: string }).actorId === account.actorId,
    );
    expect((signIn?.payload as { method?: string } | undefined)?.method).toBe('passkey');
  });

  it('refuses an assertion produced at another origin', async () => {
    const account = await makeStaff('Origin Signs In');
    const key = await registerKey(account, 'Origin key');

    const options = await beginStaffPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: at() });
    if (options.status !== 'ok') throw new Error('begin');

    const signedIn = await completeStaffPasskeySignIn({
      tenantId: fx.tenant.id,
      response: key.assert({
        challenge: (options.value.options as { challenge: string }).challenge,
        // A proxy relaying the ceremony. Nothing the operator can be persuaded to do here produces
        // a signature the Console accepts.
        origin: 'http://evil.example',
        rpId: RP.id,
        userHandle: Buffer.from(account.actorId, 'utf8').toString('base64url'),
      }),
      rp: RP,
      now: at(),
    });

    expect(signedIn.status).toBe('refused');
  });

  it('refuses a key on an account whose Console access was withdrawn', async () => {
    const account = await makeStaff('Withdrawn');
    const key = await registerKey(account, 'Withdrawn key');

    await db().actorCredential.updateMany({
      where: { tenantId: fx.tenant.id, actorId: account.actorId },
      data: { disabledAt: at(), disabledReason: 'left the firm' },
    });

    const options = await beginStaffPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: at() });
    if (options.status !== 'ok') throw new Error('begin');

    const signedIn = await completeStaffPasskeySignIn({
      tenantId: fx.tenant.id,
      response: key.assert({
        challenge: (options.value.options as { challenge: string }).challenge,
        origin: RP.origin,
        rpId: RP.id,
        userHandle: Buffer.from(account.actorId, 'utf8').toString('base64url'),
      }),
      rp: RP,
      now: at(),
    });

    // A withdrawn credential does not sign in with a key any more than it does with a password.
    expect(signedIn.status).toBe('refused');
  });
});

describe('the signature counter', () => {
  it('classifies a refusal it did not cause, and marks the credential', async () => {
    // **MUTATION TARGET.** The verifier is handed the stored counter and does the refusing. This
    // branch reads bytes already rejected and decides only what to write down - moving it above the
    // verifier makes it dead code, which is what a surviving mutation found on the client side.
    const account = await makeStaff('Counting Key');
    const key = await registerKey(account, 'Counting key', softwareAuthenticator(1));

    // One good assertion, so the stored counter advances past zero.
    const first = await assertReauth(account, key);
    const good = await verifyStaffReauthentication({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      response: first,
      rp: RP,
      now: at(),
    });
    expect(good.status).toBe('ok');

    // A second authenticator answering for the same credential would present a counter that has
    // not advanced. Forced here rather than simulated with a real clone.
    const challenge = await beginStaffReauthentication({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      rp: RP,
      now: at(),
    });
    if (challenge.status !== 'ok') throw new Error('begin');

    const stale = await verifyStaffReauthentication({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      response: key.assert({
        challenge: (challenge.value.options as { challenge: string }).challenge,
        origin: RP.origin,
        rpId: RP.id,
        counter: 1,
        userHandle: Buffer.from(account.actorId, 'utf8').toString('base64url'),
      }),
      rp: RP,
      now: at(),
    });

    expect(stale.status).toBe('refused');
    if (stale.status === 'refused') {
      // The classification is the point: a clone produces a signal somebody can act on rather than
      // looking like a mistyped touch.
      expect(stale.reason).toContain('two authenticators are answering for one credential');
    }

    const row = await db().actorWebauthnCredential.findFirst({
      where: { tenantId: fx.tenant.id, actorId: account.actorId },
    });
    expect(row?.clonedAt).not.toBeNull();
  });

  it('accepts an authenticator that never implements one', async () => {
    // Every passkey and every Touch ID credential reports zero forever. Enforcing "must advance"
    // unconditionally would reject all of them.
    const account = await makeStaff('Zero Counter');
    const key = await registerKey(account, 'Passkey', softwareAuthenticator(0));

    for (let round = 0; round < 2; round += 1) {
      const response = await assertReauth(account, key);
      const verified = await verifyStaffReauthentication({
        tenantId: fx.tenant.id,
        actorId: account.actorId,
        response,
        rp: RP,
        now: at(),
      });
      expect(verified.status, `round ${round}`).toBe('ok');
    }
  });
});

describe('turning password sign-in off', () => {
  it(`refuses with fewer than ${STAFF_KEYS_REQUIRED_TO_DISABLE_PASSWORD} keys`, async () => {
    const account = await makeStaff('One Key Only');
    const key = await registerKey(account, 'Lonely key');

    const response = await assertReauth(account, key);
    const disabled = await disableStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      confirmation: { kind: 'passkey', response },
      rp: RP,
      now: at(),
    });

    expect(disabled.status).toBe('refused');
    if (disabled.status === 'refused') expect(disabled.reason).toContain('needs 2 registered keys');
  });

  it('refuses a password, because it proves the factor being retired still works', async () => {
    const account = await makeStaff('Code Refused');
    await registerKey(account, 'Key one');
    await registerKey(account, 'Key two');

    const disabled = await disableStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      confirmation: { kind: 'password', password: PASSWORD },
      rp: RP,
      now: at(),
    });

    expect(disabled.status).toBe('refused');
    if (disabled.status === 'refused') expect(disabled.reason).toContain('takes a security key');
  });

  it('refuses a correct password afterwards, in the same sentence as a wrong one', async () => {
    const account = await makeStaff('Goes Passkey Only');
    const key = await registerKey(account, 'Key one');
    await registerKey(account, 'Key two');

    const response = await assertReauth(account, key);
    const disabled = await disableStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      confirmation: { kind: 'passkey', response },
      rp: RP,
      now: at(),
    });
    expect(disabled.status).toBe('ok');
    if (disabled.status === 'ok') expect(disabled.value.phishingResistant).toBe(true);

    // **THE PROPERTY.** A correct password is refused, and the refusal says nothing that would tell
    // an attacker which addresses to stop phishing.
    const permitted = await assertPasswordSignInPermitted({
      tenantId: fx.tenant.id,
      email: account.email,
      now: at(),
    });
    expect(permitted.status).toBe('refused');
    if (permitted.status === 'refused') {
      expect(permitted.reason).toBe('Those details are not valid.');
    }

    // Blocked, not failed: nothing was wrong with what was presented.
    const events = await readLedger({ tenantId: fx.tenant.id });
    const blocked = events.filter(
      (event) =>
        event.type === 'identity.staff.sign_in_blocked' &&
        (event.payload as { reason?: string }).reason === 'password_sign_in_disabled',
    );
    expect(blocked.length).toBeGreaterThan(0);
  });

  it('refuses removing the last key once the password is off', async () => {
    const account = await makeStaff('Cannot Strand Itself');
    const first = await registerKey(account, 'Key one');
    const second = await registerKey(account, 'Key two');

    const response = await assertReauth(account, first);
    expect(
      (
        await disableStaffPasswordSignIn({
          tenantId: fx.tenant.id,
          actorId: account.actorId,
          confirmation: { kind: 'passkey', response },
          rp: RP,
          now: at(),
        })
      ).status,
    ).toBe('ok');

    const posture = await staffSecurityPosture(fx.tenant.id, account.actorId);
    const secondId = posture.keys.find((entry) => entry.label === 'Key two')?.keyId ?? '';

    // Removing one of two is fine.
    const removedOne = await removeStaffKey({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      keyId: secondId,
      confirmation: { kind: 'passkey', response: await assertReauth(account, second) },
      rp: RP,
      now: at(),
    });
    expect(removedOne.status).toBe('ok');

    // Removing the last one would be locking somebody out of the firm in one call.
    const firstId = posture.keys.find((entry) => entry.label === 'Key one')?.keyId ?? '';
    const removedLast = await removeStaffKey({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      keyId: firstId,
      confirmation: { kind: 'passkey', response: await assertReauth(account, first) },
      rp: RP,
      now: at(),
    });
    expect(removedLast.status).toBe('refused');
    if (removedLast.status === 'refused') {
      expect(removedLast.reason).toContain('would leave no way in at all');
    }
  });
});

describe('the way back', () => {
  it('takes a Level 3 human, a recorded basis, and somebody other than the subject', async () => {
    const account = await makeStaff('Locked Out');
    const key = await registerKey(account, 'Key one');
    await registerKey(account, 'Key two');

    const response = await assertReauth(account, key);
    expect(
      (
        await disableStaffPasswordSignIn({
          tenantId: fx.tenant.id,
          actorId: account.actorId,
          confirmation: { kind: 'passkey', response },
          rp: RP,
          now: at(),
        })
      ).status,
    ).toBe('ok');

    // No basis.
    const noBasis = await restoreStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      restoredBy: fx.human.id,
      verificationBasis: 'asked',
      now: at(),
    });
    expect(noBasis.status).toBe('refused');

    // Not a Level 3 human. `fx.agent` is a village agent at Level 1.
    const notLevel3 = await restoreStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      restoredBy: fx.agent.id,
      verificationBasis: 'Recognised them on a video call and confirmed a case reference.',
      now: at(),
    });
    expect(notLevel3.status).toBe('refused');

    // Not themselves: the basis is a second person's judgement.
    const self = await restoreStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      restoredBy: account.actorId,
      verificationBasis: 'Recognised them on a video call and confirmed a case reference.',
      now: at(),
    });
    expect(self.status).toBe('refused');

    // A colleague, with a basis.
    const restored = await restoreStaffPasswordSignIn({
      tenantId: fx.tenant.id,
      actorId: account.actorId,
      restoredBy: fx.human.id,
      verificationBasis: 'Recognised them on a video call and confirmed a case reference.',
      now: at(),
    });
    expect(restored.status).toBe('ok');
    if (restored.status === 'ok') expect(restored.value.passwordSignInEnabled).toBe(true);

    // And the password signs them in again - the hash was never destroyed, which is what makes the
    // route back one act rather than a credential rebuilt over a telephone.
    const permitted = await assertPasswordSignInPermitted({
      tenantId: fx.tenant.id,
      email: account.email,
      now: at(),
    });
    expect(permitted.status).toBe('ok');

    // The basis is in the Ledger, because putting a phishable factor back is the strongest thing a
    // colleague can do to weaken an account that opens every client file.
    const events = await readLedger({ tenantId: fx.tenant.id });
    const event = events.find((entry) => entry.type === 'identity.staff.password_sign_in_restored');
    expect((event?.payload as { verificationBasis?: string } | undefined)?.verificationBasis).toBe(
      'Recognised them on a video call and confirmed a case reference.',
    );
  });
});
