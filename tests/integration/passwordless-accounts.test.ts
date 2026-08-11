/**
 * An account with no password at all, end to end.
 *
 * ADR-0029 stopped the password authenticating anybody and left the hash, because seven gates asked
 * for it. This is what those gates take instead, and what it means for the password to be gone.
 *
 * Three properties carry this file.
 *
 * **A passkey confirms a credential change wherever a password used to.** One type, one function,
 * seven gates - because seven gates each deciding what a good answer looks like is how one of them
 * ends up accepting less than the others.
 *
 * **The password is destroyed, not merely disregarded.** Two independent facts are written, and the
 * weaker one cannot resurrect the credential.
 *
 * **Recovery is one recorded act.** A client who removed their password and then lost every passkey
 * has exactly one route back, and it goes through a Level 3 human who has to say how they checked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  authenticateClientUser,
  beginWebauthnAuthentication,
  beginWebauthnRegistration,
  byPasskey,
  byPassword,
  completePasswordReset,
  completeWebauthnRegistration,
  confirmIdentity,
  disablePasswordSignIn,
  enrolClientUser,
  inviteClientUser,
  issuePasswordReset,
  passwordSignInState,
  regenerateRecoveryCodes,
  removePassword,
  requestEmailChange,
  requestPasswordReset,
  restorePassword,
  type RelyingParty,
} from '@bwc/identity';
import { softwareAuthenticator, type SoftwareAuthenticator } from '../helpers/authenticator.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-19T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
const VERIFICATION = 'Called back on the number on file and confirmed the EIN last four.';

const RP: RelyingParty = {
  id: 'portal.example.com',
  name: 'Burkham Wickmont',
  origin: 'https://portal.example.com',
};

beforeAll(async () => {
  fx = await makeFixture('passwordless');
  clientId = (await createClient(fx.tenant.id, 'Passwordless Test LLC', HUMAN())).id;
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

const registerPasskey = async (userId: string, label: string): Promise<SoftwareAuthenticator> => {
  const authenticator = softwareAuthenticator();

  const offer = await beginWebauthnRegistration({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    rp: RP,
    discoverable: true,
    now: NOW,
  });
  if (offer.status !== 'ok') throw new Error('setup: begin');

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
    discoverable: true,
    now: NOW,
  });
  if (done.status !== 'ok') throw new Error(`setup: register (${done.status})`);

  return authenticator;
};

/** An assertion for a passwordless sign-in - what `removePassword` takes. */
const signInAssertion = async (
  authenticator: SoftwareAuthenticator,
  userId: string,
): Promise<Record<string, unknown>> => {
  const { beginPasskeySignIn } = await import('@bwc/identity');
  const options = await beginPasskeySignIn({ tenantId: fx.tenant.id, rp: RP, now: NOW });
  if (options.status !== 'ok') throw new Error('setup: options');

  return authenticator.assert({
    challenge: challengeFrom(options.value.options),
    origin: RP.origin,
    rpId: RP.id,
    userHandle: Buffer.from(userId, 'utf8').toString('base64url'),
  });
};

/** An assertion for confirming a change - the account is already known. */
const reauthAssertion = async (
  authenticator: SoftwareAuthenticator,
  userId: string,
): Promise<Record<string, unknown>> => {
  const options = await beginWebauthnAuthentication({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    rp: RP,
    now: NOW,
  });
  if (options.status !== 'ok') throw new Error('setup: reauth options');

  return authenticator.assert({
    challenge: challengeFrom(options.value.options),
    origin: RP.origin,
    rpId: RP.id,
  });
};

/** Take an account all the way to having no password. */
const makePasswordless = async (
  email: string,
): Promise<{ userId: string; first: SoftwareAuthenticator; second: SoftwareAuthenticator }> => {
  const userId = await enrol(email);
  const first = await registerPasskey(userId, 'Phone');
  const second = await registerPasskey(userId, 'Backup');

  const off = await disablePasswordSignIn({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    password: PASSWORD,
    response: await signInAssertion(first, userId),
    rp: RP,
    now: NOW,
  });
  if (off.status !== 'ok') throw new Error(`setup: disable (${off.status})`);

  const removed = await removePassword({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    response: await signInAssertion(first, userId),
    rp: RP,
    now: NOW,
  });
  if (removed.status !== 'ok') throw new Error(`setup: remove (${removed.status})`);

  return { userId, first, second };
};

