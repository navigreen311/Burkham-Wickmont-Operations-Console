/**
 * Password reset for client users, end to end.
 *
 * Four properties carry this file, and three of them are about what reset must NOT do.
 *
 * **The request endpoint answers identically for every address** - enrolled, unenrolled, disabled,
 * or not a user at all - while creating a row for exactly one of them. Anything else is a list of
 * who banks with this firm.
 *
 * **Requesting a reset changes nothing about the account.** The old password still works, and the
 * lockout counter is untouched: an unauthenticated endpoint that cleared a lock would be a lockout
 * bypass, which is the mistake this file is built around catching.
 *
 * **Completing a reset ends every session**, including one held by whoever the client is resetting
 * against.
 *
 * **No token reaches the Ledger.**
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  MAX_FAILED_ATTEMPTS,
  MINIMUM_PASSWORD_LENGTH,
  PASSWORD_RESET_MINUTES,
  authenticateClientUser,
  completePasswordReset,
  disableClientUser,
  enrolClientUser,
  inviteClientUser,
  issuePasswordReset,
  pendingPasswordResets,
  requestPasswordReset,
  resolveSession,
} from '@bwc/identity';
import { signIn } from '@bwc/portal';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-08-12T09:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const REPLACEMENT = 'an-entirely-different-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

const VERIFICATION = 'Called back on the number on file and confirmed the last four of the EIN.';

beforeAll(async () => {
  fx = await makeFixture('client-reset');
  clientId = (await createClient(fx.tenant.id, 'Reset Test LLC', HUMAN())).id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

/** Invite and enrol, returning the user id. */
const enrol = async (email: string, password = PASSWORD): Promise<string> => {
  const invited = await inviteClientUser({
    tenantId: fx.tenant.id,
    clientId,
    email,
    displayName: 'A Client Person',
    issuedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });
  if (invited.status !== 'ok') throw new Error(`invite failed: ${invited.status}`);

  const enrolled = await enrolClientUser({
    tenantId: fx.tenant.id,
    token: invited.value.token,
    password,
    actor: HUMAN(),
    now: NOW,
  });
  if (enrolled.status !== 'ok') throw new Error(`enrol failed: ${enrolled.status}`);
  return enrolled.value.id;
};

/** A staff-issued reset, which is the route that works while email is ungated. */
const issue = async (clientUserId: string, now = NOW): Promise<string> => {
  const issued = await issuePasswordReset({
    tenantId: fx.tenant.id,
    clientUserId,
    issuedBy: fx.human.id,
    verificationBasis: VERIFICATION,
    actor: HUMAN(),
    now,
  });
  if (issued.status !== 'ok') throw new Error(`issue failed: ${issued.status}`);
  return issued.value.token;
};

describe('the request endpoint says the same thing to every address', () => {
  it('answers identically for an enrolled user, an unknown address, an unenrolled user and a disabled one', async () => {
    const enrolled = await enrol('known@example.com');

    // Invited, never enrolled. Enrolment is what the invitation is for; a reset here would be a
    // second enrolment path that bypasses the invitation window.
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId,
      email: 'invited-only@example.com',
      displayName: 'Never Enrolled',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (invited.status !== 'ok') throw new Error('setup: invite');

    const disabledUser = await enrol('disabled@example.com');
    await disableClientUser({
      tenantId: fx.tenant.id,
      clientUserId: disabledUser,
      reason: 'Engagement ended.',
      actor: HUMAN(),
      now: NOW,
    });

    const answers = await Promise.all(
      [
        'known@example.com',
        'nobody-at-all@example.com',
        'invited-only@example.com',
        'disabled@example.com',
      ].map((email) => requestPasswordReset({ tenantId: fx.tenant.id, email, now: NOW })),
    );

    // Same status, same sentence, four times.
    const distinct = new Set(answers.map((answer) => JSON.stringify(answer)));
    expect(distinct.size).toBe(1);
    expect(answers[0]?.status).toBe('not_built');

    // And a reset row exists for exactly one of them.
    expect(await pendingPasswordResets(fx.tenant.id, enrolled, NOW)).toHaveLength(1);
    expect(await pendingPasswordResets(fx.tenant.id, invited.value.clientUserId, NOW)).toHaveLength(
      0,
    );
    expect(await pendingPasswordResets(fx.tenant.id, disabledUser, NOW)).toHaveLength(0);
  });

  it('records a self-service request with no issuer rather than an invented one', async () => {
    const userId = await enrol('self-service@example.com');
    await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'self-service@example.com',
      now: NOW,
    });

    const [pending] = await pendingPasswordResets(fx.tenant.id, userId, NOW);
    expect(pending?.source).toBe('self_service');
    // 6.4's rule: automatic in, human out. A service-account id here would be indistinguishable
    // from a human having decided something.
    expect(pending?.issuedBy).toBeNull();
  });

  it('cannot deliver, and says so rather than reporting success', async () => {
    await enrol('undeliverable@example.com');
    const answer = await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'undeliverable@example.com',
      now: NOW,
    });

    expect(answer.status).toBe('not_built');
    if (answer.status !== 'not_built') throw new Error('unreachable');
    expect(answer.module).toContain('11.5');
    // The uniform acknowledgement, not a description of what happened to this address.
    expect(answer.reason).toContain('If that address has a portal account');
  });
});

