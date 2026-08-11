/**
 * WebAuthn as a first factor, end to end.
 *
 * **The property this file exists to assert is that the password stops working.**
 *
 * A passkey beside a live password is a convenience: an account is as strong as the weakest method
 * it will accept, and a proxy that takes the password and a code is unaffected by a credential it
 * never asked for. So the tests that matter here are not "a passkey signs me in" - they are "a
 * CORRECT password is refused", and "a reset does not quietly turn it back on".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD,
  authenticateClientUser,
  beginPasskeySignIn,
  beginWebauthnRegistration,
  completePasskeySignIn,
  completePasswordReset,
  completeWebauthnRegistration,
  disablePasswordSignIn,
  enablePasswordSignIn,
  enrolClientUser,
  inviteClientUser,
  issuePasswordReset,
  passwordSignInState,
  type RelyingParty,
} from '@bwc/identity';
import { signIn, signInWithPasskey } from '@bwc/portal';
import { softwareAuthenticator, type SoftwareAuthenticator } from '../helpers/authenticator.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-18T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
const VERIFICATION = 'Called back on the number on file and confirmed the EIN last four.';

const RP: RelyingParty = {
  id: 'portal.example.com',
  name: 'Burkham Wickmont',
  origin: 'https://portal.example.com',
};

beforeAll(async () => {
  fx = await makeFixture('passkey-first');
  clientId = (await createClient(fx.tenant.id, 'Passkey Test LLC', HUMAN())).id;
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

const challengeFrom = (options: Record<string, unknown>): string =>
  (options as { challenge: string }).challenge;

/** Register a passkey - discoverable by default, which is what a first factor has to be. */
const registerPasskey = async (
  userId: string,
  label: string,
  discoverable = true,
): Promise<SoftwareAuthenticator> => {
  const authenticator = softwareAuthenticator();

  const offer = await beginWebauthnRegistration({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    rp: RP,
    discoverable,
    now: NOW,
  });
  if (offer.status !== 'ok') throw new Error(`begin failed: ${offer.status}`);

  const done = await completeWebauthnRegistration({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    password: PASSWORD,
    label,
    response: authenticator.register({
      challenge: challengeFrom(offer.value.options),
      origin: RP.origin,
      rpId: RP.id,
    }),
    rp: RP,
    discoverable,
    now: NOW,
  });
  if (done.status !== 'ok') throw new Error(`register failed: ${done.status}`);

  return authenticator;
};

/** A passwordless assertion, as the browser would produce it. */
const assertPasskey = async (
  authenticator: SoftwareAuthenticator,
  userId: string,
  options?: { userVerified?: boolean },
): Promise<Record<string, unknown>> => {
  const challenge = await beginPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: NOW });
  if (challenge.status !== 'ok') throw new Error('options failed');

  return authenticator.assert({
    challenge: challengeFrom(challenge.value.options),
    origin: RP.origin,
    rpId: RP.id,
    // The user handle is what tells the server whose account this is without an email being typed.
    userHandle: Buffer.from(userId, 'utf8').toString('base64url'),
    ...(options?.userVerified === false ? { userVerified: false } : {}),
  });
};

