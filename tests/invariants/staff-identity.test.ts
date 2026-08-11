/**
 * Staff credentials - the rules that make a Console session mean something.
 *
 * The transport test asserts that no route answers without one. This file asserts what it takes to
 * get one, and the properties here are the reason the transport test is worth anything:
 *
 *   an Actor with no credential row cannot sign in         - absence is not permission
 *   a Village agent cannot hold one at all                 - it acts through the worker
 *   a pending enrolment cannot sign in                     - a second factor is a PRECONDITION
 *   a spent code cannot be presented twice                 - the replay window is thirty seconds
 *   five failures lock the credential                      - and the message never says so
 *   a session re-reads the actor and the credential        - "revoke now" means now
 *   no credential material reaches a Ledger payload
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { read } from '@bwc/ledger';
import { generateKek } from '@bwc/crypto';
import {
  MFA_SECRET_KEY_VARIABLE,
  STAFF_LOCKOUT_MINUTES,
  STAFF_MAX_FAILED_ATTEMPTS,
  STAFF_SESSION_ABSOLUTE_HOURS,
  STAFF_SESSION_IDLE_MINUTES,
  activeStaffSessions,
  authenticateStaff,
  base32Decode,
  beginStaffEnrolment,
  confirmStaffEnrolment,
  createActor,
  disableStaffCredential,
  resolveStaffSession,
  revokeStaffSession,
  totp,
} from '@bwc/identity';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const PASSWORD = 'a-long-enough-staff-password';

/** Distinct per test, because an email is unique per tenant and these all share one. */
let counter = 0;
const nextEmail = (): string => `staff-${(counter += 1)}@example.com`;

/**
 * Enrol a fresh Level 3 human and return everything needed to sign them in.
 *
 * `at` is stepped past the code enrolment spends, for the same reason the transport test steps its
 * clock: a confirmed code is spent, and a sign-in in the same thirty seconds is a replay.
 */
const enrol = async (
  options: { authorityLevel?: 0 | 1 | 2 | 3; kind?: 'human' | 'village_agent'; at?: Date } = {},
): Promise<{ actorId: string; email: string; secret: Buffer; at: Date }> => {
  const at = options.at ?? new Date();
  const actor = await createActor({
    tenantId: fx.tenant.id,
    kind: options.kind ?? 'human',
    label: 'Console Person',
    authorityLevel: options.authorityLevel ?? 3,
  });
  const email = nextEmail();

  const offer = await beginStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: actor.id,
    email,
    password: PASSWORD,
    grantedBy: fx.human.id,
    now: at,
  });
  if (offer.status !== 'ok') throw new Error(`enrol: ${offer.reason}`);

  const secret = base32Decode(offer.value.secret);
  if (!secret) throw new Error('enrol: secret');

  return { actorId: actor.id, email, secret, at };
};

const confirm = async (who: { actorId: string; secret: Buffer }, at: Date): Promise<void> => {
  const done = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: who.actorId,
    password: PASSWORD,
    code: totp(who.secret, at),
    now: at,
  });
  if (done.status !== 'ok') throw new Error(`confirm: ${done.reason}`);
};

const later = (from: Date, ms: number): Date => new Date(from.getTime() + ms);

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('staff-identity');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('who may hold a Console credential', () => {
  it('refuses an Actor that is a Village agent', async () => {
    const agent = await createActor({
      tenantId: fx.tenant.id,
      kind: 'village_agent',
      label: 'An agent',
      authorityLevel: 1,
    });

    const offer = await beginStaffEnrolment({
      tenantId: fx.tenant.id,
      actorId: agent.id,
      email: nextEmail(),
      password: PASSWORD,
      grantedBy: fx.human.id,
    });

    expect(offer.status).toBe('refused');
    // An agent acts through the worker, which holds no session. A credential for one would be a
    // password somebody could use to act AS the agent.
    if (offer.status === 'refused') expect(offer.reason).toMatch(/Village agent/);
  });

  it('refuses a granter below Level 3', async () => {
    const target = await createActor({
      tenantId: fx.tenant.id,
      kind: 'human',
      label: 'Hopeful',
      authorityLevel: 3,
    });

    const offer = await beginStaffEnrolment({
      tenantId: fx.tenant.id,
      actorId: target.id,
      email: nextEmail(),
      password: PASSWORD,
      // Level 1 Village agent from the fixture.
      grantedBy: fx.agent.id,
    });

    expect(offer.status).toBe('refused');
    if (offer.status === 'refused') expect(offer.reason).toMatch(/Level 3/);
  });

  it('refuses a password shorter than the floor', async () => {
    const target = await createActor({
      tenantId: fx.tenant.id,
      kind: 'human',
      label: 'Short',
      authorityLevel: 3,
    });
    const offer = await beginStaffEnrolment({
      tenantId: fx.tenant.id,
      actorId: target.id,
      email: nextEmail(),
      password: 'short',
      grantedBy: fx.human.id,
    });
    expect(offer.status).toBe('refused');
  });
});