describe('requesting a reset changes nothing about the account', () => {
  it('leaves the current password working', async () => {
    await enrol('still-works@example.com');
    await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'still-works@example.com',
      now: NOW,
    });

    // Otherwise anybody who knows a client's email address ends their access by typing it into a
    // form: denial of service with no authentication at all.
    const signedIn = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'still-works@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(signedIn.status).toBe('ok');
  });

  it('does NOT clear a lockout, because that would be a lockout bypass', async () => {
    const userId = await enrol('locked-out@example.com');

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await authenticateClientUser({
        tenantId: fx.tenant.id,
        email: 'locked-out@example.com',
        password: 'wrong-but-long-enough',
        now: NOW,
      });
    }

    const locked = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(locked.lockedUntil).not.toBeNull();

    await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'locked-out@example.com',
      now: NOW,
    });

    // THE ASSERTION THIS BLOCK EXISTS FOR. Clearing the lock here reads as helping somebody who is
    // locked out and asking for help; it hands an attacker who has burned five guesses a way to
    // reset the counter and keep going, from an endpoint that requires nothing.
    const after = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(after.lockedUntil).toEqual(locked.lockedUntil);
    expect(after.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
  });

  it('clears the lockout on COMPLETION, where the caller proved they hold the token', async () => {
    const userId = await enrol('locked-then-reset@example.com');

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await authenticateClientUser({
        tenantId: fx.tenant.id,
        email: 'locked-then-reset@example.com',
        password: 'wrong-but-long-enough',
        now: NOW,
      });
    }

    const token = await issue(userId);
    const done = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: REPLACEMENT,
      now: NOW,
    });
    expect(done.status).toBe('ok');

    // The password being guessed no longer exists, so keeping the lock would punish the client for
    // the attacker's behaviour.
    const after = await db().clientUser.findFirstOrThrow({ where: { id: userId } });
    expect(after.lockedUntil).toBeNull();
    expect(after.failedAttempts).toBe(0);

    const signedIn = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'locked-then-reset@example.com',
      password: REPLACEMENT,
      now: NOW,
    });
    expect(signedIn.status).toBe('ok');
  });
});

