/**
 * Multi-factor authentication for client users, end to end.
 *
 * Four properties carry this file.
 *
 * **The half-authenticated state is not a session.** A correct password against an account with a
 * factor produces a challenge and nothing else - the challenge token is not a session token, and
 * `principalFromToken` will not resolve it.
 *
 * **A code cannot be used twice.** The accepted time step is stored, so a code observed inside its
 * thirty-second window is dead the moment it is spent.
 *
 * **A session is not a credential.** Enrolling and removing both take the password.
 *
 * **Password reset is not an MFA bypass** - it issues no session and leaves the factor in place.
 * That is the assertion this file exists for, because reset and MFA were built a slice apart and
 * the bypass would be invisible from either one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  MFA_MAX_CHALLENGE_ATTEMPTS,
  MFA_SECRET_KEY_VARIABLE,
  RECOVERY_CODE_COUNT,
  TOTP_STEP_SECONDS,
  base32Decode,
  beginMfaEnrolment,
  completePasswordReset,
  confirmMfaEnrolment,
  disableMfa,
  enrolClientUser,
  inviteClientUser,
  issuePasswordReset,
  mfaStatus,
  regenerateRecoveryCodes,
  removeMfaForClient,
  totp,
} from '@bwc/identity';
import { completeSignInMfa, principalFromToken, signIn } from '@bwc/portal';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-13T10:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });
const VERIFICATION = 'Called back on the number on file and confirmed the EIN last four.';

beforeAll(async () => {
  fx = await makeFixture('client-mfa');
  clientId = (await createClient(fx.tenant.id, 'MFA Test LLC', HUMAN())).id;
  // The TOTP secret is encrypted at rest under a key that is not in the database. Without it,
  // enrolment refuses rather than storing the secret in the clear.
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

/** Enrol a user AND an authenticator, returning the user id, the secret and the recovery codes. */
const withAuthenticator = async (
  email: string,
  at = NOW,
): Promise<{ userId: string; secret: Buffer; recoveryCodes: readonly string[] }> => {
  const userId = await enrol(email);

  const offer = await beginMfaEnrolment({ tenantId: fx.tenant.id, clientUserId: userId, now: at });
  if (offer.status !== 'ok') throw new Error(`setup: begin (${offer.status})`);

  const secret = base32Decode(offer.value.secret);
  if (secret === null) throw new Error('setup: secret');

  const confirmed = await confirmMfaEnrolment({
    tenantId: fx.tenant.id,
    clientUserId: userId,
    password: PASSWORD,
    code: totp(secret, at),
    now: at,
  });
  if (confirmed.status !== 'ok') throw new Error(`setup: confirm (${confirmed.status})`);

  return { userId, secret, recoveryCodes: confirmed.value.recoveryCodes };
};

/** A moment far enough ahead that a fresh code is in a different time step. */
const laterThan = (at: Date, steps = 2): Date =>
  new Date(at.getTime() + steps * TOTP_STEP_SECONDS * 1000);

describe('enrolling an authenticator', () => {
  it('does not take effect until a code from it verifies', async () => {
    const userId = await enrol('unconfirmed@example.com');

    const offer = await beginMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');

    // A secret saved on trust is a lockout the client discovers at their next sign-in, by which
    // point the person who could fix it is the one locked out.
    expect((await mfaStatus(fx.tenant.id, userId)).enrolled).toBe(false);
    expect((await mfaStatus(fx.tenant.id, userId)).pendingEnrolment).toBe(true);

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email: 'unconfirmed@example.com',
      password: PASSWORD,
      now: NOW,
    });
    if (signedIn.status !== 'ok') throw new Error('sign in failed');
    expect(signedIn.value.kind).toBe('session');
  });

  it('refuses a wrong code, and refuses without the password', async () => {
    const userId = await enrol('bad-confirm@example.com');
    const offer = await beginMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      now: NOW,
    });
    if (offer.status !== 'ok') throw new Error('begin failed');
    const secret = base32Decode(offer.value.secret) as Buffer;

    const wrongCode = await confirmMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      code: '000000',
      now: NOW,
    });
    expect(wrongCode.status).toBe('refused');

    // A session is not a credential: enrolment from a stolen session alone would lock the real
    // owner out of their own file.
    const wrongPassword = await confirmMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: 'not-the-right-password',
      code: totp(secret, NOW),
      now: NOW,
    });
    expect(wrongPassword.status).toBe('refused');
    expect((await mfaStatus(fx.tenant.id, userId)).enrolled).toBe(false);
  });

  it('stores the secret encrypted, not in the clear', async () => {
    const { userId, secret } = await withAuthenticator('encrypted@example.com');

    const row = await db().clientMfaFactor.findFirstOrThrow({
      where: { clientUserId: userId, removedAt: null },
    });

    // Unlike a password hash the secret has to be recoverable - codes are computed from it - so
    // the protection is a key that is not in this database.
    expect(row.secretCiphertext).not.toContain(secret.toString('base64'));
    expect(row.secretCiphertext.startsWith('v1|')).toBe(true);
    expect(row.confirmedAt).not.toBeNull();
  });

  it('issues recovery codes once, and stores only their hashes', async () => {
    const { userId, recoveryCodes } = await withAuthenticator('codes@example.com');

    expect(recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);

    const rows = await db().clientRecoveryCode.findMany({ where: { clientUserId: userId } });
    for (const row of rows) {
      expect(recoveryCodes).not.toContain(row.codeHash);
    }
  });

  it('refuses a second authenticator while one is active', async () => {
    const { userId } = await withAuthenticator('one-factor@example.com');

    const again = await beginMfaEnrolment({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      now: NOW,
    });
    expect(again.status).toBe('refused');
  });
});

