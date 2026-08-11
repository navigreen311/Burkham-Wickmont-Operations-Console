/**
 * The five module surfaces on the Console transport: 5.1/5.6, 9.1/9.2, 1.2, 1.3, 8.1/8.3.
 *
 * Four properties carry this file.
 *
 * **A metric that could not be measured arrives as `null` with its reason, and never as zero.**
 * `Metric<T>` is a value with its basis (ADR-0017), and a transport is where that is cheapest to
 * destroy - `value ?? 0` is one keystroke and turns "we cannot measure gross margin" into "gross
 * margin is zero". Asserted field by field rather than by spot-check, because the failure is
 * silent and looks like tidy code.
 *
 * **The two figures 9.2 refuses outright reach the page with their stated reason.** Gross margin
 * and projected LTV are functions that return refusals, not fields on the dashboard, so a surface
 * rendering only the dashboard would never show either. The route calls them; this asserts it.
 *
 * **A partner's stage breakdown is suppressed below five referrals, and the suppression is stated.**
 * Both halves are asserted: `countsByStage` must be ABSENT rather than an empty object - an empty
 * object is what a page iterates into a row of zeros - and the explanation must carry the
 * threshold. A partner who referred one client knows exactly whose status a count of one describes.
 *
 * **The entity graph surface never carries an identifier, and never offers a reveal.** The payload
 * is searched for the seeded SSN and its last four digits, and the reveal gap is asserted as a
 * stated refusal rather than as an absence.
 *
 * The harness is the one `console-transport.test.ts` established: a real socket, a real session
 * cookie, and a clock this file moves forward because a TOTP code is spent when it is accepted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { grant as grantConsent } from '@bwc/consent';
import { publishOffer, fromDollars } from '@bwc/billing';
import { createLead, convertLead, qualifyLead } from '@bwc/sales';
import { addEdge, upsertEntity, upsertOwner } from '@bwc/graph';
import {
  MINIMUM_COHORT,
  completeOnboarding,
  recordQualification,
  registerPartner,
  requirementsFor,
} from '@bwc/partners';
import {
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  confirmStaffEnrolment,
  enrolStaffFromInvitation,
  inviteStaff,
  totp,
} from '@bwc/identity';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
import { createApp } from '../../apps/api/src/app.js';
import type { ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;
let cookie: string;
let clientId: string;
let graphClientId: string;
let thinPartnerId: string;
let fatPartnerId: string;
let secret: Buffer;

const PASSWORD = 'a-long-enough-console-password';
const EMAIL = 'console-capital-operator@example.com';

/** The SSN this file seeds, so the payload can be searched for it and for its last four. */
const SEEDED_SSN = '123-45-6789';
const SEEDED_LAST4 = '6789';

const limiter = createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 });

let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);
const codeNow = (): string => totp(secret, at());

const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly body: string;
}

const call = async (
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Reply> => {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      cookie,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json, body };
};

const dataOf = (reply: Reply): Record<string, unknown> => {
  expect(reply.json['status'], reply.body).toBe('ok');
  return reply.json['data'] as Record<string, unknown>;
};

