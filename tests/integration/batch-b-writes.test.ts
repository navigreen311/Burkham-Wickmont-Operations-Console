/**
 * Batch B: the determinations, and the trap that would have come with them.
 *
 * Three capability lines scoped as "the Level 2 ones". Two were not, and the split is the point:
 * a line is a surface, and the acts behind it differ. `mark_attempt_funded` sits a level above
 * every other outcome because it stops a refund clock, and `raise_intercompany_invoice` sits above
 * tagging because it moves money between related parties.
 *
 * **The assertion that carries this file is the new client.** Middleware step 4 refuses anything
 * that is not Pass or Pass with Findings, so a client in `pending_assessment` - which is every
 * client on the day their file opens - could not have an entity recorded. And the entity graph is
 * an INPUT to the assessment that would move them out of `pending_assessment`. Left ungoverned,
 * declaring `record_entity_graph` would have rebuilt the exact one-way door the governance list
 * was created to prevent, one layer out.
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

const PASSWORD = 'a-long-enough-batch-b-writes-password';
const EMAIL = 'batch-b-writes-operator@example.com';

let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

const post = async (
  path: string,
  body: unknown,
  withCookie = true,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const get = async (path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}${path}`, { headers: { cookie } })).json()) as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('batch-b-writes');

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

describe('the new client, who could not have been assessed', () => {
  it('records an entity on a client in pending_assessment', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. A client created a moment ago is in `pending_assessment`,
    // and step 4 refuses everything but Pass and Pass with Findings. Recording their entity graph
    // is how they become assessable at all - so a gate on it would mean a client could never leave
    // the state that blocks them, which is word for word the failure GOVERNANCE_ACTIONS exists to
    // prevent.
    const fresh = await createClient(fx.tenant.id, 'Brand New Holdings LLC', {
      id: fx.human.id,
      kind: 'human',
    });

    const reply = await post(`/api/console/clients/${fresh.id}/graph/entities`, {
      legalName: 'Brand New Holdings LLC',
      role: 'operating',
    });

    expect(reply.body['status'], JSON.stringify(reply.body)).toBe('ok');

    // And the trace says WHY it got through: the gate was skipped as a governance action, not
    // passed. A step reporting `passed` here would be claiming a check ran.
    const trace = reply.body['trace'] as { step: string; outcome: string; detail?: string }[];
    const firewall = trace.find((step) => step.step === 'firewall');
    expect(firewall?.outcome).toBe('skipped');
    expect(String(firewall?.detail)).toMatch(/governance action/);
  });
});

describe('the acts that are not Level 2, and why they are separate', () => {
  it('gates marking an attempt funded apart from every other outcome', async () => {
    const data = (await get('/api/console/outcomes/rate?from=2026-01-01&to=2027-01-01'))[
      'data'
    ] as Record<string, unknown>;
    const available = (data['writes'] as { available: { action: string; note: string }[] })
      .available;

    const actions = available.map((entry) => entry.action);
    expect(actions).toContain('record_funding_outcome');
    expect(actions).toContain('mark_attempt_funded');

    // The reason it is separate, on the panel: it stops a refund clock. 1.4 refunds on a sixty-day
    // approved-but-unfunded trigger, so a wrong one denies a refund the client is owed.
    const funded = available.find((entry) => entry.action === 'mark_attempt_funded');
    expect(funded?.note).toMatch(/refund/i);
  });

  it('offers three interventure acts at three different levels', async () => {
    const data = (await get('/api/console/interventure/relationships'))['data'] as Record<
      string,
      unknown
    >;
    const writes = data['writes'] as {
      available: { action: string; note: string }[];
      blocked: { capability: string; missingAction: string }[];
    };

    // One line in the blocked list became three actions, because generating a disclosure, deciding
    // a client is an inter-venture relationship, and moving money between related parties are not
    // the same act at the same level.
    const actions = writes.available.map((entry) => entry.action);
    expect(actions).toEqual([
      'generate_conflict_disclosure',
      'tag_venture',
      'raise_intercompany_invoice',
    ]);

    // And acknowledging is STILL not offered, which no batch will change.
    expect(
      writes.blocked.some((entry) => /Acknowledge a conflict disclosure/i.test(entry.capability)),
    ).toBe(true);
  });

  it('says generating a disclosure is not disclosing it', async () => {
    const data = (await get('/api/console/interventure/relationships'))['data'] as Record<
      string,
      unknown
    >;
    const available = (data['writes'] as { available: { action: string; note: string }[] })
      .available;

    // The distinction that keeps a generated artifact from reading as a completed disclosure.
    const generate = available.find((entry) => entry.action === 'generate_conflict_disclosure');
    expect(generate?.note).toMatch(/GENERATING IS NOT DISCLOSING/);
  });
});

describe('a Batch B write needs its level', () => {
  it('refuses without a session before it says what the body wants', async () => {
    const reply = await post('/api/console/outcomes/attempts', {}, false);
    expect(reply.body['status']).toBe('refused');
    expect(JSON.stringify(reply.body)).not.toMatch(/providerId/);
  });

  it('runs the chain and returns the trace on a module refusal', async () => {
    // A tag on a client that does not exist. The chain authorises - this operator holds Level 3,
    // which subsumes 2 - and the module answers for itself.
    const reply = await post(
      '/api/console/interventure/clients/00000000-0000-0000-0000-0000000000ff/tag',
      {},
    );

    const trace = reply.body['trace'] as { step: string; outcome: string }[];
    expect(trace.some((step) => step.step === 'authority_level' && step.outcome === 'passed')).toBe(
      true,
    );
    expect(reply.body['status']).not.toBe('ok');
  });
});

/** A client of this tenant, made on demand: the intelligence read is per client. */
const freshClientId = async (): Promise<string> =>
  (await createClient(fx.tenant.id, 'Intelligence Subject LLC', { id: fx.human.id, kind: 'human' }))
    .id;