describe('removing the password', () => {
  it('destroys the hash as well as recording the state', async () => {
    const { userId } = await makePasswordless('destroyed@example.com');

    const row = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(row.passwordRemovedAt).not.toBeNull();
    // Two independent facts. The hash is overwritten with a value that cannot verify, so a column
    // somebody edits back to null cannot resurrect a credential.
    expect(row.passwordHash).toBe('removed');
    expect(row.passwordHash.startsWith('scrypt$')).toBe(false);

    const state = await passwordSignInState(fx.tenant.id, userId);
    expect(state.hasPassword).toBe(false);
    expect(state.passwordSignInEnabled).toBe(false);
  });

  it('refuses while password sign-in is still on', async () => {
    const userId = await enrol('still-on@example.com');
    const first = await registerPasskey(userId, 'Phone');
    await registerPasskey(userId, 'Backup');

    // An account whose password still signs people in has not shown that anything else can.
    const attempt = await removePassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      response: await signInAssertion(first, userId),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toContain('Turn password sign-in off first');
  });

  it('leaves the old password unable to sign in, whatever is tried', async () => {
    await makePasswordless('cannot-sign-in@example.com');

    const attempt = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'cannot-sign-in@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toBe('Those sign-in details are not correct.');
  });
});

describe('a passkey confirms what a password used to', () => {
  it('is accepted by confirmIdentity, and a password is not', async () => {
    const { userId, first } = await makePasswordless('confirms@example.com');

    const byKey = await confirmIdentity({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPasskey(await reauthAssertion(first, userId)),
      rp: RP,
      now: NOW,
    });
    expect(byKey.status).toBe('ok');
    if (byKey.status !== 'ok') throw new Error('unreachable');
    expect(byKey.value.confirmedWith).toBe('passkey');

    // There is nothing to check a password against, and accepting one would mean accepting the
    // sentinel the removal left behind.
    const byOldPassword = await confirmIdentity({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      rp: RP,
      now: NOW,
    });
    expect(byOldPassword.status).toBe('refused');
    if (byOldPassword.status !== 'refused') throw new Error('unreachable');
    expect(byOldPassword.reason).toContain('no password');
  });

  it('lets a passwordless client move their address', async () => {
    const { userId, first } = await makePasswordless('moves-address@example.com');

    const asked = await requestEmailChange({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      newEmail: 'moved-passwordless@example.com',
      confirmation: byPasskey(await reauthAssertion(first, userId)),
      rp: RP,
      now: NOW,
    });
    // `not_built` is the delivery seam, which means every gate before it passed.
    expect(asked.status).toBe('not_built');
  });

  it('lets a passwordless client regenerate their recovery codes', async () => {
    const { userId, first } = await makePasswordless('new-codes@example.com');

    const fresh = await regenerateRecoveryCodes({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPasskey(await reauthAssertion(first, userId)),
      rp: RP,
      now: NOW,
    });
    expect(fresh.status).toBe('ok');
  });

  it('lets a passwordless client register a third key', async () => {
    const { userId, first } = await makePasswordless('third-key@example.com');
    const third = softwareAuthenticator();

    const offer = await beginWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      rp: RP,
      discoverable: true,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');

    const registered = await completeWebauthnRegistration({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPasskey(await reauthAssertion(first, userId)),
      label: 'Third key',
      response: third.register({
        challenge: challengeFrom(offer.value.options),
        origin: RP.origin,
        rpId: RP.id,
      }),
      rp: RP,
      discoverable: true,
      now: NOW,
    });
    expect(registered.status).toBe('ok');
  });

  it('refuses a passkey that did not verify the user', async () => {
    // THE ASSERTION A SURVIVING MUTATION ASKED FOR. A confirmation stands in for the password a gate
    // would otherwise have taken, so a touch without a PIN is accepting less than what it replaces -
    // and nothing here said so until dropping `requireUserVerification` changed no test.
    const { userId, first } = await makePasswordless('no-uv-confirm@example.com');

    const options = await beginWebauthnAuthentication({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      rp: RP,
      now: NOW,
    });
    if (options.status !== 'ok') throw new Error('setup: options');

    const attempt = await confirmIdentity({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPasskey(
        first.assert({
          challenge: challengeFrom(options.value.options),
          origin: RP.origin,
          rpId: RP.id,
          userVerified: false,
        }),
      ),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });

  it('refuses a passkey belonging to somebody else', async () => {
    const { userId } = await makePasswordless('mine-only@example.com');
    const other = await enrol('someone-else@example.com');
    const theirs = await registerPasskey(other, 'Their key');

    const attempt = await confirmIdentity({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPasskey(await reauthAssertion(theirs, other)),
      rp: RP,
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
  });
});

describe('reset has nothing to reset', () => {
  it('says nothing about it on the self-service path', async () => {
    await makePasswordless('no-reset@example.com');

    const asked = await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'no-reset@example.com',
      now: NOW,
    });
    const unknown = await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'not-a-client-at-all@example.com',
      now: NOW,
    });

    // Identical. Distinguishing them would say which addresses are passkey-only, which is a list an
    // attacker would rather have than a password.
    expect(JSON.stringify(asked)).toBe(JSON.stringify(unknown));
  });

  it('says so plainly on the staff path, and names the act that fixes it', async () => {
    const { userId } = await makePasswordless('staff-reset@example.com');

    const attempt = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      issuedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toContain('restorePassword');
  });
});