describe('the half-authenticated state is not a session', () => {
  it('returns a challenge and NO session for a correct password', async () => {
    await withAuthenticator('challenged@example.com');

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email: 'challenged@example.com',
      password: PASSWORD,
      now: NOW,
    });
    if (signedIn.status !== 'ok') throw new Error('sign in failed');

    // THE ASSERTION THIS FILE EXISTS FOR. Not a session marked unsatisfied - no session at all, so
    // there is no route that has to remember to check a flag.
    expect(signedIn.value.kind).toBe('mfa_required');
    if (signedIn.value.kind !== 'mfa_required') throw new Error('unreachable');

    const sessions = await db().clientSession.count({
      where: { clientUser: { email: 'challenged@example.com' } },
    });
    expect(sessions).toBe(0);

    // And the challenge token is not a session token.
    const asPrincipal = await principalFromToken({
      tenantId: fx.tenant.id,
      token: signedIn.value.challengeToken,
      now: NOW,
    });
    expect(asPrincipal.status).toBe('refused');
  });

  it('issues the session only once the code verifies', async () => {
    const { secret } = await withAuthenticator('two-step@example.com');

    const signedIn = await signIn({
      tenantId: fx.tenant.id,
      email: 'two-step@example.com',
      password: PASSWORD,
      now: NOW,
    });
    if (signedIn.status !== 'ok' || signedIn.value.kind !== 'mfa_required') {
      throw new Error('expected a challenge');
    }

    const at = laterThan(NOW);
    const done = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: signedIn.value.challengeToken,
      code: totp(secret, at),
      now: at,
    });
    if (done.status !== 'ok') throw new Error(`complete failed: ${done.status}`);

    const principal = await principalFromToken({
      tenantId: fx.tenant.id,
      token: done.value.token,
      now: at,
    });
    expect(principal.status).toBe('ok');
    expect(done.value.usedRecoveryCode).toBe(false);
  });
});

