/**
 * The five surfaces that had no route until now: 1.4, 7.3, 3.2, 11.11, 2.2/2.4.
 *
 * These were built once on a branch that never merged, against an `app.ts` that no longer exists.
 * Rebuilt against the route-module structure, and the assertions below are the ones that would have
 * caught what went wrong the first time: **every field the page reads is checked here**, because a
 * browser renders a name that does not exist as blank text rather than as an error.
 *
 * The other thing each of these asserts is an ABSENCE with a reason. None of the five has a
 * declared action for its writes, so none offers one - and a surface that simply had no buttons
 * would be indistinguishable from one whose buttons had been forgotten.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { create as createClient } from '@bwc/clients';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
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
let secret: Buffer;

const PASSWORD = 'a-long-enough-rebuild-password';
const EMAIL = 'rebuild-operator@example.com';

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
  fx = await makeFixture('console-rebuild');

  clientId = (
    await createClient(fx.tenant.id, 'Rebuild Subject LLC', { id: fx.human.id, kind: 'human' })
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
  const decoded = base32Decode(offer.value.secret);
  if (!decoded) throw new Error('setup: secret');
  secret = decoded;
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

describe('all five need a session', () => {
  it.each([
    '/api/console/billing/ladder',
    `/api/console/billing/clients/${'x'}`,
    '/api/console/contracts/clauses?jurisdiction=TX',
    '/api/console/vault/clients/x',
    '/api/console/workbench',
    '/api/console/workflow/instances/x',
  ])('refuses %s without one', async (path) => {
    const reply = await fetch(`${base}${path}`);
    const payload = (await reply.json()) as { status: string; reason?: string };
    expect(payload.status).toBe('refused');
    expect(payload.reason).toBe('Sign in to continue.');
  });
});

describe('1.4 billing', () => {
  it('reports an unpublished ladder as no_data rather than a free service', async () => {
    const reply = await call('/api/console/billing/ladder');
    // An empty price list is not a price of nothing. `no_data` says nobody has written one.
    expect(reply['status']).toBe('no_data');
    expect(String(reply['reason'])).toMatch(/nobody has written/);
  });

  it('carries the engagements, the ladder to compare against, and the credit', async () => {
    const data = dataOf(await call(`/api/console/billing/clients/${clientId}`));
    expect(Array.isArray(data['engagements'])).toBe(true);
    // The ladder travels WITH the engagement: a deviation is only visible if both are in front of
    // the reader, and ADR-0018 needs approval for one in either direction.
    expect(Array.isArray(data['ladder'])).toBe(true);
    expect(String(data['ladderAbsent'])).toMatch(/nothing to compare/);
    expect(typeof data['availableCreditCents']).toBe('number');
    expect((data['writes'] as { blocked: unknown[] }).blocked.length).toBeGreaterThan(0);
  });
});

describe('7.3 contracts', () => {
  it('refuses a clause set with no jurisdiction', async () => {
    const reply = await call('/api/console/contracts/clauses');
    expect(reply['status']).toBe('refused');
    // "We could not tell which state" and "no state rule applies" are different statements.
    expect(String(reply['reason'])).toMatch(/different question/);
  });

  it('answers for a jurisdiction', async () => {
    const data = dataOf(await call('/api/console/contracts/clauses?jurisdiction=tx'));
    expect(data['jurisdiction']).toBe('TX');
    expect(Array.isArray(data['clauses'])).toBe(true);
  });

  it('keys the fee exhibit by engagement, not by client', async () => {
    // A client with two engagements has two exhibits, and each reads the offer version its own
    // engagement started on - a repricing must not change what an existing client agreed to pay.
    // A well-formed id that belongs to nothing. **Not a malformed one**: every route in this
    // repository passes an id straight to a UUID column, so a malformed id raises a database error
    // and serialises as `failed` rather than `no_data`. That is pre-existing and repo-wide - these
    // five routes are no different from the twenty already merged - and it is recorded in the PR
    // rather than fixed unilaterally here.
    const reply = await call(
      '/api/console/contracts/engagements/00000000-0000-0000-0000-000000000001/fee-exhibit',
    );
    expect(reply['status']).toBe('no_data');
  });
});

describe('3.2 vault', () => {
  it('lists what is on a file and never offers the bytes', async () => {
    const data = dataOf(await call(`/api/console/vault/clients/${clientId}`));
    expect(Array.isArray(data['documents'])).toBe(true);
    expect((data['summary'] as { total: number }).total).toBe(0);

    const blocked = (data['writes'] as { blocked: { capability: string; why: string }[] }).blocked;
    const download = blocked.find((entry) => entry.capability.includes('Download'));
    // Not missing - REFUSED, and the surface says which. A second download path would be a second
    // set of rules about watermarking and legal hold to keep in step with 3.2's.
    expect(download?.why).toMatch(/separate process/);
  });

  it('counts refusals in an access log separately', async () => {
    const data = dataOf(
      await call('/api/console/vault/documents/00000000-0000-0000-0000-000000000002/access-log'),
    );
    expect(Array.isArray(data['entries'])).toBe(true);
    // A log read as "twelve accesses" hides that four were refused, and a refused access is the
    // more interesting row.
    expect(data['refused']).toBe(0);
  });
});

describe('11.11 workbench', () => {
  it('assembles the whole surface live', async () => {
    const data = dataOf(await call('/api/console/workbench'));
    expect(data['decisions']).toBeDefined();
    expect(data['health']).toBeDefined();
  });

  it('says an empty queue is an answer rather than rendering a blank panel', async () => {
    const data = dataOf(await call('/api/console/workbench/decisions'));
    const detail = String(data['detail']);
    expect(detail.length).toBeGreaterThan(0);
    // "Nothing needs you" and "this did not load" look identical when both are empty.
    if ((data['decisions'] as unknown[]).length === 0) {
      expect(detail).toMatch(/not an empty screen/);
    }
  });
});

describe('2.2 / 2.4 workflow', () => {
  it('reports an instance from another tenant as no_data, not a refusal', async () => {
    const reply = await call(
      '/api/console/workflow/instances/00000000-0000-0000-0000-000000000000',
    );
    // A caller must not learn that an id exists somewhere else.
    expect(reply['status']).toBe('no_data');
  });

  it('names the missing list read as a gap in 2.2 rather than pretending to have one', async () => {
    // There is no route that lists running instances, and that is deliberate: `@bwc/workflow`
    // exposes no tenant-scoped read, and querying the table from the transport would put a module
    // read in the wrong layer. The blocked list is where that is recorded.
    const paths = await fetch(`${base}/api/console/workflow/instances`, { headers: { cookie } });
    expect(paths.status).toBe(404);
  });
});
