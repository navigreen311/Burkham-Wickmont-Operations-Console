/**
 * Client authentication for 11.10, end to end.
 *
 * Three properties carry this file.
 *
 * **A client user is not an Actor.** The first assertion is that `findActor` cannot resolve a
 * client user id, because that is the boundary the whole design rests on - and a build that made
 * client users Actor rows at Level 0 would pass every other test here.
 *
 * **Every failure gives the same answer.** An unknown email, a wrong password, an unenrolled user
 * and a disabled one are indistinguishable, or the endpoint tells an attacker which addresses are
 * clients of this firm.
 *
 * **A disabled account stops working on the next request**, not when its session happens to lapse.
 * Tested by disabling mid-session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  MAX_FAILED_ATTEMPTS,
  MINIMUM_PASSWORD_LENGTH,
  SESSION_ABSOLUTE_HOURS,
  SESSION_IDLE_MINUTES,
  activeSessions,
  disableClientUser,
  enrolClientUser,
  findActor,
  findClientUser,
  hashPassword,
  inviteClientUser,
  verifyPassword,
} from '@bwc/identity';
import { clientRoom, principalFromToken, signIn, signOut, uploadDocument } from '@bwc/portal';
import { EnvKekProvider, LocalEncryptedStore, generateKek, type VaultConfig } from '@bwc/vault';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let alpha: string;
let beta: string;
let vault: VaultConfig;

const NOW = new Date('2026-08-11T12:00:00.000Z');
const PASSWORD = 'a-long-enough-portal-password';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('client-auth');
  const root = await mkdtemp(join(tmpdir(), 'bwc-auth-'));
  process.env['VAULT_AUTH_KEK'] = generateKek();
  vault = { store: new LocalEncryptedStore(root), kek: new EnvKekProvider('VAULT_AUTH_KEK') };

  const [a, b] = await Promise.all([
    createClient(fx.tenant.id, 'Alpha Manufacturing LLC', HUMAN()),
    createClient(fx.tenant.id, 'Beta Logistics LLC', HUMAN()),
  ]);
  alpha = a.id;
  beta = b.id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

/** Invite and enrol, returning the user id. */
const enrol = async (clientId: string, email: string, password = PASSWORD) => {
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
  return { userId: enrolled.value.id, invitationToken: invited.value.token };
};

describe('a client user is not an Actor', () => {
  it('is not resolvable by findActor', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR.
    //
    // `vault.read` grants on tenant + authority level with NO ownership check, and
    // MINIMUM_LEVEL_TO_READ puts bank_statement at level 0. A client holding a Level 0 Actor row
    // could read ANY client's bank statements in the tenant. A build that made client users Actors
    // would pass every other test in this file and fail here.
    const { userId } = await enrol(alpha, 'alpha-owner@example.com');

    expect(await findActor(userId)).toBeNull();

    const asActor = await db().actor.findFirst({ where: { id: userId } });
    expect(asActor).toBeNull();
  });

  it('has no authority level to hold', async () => {
    const user = await findClientUser(
      fx.tenant.id,
      (await enrol(beta, 'beta-owner@example.com')).userId,
    );
    expect(user).not.toBeNull();
    expect(Object.keys(user as object)).not.toContain('authorityLevel');
  });

  it('acts on the Ledger as kind `client`', async () => {
    const events = await read({
      tenantId: fx.tenant.id,
      clientId: alpha,
      type: 'identity.client_user.enrolled',
    });
    expect(events.length).toBeGreaterThan(0);
    // A client enrolling and a staff member enrolling on their behalf are different acts, and
    // recording both as `human` would blur the line `sign_for_client` is drawn along.
    expect(events[0]?.actor.kind).toBe('client');
  });
});