describe('a code cannot be used twice', () => {
  it('refuses the same code on a second challenge', async () => {
    const { secret } = await withAuthenticator('replay@example.com');
    const at = laterThan(NOW);
    const code = totp(secret, at);

    const first = await signIn({
      tenantId: fx.tenant.id,
      email: 'replay@example.com',
      password: PASSWORD,
      now: at,
    });
    if (first.status !== 'ok' || first.value.kind !== 'mfa_required') throw new Error('setup');
    const opened = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: first.value.challengeToken,
      code,
      now: at,
    });
    expect(opened.status).toBe('ok');

    // THE ASSERTION. Somebody who read that code over a shoulder has thirty seconds; this is what
    // takes them away.
    const second = await signIn({
      tenantId: fx.tenant.id,
      email: 'replay@example.com',
      password: PASSWORD,
      now: at,
    });
    if (second.status !== 'ok' || second.value.kind !== 'mfa_required') throw new Error('setup');
    const replayed = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: second.value.challengeToken,
      code,
      now: at,
    });
    expect(replayed.status).toBe('refused');
  });

  it('kills the challenge after five wrong codes, not the account', async () => {
    const { secret } = await withAuthenticator('brute-force@example.com');
    const at = laterThan(NOW);

    const opened = await signIn({
      tenantId: fx.tenant.id,
      email: 'brute-force@example.com',
      password: PASSWORD,
      now: at,
    });
    if (opened.status !== 'ok' || opened.value.kind !== 'mfa_required') throw new Error('setup');

    for (let attempt = 0; attempt < MFA_MAX_CHALLENGE_ATTEMPTS; attempt += 1) {
      const wrong = await completeSignInMfa({
        tenantId: fx.tenant.id,
        challengeToken: opened.value.challengeToken,
        code: '000000',
        now: at,
      });
      expect(wrong.status).toBe('refused');
    }

    // The correct code no longer helps: the challenge is dead.
    const correct = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: opened.value.challengeToken,
      code: totp(secret, at),
      now: at,
    });
    expect(correct.status).toBe('refused');

    // But the ACCOUNT is untouched - the password still opens a new challenge, and six digits are
    // defended by the fact that failing them costs a password attempt.
    const again = await signIn({
      tenantId: fx.tenant.id,
      email: 'brute-force@example.com',
      password: PASSWORD,
      now: at,
    });
    if (again.status !== 'ok' || again.value.kind !== 'mfa_required') throw new Error('expected');

    const later = laterThan(at);
    const finished = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: again.value.challengeToken,
      code: totp(secret, later),
      now: later,
    });
    expect(finished.status).toBe('ok');
  });
});

describe('recovery codes', () => {
  it('satisfy a challenge, are single use, and do NOT disable the factor', async () => {
    const { userId, recoveryCodes } = await withAuthenticator('recovery@example.com');
    const at = laterThan(NOW);
    const code = recoveryCodes[0] as string;

    const opened = await signIn({
      tenantId: fx.tenant.id,
      email: 'recovery@example.com',
      password: PASSWORD,
      now: at,
    });
    if (opened.status !== 'ok' || opened.value.kind !== 'mfa_required') throw new Error('setup');

    const done = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: opened.value.challengeToken,
      code,
      now: at,
    });
    if (done.status !== 'ok') throw new Error('recovery sign-in failed');
    expect(done.value.usedRecoveryCode).toBe(true);
    expect(done.value.recoveryCodesRemaining).toBe(RECOVERY_CODE_COUNT - 1);

    // A recovery code satisfies ONE sign-in. It is not a way to turn the factor off.
    expect((await mfaStatus(fx.tenant.id, userId)).enrolled).toBe(true);

    const reused = await signIn({
      tenantId: fx.tenant.id,
      email: 'recovery@example.com',
      password: PASSWORD,
      now: at,
    });
    if (reused.status !== 'ok' || reused.value.kind !== 'mfa_required') throw new Error('setup');
    const secondUse = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: reused.value.challengeToken,
      code,
      now: at,
    });
    expect(secondUse.status).toBe('refused');
  });

  it('are retired as a set when new ones are issued', async () => {
    const { userId, recoveryCodes } = await withAuthenticator('regenerated@example.com');

    const fresh = await regenerateRecoveryCodes({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      now: NOW,
    });
    if (fresh.status !== 'ok') throw new Error('regenerate failed');

    expect((await mfaStatus(fx.tenant.id, userId)).recoveryCodesRemaining).toBe(
      RECOVERY_CODE_COUNT,
    );

    // A printout the client has replaced must not still open the account.
    const at = laterThan(NOW);
    const opened = await signIn({
      tenantId: fx.tenant.id,
      email: 'regenerated@example.com',
      password: PASSWORD,
      now: at,
    });
    if (opened.status !== 'ok' || opened.value.kind !== 'mfa_required') throw new Error('setup');

    const withOld = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: opened.value.challengeToken,
      code: recoveryCodes[0] as string,
      now: at,
    });
    expect(withOld.status).toBe('refused');
  });
});