/** Register a partner and put `count` converted referrals against them. */
const partnerWithReferrals = async (name: string, count: number): Promise<string> => {
  const registered = await registerPartner({
    tenantId: fx.tenant.id,
    legalName: name,
    contactName: 'A Contact',
    contactEmail: 'contact@example.com',
    track: 'cpa_bookkeeper',
    actor: HUMAN(),
  });
  if (registered.status !== 'ok') throw new Error(`setup: partner ${registered.status}`);

  for (const qualification of requirementsFor('cpa_bookkeeper').qualifications) {
    await recordQualification({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      qualification,
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });
  }
  await completeOnboarding({
    tenantId: fx.tenant.id,
    partnerId: registered.value.id,
    completedBy: fx.human.id,
    actor: HUMAN(),
  });

  for (let index = 0; index < count; index += 1) {
    const lead = await createLead({
      tenantId: fx.tenant.id,
      prospectName: `${name} referral ${index}`,
      sourceChannel: 'partner_referral',
      referrerName: name,
      referrerPartnerId: registered.value.id,
      createdOn: new Date('2026-06-01T00:00:00.000Z'),
      actor: HUMAN(),
    });
    if (lead.status !== 'ok') throw new Error('setup: lead');
    await qualifyLead({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      qualification: 'qualified',
      note: 'Two years trading with a clean bank feed and a working capital need.',
      occurredAt: new Date('2026-06-02T00:00:00.000Z'),
      actor: HUMAN(),
    });
    await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      convertedBy: fx.human.id,
      convertedOn: new Date('2026-06-03T00:00:00.000Z'),
      actor: HUMAN(),
    });
  }

  return registered.value.id;
};

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  // The entity graph envelope-encrypts SSN and EIN with the vault KEK provider.
  process.env['VAULT_KEK'] = process.env['VAULT_KEK'] ?? generateKek();
  fx = await makeFixture('console-capital');

  clientId = (await createClient(fx.tenant.id, 'Console Capital LLC', HUMAN())).id;
  graphClientId = (await createClient(fx.tenant.id, 'Console Graph LLC', HUMAN())).id;

  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    publishedBy: 'concierge-desk',
    actor: HUMAN(),
  });

  // An entity graph with an owner carrying an SSN, so the payload has something to leak.
  const entity = await upsertEntity({
    tenantId: fx.tenant.id,
    clientId: graphClientId,
    legalName: 'Graph Operating Co',
    role: 'operating',
    actor: HUMAN(),
  });
  if (entity.status !== 'ok') throw new Error(`setup: entity ${entity.status}`);

  const owner = await upsertOwner({
    tenantId: fx.tenant.id,
    clientId: graphClientId,
    fullName: 'Jane Q Owner',
    ssn: SEEDED_SSN,
    actor: HUMAN(),
  });
  if (owner.status !== 'ok') throw new Error(`setup: owner ${owner.status}`);

  await addEdge({
    tenantId: fx.tenant.id,
    clientId: graphClientId,
    kind: 'ownership',
    fromKind: 'owner',
    fromId: owner.value.id,
    toKind: 'entity',
    toId: entity.value.id,
    ownershipPercent: 100,
    provenanceTag: 'client_stated',
    actor: HUMAN(),
  });

  thinPartnerId = await partnerWithReferrals('Thin Book CPA', MINIMUM_COHORT - 1);
  fatPartnerId = await partnerWithReferrals('Fat Book CPA', MINIMUM_COHORT + 1);

  // One decided lead on its own channel, so the conversion report has a channel on each side of
  // the minimum sample in the same answer.
  const thinLead = await createLead({
    tenantId: fx.tenant.id,
    prospectName: 'Thin Channel Co',
    sourceChannel: 'thin_channel',
    createdOn: new Date('2026-06-01T00:00:00.000Z'),
    actor: HUMAN(),
  });
  if (thinLead.status !== 'ok') throw new Error('setup: thin lead');
  await qualifyLead({
    tenantId: fx.tenant.id,
    leadId: thinLead.value.id,
    qualification: 'qualified',
    note: 'Two years trading with a clean bank feed and a working capital need.',
    occurredAt: new Date('2026-06-02T00:00:00.000Z'),
    actor: HUMAN(),
  });
  await convertLead({
    tenantId: fx.tenant.id,
    leadId: thinLead.value.id,
    convertedBy: fx.human.id,
    convertedOn: new Date('2026-06-03T00:00:00.000Z'),
    actor: HUMAN(),
  });

  void grantConsent;

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

  const confirmed = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    password: PASSWORD,
    code: codeNow(),
  });
  if (confirmed.status !== 'ok') throw new Error('setup: confirm');

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
  };

  server = createServer(createApp({ config, limiter, now: at }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;

  offsetMs += 31_000;
  const signedIn = await fetch(`${base}/api/console/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, code: codeNow() }),
  });
  const setCookie = signedIn.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup: no cookie');
  cookie = setCookie.split(';')[0] as string;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTenant(fx.tenant.id);
});

describe('every new route needs a session', () => {
  const GUARDED = [
    '/api/console/dashboards/executive',
    '/api/console/dashboards/unit-economics',
    '/api/console/dashboards/gardner-rollup',
    '/api/console/dashboards/gaps',
    '/api/console/clients/any-id/stack',
    '/api/console/clients/any-id/graph',
    '/api/console/clients/any-id/graph/profile',
    '/api/console/sales/pipeline',
    '/api/console/sales/expansion',
    '/api/console/sales/leads/any-id',
    '/api/console/partners',
    '/api/console/partners/any-id',
  ] as const;

  it('refuses each of them anonymously', async () => {
    for (const path of GUARDED) {
      const response = await fetch(`${base}${path}`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status'], path).toBe('refused');
      expect(String(body['reason']), path).toMatch(/Sign in/);
    }
  });

  it('refuses the capital model anonymously too', async () => {
    const response = await fetch(`${base}/api/console/capital/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: [] }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe('refused');
    expect(String(body['reason'])).toMatch(/Sign in/);
  });
});