describe('enrolment is an invitation, not a signup', () => {
  it('takes a Level 3 human to invite', async () => {
    const byAgent = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId: alpha,
      email: 'agent-invited@example.com',
      displayName: 'Somebody',
      issuedBy: fx.agent.id,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');
  });

  it('refuses an invitation for a client that does not exist', async () => {
    const result = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId: '00000000-0000-4000-8000-000000000000',
      email: 'nobody@example.com',
      displayName: 'Somebody',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('no_data');
  });

  it('stores the invitation token hashed, never in the clear', async () => {
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId: alpha,
      email: 'hashed-token@example.com',
      displayName: 'Token Test',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (invited.status !== 'ok') throw new Error('setup');

    const rows = await db().clientInvitation.findMany({ where: { tenantId: fx.tenant.id } });
    expect(rows.map((row) => row.tokenHash)).not.toContain(invited.value.token);
    // And the token is not in a Ledger payload either.
    const events = await read({ tenantId: fx.tenant.id, type: 'identity.client_user.invited' });
    expect(JSON.stringify(events)).not.toContain(invited.value.token);
  });

  it('spends an invitation on use', async () => {
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId: alpha,
      email: 'single-use@example.com',
      displayName: 'Single Use',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (invited.status !== 'ok') throw new Error('setup');

    expect(
      (
        await enrolClientUser({
          tenantId: fx.tenant.id,
          token: invited.value.token,
          password: PASSWORD,
          actor: HUMAN(),
          now: NOW,
        })
      ).status,
    ).toBe('ok');

    // A token read from a forwarded email cannot be used after the client has enrolled.
    const second = await enrolClientUser({
      tenantId: fx.tenant.id,
      token: invited.value.token,
      password: 'another-long-enough-password',
      actor: HUMAN(),
      now: NOW,
    });
    expect(second.status).toBe('refused');
    if (second.status === 'refused') expect(second.reason).toMatch(/already been used/);
  });

  it('refuses an expired invitation', async () => {
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId: alpha,
      email: 'expired@example.com',
      displayName: 'Expired',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (invited.status !== 'ok') throw new Error('setup');

    const later = new Date(NOW.getTime() + 80 * 60 * 60 * 1000);
    const result = await enrolClientUser({
      tenantId: fx.tenant.id,
      token: invited.value.token,
      password: PASSWORD,
      actor: HUMAN(),
      now: later,
    });
    expect(result.status).toBe('refused');
  });

  it('refuses a short password and stores no plaintext', async () => {
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId: alpha,
      email: 'weak@example.com',
      displayName: 'Weak',
      issuedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (invited.status !== 'ok') throw new Error('setup');

    const short = await enrolClientUser({
      tenantId: fx.tenant.id,
      token: invited.value.token,
      password: 'short',
      actor: HUMAN(),
      now: NOW,
    });
    expect(short.status).toBe('refused');
    if (short.status === 'refused') {
      expect(short.reason).toMatch(new RegExp(String(MINIMUM_PASSWORD_LENGTH)));
      // No composition rules - they push people toward 'Password1!'.
      expect(short.reason).toMatch(/no composition rules/);
    }

    const stored = await db().clientUser.findMany({ where: { tenantId: fx.tenant.id } });
    expect(stored.map((row) => row.passwordHash)).not.toContain(PASSWORD);
    expect(stored.every((row) => !row.passwordHash.includes(PASSWORD))).toBe(true);
  });
});

describe('credentials', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('not-the-password', hash)).toBe(false);
  });

  it('produces a different hash for the same password each time', async () => {
    // Per-user salt. Two clients choosing the same password must not be visible as such in the
    // table, which is what an unsalted hash would show.
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('carries its cost parameters with the hash', async () => {
    // A stored hash that did not record them could not be verified after somebody raised them.
    const [scheme, cost] = (await hashPassword(PASSWORD)).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number.parseInt(cost as string, 10)).toBe(2 ** 15);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A throw would be distinguishable from a wrong password by the caller - the same leak in a
    // different shape.
    expect(await verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$a$b$c$d$e')).toBe(false);
  });
});