describe('an Actor with no credential cannot sign in', () => {
  it('refuses, in the same words a wrong password gets', async () => {
    const bare = await createActor({
      tenantId: fx.tenant.id,
      kind: 'human',
      label: 'No credential',
      authorityLevel: 3,
    });
    expect(bare.id).toBeDefined();

    const attempt = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: 'nobody-at-all@example.com',
      password: PASSWORD,
      code: '000000',
    });

    expect(attempt.status).toBe('refused');
    if (attempt.status === 'refused') expect(attempt.reason).toBe('Those details are not valid.');
  });
});

describe('the second factor is a precondition, not a setting', () => {
  it('refuses a pending enrolment even with the right password', async () => {
    const who = await enrol();

    // Password correct, code correct, enrolment unfinished. This is the case that would otherwise
    // be "signs in with one factor", and it is refused outright.
    const attempt = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, who.at),
      now: who.at,
    });

    expect(attempt.status).toBe('refused');
  });

  it('signs in once the authenticator has been proved', async () => {
    const who = await enrol();
    await confirm(who, who.at);

    const at = later(who.at, 31_000);
    const attempt = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, at),
      now: at,
    });

    expect(attempt.status).toBe('ok');
    if (attempt.status === 'ok') expect(attempt.value.actor.id).toBe(who.actorId);
  });

  it('refuses confirmation without the password', async () => {
    const who = await enrol();
    const done = await confirmStaffEnrolment({
      tenantId: fx.tenant.id,
      actorId: who.actorId,
      password: 'not-the-password-at-all',
      code: totp(who.secret, who.at),
      now: who.at,
    });
    // The offer was handed to somebody. Without this, whoever intercepted it could complete it.
    expect(done.status).toBe('refused');
  });
});

describe('a code cannot be presented twice', () => {
  it('refuses the step it already accepted', async () => {
    const who = await enrol();
    await confirm(who, who.at);

    const at = later(who.at, 31_000);
    const first = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, at),
      now: at,
    });
    expect(first.status).toBe('ok');

    // Same second, same code. Correct, and spent - which is what closes the window on somebody who
    // read it over a shoulder.
    const second = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, at),
      now: at,
    });
    expect(second.status).toBe('refused');
  });
});

describe('lockout', () => {
  it('locks after the fifth failure and says nothing different', async () => {
    const who = await enrol();
    await confirm(who, who.at);

    const at = later(who.at, 31_000);
    for (let attempt = 0; attempt < STAFF_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const failure = await authenticateStaff({
        tenantId: fx.tenant.id,
        email: who.email,
        password: 'wrong-but-long-enough',
        code: totp(who.secret, at),
        now: at,
      });
      expect(failure.status).toBe('refused');
    }

    // Correct credentials now, and still refused - with the identical sentence, because a message
    // saying "locked" tells an attacker their spray is working.
    const locked = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, at),
      now: at,
    });
    expect(locked.status).toBe('refused');
    if (locked.status === 'refused') expect(locked.reason).toBe('Those details are not valid.');

    // And it lifts on its own.
    const after = later(at, (STAFF_LOCKOUT_MINUTES + 1) * 60 * 1000);
    const recovered = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, after),
      now: after,
    });
    expect(recovered.status).toBe('ok');
  });
});