describe('restoring a password', () => {
  it('is one recorded act by a Level 3 human, and the client chooses the password', async () => {
    const { userId } = await makePasswordless('restores@example.com');

    const byAgent = await restorePassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      restoredBy: fx.agent.id,
      verificationBasis: VERIFICATION,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const noBasis = await restorePassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      restoredBy: fx.human.id,
      verificationBasis: 'phoned',
      actor: HUMAN(),
      now: NOW,
    });
    expect(noBasis.status).toBe('refused');

    const restored = await restorePassword({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      restoredBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    if (restored.status !== 'ok') throw new Error(`restore failed: ${restored.status}`);

    // A reset token comes back rather than a password: one read down a telephone is a password two
    // people know.
    const set = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: restored.value.token,
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    expect(set.status).toBe('ok');

    const signedIn = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'restores@example.com',
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    expect(signedIn.status).toBe('ok');

    const state = await passwordSignInState(fx.tenant.id, userId);
    expect(state.hasPassword).toBe(true);
    expect(state.passwordSignInEnabled).toBe(true);

    const events = await read(fx.tenant.id);
    const event = events.find(
      (candidate) =>
        candidate.type === 'identity.client_user.password_restored' &&
        (candidate.payload as { clientUserId?: string }).clientUserId === userId,
    );
    expect((event?.payload as { verificationBasis?: string }).verificationBasis).toBe(VERIFICATION);
  });
});

describe('nothing changed for an account that keeps its password', () => {
  it('still signs in, still confirms with a password', async () => {
    const userId = await enrol('ordinary-still@example.com');

    expect(
      (
        await authenticateClientUser({
          tenantId: fx.tenant.id,
          email: 'ordinary-still@example.com',
          password: PASSWORD,
          now: NOW,
        })
      ).status,
    ).toBe('ok');

    const confirmed = await confirmIdentity({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPassword(PASSWORD),
      now: NOW,
    });
    expect(confirmed.status).toBe('ok');
    if (confirmed.status !== 'ok') throw new Error('unreachable');
    expect(confirmed.value.confirmedWith).toBe('password');

    const state = await passwordSignInState(fx.tenant.id, userId);
    expect(state.hasPassword).toBe(true);
    expect(state.mayRemovePassword).toBe(false);
  });

  it('refuses a passkey confirmation from a gate that cannot check one', async () => {
    const userId = await enrol('no-rp@example.com');

    // Not a refusal the caller can fix by retrying: the gate was wired without a relying party.
    const attempt = await confirmIdentity({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      confirmation: byPasskey({ id: 'anything' }),
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toContain('cannot accept a passkey');
  });
});