describe('9.1 and 9.2 - a metric with no value keeps its reason', () => {
  it('carries every executive metric with its basis, and null is never zero', async () => {
    const data = dataOf(await call('/api/console/dashboards/executive'));

    const keys = [
      'complianceDistribution',
      'complianceMovement',
      'readinessImprovement',
      'placementApprovalRate',
      'internalGateRefusalRate',
      'firewallResolutionRate',
      'openCorrectionObligations',
      'partnerConversionRate',
      'refundRate',
      'revenuePerClientCents',
    ];

    for (const key of keys) {
      const metric = data[key] as Record<string, unknown>;
      expect(metric, key).toBeDefined();
      // The three fields a page needs to render a refusal honestly.
      expect(typeof metric['label'], key).toBe('string');
      expect(typeof metric['note'], key).toBe('string');
      expect(String(metric['note']).length, key).toBeGreaterThan(0);
      expect(metric, key).toHaveProperty('value');
      // `value` may be null. What it must never be is absent - an absent field renders as nothing.
      const basis = metric['basis'] as Record<string, unknown>;
      expect(basis, key).toBeDefined();
      expect(['complete', 'partial', 'unavailable'], key).toContain(basis['coverage']);
    }
  });

  it('withholds the placement approval rate, now on sample size rather than a missing denominator', async () => {
    // **The refusal changed reason, and the transport's job is unchanged.**
    //
    // This asserted `/100% forever/` when it was written: only approvals were recorded, so the
    // denominator could only ever equal the numerator and no honest rate existed at any sample
    // size. 5.5 Funding Outcome Ledger records the ATTEMPT, so a decline is a row and the
    // denominator is real - see ADR-0041. The sibling assertion in `kpi-dashboards.test.ts` was
    // updated in that slice; this one was written on a branch that did not have it yet, and the
    // two only met on main.
    //
    // What this test is actually for is unchanged: the metric is null, it is NOT zero, and it
    // carries a sentence saying what would make it appear. Only the sentence is different, and it
    // is better - "10 are needed" tells an operator what to do, where "100% forever" told them to
    // wait for a module that has now shipped.
    const data = dataOf(await call('/api/console/dashboards/executive'));
    const metric = data['placementApprovalRate'] as Record<string, unknown>;

    expect(metric['value']).toBeNull();
    expect(metric['value']).not.toBe(0);
    expect(String(metric['note'])).toMatch(/10 are needed/);
    // Nothing is awaited any more: the denominator exists, there is just not enough of it yet.
    expect((metric['basis'] as Record<string, unknown>)['unmeasured']).toEqual([]);
  });

  it('lists every withheld metric with its reason, assembled from the metrics themselves', async () => {
    const data = dataOf(await call('/api/console/dashboards/executive'));
    const withheld = data['withheld'] as { key: string; label: string; note: string }[];

    expect(withheld.length).toBeGreaterThan(0);
    expect(withheld.map((entry) => entry.key)).toContain('placement_approval_rate');
    for (const entry of withheld) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('names the domains 9.1 asks for that nothing produces', async () => {
    const data = dataOf(await call('/api/console/dashboards/executive'));
    const unproduced = data['unproduced'] as { domain: string; awaiting: string }[];
    expect(unproduced.length).toBeGreaterThan(0);
    expect(unproduced.map((entry) => entry.domain).join(' ')).toMatch(/gross margin/i);
    for (const entry of unproduced) expect(entry.awaiting.length).toBeGreaterThan(0);
  });

  it('carries gross margin and projected LTV as refusals with their stated reason', async () => {
    // **The assertion the 9.2 panel exists for.** Neither is a field on the dashboard, so a route
    // that forwarded only the dashboard would show neither - and an operator asked why margin is
    // missing would have nothing to say.
    const data = dataOf(await call('/api/console/dashboards/unit-economics'));
    const refused = data['refusedOutright'] as {
      metric: string;
      label: string;
      status: string;
      why: string;
      principle: string | null;
    }[];

    const margin = refused.find((entry) => entry.metric === 'gross_margin');
    expect(margin).toBeDefined();
    expect(margin?.status).toBe('refused');
    expect(margin?.why).toMatch(/vendor costs|ungated/i);
    expect(margin?.principle).toMatch(/9\.2/);

    const ltv = refused.find((entry) => entry.metric === 'projected_ltv');
    expect(ltv).toBeDefined();
    expect(ltv?.status).toBe('refused');
    expect(ltv?.why).toMatch(/churn|assumptions/i);
  });

  it('carries the COGS lines 9.2 requires and nothing can measure', async () => {
    const data = dataOf(await call('/api/console/dashboards/unit-economics'));
    const lines = data['unmeasuredCostLines'] as { line: string; gate: string }[];
    expect(lines.length).toBeGreaterThan(0);
    for (const entry of lines) expect(entry.gate.length).toBeGreaterThan(0);
  });

  it('refuses a malformed period rather than quietly using the default', async () => {
    // A dashboard that reported a different window from the one asked for is a dashboard whose
    // numbers cannot be checked against anything.
    const reply = await call('/api/console/dashboards/executive?from=not-a-date&to=2026-08-01');
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/ISO date/);
  });

  it('serves the Gardner rollup with its own withheld list', async () => {
    const data = dataOf(await call('/api/console/dashboards/gardner-rollup'));
    expect(data).toHaveProperty('complianceCounts');
    expect(data).toHaveProperty('withheld');
    expect(Array.isArray(data['withheld'])).toBe(true);
  });
});

describe('8.1 - a stage breakdown is suppressed below the cohort', () => {
  it('withholds the breakdown, states the threshold, and sends no empty object', async () => {
    // **The assertion this surface exists for**, and both halves matter. An absent field cannot be
    // iterated into a row of zeros; an empty object can, and would read as a partner whose every
    // client is nowhere.
    const data = dataOf(await call(`/api/console/partners/${thinPartnerId}`));
    const aggregate = data['aggregateStatus'] as Record<string, unknown>;

    expect(aggregate['released']).toBe(false);
    expect(aggregate).not.toHaveProperty('countsByStage');
    expect(aggregate['totalReferrals']).toBe(MINIMUM_COHORT - 1);
    expect(aggregate['minimumCohort']).toBe(MINIMUM_COHORT);
    expect(String(aggregate['detail'])).toMatch(/withheld below 5/i);
    // The reason, not just the fact. A page that said "withheld" without this teaches its reader
    // that the system is arbitrary.
    expect(String(aggregate['detail'])).toMatch(/identify individual clients/i);
  });

  it('releases the breakdown at or above the cohort', async () => {
    // The counterpart. A rule that suppressed everything would pass the test above and be useless.
    const data = dataOf(await call(`/api/console/partners/${fatPartnerId}`));
    const aggregate = data['aggregateStatus'] as Record<string, unknown>;

    expect(aggregate['released']).toBe(true);
    expect(aggregate).toHaveProperty('countsByStage');
    expect(aggregate['totalReferrals']).toBe(MINIMUM_COHORT + 1);
    const counts = aggregate['countsByStage'] as Record<string, number>;
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(MINIMUM_COHORT + 1);
  });

  it('reports what a partner may do, and what they are owed, rather than leaving both blank', async () => {
    const data = dataOf(await call(`/api/console/partners/${thinPartnerId}`));

    const refer = data['mayRefer'] as Record<string, unknown>;
    expect(typeof refer['permitted']).toBe('boolean');
    if (refer['permitted'] === false) expect(String(refer['reason']).length).toBeGreaterThan(0);

    // `not_built` until 8.2, and carried rather than omitted: a partner page with no payout
    // section reads as a partner who is owed nothing.
    const payable = data['payable'] as Record<string, unknown>;
    expect(payable['status']).toBe('not_built');
    expect(String(payable['reason'])).toMatch(/8\.2/);
  });

  it('lists partners with the curriculum they are measured against', async () => {
    const data = dataOf(await call('/api/console/partners'));
    expect((data['partners'] as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(data).toHaveProperty('curriculum');
    expect(data['recertificationCadenceDays']).toBeGreaterThan(0);
  });
});

describe('1.2 - the graph surface carries no identifier and offers no reveal', () => {
  it('sends the last four and never the SSN', async () => {
    const reply = await call(`/api/console/clients/${graphClientId}/graph`);
    const data = dataOf(reply);

    const owners = data['owners'] as { fullName: string; ssnLast4: string | null }[];
    expect(owners).toHaveLength(1);
    expect(owners[0]?.ssnLast4).toBe(SEEDED_LAST4);

    // The whole payload, searched. Not the owners array - a leak would most likely arrive through
    // a finding, a rationale or an exposure detail, which is exactly why the module never gives
    // those the plaintext.
    expect(reply.body).not.toContain(SEEDED_SSN);
    expect(reply.body).not.toContain('123456789');
  });

  it('states that a reveal cannot be offered, and why, rather than leaving it absent', async () => {
    const data = dataOf(await call(`/api/console/clients/${graphClientId}/graph`));
    const blocked = (data['writes'] as Record<string, unknown>)['blocked'] as {
      capability: string;
      missingAction: string;
      why: string;
    }[];

    const reveal = blocked.find((entry) => /Reveal an SSN/i.test(entry.capability));
    expect(reveal).toBeDefined();
    expect(reveal?.missingAction).toBe('none declared');
    // The reasoning, so a reader knows this is a decision somebody has to make rather than a bug.
    expect(reveal?.why).toMatch(/false audit record|Level 0/i);
    expect((data['writes'] as Record<string, unknown>)['available']).toEqual([]);
  });

  it('renders an empty graph as empty and says what that means', async () => {
    const data = dataOf(await call(`/api/console/clients/${clientId}/graph`));
    expect(data['isEmpty']).toBe(true);
    expect(String(data['emptyNote'])).toMatch(/not a finding about the client/i);
    expect(data['risk']).toHaveProperty('band');
  });

  it('refuses a profile with no stated capital need rather than deriving against a default', async () => {
    const reply = await call(`/api/console/clients/${graphClientId}/graph/profile`);
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/need must be one of/);
  });
});

describe('5.1 and 5.6 - a refusal where the feed would be, a calculator where it works', () => {
  it('refuses the per-client stack and names Decision A', async () => {
    const reply = await call(`/api/console/clients/${clientId}/stack`);
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/Plaid/);
    // The sentence that stops somebody "fixing" this by returning an empty array.
    expect(String(reply.json['reason'])).toMatch(/this client has no debt/i);
  });

  it('models a stated stack and stamps every answer as operator-stated', async () => {
    const data = dataOf(
      await call('/api/console/capital/model', {
        body: {
          positions: [
            {
              provider: 'Test Bank',
              label: 'Working capital card',
              kind: 'credit_card',
              creditLimit: 50_000,
              outstandingBalance: 30_000,
              annualRate: 0.219,
              factorRate: null,
              cadence: 'monthly',
              paymentPerPeriod: 1_200,
              asOf: '2026-08-01',
              personalGuarantee: { ownerName: 'Jane Q Owner', limitAmount: null },
            },
          ],
        },
      }),
    );

    const basis = data['basis'] as Record<string, unknown>;
    expect(basis['source']).toBe('operator_stated');
    expect(String(basis['detail'])).toMatch(/no better/);
    expect(data['asOf']).toBe('2026-08-01');
    expect(data['positionCount']).toBe(1);

    // The health score never travels without its components.
    const health = data['health'] as Record<string, unknown>;
    expect(Array.isArray(health['components'])).toBe(true);
    expect((health['components'] as unknown[]).length).toBeGreaterThan(0);

    // An unlimited guarantee is flagged as unlimited rather than as a large number.
    const exposure = data['pgExposure'] as { ownerName: string; hasUnlimitedGuarantee: boolean }[];
    expect(exposure[0]?.hasUnlimitedGuarantee).toBe(true);

    const perPosition = data['perPosition'] as { termIsDerived: boolean }[];
    expect(perPosition[0]?.termIsDerived).toBe(true);
  });

  it('names the row that could not be read rather than refusing the whole stack anonymously', async () => {
    const reply = await call('/api/console/capital/model', {
      body: {
        positions: [
          {
            provider: 'Test Bank',
            label: 'Good row',
            kind: 'term_loan',
            creditLimit: null,
            outstandingBalance: 10_000,
            annualRate: 0.1,
            factorRate: null,
            cadence: 'monthly',
            paymentPerPeriod: 500,
            asOf: '2026-08-01',
          },
          { provider: 'Test Bank', label: 'Bad row', kind: 'not_a_kind' },
        ],
      },
    });

    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/row 2/);
  });

  it('refuses an empty stack rather than computing over nothing', async () => {
    const reply = await call('/api/console/capital/model', { body: { positions: [] } });
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/at least one position/);
  });
});

