/**
 * The last five module surfaces on the Console transport: 11.7, 3.1, 3.3, 10.1, 11.6.
 *
 * Five properties carry this file, one per module, and each is the thing that module is easiest to
 * get wrong from a transport.
 *
 * **11.7 — invariants arrive as a separate collection, not as parameters with a flag.** Asserted by
 * shape: every invariant carries `whyFixed`, no invariant carries bounds, and no parameter key
 * appears in both lists. A single list with `editable: false` would satisfy a looser test and would
 * put a rendering branch one truthy value away from drawing an input for TCPA quiet hours.
 *
 * **11.6 — the warehouse refuses without a period, and answers `no_data` for an empty one.** Both
 * halves matter: a default period is a live read wearing a historical label, and a zero-filled
 * series is a claim that the business did nothing.
 *
 * **10.1 — no acknowledgement is reachable, and the reason is not "no declared action".** The
 * blocked-writes list separates the two kinds, and the test asserts the acknowledgement entry says
 * it is unblocked by nothing on this surface.
 *
 * **3.3 — every finding carries provenance and the confidence it supports.** Asserted field by
 * field, because forwarding `detail.value` alone is one keystroke and turns a sourced observation
 * into a bare fact.
 *
 * **3.1 — every version is listed with its own status, and an unverified figure is flagged.**
 *
 * Every field the pages render is asserted here. A browser shows a wrong field name as blank text,
 * never as an error.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { INVARIANTS, PARAMETERS } from '@bwc/admin';
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
let secret: Buffer;

const PASSWORD = 'a-long-enough-console-password';
const EMAIL = 'console-final-operator@example.com';

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

const call = async (path: string): Promise<Reply> => {
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
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

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('console-final');

  clientId = (await createClient(fx.tenant.id, 'Console Final LLC', HUMAN())).id;

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
    '/api/console/admin/configuration',
    '/api/console/deliverables/templates',
    '/api/console/deliverables/any-id',
    '/api/console/clients/any-id/deliverables',
    '/api/console/clients/any-id/intelligence?phase=0',
    '/api/console/interventure/relationships',
    '/api/console/interventure/engagements/any-id?clientId=x',
    '/api/console/interventure/clients/any-id',
    '/api/console/warehouse/snapshots?from=2026-01-01&to=2026-02-01',
    '/api/console/warehouse/trend?from=2026-01-01&to=2026-02-01&metric=clients',
    '/api/console/warehouse/cohorts',
  ] as const;

  it('refuses each of them anonymously', async () => {
    for (const path of GUARDED) {
      const response = await fetch(`${base}${path}`);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['status'], path).toBe('refused');
      expect(String(body['reason']), path).toMatch(/Sign in/);
    }
  });
});

describe('11.7 - an invariant is absent, not permission-gated', () => {
  it('sends invariants as their own collection, each with why it is fixed', async () => {
    const data = dataOf(await call('/api/console/admin/configuration'));
    const invariants = data['invariants'] as {
      key: string;
      label: string;
      value: string;
      whyFixed: string;
    }[];

    expect(invariants.length).toBe(INVARIANTS.length);
    expect(invariants.length).toBeGreaterThan(0);

    for (const invariant of invariants) {
      // The sentence that stops somebody looking for a workaround. Never empty, never truncated.
      expect(invariant.whyFixed.length, invariant.key).toBeGreaterThan(40);
      expect(invariant.value.length, invariant.key).toBeGreaterThan(0);
      expect(invariant.label.length, invariant.key).toBeGreaterThan(0);
    }

    // The TCPA window and the Level 4 list are the two an admin surface is most likely to be
    // asked for, so they are asserted by name rather than by count.
    const quietHours = invariants.find((entry) => entry.key === 'comms.QUIET_HOURS');
    expect(quietHours?.whyFixed).toMatch(/TCPA/);
    const prohibited = invariants.find((entry) => entry.key === 'core.PROHIBITED_ACTIONS');
    expect(prohibited?.whyFixed).toMatch(/no authority level/i);
  });

  it('gives an invariant no bounds and no editability flag, in either direction', async () => {
    // **The shape assertion.** An invariant that carried `minimum`/`maximum` would render through
    // the parameter path; a parameter that carried `whyFixed` would render as fixed. Either is a
    // list that has become one list wearing a boolean.
    const data = dataOf(await call('/api/console/admin/configuration'));
    const invariants = data['invariants'] as Record<string, unknown>[];
    const parameters = data['parameters'] as Record<string, unknown>[];

    for (const invariant of invariants) {
      expect(invariant).not.toHaveProperty('minimum');
      expect(invariant).not.toHaveProperty('maximum');
      expect(invariant).not.toHaveProperty('editable');
      expect(invariant).not.toHaveProperty('compiledDefault');
    }
    for (const parameter of parameters) {
      expect(parameter).not.toHaveProperty('whyFixed');
      expect(parameter).toHaveProperty('minimum');
      expect(parameter).toHaveProperty('maximum');
    }

    // And no key is in both lists. A key that was would be configurable and fixed at once.
    const invariantKeys = new Set(invariants.map((entry) => entry.key));
    for (const parameter of parameters) {
      expect(invariantKeys.has(parameter['key']), String(parameter['key'])).toBe(false);
    }
  });

  it('carries every parameter with the bounds and the reasoning behind them', async () => {
    const data = dataOf(await call('/api/console/admin/configuration'));
    const parameters = data['parameters'] as Record<string, unknown>[];

    expect(parameters.length).toBe(PARAMETERS.length);
    for (const parameter of parameters) {
      // A range with no reasoning is a guess with a fence.
      expect(String(parameter['boundsBasis']).length).toBeGreaterThan(20);
      expect(String(parameter['owner']).length).toBeGreaterThan(0);
      expect(typeof parameter['highRisk']).toBe('boolean');
      // Where the value came from, so 45 days is distinguishable from nobody having chosen.
      expect(['compiled_default', 'tenant_change']).toContain(parameter['source']);
    }
  });

  it('reports totals so a list is not something a reader has to count', async () => {
    const data = dataOf(await call('/api/console/admin/configuration'));
    const totals = data['totals'] as Record<string, number>;
    expect(totals['invariants']).toBe(INVARIANTS.length);
    expect(totals['parametersInRegistry']).toBe(PARAMETERS.length);
    expect(totals['parameters']).toBe((data['parameters'] as unknown[]).length);
  });

  it('offers no write, and says configuration is what is missing', async () => {
    const data = dataOf(await call('/api/console/admin/configuration'));
    const writes = data['writes'] as Record<string, unknown>;
    expect(writes['available']).toEqual([]);
    const blocked = writes['blocked'] as { capability: string; why: string }[];
    expect(blocked.length).toBeGreaterThan(0);
    // And editing an invariant is NOT listed as blocked - that would put it on the same footing as
    // a parameter change waiting on a decision, and imply an action would unlock it.
    expect(blocked.map((entry) => entry.capability).join(' ')).not.toMatch(/invariant/i);
  });
});

describe('11.6 - the warehouse answers about the past', () => {
  it('refuses without a period rather than defaulting one', async () => {
    // A default period is a live read wearing a historical label.
    const reply = await call('/api/console/warehouse/snapshots');
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/no notion of "now"/);
  });

  it('answers no_data for an empty period, never a zero', async () => {
    const reply = await call('/api/console/warehouse/snapshots?from=2020-01-01&to=2020-02-01');
    expect(reply.json['status']).toBe('no_data');
    expect(String(reply.json['reason'])).toMatch(/not a period in which nothing happened/);
    // No zeroed facts anywhere in the body - a flat line would be a claim about the business.
    expect(reply.body).not.toMatch(/"clients":0/);
  });

  it('refuses an unknown trend metric with the list rather than returning nothing', async () => {
    const reply = await call(
      '/api/console/warehouse/trend?from=2020-01-01&to=2020-02-01&metric=made_up',
    );
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/metric must be one of/);
  });

  it('forwards the module no_data for a trend over an empty period', async () => {
    const reply = await call(
      '/api/console/warehouse/trend?from=2020-01-01&to=2020-02-01&metric=clients',
    );
    expect(reply.json['status']).toBe('no_data');
  });

  it('lists cohorts without a period, and says nothing captures snapshots', async () => {
    const data = dataOf(await call('/api/console/warehouse/cohorts'));
    expect(Array.isArray(data['cohorts'])).toBe(true);
    expect(data['total']).toBe((data['cohorts'] as unknown[]).length);
    expect(data['retention']).toBeNull();
    // The fact that makes this surface worth its keep: the ETL gap is visible.
    const etl = data['etl'] as Record<string, string>;
    expect(etl['producer']).toBe('none');
    expect(etl['detail']).toMatch(/only tests do/);
  });
});

describe('10.1 - a page cannot complete a disclosure', () => {
  it('separates a missing action from a party who is not us', async () => {
    // **The assertion this surface exists for.** Both entries are blocked; only one would be
    // unblocked by declaring an action, and collapsing them would suggest otherwise.
    const data = dataOf(await call('/api/console/interventure/relationships'));
    const blocked = (data['writes'] as Record<string, unknown>)['blocked'] as {
      capability: string;
      missingAction: string;
      why: string;
      unblockedBy: string;
    }[];

    const generate = blocked.find((entry) =>
      /Generate a conflict disclosure/i.test(entry.capability),
    );
    expect(generate?.missingAction).toBe('none declared');
    expect(generate?.unblockedBy).toMatch(/declared action/);

    const acknowledge = blocked.find((entry) =>
      /Acknowledge a conflict disclosure/i.test(entry.capability),
    );
    expect(acknowledge).toBeDefined();
    expect(acknowledge?.missingAction).toBe('not applicable');
    expect(acknowledge?.unblockedBy).toMatch(/nothing on this surface/);
    expect(acknowledge?.why).toMatch(/NOT us/);
    expect(acknowledge?.why).toMatch(/manufacture the evidence/);
  });

  it('lists relationships with totals and the ventures they could be tagged as', async () => {
    const data = dataOf(await call('/api/console/interventure/relationships'));
    expect(data['total']).toBe((data['relationships'] as unknown[]).length);
    expect((data['ventures'] as unknown[]).length).toBeGreaterThan(0);
    expect(data['awaitingRoutingTotal']).toBe((data['awaitingRouting'] as unknown[]).length);
  });

  it('requires a client id for a conflict position rather than guessing', async () => {
    // A well-formed engagement id. `some-engagement` passed here only because `mayProceed`
    // short-circuits on a client with no venture relationship before it reaches the
    // `conflictDisclosure` query - and that column is `@db.Uuid`, so any client that HAD one
    // raised in Postgres and returned a 500. The id guard catches it first now.
    const reply = await call(
      '/api/console/interventure/engagements/00000000-0000-0000-0000-0000000000e1',
    );
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/clientId is required/);
  });

  it('reports a non-intercompany engagement as such rather than as an empty disclosure', async () => {
    const reply = await call(
      `/api/console/interventure/engagements/00000000-0000-0000-0000-0000000000e1?clientId=${clientId}`,
    );
    // `mayProceed` answers ok for an engagement with no venture relationship - most engagements.
    const data = dataOf(reply);
    expect(data['intercompany']).toBe(false);
    expect(data['disclosure']).toBeNull();
    expect(String(data['detail']).length).toBeGreaterThan(0);
  });

  it('lists handoffs and pricing deviations for a client, with totals', async () => {
    const data = dataOf(await call(`/api/console/interventure/clients/${clientId}`));
    expect(data['handoffsTotal']).toBe((data['handoffs'] as unknown[]).length);
    expect(data['deviationsTotal']).toBe((data['deviations'] as unknown[]).length);
  });
});

describe('3.3 - a finding is not a fact', () => {
  it('refuses without a phase, because coverage is per phase', async () => {
    const reply = await call(`/api/console/clients/${clientId}/intelligence`);
    expect(reply.json['status']).toBe('refused');
    expect(String(reply.json['reason'])).toMatch(/phase must be one of/);
  });

  it('carries findings, runs and coverage together with the threshold applied', async () => {
    const data = dataOf(await call(`/api/console/clients/${clientId}/intelligence?phase=0`));

    expect(Array.isArray(data['findings'])).toBe(true);
    expect(data['findingsTotal']).toBe((data['findings'] as unknown[]).length);
    expect(typeof data['findingsUnverified']).toBe('number');
    expect(Array.isArray(data['runs'])).toBe(true);
    expect(data['runsTotal']).toBe((data['runs'] as unknown[]).length);
    // The line the module draws, sent so the page states it rather than leaving a bare ratio.
    expect(typeof data['minimumCoverage']).toBe('number');
    expect(data['coverage']).toHaveProperty('phase');
  });

  it('names the pipeline write it cannot offer, and why analyze_file is the wrong label', async () => {
    const data = dataOf(await call(`/api/console/clients/${clientId}/intelligence?phase=0`));
    const blocked = (data['writes'] as Record<string, unknown>)['blocked'] as { why: string }[];
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]?.why).toMatch(/analyze_file/);
    expect(blocked[0]?.why).toMatch(/not creating risk findings/);
  });
});

describe('3.1 - a deliverable is versioned and its provenance travels', () => {
  it('serves the template library with the renderer own labels', async () => {
    const data = dataOf(await call('/api/console/deliverables/templates'));
    expect((data['templates'] as unknown[]).length).toBeGreaterThan(0);
    expect(data['total']).toBe((data['templates'] as unknown[]).length);
    // The label the PDF renderer uses, so the page uses the same wording.
    expect(String(data['unverifiedLabel']).length).toBeGreaterThan(0);
    expect(data['complianceStateLabels']).toHaveProperty('pass_with_findings');
  });

  it('lists every version for a client with its own status, plus totals', async () => {
    const data = dataOf(await call(`/api/console/clients/${clientId}/deliverables`));
    expect(Array.isArray(data['deliverables'])).toBe(true);
    expect(data['total']).toBe((data['deliverables'] as unknown[]).length);
    expect(typeof data['withUnverifiedFigures']).toBe('number');
    expect(typeof data['delivered']).toBe('number');
    expect(String(data['unverifiedLabel']).length).toBeGreaterThan(0);
  });

  it('says plainly that a deliverable is not there', async () => {
    const reply = await call('/api/console/deliverables/00000000-0000-4000-8000-000000000000');
    expect(reply.json['status']).toBe('no_data');
  });
});

describe('the view sources', () => {
  /**
   * Read rather than executed, for the reason `portal-ui.test.ts` reads the portal's: there is no
   * DOM environment in this runner. Weaker than driving the DOM - it catches a rendering rule being
   * deleted, not one kept and computed wrongly - and it is what covers the panels the browser
   * suite cannot reach with the data the e2e harness seeds.
   */
  const VIEWS = join(process.cwd(), 'apps', 'api', 'public', 'views');
  const FILES = [
    'admin.js',
    'warehouse.js',
    'interventure.js',
    'intelligence.js',
    'deliverables.js',
  ];

  it('assigns nothing to innerHTML, anywhere in the panels', async () => {
    for (const file of FILES) {
      const source = await readFile(join(VIEWS, file), 'utf8');
      expect(source, file).not.toContain('innerHTML');
      expect(source, file).not.toContain('outerHTML');
      expect(source, file).not.toContain('insertAdjacentHTML');
      expect(source, file).not.toContain('document.write');
      expect(source, file).not.toContain('eval(');
    }
  });

  it('renders an invariant with its reason and no input, in the admin panel', async () => {
    // **The mutation target.** Making an invariant editable means giving `renderInvariant` a
    // control, and these assertions are what fails when somebody does.
    const source = await readFile(join(VIEWS, 'admin.js'), 'utf8');

    expect(source).toContain('renderInvariant');
    expect(source).toContain('invariant.whyFixed');
    expect(source).toContain('FIXED');

    // No control is constructed anywhere in this file. An input or a form here would only exist to
    // change something, and the only thing on this panel not already unchangeable is an invariant.
    expect(source).not.toContain("createElement('input')");
    expect(source).not.toContain("createElement('form')");
    expect(source).not.toContain("createElement('select')");
    expect(source).not.toContain("createElement('textarea')");
  });

  it('renders a warehouse point with its gaps rather than as a bare number', async () => {
    const source = await readFile(join(VIEWS, 'warehouse.js'), 'utf8');
    expect(source).toContain('point.gaps');
    expect(source).toContain('incomplete');
  });
});