describe('password reset is not an MFA bypass', () => {
  it('issues no session and leaves the factor in place', async () => {
    const { userId, secret } = await withAuthenticator('reset-and-mfa@example.com');

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
    if (reset.status !== 'ok') throw new Error('reset failed');

    // THE ASSERTION THIS BLOCK EXISTS FOR. Reset and MFA were built a slice apart, and a reset that
    // signed the caller in, or that cleared the factor, would turn the email channel into a
    // complete account takeover - invisible from either feature on its own.
    expect((await mfaStatus(fx.tenant.id, userId)).enrolled).toBe(true);

    const after = await signIn({
      tenantId: fx.tenant.id,
      email: 'reset-and-mfa@example.com',
      password: 'a-brand-new-portal-password',
      now: NOW,
    });
    if (after.status !== 'ok') throw new Error('sign in failed');
    expect(after.value.kind).toBe('mfa_required');

    // And the authenticator still governs the account.
    if (after.value.kind !== 'mfa_required') throw new Error('unreachable');
    const at = laterThan(NOW);
    const done = await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: after.value.challengeToken,
      code: totp(secret, at),
      now: at,
    });
    expect(done.status).toBe('ok');
  });
});

describe('removing a factor', () => {
  it('needs the password AND a code', async () => {
    const { userId, secret } = await withAuthenticator('self-remove@example.com');
    const at = laterThan(NOW);

    const withoutPassword = await disableMfa({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: 'not-the-right-password',
      code: totp(secret, at),
      now: at,
    });
    expect(withoutPassword.status).toBe('refused');

    const withoutCode = await disableMfa({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      code: '000000',
      now: at,
    });
    expect(withoutCode.status).toBe('refused');
    expect((await mfaStatus(fx.tenant.id, userId)).enrolled).toBe(true);

    const removed = await disableMfa({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      code: totp(secret, at),
      now: at,
    });
    expect(removed.status).toBe('ok');

    const status = await mfaStatus(fx.tenant.id, userId);
    expect(status.enrolled).toBe(false);
    // The codes went with the factor. Leaving them live would leave a way past a factor that is no
    // longer there, and they would silently apply to the next one.
    expect(status.recoveryCodesRemaining).toBe(0);
  });

  it('accepts a recovery code in place of an authenticator code', async () => {
    const { userId, recoveryCodes } = await withAuthenticator('remove-by-recovery@example.com');

    const removed = await disableMfa({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      password: PASSWORD,
      code: recoveryCodes[0] as string,
      now: NOW,
    });
    expect(removed.status).toBe('ok');
  });

  it('needs a Level 3 human and a verification basis when staff do it', async () => {
    const { userId } = await withAuthenticator('staff-remove@example.com');

    const byAgent = await removeMfaForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      removedBy: fx.agent.id,
      verificationBasis: VERIFICATION,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const noBasis = await removeMfaForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      removedBy: fx.human.id,
      verificationBasis: 'phoned',
      actor: HUMAN(),
      now: NOW,
    });
    expect(noBasis.status).toBe('refused');

    const removed = await removeMfaForClient({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      removedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    expect(removed.status).toBe('ok');

    // It signs nobody in: the client still needs their password.
    const events = await read(fx.tenant.id);
    const event = events.find(
      (candidate) =>
        candidate.type === 'identity.client_user.mfa_removed' &&
        (candidate.payload as { clientUserId?: string }).clientUserId === userId,
    );
    expect((event?.payload as { byStaff?: boolean }).byStaff).toBe(true);
    expect((event?.payload as { verificationBasis?: string }).verificationBasis).toBe(VERIFICATION);
  });
});

describe('no secret material leaves the module', () => {
  it('puts no secret and no recovery code in any Ledger payload', async () => {
    const { userId, secret, recoveryCodes } = await withAuthenticator('ledger-mfa@example.com');
    const at = laterThan(NOW);

    const opened = await signIn({
      tenantId: fx.tenant.id,
      email: 'ledger-mfa@example.com',
      password: PASSWORD,
      now: at,
    });
    if (opened.status !== 'ok' || opened.value.kind !== 'mfa_required') throw new Error('setup');
    await completeSignInMfa({
      tenantId: fx.tenant.id,
      challengeToken: opened.value.challengeToken,
      code: recoveryCodes[1] as string,
      now: at,
    });

    const events = await read(fx.tenant.id);
    const mine = events.filter(
      (event) =>
        event.type.includes('mfa') &&
        (event.payload as { clientUserId?: string }).clientUserId === userId,
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);

    const serialised = JSON.stringify(mine);
    expect(serialised).not.toContain(secret.toString('base64'));
    for (const code of recoveryCodes) {
      expect(serialised).not.toContain(code);
    }
  });
});