describe('Batch C: the casework, and the one act inside it that is not', () => {
  it('offers the lead lifecycle at Level 1 and conversion separately', async () => {
    const data = (await get('/api/console/sales/pipeline'))['data'] as Record<string, unknown>;
    const writes = data['writes'] as { available: { action: string; note: string }[] };
    const actions = writes.available.map((entry) => entry.action);

    // One capability line became two actions, at 1 and 3.
    expect(actions).toEqual(['manage_lead', 'convert_lead']);
  });

  it('gates conversion at the level of the heaviest thing it can do', async () => {
    const data = (await get('/api/console/sales/pipeline'))['data'] as Record<string, unknown>;
    const available = (data['writes'] as { available: { action: string; note: string }[] })
      .available;

    // **THE FINDING.** `convertLead` creates a client and may start an engagement - which are
    // `create_client_record` at 2 and `manage_engagement` at 3. Declared at Level 1 alongside the
    // rest of the lifecycle, it would have been a lower-level path to both: ADR-0034's rule that a
    // control somebody can reach another way is not a control.
    const convert = available.find((entry) => entry.action === 'convert_lead');
    expect(convert?.note).toMatch(/Level 3/);
    expect(convert?.note).toMatch(/creates a client/i);
  });

  it('records market intelligence at Level 1, and says why it is not Level 0', async () => {
    const data = (await get(`/api/console/clients/${await freshClientId()}/intelligence?phase=0`))[
      'data'
    ] as Record<string, unknown>;
    const available = (data['writes'] as { available: { action: string; note: string }[] })
      .available;

    const intel = available.find((entry) => entry.action === 'record_market_intelligence');
    expect(intel).toBeDefined();
    // It WRITES a feed others read as given, which is more than generate_internal_report does.
    expect(intel?.note).toMatch(/writes a feed/i);
    expect(intel?.note).toMatch(/Level 0/);
  });
});