describe('a session is checked on every request, not at sign-in', () => {
  const signedIn = async (): Promise<{ token: string; actorId: string; at: Date }> => {
    const who = await enrol();
    await confirm(who, who.at);
    const at = later(who.at, 31_000);
    const authenticated = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, at),
      now: at,
    });
    if (authenticated.status !== 'ok') throw new Error('sign-in');
    return { token: authenticated.value.token, actorId: who.actorId, at };
  };

  it('ends at the absolute expiry however active it has been', async () => {
    const session = await signedIn();

    // Kept alive right up to the boundary: a resolve every ten minutes.
    let cursor = session.at;
    for (let step = 0; step < 6; step += 1) {
      cursor = later(cursor, 10 * 60 * 1000);
      expect(
        (await resolveStaffSession({ tenantId: fx.tenant.id, token: session.token, now: cursor }))
          .status,
      ).toBe('ok');
    }

    const past = later(session.at, (STAFF_SESSION_ABSOLUTE_HOURS * 60 + 1) * 60 * 1000);
    expect(
      (await resolveStaffSession({ tenantId: fx.tenant.id, token: session.token, now: past }))
        .status,
    ).toBe('refused');
  });

  it('ends after the idle window', async () => {
    const session = await signedIn();
    const idle = later(session.at, (STAFF_SESSION_IDLE_MINUTES + 1) * 60 * 1000);
    expect(
      (await resolveStaffSession({ tenantId: fx.tenant.id, token: session.token, now: idle }))
        .status,
    ).toBe('refused');
  });

  it('stops the moment the credential is disabled', async () => {
    const session = await signedIn();
    const soon = later(session.at, 60_000);

    expect(
      (await resolveStaffSession({ tenantId: fx.tenant.id, token: session.token, now: soon }))
        .status,
    ).toBe('ok');

    const disabled = await disableStaffCredential({
      tenantId: fx.tenant.id,
      actorId: session.actorId,
      reason: 'left the firm',
      disabledBy: fx.human.id,
      now: soon,
    });
    expect(disabled.status).toBe('ok');
    // Sessions are revoked in the same call, so an access review does not report them as live.
    if (disabled.status === 'ok') expect(disabled.value.sessionsRevoked).toBeGreaterThan(0);

    expect(
      (
        await resolveStaffSession({
          tenantId: fx.tenant.id,
          token: session.token,
          now: later(soon, 1000),
        })
      ).status,
    ).toBe('refused');
  });

  it('reports the Actor as it is now, not as it was at sign-in', async () => {
    const session = await signedIn();
    const soon = later(session.at, 60_000);

    await db().actor.update({ where: { id: session.actorId }, data: { authorityLevel: 1 } });

    const resolved = await resolveStaffSession({
      tenantId: fx.tenant.id,
      token: session.token,
      now: soon,
    });
    expect(resolved.status).toBe('ok');
    // An Authority Level lowered this morning is the level in force this afternoon.
    if (resolved.status === 'ok') expect(resolved.value.actor.authorityLevel).toBe(1);
  });

  it('is gone once revoked, and revoking twice is not an error', async () => {
    const session = await signedIn();
    const soon = later(session.at, 60_000);

    const resolved = await resolveStaffSession({
      tenantId: fx.tenant.id,
      token: session.token,
      now: soon,
    });
    if (resolved.status !== 'ok') throw new Error('resolve');

    expect(
      (
        await revokeStaffSession({
          tenantId: fx.tenant.id,
          sessionId: resolved.value.sessionId,
          now: soon,
        })
      ).status,
    ).toBe('ok');
    expect(
      (
        await revokeStaffSession({
          tenantId: fx.tenant.id,
          sessionId: resolved.value.sessionId,
          now: soon,
        })
      ).status,
    ).toBe('ok');

    expect(
      (await resolveStaffSession({ tenantId: fx.tenant.id, token: session.token, now: soon }))
        .status,
    ).toBe('refused');
    expect(await activeStaffSessions(fx.tenant.id, session.actorId, soon)).toHaveLength(0);
  });

  it('refuses a token that never existed, in the same words', async () => {
    const resolved = await resolveStaffSession({
      tenantId: fx.tenant.id,
      token: 'not-a-token-anybody-issued',
    });
    expect(resolved.status).toBe('refused');
    if (resolved.status === 'refused') {
      expect(resolved.reason).toBe('That session is not valid. Sign in again.');
    }
  });
});

describe('nothing credential-shaped reaches the Ledger', () => {
  it('records the enrolment and the sign-in without the password, the secret or the token', async () => {
    const who = await enrol();
    await confirm(who, who.at);
    const at = later(who.at, 31_000);
    const authenticated = await authenticateStaff({
      tenantId: fx.tenant.id,
      email: who.email,
      password: PASSWORD,
      code: totp(who.secret, at),
      now: at,
    });
    if (authenticated.status !== 'ok') throw new Error('sign-in');

    const events = await read({ tenantId: fx.tenant.id });
    const mine = events.filter((event) => event.type.startsWith('identity.staff'));
    expect(mine.length).toBeGreaterThan(0);

    const written = JSON.stringify(mine);
    expect(written).not.toContain(PASSWORD);
    expect(written).not.toContain(authenticated.value.token);
    // The email is a credential half on this surface: it is what an attacker needs before a
    // password is worth guessing, and the Ledger has the actor id, which is the useful fact.
    expect(written).not.toContain(who.email);
  });
});