describe('authentication gives one answer to every failure', () => {
  const email = 'same-answer@example.com';

  beforeAll(async () => {
    await enrol(alpha, email);
  });

  it('refuses an unknown email and a wrong password identically', async () => {
    const unknown = await signIn({
      tenantId: fx.tenant.id,
      email: 'nobody-here@example.com',
      password: PASSWORD,
      now: NOW,
    });
    const wrong = await signIn({
      tenantId: fx.tenant.id,
      email,
      password: 'not-the-right-password',
      now: NOW,
    });

    expect(unknown.status).toBe('refused');
    expect(wrong.status).toBe('refused');
    if (unknown.status !== 'refused' || wrong.status !== 'refused') return;
    // Identical, or the endpoint is an oracle telling an attacker which addresses are clients of
    // this firm - which is itself the disclosure.
    expect(unknown.reason).toBe(wrong.reason);
  });

  it('signs in with the right password', async () => {
    const result = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.token.length).toBeGreaterThan(20);
    expect(result.value.displayName).toBe('A Client Person');
  });

  it('locks out after repeated failures, and the lock is reported differently', async () => {
    const lockEmail = 'lockout@example.com';
    await enrol(alpha, lockEmail);

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      const result = await signIn({
        tenantId: fx.tenant.id,
        email: lockEmail,
        password: 'wrong-password-attempt',
        now: NOW,
      });
      expect(result.status).toBe('refused');
    }

    // Now locked. The message DOES differ here, deliberately: the account is known to the person
    // being told, because they just failed against it five times.
    const locked = await signIn({
      tenantId: fx.tenant.id,
      email: lockEmail,
      password: PASSWORD,
      now: NOW,
    });
    expect(locked.status).toBe('refused');
    if (locked.status === 'refused') expect(locked.reason).toMatch(/Too many failed attempts/);

    // And it clears.
    const afterLock = new Date(NOW.getTime() + 20 * 60 * 1000);
    const cleared = await signIn({
      tenantId: fx.tenant.id,
      email: lockEmail,
      password: PASSWORD,
      now: afterLock,
    });
    expect(cleared.status).toBe('ok');
  });

  it('records failures on the Ledger, and no credential material', async () => {
    const events = await read({
      tenantId: fx.tenant.id,
      type: 'identity.client_user.sign_in_failed',
    });
    expect(events.length).toBeGreaterThan(0);
    // A run of failures against one client file is the signal that matters, and it is invisible
    // if only successes are recorded.
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain('wrong-password-attempt');
  });
});

