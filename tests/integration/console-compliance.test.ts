/**
 * The compliance and governance surfaces — 7.2, 7.1, 5.4, 7.4 and 4.5 — over a real socket.
 *
 * **The centre of this file is the 7.2 activation gate**, and specifically the property ADR-0009
 * built the module around: the Authority Level is read from the RECORDED actor, and activation
 * requires a *human*, not merely somebody holding Level 3.
 *
 * That property is easy to test for the wrong reason. Only a human can hold a Console credential
 * (`inviteStaff` refuses a village agent outright), so a test that signed in and tried would be
 * asserting the session gate and would pass with the module's gate deleted. To reach the module's
 * check at all, the agent case goes through the `x-actor-id` development seam on a second app —
 * which is the one path that can present a village agent to a route.
 *
 * The other property carried here is 7.1's: **`empty` is never `not_built`.** They produce the same
 * zero and mean opposite things, and the response counts them separately so the page cannot merge
 * them by accident.
 *
 * Every field the page renders is asserted by name. A browser renders a missing field as nothing at
 * all, so a renamed one is a blank in a sentence and no error anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import {
  MFA_SECRET_KEY_VARIABLE,
  base32Decode,
  confirmStaffEnrolment,
  createActor,
  enrolStaffFromInvitation,
  inviteStaff,
  totp,
  type Actor,
} from '@bwc/identity';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
import { publishStateModule, standingFor } from '@bwc/regulatory';
import { seedFoundingClaims } from '@bwc/claims';
import { createAsset, proposeClaim } from '@bwc/marketing';
import { approve, submitForReview } from '@bwc/governance';
import { registerProvider } from '@bwc/lenders';
import { createApp } from '../../apps/api/src/app.js';
import { type ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let seamServer: Server;
let base: string;
let seamBase: string;
let config: ConsoleConfig;

let clientId: string;
let providerId: string;
/** A village agent at Level 3. The actor the activation gate exists to refuse. */
let level3Agent: Actor;
/** A human at Level 0. Refused for the other reason - the level, not the kind. */
let level0Human: Actor;

const PASSWORD = 'a-long-enough-console-password';
const EMAIL = 'console-compliance@example.com';

const limiter = createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 });

let secret: Buffer;
let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

/** The date counsel is recorded as having reviewed. Fixed, never "now". */
const REVIEWED_AT = '2026-08-01';
const DOCUMENT_REFERENCE = 'Memo BW-REG-2026-050';
const COUNSEL = 'Outside counsel, Fig & Rowe LLP';

const human = () => ({ id: fx.human.id, kind: 'human' as const });

/** A well-formed id the board has never seen. The column is a UUID, so it has to look like one. */
const UNGOVERNED_PROVIDER_ID = '00000000-0000-4000-8000-00000000beef';

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly body: string;
}

let cookie = '';