describe('completing a reset', () => {
  it('replaces the password and retires the old one', async () => {
    const userId = await enrol('replaced@example.com');
    const token = await issue(userId);

    const done = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: REPLACEMENT,
      now: NOW,
    });
    expect(done.status).toBe('ok');

    const withOld = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'replaced@example.com',
      password: PASSWORD,
      now: NOW,
    });
    expect(withOld.status).toBe('refused');

    const withNew = await authenticateClientUser({
      tenantId: fx.tenant.id,
      email: 'replaced@example.com',
      password: REPLACEMENT,
      now: NOW,
    });
    expect(withNew.status).toBe('ok');
  });

  it('ends every live session', async () => {
    const userId = await enrol('sessions@example.com');

    // Two sessions: the client's own, and the one somebody else is holding.
    const mine = await signIn({
      tenantId: fx.tenant.id,
      email: 'sessions@example.com',
      password: PASSWORD,
      now: NOW,
    });
    const theirs = await signIn({
      tenantId: fx.tenant.id,
      email: 'sessions@example.com',
      password: PASSWORD,
      now: NOW,
    });
    if (mine.status !== 'ok' || theirs.status !== 'ok') throw new Error('setup: sign in');

    const token = await issue(userId);
    const done = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: REPLACEMENT,
      now: NOW,
    });
    if (done.status !== 'ok') throw new Error('reset failed');

    // THE ASSERTION THIS BLOCK EXISTS FOR. The reason a person resets a password is often that
    // somebody else has it, and a reset that left sessions running would leave the attacker holding
    // a valid cookie for twelve hours.
    expect(done.value.sessionsRevoked).toBe(2);
    for (const session of [mine.value.token, theirs.value.token]) {
      const resolved = await resolveSession({ tenantId: fx.tenant.id, token: session, now: NOW });
      expect(resolved.status).toBe('refused');
    }
  });

  it('refuses the password the account already has', async () => {
    const userId = await enrol('same-again@example.com');
    const token = await issue(userId);

    // Setting it back accomplishes nothing while looking like it accomplished something, and the
    // reason to reset is often that somebody else knows the current one.
    const done = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: PASSWORD,
      now: NOW,
    });
    expect(done.status).toBe('refused');
    if (done.status !== 'refused') throw new Error('unreachable');
    expect(done.reason).toContain('already has');
  });

  it('refuses a password below the length floor', async () => {
    const userId = await enrol('too-short@example.com');
    const token = await issue(userId);

    const done = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: 'short',
      now: NOW,
    });
    expect(done.status).toBe('refused');
    if (done.status !== 'refused') throw new Error('unreachable');
    expect(done.reason).toContain(String(MINIMUM_PASSWORD_LENGTH));
  });

  it('is single use', async () => {
    const userId = await enrol('single-use@example.com');
    const token = await issue(userId);

    const first = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: REPLACEMENT,
      now: NOW,
    });
    expect(first.status).toBe('ok');

    const second = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: 'a-third-password-entirely',
      now: NOW,
    });
    expect(second.status).toBe('refused');
  });

  it('answers a consumed, an expired and a fabricated token identically', async () => {
    const userId = await enrol('indistinguishable@example.com');

    const consumed = await issue(userId);
    await completePasswordReset({
      tenantId: fx.tenant.id,
      token: consumed,
      password: REPLACEMENT,
      now: NOW,
    });

    const expiredToken = await issue(userId);
    const afterExpiry = new Date(NOW.getTime() + (PASSWORD_RESET_MINUTES + 1) * 60 * 1000);

    const answers = await Promise.all([
      completePasswordReset({
        tenantId: fx.tenant.id,
        token: consumed,
        password: 'another-long-password',
        now: NOW,
      }),
      completePasswordReset({
        tenantId: fx.tenant.id,
        token: expiredToken,
        password: 'another-long-password',
        now: afterExpiry,
      }),
      completePasswordReset({
        tenantId: fx.tenant.id,
        token: 'a-token-that-was-never-real',
        password: 'another-long-password',
        now: NOW,
      }),
    ]);

    // Distinguishing them confirms a token was once real, which is what somebody holding a stale
    // one wants to know.
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  it('spends the outstanding reset when a newer one is issued', async () => {
    const userId = await enrol('superseded@example.com');
    const first = await issue(userId);
    const second = await issue(userId);

    // Two live tokens would mean revoking one and leaving the other.
    expect(await pendingPasswordResets(fx.tenant.id, userId, NOW)).toHaveLength(1);

    const withFirst = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: first,
      password: REPLACEMENT,
      now: NOW,
    });
    expect(withFirst.status).toBe('refused');

    const withSecond = await completePasswordReset({
      tenantId: fx.tenant.id,
      token: second,
      password: REPLACEMENT,
      now: NOW,
    });
    expect(withSecond.status).toBe('ok');
  });

  it('refuses a user disabled between issue and completion', async () => {
    const userId = await enrol('disabled-midway@example.com');
    const token = await issue(userId);

    await disableClientUser({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      reason: 'Access withdrawn while the email sat in an inbox.',
      actor: HUMAN(),
      now: NOW,
    });

    // The gap between issue and completion is exactly where an account changes standing.
    const done = await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: REPLACEMENT,
      now: NOW,
    });
    expect(done.status).toBe('refused');
  });
});

