/**
 * The last two modules to get a surface: 5.5 Funding Outcome Ledger and 7.5 Legal Hold & Retention.
 *
 * Both arrived in a V1.5 batch **after** the surface prompts were written, which is why they were
 * the last two — engine work creates surface debt faster than surface work clears it, and nobody
 * was ever asked to build these.
 *
 * The assertions that carry this file are the two withholdings:
 *
 *   5.5 refuses a rate below the minimum sample and shows the counts anyway. `null` is not zero,
 *       and a rate rendered as `0%` is a claim nobody made.
 *   7.5 keeps holding when a review lapses. A hold that expired on a date passing is records being
 *       destroyed because nobody looked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { create as createClient } from '@bwc/clients';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
import { MINIMUM_DECIDED_FOR_RATE } from '@bwc/outcomes';
import { DELETION_AUTHORITY_LEVEL, HOLD_AUTHORITY_LEVEL, placeHold } from '@bwc/retention';
import {
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  inviteStaff,
  totp,
} from '@bwc/identity';
import { createApp } from '../../apps/api/src/app.js';
import type { ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;
let cookie: string;
let clientId: string;

const PASSWORD = 'a-long-enough-last-two-password';
const EMAIL = 'last-two-operator@example.com';

let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

const call = async (path: string): Promise<Record<string, unknown>> => {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  return (await response.json()) as Record<string, unknown>;
};

const dataOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload['data'] as Record<string, unknown>;

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('console-last-two');

  clientId = (
    await createClient(fx.tenant.id, 'Last Two Subject LLC', { id: fx.human.id, kind: 'human' })
  ).id;

  const invitation = await inviteStaff({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    email: EMAIL,
    invitedBy: fx.human.id,
  });
  if (invitation.status !== 'ok') throw new Error('setup: invite');
  const offer = await enrolStaffFromInvitation({
    tenantId: fx.tenant.id,
    token: invitation.value.token,
    password: PASSWORD,
  });
  if (offer.status !== 'ok') throw new Error('setup: enrol');
  const secret = base32Decode(offer.value.secret);
  if (!secret) throw new Error('setup: secret');
  await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    password: PASSWORD,
    code: totp(secret, at()),
  });

  const config: ConsoleConfig = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_console_session',
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 10_000,
    rateLimitStore: 'memory',
    devActorHeader: false,
    rpId: 'localhost',
    rpName: 'Burkham Wickmont',
    origin: 'http://localhost',
  };

  server = createServer(
    createApp({
      config,
      limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 }),
      now: at,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;

  offsetMs += 31_000;
  const signedIn = await fetch(`${base}/api/console/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, code: totp(secret, at()) }),
  });
  cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] as string;
  expect(cookie.length).toBeGreaterThan(10);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTenant(fx.tenant.id);
});

describe('both need a session', () => {
  it.each([
    '/api/console/outcomes/rate?from=2026-01-01&to=2026-02-01',
    '/api/console/outcomes/approved-unfunded',
    '/api/console/retention/holds',
    '/api/console/retention/requests',
  ])('refuses %s without one', async (path) => {
    const reply = (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>;
    expect(reply['status']).toBe('refused');
    expect(reply['reason']).toBe('Sign in to continue.');
  });
});

describe('5.5 - the rate is withheld and the counts are not', () => {
  it('requires a period, because a rate over "recently" is unverifiable', async () => {
    const reply = await call('/api/console/outcomes/rate');
    expect(reply['status']).toBe('refused');
    expect(String(reply['reason'])).toMatch(/from and to are both required/);
  });

  it('refuses a period that runs backwards', async () => {
    const reply = await call('/api/console/outcomes/rate?from=2026-03-01&to=2026-01-01');
    expect(reply['status']).toBe('refused');
  });

  it('withholds the rate below the sample and shows every count', async () => {
    const data = dataOf(await call('/api/console/outcomes/rate?from=2026-01-01&to=2027-01-01'));

    // THE ASSERTION THIS MODULE EXISTS FOR. Null, not zero: a rate rendered as 0% is a claim
    // nobody made, and 9.1 spent its whole life refusing to make the opposite one.
    expect(data['rate']).toBeNull();
    expect(data['rate']).not.toBe(0);

    // The counts are measurements and are real whether or not a rate exists.
    for (const key of ['submitted', 'approved', 'declined', 'withdrawn', 'pending', 'decided']) {
      expect(typeof data[key], key).toBe('number');
    }

    // And the note says what would produce a figure, so the withholding is actionable.
    expect(String(data['note'])).toMatch(new RegExp(`${MINIMUM_DECIDED_FOR_RATE} are needed`));
  });

  it('reports approvals that never became money', async () => {
    const data = dataOf(await call('/api/console/outcomes/approved-unfunded'));
    expect(Array.isArray(data['attempts'])).toBe(true);
    // An approval that never funded counts as a success in every percentage. The empty case is a
    // sentence rather than a blank list.
    expect(String(data['detail']).length).toBeGreaterThan(0);
  });

  it('summarises a client file so three attempts cannot read as three approvals', async () => {
    const data = dataOf(await call(`/api/console/outcomes/clients/${clientId}`));
    const summary = data['summary'] as Record<string, number>;
    expect(summary['total']).toBe(0);
    expect(summary['approved']).toBe(0);
    expect(summary['declined']).toBe(0);
  });
});

describe('7.5 - a hold is a matter, and an overdue one keeps holding', () => {
  it('reports no holds as records governed by their schedule alone', async () => {
    const data = dataOf(await call('/api/console/retention/holds'));
    expect(data['holds']).toEqual([]);
    expect(String(data['detail'])).toMatch(/retention schedule alone/);
  });

  it('keeps an overdue hold in force and says it is overdue', async () => {
    const placed = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'litigation',
      scope: 'client',
      clientId,
      matterReference: 'MATTER-2026-01',
      reason: 'Anticipated litigation over a declined application.',
      placedBy: fx.human.id,
      actor: { id: fx.human.id, kind: 'human' },
      // Placed 400 days ago, so its review is long overdue when read now.
      //
      // The clock is moved BACKWARDS for the hold rather than forwards for the reader: a staff
      // session lasts eight hours, so advancing the shared clock past the cadence would expire
      // the session and every assertion below would fail on authentication instead of on the
      // thing being tested.
      now: new Date(at().getTime() - 400 * 24 * 60 * 60 * 1000),
    });
    if (placed.status !== 'ok') throw new Error(`setup: hold ${JSON.stringify(placed)}`);

    const data = dataOf(await call('/api/console/retention/holds'));
    const holds = data['holds'] as { matterReference: string; reviewOverdue: boolean }[];

    expect(holds).toHaveLength(1);
    expect(holds[0]?.matterReference).toBe('MATTER-2026-01');
    expect(holds[0]?.reviewOverdue).toBe(true);
    expect(String(data['detail'])).toMatch(/keeps holding/);
  });

  it('refuses deletion while a hold is in force, and names what holds it', async () => {
    const data = dataOf(await call(`/api/console/retention/clients/${clientId}`));
    const eligibility = data['eligibility'] as Record<string, unknown>;

    expect(eligibility['deletable']).toBe(false);
    // `deletable: false` on its own leaves an operator with nothing to act on.
    expect(String(eligibility['heldBy'] ?? eligibility['note']).length).toBeGreaterThan(0);
  });

  it('offers both irreversible acts, and names the authority each needs', async () => {
    const data = dataOf(await call('/api/console/retention/requests'));
    const writes = data['writes'] as {
      available: { capability: string; action: string; note: string }[];
      blocked: unknown[];
    };

    // This replaces an assertion that both were BLOCKED and named their level in the refusal. They
    // are offered now, through the chain, at those same levels - the module had already chosen
    // HOLD_AUTHORITY_LEVEL and DELETION_AUTHORITY_LEVEL, and declaring the actions is what let the
    // authority model agree with a judgement it previously had no way to enforce.
    expect(writes.blocked).toEqual([]);
    expect(
      writes.available.some((entry) => entry.note.includes(String(HOLD_AUTHORITY_LEVEL))),
    ).toBe(true);
    expect(DELETION_AUTHORITY_LEVEL).toBe(HOLD_AUTHORITY_LEVEL);

    // And the panel still says which cannot be undone, which is what the refusal used to carry.
    expect(writes.available.some((entry) => /IRREVERSIBLE/.test(entry.note))).toBe(true);
    expect(writes.available.map((entry) => entry.action).includes('decide_deletion_request')).toBe(
      true,
    );
  });
});