const call = async (
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    origin?: string;
    /**
     * Send no session cookie.
     *
     * **Required on every seam call, and the first version of this file got it wrong.** `staffFrom`
     * reads the cookie BEFORE the development header, so a seam request that also carried a valid
     * session resolved to the signed-in human - and the village-agent test passed while never
     * presenting a village agent to the gate at all. It asserted nothing and would have survived
     * the gate being deleted.
     */
    noCookie?: boolean;
  } = {},
): Promise<Reply> => {
  const response = await fetch(`${init.origin ?? base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(cookie === '' || init.noCookie === true ? {} : { cookie }),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
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

const dataOf = async (path: string): Promise<Record<string, unknown>> => {
  const reply = await call(path);
  expect(reply.json['status'], `${path} -> ${reply.body}`).toBe('ok');
  return reply.json['data'] as Record<string, unknown>;
};

/** Publish a module so a state has something for counsel to have reviewed. */
const publish = async (state: string, changeKind: 'material' | 'editorial', version: string) =>
  publishStateModule({
    tenantId: fx.tenant.id,
    state,
    summary: `${state} module ${version}.`,
    citations: [`${state} commercial financing provisions`],
    disclosures: [
      {
        key: `${state.toLowerCase()}_cost_basis`,
        text: `Any cost figure shown to a ${state} client states the basis on which it was computed.`,
        citation: `${state} commercial financing provisions §1`,
      },
    ],
    changeKind,
    ...(changeKind === 'editorial' ? { changeRationale: 'Corrected a section number.' } : {}),
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('console-compliance');

  clientId = (await createClient(fx.tenant.id, 'Compliance Surfaces LLC', human())).id;

  // The actor this whole file is about: Level 3, and not a human.
  level3Agent = await createActor({
    tenantId: fx.tenant.id,
    kind: 'village_agent',
    label: 'Compliance & Evidence agent',
    authorityLevel: 3,
    department: 'compliance_and_evidence',
  });

  level0Human = await createActor({
    tenantId: fx.tenant.id,
    kind: 'human',
    label: 'Observing human',
    authorityLevel: 0,
    department: 'operations',
  });

  // --- the staff credential (a human at Level 3) ---
  const invitation = await inviteStaff({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    email: EMAIL,
    invitedBy: fx.human.id,
  });
  if (invitation.status !== 'ok') throw new Error(`setup: invite - ${invitation.reason}`);

  const offer = await enrolStaffFromInvitation({
    tenantId: fx.tenant.id,
    token: invitation.value.token,
    password: PASSWORD,
  });
  if (offer.status !== 'ok') throw new Error(`setup: enrol - ${offer.reason}`);

  const decoded = base32Decode(offer.value.secret);
  if (!decoded) throw new Error('setup: unreadable secret');
  secret = decoded;

  const confirmed = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    password: PASSWORD,
    code: totp(secret, at()),
  });
  if (confirmed.status !== 'ok') throw new Error(`setup: confirm - ${confirmed.reason}`);

  // --- 7.2: two states with modules, five priority states without ---
  const tx = await publish('TX', 'material', 'v1');
  if (tx.status !== 'ok') throw new Error(`setup: TX module - ${tx.reason}`);
  const nv = await publish('NV', 'material', 'v1');
  if (nv.status !== 'ok') throw new Error(`setup: NV module - ${nv.reason}`);

  // --- 7.4 / 4.5 ---
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', human());
  await proposeClaim({
    tenantId: fx.tenant.id,
    phrase: 'We work with lenders across the country',
    intendedUse: 'Landing page headline for the capital readiness funnel.',
    submittedBy: fx.human.id,
    actor: human(),
  });
  await createAsset({
    tenantId: fx.tenant.id,
    key: 'readiness-explainer',
    kind: 'email',
    body: 'A short explainer about capital readiness.',
    createdBy: fx.human.id,
    actor: human(),
  });

  // --- 5.4: one approved provider, reviewed long ago ---
  const provider = await registerProvider({
    tenantId: fx.tenant.id,
    name: 'A Governed Bank',
    kind: 'national_bank',
    statesServed: ['*'],
    actor: human(),
  });
  if (provider.status !== 'ok') throw new Error('setup: provider');
  providerId = provider.value.id;

  await submitForReview({
    tenantId: fx.tenant.id,
    providerId,
    submittedBy: 'capital-ops',
    rationale: 'Opening a governance file for the console test.',
    actor: human(),
  });
  const approved = await approve({
    tenantId: fx.tenant.id,
    providerId,
    approvedBy: 'capital-ops',
    rationale: 'Approved for the console test.',
    actor: human(),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  if (approved.status !== 'ok') throw new Error(`setup: approve - ${approved.reason}`);

  config = {
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

  /**
   * A second app with the development seam ON.
   *
   * The only way to present a village agent to a route: `inviteStaff` refuses one a credential, so
   * there is no session that could carry one. Without this, the agent case is untestable and the
   * module's `kind !== 'human'` check has nothing asserting it.
   */
  seamServer = createServer(
    createApp({ config: { ...config, devActorHeader: true }, limiter, now: at }),
  );
  await new Promise<void>((resolve) => seamServer.listen(0, '127.0.0.1', resolve));
  const seamAddress = seamServer.address();
  if (seamAddress === null || typeof seamAddress === 'string') throw new Error('setup: no address');
  seamBase = `http://127.0.0.1:${seamAddress.port}`;

  offsetMs += 31_000;
  const signIn = await fetch(`${base}/api/console/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, code: totp(secret, at()) }),
  });
  const setCookie = signIn.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup: sign-in returned no cookie');
  cookie = setCookie.split(';')[0] as string;
});

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (seamServer !== undefined) {
    await new Promise<void>((resolve) => seamServer.close(() => resolve()));
  }
  if (fx !== undefined) await cleanupTenant(fx.tenant.id);
});

const ADDED: readonly { path: string; method: 'GET' | 'POST'; body?: unknown }[] = [
  { path: '/api/console/regulatory/coverage', method: 'GET' },
  { path: '/api/console/regulatory/states/TX', method: 'GET' },
  {
    path: '/api/console/regulatory/states/TX/activation',
    method: 'POST',
    body: { reviewedBy: 'x', reviewedAt: REVIEWED_AT, documentReference: 'y' },
  },
  { path: '/api/console/regulatory/states/TX/withdrawal', method: 'POST', body: { reason: 'x' } },
  { path: '/api/console/evidence/clients/any-id/file', method: 'GET' },
  { path: '/api/console/evidence/clients/any-id/exports', method: 'GET' },
  { path: '/api/console/evidence/exports/any-id/reconciliation', method: 'GET' },
  { path: '/api/console/governance/review-queue', method: 'GET' },
  { path: '/api/console/governance/providers/any-id', method: 'GET' },
  { path: '/api/console/governance/restrictions', method: 'GET' },
  { path: '/api/console/marketing/claims', method: 'GET' },
  { path: '/api/console/marketing/proposals', method: 'GET' },
  { path: '/api/console/marketing/assets', method: 'GET' },
];

describe('none of the new surfaces answers without a session', () => {
  it.each(ADDED)('refuses $method $path', async (route) => {
    const held = cookie;
    cookie = '';
    try {
      const reply = await call(route.path, { method: route.method, body: route.body });
      expect(reply.json['status'], route.path).toBe('refused');
      expect(reply.status, route.path).toBe(409);
      expect(reply.json['reason'], route.path).toBe('Sign in to continue.');
    } finally {
      cookie = held;
    }
  });
});

// --- 7.2 the activation gate ------------------------------------------------

describe('7.2 the coverage map', () => {
  it('leads with the sentence that says the firm cannot serve anybody', async () => {
    const data = await dataOf('/api/console/regulatory/coverage');

    // Nothing is activated at this point in the file, which is the system's actual condition.
    expect(data['activeTotal']).toBe(0);
    expect(data['activeStates']).toEqual([]);
    expect(String(data['headline'])).toContain('No state is active');
    expect(String(data['headline'])).toContain('middleware step 5');
  });

  it('carries every field the page reads on a state row', async () => {
    const data = await dataOf('/api/console/regulatory/coverage');
    const states = data['states'] as Record<string, unknown>[];

    expect(states).toHaveLength(2);
    expect(Object.keys(states[0] as object).sort()).toEqual([
      'currentVersion',
      'explanation',
      'permitsClientFacingAction',
      'reviewedVersion',
      'state',
      'status',
    ]);
    expect(data['total']).toBe(2);

    const nv = states.find((entry) => entry['state'] === 'NV');
    expect(nv?.['status']).toBe('draft');
    expect(nv?.['permitsClientFacingAction']).toBe(false);
    // Never activated, so nothing has been reviewed. `null`, not 0 - a reviewed version of zero
    // would read as a review of the first module.
    expect(nv?.['reviewedVersion']).toBeNull();

    // Counted by status rather than reduced to a percentage: `draft` and `needs_counsel_review`
    // both block and are cleared by different work.
    expect((data['byStatus'] as Record<string, number>)['draft']).toBe(2);
  });

  it('names the V1 priority states that have no module at all', async () => {
    const data = await dataOf('/api/console/regulatory/coverage');

    // Absent from `coverage()` by construction, because it reads published modules. A map that
    // omitted them would read as complete.
    expect(data['priorityStatesWithoutModule']).toEqual(['CA', 'NY', 'FL', 'AZ', 'UT']);
    expect(data['priorityStatesWithoutModuleTotal']).toBe(5);
  });
});

describe('7.2 one state', () => {
  it('carries the standing, the module, the history and what activation requires', async () => {
    const data = await dataOf('/api/console/regulatory/states/TX');

    expect(Object.keys(data['standing'] as object).sort()).toEqual([
      'currentVersion',
      'explanation',
      'permitsClientFacingAction',
      'reviewedVersion',
      'state',
      'status',
    ]);

    // The requirement is described from the module rather than restated by the page.
    const requires = data['activationRequires'] as Record<string, unknown>;
    expect(Object.keys(requires).sort()).toEqual([
      'counselName',
      'documentReference',
      'humanActorAtLevel',
      'note',
      'reviewDate',
    ]);
    expect(requires['humanActorAtLevel']).toBe(3);
    // The sentence that stops a reader assuming Level 3 is the whole of it.
    expect(String(requires['note'])).toContain('village agent at Level 3 is refused');

    const module = data['module'] as Record<string, unknown>;
    expect(Object.keys(module).sort()).toEqual([
      'changeKind',
      'changeRationale',
      'citations',
      'createdBy',
      'summary',
      'version',
    ]);
    expect(data['moduleUnavailableReason']).toBeNull();

    const history = data['history'] as Record<string, unknown>[];
    expect(Object.keys(history[0] as object).sort()).toEqual([
      'changeKind',
      'changeRationale',
      'createdBy',
      'summary',
      'supersededAt',
      'version',
    ]);
    expect(data['historyTotal']).toBe(history.length);

    const disclosures = data['disclosures'] as Record<string, unknown>[];
    expect(Object.keys(disclosures[0] as object).sort()).toEqual([
      'citation',
      'key',
      'productKind',
      'source',
      'text',
    ]);
    // Federal first, then the state layer. `source` is what tells a reader which obliges it.
    expect(disclosures[0]?.['source']).toBe('federal');
    expect(disclosures.some((entry) => entry['source'] === 'TX')).toBe(true);
    expect(data['disclosuresTotal']).toBe(disclosures.length);

    expect(data['outstandingLawChanges']).toEqual([]);
    expect(data['outstandingLawChangesTotal']).toBe(0);
  });

  it('reports a state with no module as such rather than as an error', async () => {
    const data = await dataOf('/api/console/regulatory/states/WY');

    expect((data['standing'] as Record<string, unknown>)['status']).toBe('no_module');
    expect(data['module']).toBeNull();
    expect(String(data['moduleUnavailableReason'])).toContain('No regulatory module');
  });
});

describe('7.2 THE ACTIVATION GATE', () => {
  it('refuses a Level 3 VILLAGE AGENT, which is the property ADR-0009 exists for', async () => {
    // **THE ASSERTION THIS FILE EXISTS FOR.**
    //
    // Level 3 is not the gate. `kind === 'human'` is the other half, and it is the half a numeric
    // level check - which is all middleware step 3 would apply - does not perform. Reached through
    // the development seam because a village agent cannot hold a Console credential at all, so no
    // session could carry one.
    const reply = await call('/api/console/regulatory/states/TX/activation', {
      origin: seamBase,
      noCookie: true,
      headers: { 'x-actor-id': level3Agent.id },
      body: {
        reviewedBy: COUNSEL,
        reviewedAt: REVIEWED_AT,
        documentReference: DOCUMENT_REFERENCE,
      },
    });

    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toContain('cannot activate TX');
    expect(String(reply.json['reason'])).toContain('human at Authority Level 3');

    // The module gate is named as the step that blocked it, so a reader is not left to guess
    // whether the session, the input or the module refused.
    const gate = reply.json['gate'] as Record<string, unknown>[];
    const blocked = gate.find((step) => step['outcome'] === 'blocked');
    expect(blocked?.['check']).toBe('module_gate');

    // And the state is unchanged.
    const standing = await standingFor(fx.tenant.id, 'TX');
    expect(standing.status).not.toBe('active');
    expect(standing.permitsClientFacingAction).toBe(false);
  });

  it('refuses a human below Level 3', async () => {
    const reply = await call('/api/console/regulatory/states/TX/activation', {
      origin: seamBase,
      noCookie: true,
      headers: { 'x-actor-id': level0Human.id },
      body: {
        reviewedBy: COUNSEL,
        reviewedAt: REVIEWED_AT,
        documentReference: DOCUMENT_REFERENCE,
      },
    });

    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toContain('human at Authority Level 3');
    // Deliberately NOT asserting TX's standing here. The agent test above owns that claim, and
    // duplicating it made this test fail whenever THAT one did - mutation testing surfaced it as a
    // second red line with a cause it did not have. A test that fails for somebody else's reason is
    // a test that will one day be believed about the wrong thing.
  });

  it.each([
    ['documentReference', { reviewedBy: COUNSEL, reviewedAt: REVIEWED_AT }],
    ['reviewedBy', { reviewedAt: REVIEWED_AT, documentReference: DOCUMENT_REFERENCE }],
    ['reviewedAt', { reviewedBy: COUNSEL, documentReference: DOCUMENT_REFERENCE }],
  ])('refuses an activation missing %s, naming it', async (field, body) => {
    const reply = await call('/api/console/regulatory/states/TX/activation', { body });

    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toContain(field);

    const gate = reply.json['gate'] as Record<string, unknown>[];
    const blocked = gate.find((step) => step['outcome'] === 'blocked');
    expect(blocked?.['check']).toBe('counsel_review_recorded');
  });

  it('refuses a review date it cannot read rather than substituting one', async () => {
    // ADR-0035: a defaulted review date would be the system asserting when counsel did their work.
    const reply = await call('/api/console/regulatory/states/TX/activation', {
      body: {
        reviewedBy: COUNSEL,
        reviewedAt: 'last Tuesday',
        documentReference: DOCUMENT_REFERENCE,
      },
    });

    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toContain('reviewedAt');
  });

  it('refuses a state with no module, because there is nothing for counsel to have reviewed', async () => {
    const reply = await call('/api/console/regulatory/states/WY/activation', {
      body: {
        reviewedBy: COUNSEL,
        reviewedAt: REVIEWED_AT,
        documentReference: DOCUMENT_REFERENCE,
      },
    });

    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toContain('No regulatory module exists for WY');
  });

  it('brings a state online for a Level 3 human, and says which checks ran', async () => {
    const reply = await call('/api/console/regulatory/states/TX/activation', {
      body: {
        reviewedBy: COUNSEL,
        reviewedAt: REVIEWED_AT,
        documentReference: DOCUMENT_REFERENCE,
        notes: 'Reviewed alongside the federal baseline.',
      },
    });

    expect(reply.json['status'], reply.body).toBe('ok');
    const data = reply.json['data'] as Record<string, unknown>;
    expect(data['status']).toBe('active');
    expect(data['permitsClientFacingAction']).toBe(true);
    expect(data['reviewedVersion']).toBe(1);

    // Every gate step the page renders.
    const gate = reply.json['gate'] as Record<string, unknown>[];
    expect(gate.map((step) => step['check'])).toEqual([
      'session',
      'tenant_scope',
      'counsel_review_recorded',
      'module_gate',
    ]);
    for (const step of gate) {
      expect(Object.keys(step).sort()).toEqual(['check', 'detail', 'outcome']);
      expect(step['outcome']).toBe('passed');
    }

    // The note is what stops a reader mistaking these for the middleware chain.
    expect(String(reply.json['gateNote'])).toContain('not the middleware chain');
    expect(String(reply.json['gateNote'])).toContain('ACTION_MINIMUM_LEVEL');

    // The gate is real: the module agrees, not just the response.
    const standing = await standingFor(fx.tenant.id, 'TX');
    expect(standing.status).toBe('active');
    expect(standing.permitsClientFacingAction).toBe(true);
  });

  it('now reports the state as active on the coverage map', async () => {
    const data = await dataOf('/api/console/regulatory/coverage');

    expect(data['activeTotal']).toBe(1);
    expect(data['activeStates']).toEqual(['TX']);
    expect(String(data['headline'])).toContain('1 state(s) active: TX');
    expect(String(data['headline'])).toContain('cannot be served');
  });

  it('sends the state back to counsel when the module is materially republished', async () => {
    // ADR-0009's rule: any MATERIAL version since the reviewed one, not merely a newer version.
    const republished = await publish('TX', 'material', 'v2');
    expect(republished.status).toBe('ok');

    const data = await dataOf('/api/console/regulatory/states/TX');
    const standing = data['standing'] as Record<string, unknown>;

    expect(standing['status']).toBe('needs_counsel_review');
    expect(standing['permitsClientFacingAction']).toBe(false);
    expect(standing['reviewedVersion']).toBe(1);
    expect(standing['currentVersion']).toBe(2);
    expect(String(standing['explanation'])).toContain('material change');
  });

  it('leaves activation intact across an editorial republish', async () => {
    // Re-activate against v2, then publish an editorial v3.
    const reactivated = await call('/api/console/regulatory/states/TX/activation', {
      body: {
        reviewedBy: COUNSEL,
        reviewedAt: REVIEWED_AT,
        documentReference: 'Memo BW-REG-2026-051',
      },
    });
    expect(reactivated.json['status'], reactivated.body).toBe('ok');

    const editorial = await publish('TX', 'editorial', 'v3');
    expect(editorial.status).toBe('ok');

    const standing = await standingFor(fx.tenant.id, 'TX');
    // A rule that punished a typo fix as hard as a rewrite would teach people to batch typo fixes
    // into rewrites, which is the opposite of what the gate wants.
    expect(standing.status).toBe('active');
    expect(standing.permitsClientFacingAction).toBe(true);
  });

  it('withdraws a state with a reason, and refuses one without', async () => {
    const without = await call('/api/console/regulatory/states/TX/withdrawal', { body: {} });
    expect(without.json['status']).toBe('refused');
    expect(String(without.json['reason'])).toContain('requires a reason');

    const withdrawn = await call('/api/console/regulatory/states/TX/withdrawal', {
      body: { reason: 'Counsel flagged an ambiguity in the disclosure wording.' },
    });
    expect(withdrawn.json['status'], withdrawn.body).toBe('ok');
    expect((withdrawn.json['data'] as Record<string, unknown>)['status']).toBe('withdrawn');
    expect(
      (withdrawn.json['data'] as Record<string, unknown>)['permitsClientFacingAction'],
    ).toBe(false);

    // Withdrawal takes effect on the next action with no propagation step, because standing is
    // derived rather than stored.
    expect((await standingFor(fx.tenant.id, 'TX')).permitsClientFacingAction).toBe(false);
  });
});

// --- 7.1 the evidence file --------------------------------------------------

describe('7.1 the evidence file', () => {
  it('counts the four coverage verdicts separately, so empty is never not_built', async () => {
    const data = await dataOf(`/api/console/evidence/clients/${clientId}/file`);

    // **THE ASSERTION THIS SURFACE EXISTS FOR.** One "sections with no rows" figure would merge a
    // client who has no complaints with a complaints module nobody built.
    const by = data['byCoverage'] as Record<string, number>;
    expect(Object.keys(by).sort()).toEqual(['complete', 'empty', 'failed', 'not_built']);
    expect(by['empty']).toBeGreaterThan(0);
    expect(by['not_built']).toBeGreaterThan(0);
    // The two zeroes are different numbers in the response, not one merged count.
    expect(by['empty']).not.toBe(undefined);
    expect(by['not_built']).not.toBe(undefined);

    expect(data['coverageTotal']).toBe((data['coverage'] as unknown[]).length);
  });

  it('carries every field the page reads on a coverage row, with the verdict beside the count', async () => {
    const data = await dataOf(`/api/console/evidence/clients/${clientId}/file`);
    const coverage = data['coverage'] as Record<string, unknown>[];

    expect(Object.keys(coverage[0] as object).sort()).toEqual([
      'coverage',
      'description',
      'itemCount',
      'key',
      'module',
      'note',
    ]);

    // `itemCount` never travels without `coverage`: a bare 0 is the misleading half of this file.
    for (const entry of coverage) {
      expect(typeof entry['coverage']).toBe('string');
      expect(typeof entry['itemCount']).toBe('number');
      expect(String(entry['note']).length).toBeGreaterThan(0);
    }

    // A `not_built` row still names the module it would have come from, so a gap is traceable.
    const notBuilt = coverage.find((entry) => entry['coverage'] === 'not_built');
    expect(String(notBuilt?.['module']).length).toBeGreaterThan(0);
  });

  it('carries the header fields, the hash and the ledger integrity', async () => {
    const data = await dataOf(`/api/console/evidence/clients/${clientId}/file`);

    expect(data['clientLegalName']).toBe('Compliance Surfaces LLC');
    expect(data['scope']).toBe('client');
    expect(data['engagementId']).toBeNull();
    expect(data['complianceState']).toBe('pending_assessment');
    expect(typeof data['contentHash']).toBe('string');

    const integrity = data['ledgerIntegrity'] as Record<string, unknown>;
    expect(Object.keys(integrity).sort()).toEqual(['checked', 'detail', 'intact']);
    expect(integrity['intact']).toBe(true);

    expect(data['gapsTotal']).toBe((data['gaps'] as unknown[]).length);
  });

  it('says the evidence itself is not carried rather than leaving it to be inferred', async () => {
    const data = await dataOf(`/api/console/evidence/clients/${clientId}/file`);

    expect(data['sectionsCarried']).toBe(false);
    expect(String(data['sectionsNote'])).toContain('coverage map travels');
    // No section contents anywhere in the response.
    expect(data).not.toHaveProperty('sections');
  });

  it('names the export as unavailable and why, rather than offering a control that would fail', async () => {
    const data = await dataOf(`/api/console/evidence/clients/${clientId}/exports`);

    expect(data['exports']).toEqual([]);
    expect(data['total']).toBe(0);
    expect(data['exportAvailableHere']).toBe(false);
    expect(String(data['exportUnavailableReason'])).toContain('ACTION_MINIMUM_LEVEL');
    expect(data['requiredAction']).toBe('export_evidence_file');
  });
});

// --- 5.4 governance ---------------------------------------------------------

describe('5.4 provider governance', () => {
  it('reports the review queue with the cadence ceiling beside it', async () => {
    const data = await dataOf('/api/console/governance/review-queue');

    // Approved on 2026-01-01 and the clock is well past 90 days, so it is overdue.
    const providers = data['providers'] as Record<string, unknown>[];
    expect(providers.length).toBeGreaterThan(0);
    expect(Object.keys(providers[0] as object).sort()).toEqual([
      'blockers',
      'daysSinceReview',
      'explanation',
      'providerId',
      'requiredDisclosures',
      'verdict',
    ]);
    expect(providers[0]?.['verdict']).toBe('not_recommendable');
    expect(providers[0]?.['blockers']).toContain('review_overdue');

    expect(data['total']).toBe(providers.length);
    // "Overdue" says nothing without the number it is overdue against.
    expect(data['maximumReviewCadenceDays']).toBe(90);
    expect(String(data['headline'])).toContain('past their review cadence');
  });

  it('reports a provider the board has never seen as never governed, not as unapproved', async () => {
    const data = await dataOf(`/api/console/governance/providers/${UNGOVERNED_PROVIDER_ID}`);

    expect(data['governance']).toBeNull();
    expect(data['neverGoverned']).toBe(true);

    const standing = data['standing'] as Record<string, unknown>;
    expect(Object.keys(standing).sort()).toEqual([
      'blockers',
      'daysSinceReview',
      'explanation',
      'requiredDisclosures',
      'verdict',
    ]);
    expect(standing['blockers']).toContain('never_governed');
    expect(standing['daysSinceReview']).toBeNull();
    expect(data['decisionsTotal']).toBe(0);
    expect(data['complaintsTotal']).toBe(0);
  });

  it('carries the governance record and its decision history for a governed provider', async () => {
    const data = await dataOf(`/api/console/governance/providers/${providerId}`);

    expect(data['neverGoverned']).toBe(false);
    const governance = data['governance'] as Record<string, unknown>;
    expect(Object.keys(governance).sort()).toEqual([
      'approvedStates',
      'blacklistReason',
      'complaintCount',
      'lastReviewedAt',
      'requiredDisclosures',
      'restrictedStates',
      'reviewCadenceDays',
      'status',
    ]);
    expect(governance['status']).toBe('approved');

    const decisions = data['decisions'] as Record<string, unknown>[];
    expect(Object.keys(decisions[0] as object).sort()).toEqual([
      'decidedAt',
      'decidedBy',
      'fromStatus',
      'rationale',
      'toStatus',
    ]);
    expect(data['decisionsTotal']).toBe(decisions.length);
  });

  it('says an empty approved-states list means not limited, not limited to nothing', async () => {
    const data = await dataOf('/api/console/governance/restrictions');
    const restrictions = data['restrictions'] as Record<string, unknown>[];

    expect(Object.keys(restrictions[0] as object).sort()).toEqual([
      'approvedStates',
      'limitedToStates',
      'providerId',
      'requiredDisclosures',
      'restrictedStates',
      'status',
    ]);
    // The provider was approved with no state restriction, so the flag is false and the page
    // renders "approval not limited by state" rather than an empty list.
    expect(restrictions[0]?.['limitedToStates']).toBe(false);
    expect(restrictions[0]?.['approvedStates']).toEqual([]);
    expect(data['total']).toBe(restrictions.length);
    expect(String(data['note'])).toContain('not that it is limited to none');
  });
});

// --- 7.4 and 4.5 ------------------------------------------------------------

describe('7.4 the claim library', () => {
  it('counts banned as a peer disposition, not as a problem tally', async () => {
    const data = await dataOf('/api/console/marketing/claims');
    const by = data['byDisposition'] as Record<string, number>;

    // **THE ASSERTION.** All three seeded to zero and counted the same way, so no arithmetic on
    // this response can produce a "problems" figure.
    expect(Object.keys(by).sort()).toEqual(['approved', 'banned', 'requires_disclaimer']);
    expect(by['banned']).toBeGreaterThan(0);

    // Said in the response rather than left to the page's styling.
    expect(data['bannedIsAnOutcome']).toBe(true);
    expect(String(data['bannedNote'])).toContain('Board working');
    expect(data['dispositions']).toEqual(['approved', 'banned', 'requires_disclaimer']);
  });

  it('carries every field the page reads on a claim', async () => {
    const data = await dataOf('/api/console/marketing/claims');
    const claims = data['claims'] as Record<string, unknown>[];

    expect(Object.keys(claims[0] as object).sort()).toEqual([
      'approvedBy',
      'disposition',
      'global',
      'id',
      'jurisdiction',
      'phrase',
      'rationale',
      'requiredDisclosure',
      'version',
    ]);
    expect(data['total']).toBe(claims.length);
    expect(data['jurisdiction']).toBeNull();

    // `global` is derived from the sentinel so the page never has to know what `*` means.
    const banned = claims.find((claim) => claim['disposition'] === 'banned');
    expect(banned?.['global']).toBe(true);
    expect(String(banned?.['rationale']).length).toBeGreaterThan(0);
  });
});

describe('4.5 marketing ops', () => {
  it('carries the proposal queue with its intended use and all three outcomes', async () => {
    const data = await dataOf('/api/console/marketing/proposals');
    const proposals = data['proposals'] as Record<string, unknown>[];

    expect(proposals).toHaveLength(1);
    expect(Object.keys(proposals[0] as object).sort()).toEqual([
      'id',
      'intendedUse',
      'jurisdiction',
      'phrase',
      'status',
      'submittedAt',
    ]);
    expect(data['total']).toBe(1);
    expect(data['reviewAuthorityLevel']).toBe(3);

    // Three outcomes, not two. A queue offering approve-or-reject loses the useful one.
    expect(String(data['outcomesNote'])).toContain('approved as banned');
    expect(data['decisionAvailableHere']).toBe(false);
    expect(data['requiredActions']).toEqual([
      'approve_marketing_claim',
      'reject_marketing_claim',
    ]);
  });

  it('carries assets with every state counted, including the empty ones', async () => {
    const data = await dataOf('/api/console/marketing/assets');
    const assets = data['assets'] as Record<string, unknown>[];

    expect(Object.keys(assets[0] as object).sort()).toEqual([
      'body',
      'id',
      'key',
      'kind',
      'rejectionReason',
      'state',
    ]);
    expect(data['total']).toBe(assets.length);

    // Every state seeded to zero, so a state with no assets renders as `0` rather than as nothing.
    const byState = data['byState'] as Record<string, number>;
    expect(Object.keys(byState).sort()).toEqual([
      'approved',
      'draft',
      'in_review',
      'rejected',
      'retired',
    ]);
    expect(byState['draft']).toBe(1);
    expect(data['filteredTo']).toBeNull();
  });
});

// --- the page's own source --------------------------------------------------

const VIEWS = join(process.cwd(), 'apps', 'api', 'public', 'views');

describe('the view modules keep the rules the page keeps', () => {
  it('assign nothing to a markup-writing property', async () => {
    for (const file of ['regulatory.js', 'compliance.js', 'governance.js', 'marketing.js']) {
      const source = await readFile(join(VIEWS, file), 'utf8');
      expect(source, file).not.toContain('innerHTML');
      expect(source, file).not.toContain('outerHTML');
      expect(source, file).not.toContain('insertAdjacentHTML');
      expect(source, file).not.toContain('document.write');
      expect(source, file).not.toContain('eval(');
    }
  });

  it('are served, and named only from the document', async () => {
    const html = await readFile(
      join(process.cwd(), 'apps', 'api', 'public', 'index.html'),
      'utf8',
    );

    for (const file of ['regulatory.js', 'compliance.js', 'governance.js', 'marketing.js']) {
      expect(html).toContain(`/console/views/${file}`);
      const response = await fetch(`${base}/console/views/${file}`);
      expect(response.status, file).toBe(200);
      expect(response.headers.get('content-type'), file).toMatch(/javascript/u);
    }

    // Still no inline script anywhere, so the policy needs no 'unsafe-inline' and no nonce.
    expect(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/u.test(html)).toBe(false);
  });

  it('name only routes that exist', async () => {
    for (const file of ['regulatory.js', 'compliance.js', 'governance.js', 'marketing.js']) {
      const source = await readFile(join(VIEWS, file), 'utf8');
      const paths = [...source.matchAll(/[`'"](\/api\/[^`'"]*)[`'"]/gu)]
        .map((match) => match[1] as string)
        .map((path) => path.replace(/\$\{[^}]*\}/gu, 'a-placeholder-id'))
        .map((path) => path.replace(/\?.*$/u, ''));

      expect(paths.length, file).toBeGreaterThan(0);

      for (const path of new Set(paths)) {
        const [posted, fetched] = await Promise.all([
          fetch(`${base}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
          fetch(`${base}${path}`),
        ]);
        // A page written against a renamed endpoint fails in a browser and passes every server
        // test. This is the only cheap defence.
        expect(posted.status === 404 && fetched.status === 404, `${file} ${path}`).toBe(false);
      }
    }
  });
});