describe('the view sources', () => {
  /**
   * Read rather than executed, which is the honest description of what this covers.
   *
   * There is no DOM environment in this runner - vitest is configured `environment: 'node'` and no
   * jsdom is installed - so these assert the source of the five panel modules the way
   * `portal-ui.test.ts` asserts the portal's. That is **weaker than driving the DOM** and is worth
   * naming as such: it catches a rendering rule being deleted, and would not catch one that was
   * kept and computed wrongly.
   *
   * It exists because of a gap mutation testing found. The browser spec covers the metric-refusal
   * rendering end to end, but the Console e2e harness seeds no partners, so `renderOne` never runs
   * in a browser - and a mutation that rendered a suppressed cohort as a row of zeros passed all
   * eleven browser tests. These assertions are what fail on it.
   */
  const VIEWS = join(process.cwd(), 'apps', 'api', 'public', 'views');

  it('assigns nothing to innerHTML, anywhere in the panels', async () => {
    for (const file of ['capital.js', 'dashboards.js', 'graph.js', 'sales.js', 'partners.js']) {
      const source = await readFile(join(VIEWS, file), 'utf8');
      expect(source, file).not.toContain('innerHTML');
      expect(source, file).not.toContain('outerHTML');
      expect(source, file).not.toContain('insertAdjacentHTML');
      expect(source, file).not.toContain('document.write');
      expect(source, file).not.toContain('eval(');
    }
  });

  it('renders the cohort suppression as a stated withholding, not as counts', async () => {
    const source = await readFile(join(VIEWS, 'partners.js'), 'utf8');

    // The sentence that must appear where the breakdown would have been.
    expect(source).toContain('Stage breakdown WITHHELD');
    // The threshold, so the page never says "withheld" without saying below what.
    expect(source).toContain('minimumCohort');
    // The module's own explanation, rendered rather than replaced with a shorter one.
    expect(source).toContain('aggregateStatus.detail');
    // The counts are read only inside the released branch.
    expect(source).toContain('if (data.aggregateStatus.released)');
  });

  it('renders an unmeasured metric as words rather than a number', async () => {
    const source = await readFile(join(VIEWS, 'dashboards.js'), 'utf8');
    expect(source).toContain("return 'not measured'");
    // The two coalescings that would turn a refusal into a figure.
    expect(source).not.toContain('value ?? 0');
    expect(source).not.toContain('?? 0;');
  });
});