describe('a staff-issued reset', () => {
  it('needs a Level 3 human', async () => {
    const userId = await enrol('needs-level-three@example.com');

    for (const issuedBy of [fx.agent.id, fx.observer.id]) {
      const attempt = await issuePasswordReset({
        tenantId: fx.tenant.id,
        clientUserId: userId,
        issuedBy,
        verificationBasis: VERIFICATION,
        actor: { id: issuedBy, kind: 'village_agent' },
        now: NOW,
      });
      expect(attempt.status).toBe('refused');
    }
  });

  it('needs a recorded verification basis', async () => {
    const userId = await enrol('needs-verification@example.com');

    const attempt = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      issuedBy: fx.human.id,
      // The attack on this path is somebody phoning up and sounding convincing, and a blank field
      // is what that looks like afterwards.
      verificationBasis: 'phoned',
      actor: HUMAN(),
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toContain('verified');
  });

  it('records the basis where it cannot be edited afterwards', async () => {
    const userId = await enrol('recorded-basis@example.com');
    await issue(userId);

    const events = await read(fx.tenant.id);
    const issued = events.find(
      (event) =>
        event.type === 'identity.client_user.password_reset_issued' &&
        (event.payload as { clientUserId?: string }).clientUserId === userId,
    );

    expect(issued).toBeDefined();
    expect((issued?.payload as { verificationBasis?: string }).verificationBasis).toBe(
      VERIFICATION,
    );
    expect((issued?.payload as { issuedBy?: string }).issuedBy).toBe(fx.human.id);
  });

  it('refuses a user who never enrolled, because that is what an invitation is for', async () => {
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId,
      email: 'never-enrolled-staff@example.com',
      displayName: 'Never Enrolled',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (invited.status !== 'ok') throw new Error('setup: invite');

    const attempt = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: invited.value.clientUserId,
      issuedBy: fx.human.id,
      verificationBasis: VERIFICATION,
      actor: HUMAN(),
      now: NOW,
    });
    expect(attempt.status).toBe('refused');
    if (attempt.status !== 'refused') throw new Error('unreachable');
    expect(attempt.reason).toContain('invitation');
  });
});

describe('no credential material leaves the module', () => {
  it('puts no token in any Ledger payload', async () => {
    const userId = await enrol('ledger-clean@example.com');
    const token = await issue(userId);
    await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'ledger-clean@example.com',
      now: NOW,
    });
    await completePasswordReset({
      tenantId: fx.tenant.id,
      token,
      password: REPLACEMENT,
      now: NOW,
    });

    const events = await read(fx.tenant.id);
    const resetEvents = events.filter((event) => event.type.includes('password_reset'));
    expect(resetEvents.length).toBeGreaterThanOrEqual(2);

    const serialised = JSON.stringify(resetEvents);
    expect(serialised).not.toContain(token);
    // Not the hash either. It is not a credential, but it is what a reset is looked up by, and the
    // Ledger is readable by more people than the identity schema.
    expect(serialised).not.toContain(REPLACEMENT);
    expect(serialised).not.toContain(PASSWORD);
  });

  it('never returns the token from the unauthenticated request path', async () => {
    const userId = await enrol('no-token-back@example.com');
    const answer = await requestPasswordReset({
      tenantId: fx.tenant.id,
      email: 'no-token-back@example.com',
      now: NOW,
    });

    const [pending] = await pendingPasswordResets(fx.tenant.id, userId, NOW);
    expect(pending).toBeDefined();

    // A reset was created, and nothing about it came back to the caller. The value has no field a
    // token could occupy.
    expect(JSON.stringify(answer)).not.toContain(pending?.id ?? 'unreachable');
    expect(Object.keys(answer)).toEqual(['status', 'module', 'reason']);
  });
});