describe('signing in with a passkey alone', () => {
  it('issues a session with no email and no password', async () => {
    const userId = await enrol('passwordless@example.com');
    const authenticator = await registerPasskey(userId, 'Phone');

    const done = await signInWithPasskey({
      tenantId: fx.tenant.id,
      response: await assertPasskey(authenticator, userId),
      rp: RP,
      now: NOW,
    });

    expect(done.status).toBe('ok');
    if (done.status !== 'ok') throw new Error('unreachable');
    // One step. A discoverable credential asserted with user verification is possession plus
    // verification in one gesture, so there is no challenge to follow it.
    expect(done.value.kind).toBe('session');
    expect(done.value.displayName).toBe('A Client Person');
  });

  it('refuses an assertion without user verification', async () => {
    // Standing alone a passkey has to carry both halves. Without user verification it is possession
    // only, which is not a password replacement.
    const userId = await enrol('no-uv@example.com');
    const authenticator = await registerPasskey(userId, 'Key with no PIN');

    const done = await completePasskeySignIn({
      tenantId: fx.tenant.id,
      response: await assertPasskey(authenticator, userId, { userVerified: false }),
      rp: RP,
      now: NOW,
    });
    expect(done.status).toBe('refused');
  });

  it('refuses a SECOND-factor credential, however well it signs', async () => {
    const userId = await enrol('second-factor-only@example.com');
    // Registered non-discoverable: it was never asked to verify the user, so it never proved what a
    // first factor has to prove.
    const authenticator = await registerPasskey(userId, 'Second factor key', false);

    const done = await completePasskeySignIn({
      tenantId: fx.tenant.id,
      response: await assertPasskey(authenticator, userId),
      rp: RP,
      now: NOW,
    });
    expect(done.status).toBe('refused');
  });

  it('refuses an assertion for another origin', async () => {
    const userId = await enrol('phished-passkey@example.com');
    const authenticator = await registerPasskey(userId, 'Phone');

    const challenge = await beginPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: NOW });
    if (challenge.status !== 'ok') throw new Error('options failed');

    const done = await completePasskeySignIn({
      tenantId: fx.tenant.id,
      response: authenticator.assert({
        challenge: challengeFrom(challenge.value.options),
        origin: 'https://portal.example.com.evil.example',
        rpId: RP.id,
        userHandle: Buffer.from(userId, 'utf8').toString('base64url'),
      }),
      rp: RP,
      now: NOW,
    });
    expect(done.status).toBe('refused');
  });
});

describe('turning password sign-in off', () => {
  it('REFUSES a correct password afterwards, with the same sentence as any other failure', async () => {
    const userId = await enrol('passkey-only@example.com');
    const first = await registerPasskey(userId, 'Phone');
    await registerPasskey(userId, 'Backup key');

    const off = await disablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      response: await assertPasskey(first, userId),
      rp: RP,
      now: NOW,
    });
    expect(off.status).toBe('ok');

    // THE ASSERTION THIS FILE EXISTS FOR. A passkey beside a live password is a convenience; the
    // security property is that the phishable path stops working.
    const withPassword = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'passkey-only@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(withPassword.status).toBe('refused');
    if (withPassword.status !== 'refused') throw new Error('unreachable');
    // The same sentence a wrong password gets. Saying "this account is passkey-only" would tell an
    // attacker which addresses to stop guessing at and which to keep phishing.
    expect(withPassword.reason).toBe('Those sign-in details are not correct.');

    // And the portal's sign-in says the same thing.
    const throughPortal = await signIn({
      tenantId: fx.tenant.id,
      email: 'passkey-only@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(throughPortal.status).toBe('refused');

    // The passkey still works.
    const byKey = await signInWithPasskey({
      tenantId: fx.tenant.id,
      response: await assertPasskey(first, userId),
      rp: RP,
      now: NOW,
    });
    expect(byKey.status).toBe('ok');
  });

  it('needs two passkeys, because one is one lost object away from nothing', async () => {
    const userId = await enrol('one-key@example.com');
    const only = await registerPasskey(userId, 'Only key');

    const state = await passwordSignInState(fx.tenant.id, userId);
    expect(state.discoverableKeys).toBe(1);
    expect(state.mayDisablePassword).toBe(false);

    const attempt = await disablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      response: await assertPasskey(only, userId),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toContain(String(PASSKEYS_REQUIRED_TO_DISABLE_PASSWORD));

    // Still on.
    expect(
      (
        await authenticateClientUser({
          tenantId: fx.tenant.id,
          email: 'one-key@example.com',
          password: PASSWORD,
          now: NOW,
        })
      ).status,
    ).toBe('ok');
  });

  it('needs the password as well as the passkey', async () => {
    const userId = await enrol('needs-both@example.com');
    const first = await registerPasskey(userId, 'Phone');
    await registerPasskey(userId, 'Backup');

    const attempt = await disablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: 'not-the-right-password',
      response: await assertPasskey(first, userId),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });

  it('refuses a passkey belonging to another account', async () => {
    const mine = await enrol('mine@example.com');
    const theirs = await enrol('theirs@example.com');
    await registerPasskey(mine, 'My phone');
    await registerPasskey(mine, 'My backup');
    const notMine = await registerPasskey(theirs, 'Their phone');

    const attempt = await disablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: mine,
      password: PASSWORD,
      response: await assertPasskey(notMine, theirs),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });
});