describe('1.3 - the pipeline is visible and unchangeable, and says so', () => {
  it('carries the pipeline, the idle leads and the threshold being applied', async () => {
    const data = dataOf(await call('/api/console/sales/pipeline'));
    expect(Array.isArray(data['leads'])).toBe(true);
    expect(Array.isArray(data['stale'])).toBe(true);
    expect(data['inactivityDays']).toBeGreaterThan(0);
    expect(data['minimumLeadsForRate']).toBeGreaterThan(0);
  });

  it('withholds a channel rate below the minimum and releases one at it, in the same answer', async () => {
    // **Both sides, deliberately.** A suite that only asserted the withholding would pass against a
    // module that never reported a rate at all, which is a different and equally useless surface.
    //
    // The fixture puts ten decided leads on `partner_referral` - exactly `MINIMUM_LEADS_FOR_RATE` -
    // and one on `thin_channel`. The first draft of this test asserted the referral rate was null
    // and failed, correctly: ten IS the minimum, so the rate is released. The threshold is
    // inclusive and the test now says which side of it each channel is on.
    const data = dataOf(await call('/api/console/sales/pipeline'));
    const minimum = data['minimumLeadsForRate'] as number;
    const channels = data['conversionByChannel'] as {
      sourceChannel: string;
      conversionRate: number | null;
      converted: number;
      lost: number;
      note: string;
    }[];

    const thin = channels.find((entry) => entry.sourceChannel === 'thin_channel');
    expect(thin).toBeDefined();
    expect((thin?.converted ?? 0) + (thin?.lost ?? 0)).toBeLessThan(minimum);
    // Withheld, and specifically not zero: this channel converted its only decided lead.
    expect(thin?.conversionRate).toBeNull();
    expect(thin?.conversionRate).not.toBe(0);
    expect(thin?.converted).toBe(1);
    // And the module says what would make it a rate, which is the sentence the page renders.
    expect(thin?.note.length).toBeGreaterThan(0);

    const referral = channels.find((entry) => entry.sourceChannel === 'partner_referral');
    expect(referral).toBeDefined();
    expect((referral?.converted ?? 0) + (referral?.lost ?? 0)).toBeGreaterThanOrEqual(minimum);
    expect(referral?.conversionRate).toBeCloseTo(1, 10);
  });

  it('states the writes it cannot offer, with the missing action named', async () => {
    const data = dataOf(await call('/api/console/sales/pipeline'));
    const blocked = (data['writes'] as Record<string, unknown>)['blocked'] as {
      capability: string;
      missingAction: string;
      why: string;
    }[];

    expect(blocked.length).toBeGreaterThan(0);
    for (const entry of blocked) {
      expect(entry.missingAction).toBe('none declared');
      expect(entry.why).toMatch(/middleware chain|declared action/);
    }
  });

  it('says plainly that a lead is not there', async () => {
    const reply = await call('/api/console/sales/leads/00000000-0000-4000-8000-000000000000');
    expect(reply.json['status']).toBe('no_data');
  });
});