describe('sessions', () => {
  let token: string;
  const email = 'session-user@example.com';

  beforeAll(async () => {
    await enrol(alpha, email);
    const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    if (signedIn.status !== 'ok') throw new Error('setup');
    token = signedIn.value.token;
  });

  it("resolves to a principal on the client's own file", async () => {
    const principal = await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW });
    expect(principal.status).toBe('ok');
    if (principal.status !== 'ok') return;
    expect(principal.value.clientId).toBe(alpha);
    // The client user's own id, not a service account: a hundred clients sharing one actor id
    // would make every access record say the same thing.
    expect(principal.value.actorId).not.toBe(fx.human.id);
  });

  it('drives the portal with nothing else supplied', async () => {
    const principal = await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW });
    if (principal.status !== 'ok') return;

    const room = await clientRoom(principal.value);
    expect(room.status).toBe('ok');
    if (room.status === 'ok') expect(room.value.clientLegalName).toBe('Alpha Manufacturing LLC');

    const uploaded = await uploadDocument({
      principal: principal.value,
      kind: 'bank_statement',
      filename: 'august.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 statement'),
      vaultConfig: vault,
    });
    // The vault resolves an internal Actor and a client user is deliberately not one, so this
    // refuses rather than silently attributing the upload to somebody else. Named in the PR as
    // the follow-on, not papered over here.
    expect(uploaded.status).toBe('refused');
  });

  it('refuses an unknown, expired or idle session identically', async () => {
    const unknown = await principalFromToken({
      tenantId: fx.tenant.id,
      token: 'not-a-real-token',
      now: NOW,
    });
    const expired = await principalFromToken({
      tenantId: fx.tenant.id,
      token,
      now: new Date(NOW.getTime() + (SESSION_ABSOLUTE_HOURS + 1) * 60 * 60 * 1000),
    });
    const idle = await principalFromToken({
      tenantId: fx.tenant.id,
      token,
      now: new Date(NOW.getTime() + (SESSION_IDLE_MINUTES + 5) * 60 * 1000),
    });

    for (const result of [unknown, expired, idle]) {
      expect(result.status).toBe('refused');
    }
    if (unknown.status === 'refused' && expired.status === 'refused' && idle.status === 'refused') {
      // A caller cannot tell an expired session from a revoked one from a token that never
      // existed, which stops the endpoint confirming a token was once real.
      expect(unknown.reason).toBe(expired.reason);
      expect(expired.reason).toBe(idle.reason);
    }
  });

  it('slides the idle window on use', async () => {
    const halfway = new Date(NOW.getTime() + (SESSION_IDLE_MINUTES - 5) * 60 * 1000);
    expect((await principalFromToken({ tenantId: fx.tenant.id, token, now: halfway })).status).toBe(
      'ok',
    );
    // Still valid slightly beyond the original idle deadline, because the previous call moved it.
    const beyondOriginal = new Date(halfway.getTime() + (SESSION_IDLE_MINUTES - 5) * 60 * 1000);
    expect(
      (await principalFromToken({ tenantId: fx.tenant.id, token, now: beyondOriginal })).status,
    ).toBe('ok');
  });

  it('signs out, and the token stops working', async () => {
    expect((await signOut({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe('ok');
    expect((await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'refused',
    );
  });
});

describe('disabling takes effect on the next request', () => {
  it('stops a live session immediately', async () => {
    const email = 'to-be-disabled@example.com';
    const { userId } = await enrol(alpha, email);

    const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    if (signedIn.status !== 'ok') throw new Error('setup');
    const token = signedIn.value.token;

    expect((await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'ok',
    );
    expect((await activeSessions(fx.tenant.id, userId, NOW)).length).toBe(1);

    const disabled = await disableClientUser({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      reason: 'Engagement ended; portal access withdrawn.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(disabled.status).toBe('ok');

    // THE ASSERTION. Not at session expiry - "revoke this person's access" means now.
    expect((await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'refused',
    );
    expect((await activeSessions(fx.tenant.id, userId, NOW)).length).toBe(0);

    // And they cannot sign in again to get a fresh one.
    expect(
      (await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW })).status,
    ).toBe('refused');
  });

  it('catches a disabled user even when their session was never revoked', async () => {
    // `disableClientUser` does two things: it revokes live sessions AND `resolveSession` re-reads
    // the user. The first alone passes the test above, so this exercises the second on its own -
    // found by a mutation that removed the user re-check and broke nothing.
    //
    // The case is real rather than contrived: any future path that disables a user without going
    // through `disableClientUser` - an admin tool, a partial failure mid-transaction - leaves live
    // sessions behind, and the resolve-time check is what stops them working.
    const email = 'stale-session@example.com';
    const { userId } = await enrol(alpha, email);

    const signedIn = await signIn({ tenantId: fx.tenant.id, email, password: PASSWORD, now: NOW });
    if (signedIn.status !== 'ok') throw new Error('setup');
    const token = signedIn.value.token;

    expect((await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'ok',
    );

    // Disable the user WITHOUT touching sessions.
    await db().clientUser.update({
      where: { id: userId },
      data: { disabledAt: NOW, disabledReason: 'Disabled by a path that left sessions alone.' },
    });

    const stillLive = await db().clientSession.findFirst({
      where: { clientUserId: userId, revokedAt: null },
    });
    expect(stillLive).not.toBeNull();

    // The session row is untouched, so only the resolve-time user check can catch this.
    expect((await principalFromToken({ tenantId: fx.tenant.id, token, now: NOW })).status).toBe(
      'refused',
    );
  });

  it('refuses to disable without a reason', async () => {
    const { userId } = await enrol(beta, 'reason-required@example.com');
    const result = await disableClientUser({
      tenantId: fx.tenant.id,
      clientUserId: userId,
      reason: 'no',
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });
});