describe('a reset does not re-open the door', () => {
  it('sets the password and leaves password sign-in OFF', async () => {
    const userId = await enrol('reset-while-off@example.com');
    const first = await registerPasskey(userId, 'Phone');
    await registerPasskey(userId, 'Backup');

    const off = await disablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      response: await assertPasskey(first, userId),
      rp: RP,
      now: NOW,
    });
    if (off.status !== 'ok') throw new Error('disable failed');

    const issued = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      issuedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    if (issued.status !== 'ok') throw new Error('setup: issue');

    const reset = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: issued.value.token,
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    expect(reset.status).toBe('ok');

    // THE ASSERTION. Otherwise the email channel is a way to undo the client's decision silently -
    // an attacker who took the inbox would get back the phishable path the client closed.
    const withNew = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'reset-while-off@example.com',
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    expect(withNew.status).toBe('refused');

    expect((await passwordSignInState(fx.tenant.id, userId)).passwordSignInEnabled).toBe(false);
  });
});

describe('turning it back on', () => {
  const setUp = async (email: string): Promise<{ userId: string; key: SoftwareAuthenticator }> => {
    const userId = await enrol(email);
    const key = await registerPasskey(userId, 'Phone');
    await registerPasskey(userId, 'Backup');

    const off = await disablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      response: await assertPasskey(key, userId),
      rp: RP,
      now: NOW,
    });
    if (off.status !== 'ok') throw new Error('disable failed');

    return { userId, key };
  };

  it('accepts a passkey from the client who changed their mind', async () => {
    const { userId, key } = await setUp('changed-mind@example.com');

    const on = await enablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      response: await assertPasskey(key, userId),
      rp: RP,
      actor: { id: userId, kind: 'client' },
      now: NOW,
    });
    expect(on.status).toBe('ok');

    expect(
      (
        await authenticateClientUser({
          tenantId: fx.tenant.id,
          email: 'changed-mind@example.com',
          password: PASSWORD,
          now: NOW,
        })
      ).status,
    ).toBe('ok');
  });

  it('needs a Level 3 human and a basis when the client holds no passkey', async () => {
    const { userId } = await setUp('lost-everything@example.com');

    const byAgent = await enablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      enabledBy: fx.agent.id,
      verificationBasis: VERIFICATION,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const noBasis = await enablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      enabledBy: fx.human.id,
      verificationBasis: 'phoned',
      actor: HUMAN(),
      now: NOW,
    });
    expect(noBasis.status).toBe('refused');

    const on = await enablePasswordSignIn({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      enabledBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    expect(on.status).toBe('ok');

    // Recorded as a staff act, because restoring the path a client deliberately closed is the
    // strongest thing anybody can do to weaken their account.
    const events = await read(fx.tenant.id);
    const event = events.find(
      (candidate) =>
        candidate.type === 'identity.client_user.password_sign_in_enabled' &&
        (candidate.payload as { clientUserId?: string }).clientUserId === userId,
    );
    expect((event?.payload as { byStaff?: boolean }).byStaff).toBe(true);
    expect((event?.payload as { verificationBasis?: string }).verificationBasis).toBe(VERIFICATION);
  });
});

describe('nothing else changed', () => {
  it('leaves an ordinary account signing in with its password', async () => {
    const userId = await enrol('ordinary@example.com');

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email: 'ordinary@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(signedIn.status).toBe('ok');
    if (signedIn.status !== 'ok') throw new Error('unreachable');
    expect(signedIn.value.kind).toBe('session');

    const state = await passwordSignInState(fx.tenant.id, userId);
    expect(state.passwordSignInEnabled).toBe(true);
    expect(state.discoverableKeys).toBe(0);

    const row = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(row.passwordSignInDisabledAt).toBeNull();
  });
});
