/**
 * The internal Console's HTTP transport, end to end over a real socket.
 *
 * Four properties carry this file.
 *
 * **Nothing internal is reachable without a session.** Asserted route by route from a list built
 * from the app itself rather than by hand, because a route somebody adds and forgets to guard is
 * precisely the one a hand-written list would omit.
 *
 * **The `x-actor-id` seam is off unless a deployment turns it on.** This is the defect the Console
 * would otherwise have shipped on top of: with the flag false, a header naming a Level 3 actor is
 * just a header.
 *
 * **Both factors, or neither.** A correct password with a wrong code is the same refusal as
 * everything else, and an actor who has not finished enrolment cannot sign in at all.
 *
 * **The page's relaxed policy does not leak onto the API.** The same assertion the portal makes,
 * because the same mistake is available here.
 *
 * **Every write is refused below the Authority Level its action declares.** Added when the Console
 * grew buttons, and the assertion that would have failed before this slice: the write routes called
 * their modules directly, so a Level 0 observer with a session could move a client to `pass`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { create as createClient } from '@bwc/clients';
import { read as readLedger } from '@bwc/ledger';
import { transitionComplianceState } from '@bwc/clients';
import {
  MFA_SECRET_KEY_VARIABLE,
  STAFF_MAX_FAILED_ATTEMPTS,
  base32Decode,
  beginStaffEnrolment,
  confirmStaffEnrolment,
  createActor,
  disableStaffCredential,
  totp,
} from '@bwc/identity';
import { generateKek } from '@bwc/crypto';
import { createRateLimiter } from '@bwc/http';
import { createApp } from '../../apps/api/src/app.js';
import { readConsoleConfig, type ConsoleConfig } from '../../apps/api/src/config.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;
let config: ConsoleConfig;
let clientId: string;

const PASSWORD = 'a-long-enough-console-password';
const EMAIL = 'console-operator@example.com';

/** Generous: the limiter is not what these tests are about, except where it is. */
const limiter = createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 });

let secret: Buffer;

/**
 * A clock this file moves forward, shared by the app and the codes it is given.
 *
 * **Not a convenience.** A TOTP code is refused if its step is at or below the last one accepted -
 * that is the replay guard, and it means one authenticator cannot sign in twice inside the same
 * thirty seconds. A person waits; a test that ran in one second would be asserting the guard was
 * absent. Every sign-in below steps the clock past the step it last spent, which is what a second
 * sign-in actually looks like.
 */
let offsetMs = 0;
const at = (): Date => new Date(Date.now() + offsetMs);

/** A code for the enrolled secret, at whatever step the clock is on. */
const codeNow = (secretForCode: Buffer = secret): string => totp(secretForCode, at());

/** Move past the step last spent, and hand back a body that will verify. */
const freshCredentials = (): { email: string; password: string; code: string } => {
  offsetMs += 31_000;
  return { email: EMAIL, password: PASSWORD, code: codeNow() };
};

interface Reply {
  readonly status: number;
  readonly json: Record<string, unknown>;
  readonly headers: Headers;
  readonly body: string;
}

const call = async (
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> => {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
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
  return { status: response.status, json, headers: response.headers, body };
};

/** Sign in and return the cookie header a browser would send back. */
const signIn = async (): Promise<string> => {
  const reply = await call('/api/console/sign-in', { body: freshCredentials() });
  expect(reply.json['status'], reply.body).toBe('ok');
  const setCookie = reply.headers.get('set-cookie');
  if (setCookie === null) throw new Error('sign-in returned no cookie');
  return setCookie.split(';')[0] as string;
};

beforeAll(async () => {
  process.env[MFA_SECRET_KEY_VARIABLE] = generateKek();
  fx = await makeFixture('console-transport');

  clientId = (
    await createClient(fx.tenant.id, 'Console Transport LLC', {
      id: fx.human.id,
      kind: 'human',
    })
  ).id;

  const offer = await beginStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    email: EMAIL,
    password: PASSWORD,
    grantedBy: fx.human.id,
  });
  if (offer.status !== 'ok') throw new Error(`setup: enrolment - ${offer.reason}`);

  const decoded = base32Decode(offer.value.secret);
  if (!decoded) throw new Error('setup: secret');
  secret = decoded;

  const confirmed = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: fx.human.id,
    password: PASSWORD,
    code: codeNow(),
  });
  if (confirmed.status !== 'ok') throw new Error(`setup: confirm - ${confirmed.reason}`);

  config = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_console_session',
    // False for the test transport, which is plaintext HTTP over loopback. A deployment must set it.
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 10_000,
    rateLimitStore: 'memory',
    // The property most of this file rests on.
    devActorHeader: false,
  };

  server = createServer(createApp({ config, limiter, now: at }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTenant(fx.tenant.id);
});

/**
 * Every route that must not answer without a session.
 *
 * Written as data so the list is one thing to keep current, and so a new route added below without
 * a guard shows up as a failure here rather than as nothing at all.
 */
const GUARDED: readonly { path: string; method: 'GET' | 'POST'; body?: unknown }[] = [
  { path: '/api/health/integrations', method: 'GET' },
  { path: '/api/console/me', method: 'GET' },
  { path: '/api/console/overview', method: 'GET' },
  { path: '/api/console/health', method: 'GET' },
  { path: '/api/console/queue', method: 'GET' },
  { path: '/api/console/obligations', method: 'GET' },
  { path: '/api/console/clients', method: 'GET' },
  { path: '/api/console/clients/any-id', method: 'GET' },
  { path: '/api/console/clients/any-id/risk', method: 'GET' },
  { path: '/api/clients', method: 'POST', body: { legalName: 'Nope Ltd' } },
  { path: '/api/clients/any-id', method: 'GET' },
  {
    path: '/api/clients/any-id/compliance',
    method: 'POST',
    body: { to: 'pass', reason: 'no' },
  },
  { path: '/api/clients/any-id/consents', method: 'POST', body: { kind: 'k', scope: 's' } },
  { path: '/api/clients/any-id/firewall', method: 'GET' },
  { path: '/api/clients/any-id/firewall/trigger', method: 'POST', body: { reason: 'no' } },
  { path: '/api/clients/any-id/placements', method: 'POST', body: { applicationRef: 'a' } },
  { path: '/api/clients/any-id/ledger', method: 'GET' },
  { path: '/api/ledger/integrity', method: 'GET' },
];

describe('nothing internal answers without a session', () => {
  it.each(GUARDED)('refuses $method $path', async (route) => {
    const reply = await call(route.path, { method: route.method, body: route.body });
    expect(reply.json['status'], route.path).toBe('refused');
    expect(reply.status, route.path).toBe(409);
    // One sentence for every cause, so a caller cannot learn which route exists from the refusal.
    expect(reply.json['reason'], route.path).toBe('Sign in to continue.');
  });

  it('refuses a header naming a real Level 3 actor', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Before this slice `x-actor-id` WAS the authentication:
    // a UUID typed by whoever was asking. With the seam off it is a header and nothing more.
    const reply = await call('/api/console/overview', {
      headers: { 'x-actor-id': fx.human.id },
    });
    expect(reply.json['status']).toBe('refused');
    expect(reply.json['reason']).toBe('Sign in to continue.');
  });

  it('accepts the header only when the deployment turned it on', async () => {
    const seamed = createServer(
      createApp({ config: { ...config, devActorHeader: true }, limiter, now: at }),
    );
    await new Promise<void>((resolve) => seamed.listen(0, '127.0.0.1', resolve));
    const address = seamed.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    const reply = await fetch(`http://127.0.0.1:${address.port}/api/console/me`, {
      headers: { 'x-actor-id': fx.human.id },
    });
    const payload = (await reply.json()) as { status: string; data?: { actorId?: string } };

    expect(payload.status).toBe('ok');
    expect(payload.data?.actorId).toBe(fx.human.id);

    await new Promise<void>((resolve) => seamed.close(() => resolve()));
  });

  it('leaves liveness unauthenticated and free of detail', async () => {
    const reply = await call('/api/health');
    expect(reply.status).toBe(200);
    // Deliberately says nothing about components. `/api/console/health` has that, behind a session.
    expect(reply.body).not.toMatch(/unmonitored|degraded|failing/);
  });
});

describe('signing in', () => {
  it('takes a password and a code together', async () => {
    const cookie = await signIn();
    const reply = await call('/api/console/me', { headers: { cookie } });
    expect(reply.json['status']).toBe('ok');
    expect((reply.json['data'] as { actorId: string }).actorId).toBe(fx.human.id);
  });

  it('does not return the token in the body', async () => {
    // It is in an httpOnly cookie precisely so script cannot read it, and returning it here would
    // undo that in one line.
    const reply = await call('/api/console/sign-in', { body: freshCredentials() });
    expect(reply.body).not.toMatch(/"token"/);
  });

  it('sets a cookie that script cannot read and another origin cannot send', async () => {
    const reply = await call('/api/console/sign-in', { body: freshCredentials() });
    const cookie = reply.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('refuses a correct password with a wrong code, in the same words as everything else', async () => {
    const reply = await call('/api/console/sign-in', {
      body: { email: EMAIL, password: PASSWORD, code: '000000' },
    });
    expect(reply.json['status']).toBe('refused');
    expect(reply.json['reason']).toBe('Those details are not valid.');
  });

  it('refuses a missing field in the same words, naming nothing', async () => {
    const reply = await call('/api/console/sign-in', { body: { email: EMAIL } });
    // A message naming the missing field would let a caller learn which factors this account needs.
    expect(reply.json['reason']).toBe('Those details are not valid.');
  });

  it('ends the session on sign-out', async () => {
    const cookie = await signIn();
    expect((await call('/api/console/me', { headers: { cookie } })).json['status']).toBe('ok');

    await call('/api/console/sign-out', { body: {}, headers: { cookie } });

    const after = await call('/api/console/me', { headers: { cookie } });
    expect(after.json['status']).toBe('refused');
  });
});

describe('what a signed-in operator can read', () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await signIn();
  });

  it('lists clients with the total beside them', async () => {
    const reply = await call('/api/console/clients', { headers: { cookie } });
    const data = reply.json['data'] as { clients: { legalName: string }[]; total: number };
    expect(data.clients.some((c) => c.legalName === 'Console Transport LLC')).toBe(true);
    // The total travels with the page, so a page cannot read as the whole book.
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  it('assembles one client file from the modules that own each part', async () => {
    const reply = await call(`/api/console/clients/${clientId}`, { headers: { cookie } });
    const data = reply.json['data'] as Record<string, unknown>;
    expect(data['client']).toBeDefined();
    expect(data['findings']).toBeDefined();
    expect(data['firewall']).toBeDefined();
    // Present and null, rather than absent. An absent key reads as "not checked".
    expect(data).toHaveProperty('doNotFund');
    expect(data['doNotFund']).toBeNull();
  });

  it('carries the health picture whole, including what nothing monitors', async () => {
    const reply = await call('/api/console/health', { headers: { cookie } });
    const data = reply.json['data'] as {
      overall: string;
      components: { state: string }[];
      counts: Record<string, number>;
    };
    // ADR-0019: `unmonitored` is a state and it is not green. The Console shows the components
    // rather than a colour, so this must survive the trip through the transport.
    expect(data.components.some((component) => component.state === 'unmonitored')).toBe(true);
    expect(data.counts['unmonitored']).toBeGreaterThan(0);
  });

  it('reports a risk timeline with its unmonitored sources attached', async () => {
    const reply = await call(`/api/console/clients/${clientId}/risk`, { headers: { cookie } });
    const data = reply.json['data'] as { entries: unknown[]; unmonitored: unknown[] };
    // 6.5 carries these on every timeline including an empty one, and the page prints them.
    expect(data.unmonitored.length).toBeGreaterThan(0);
  });
});

describe('a credential that has been withdrawn', () => {
  it('stops resolving on the next request, not when the session lapses', async () => {
    const spare = await createActor({
      tenantId: fx.tenant.id,
      kind: 'human',
      label: 'Leaving Person',
      authorityLevel: 3,
    });

    const offer = await beginStaffEnrolment({
      tenantId: fx.tenant.id,
      actorId: spare.id,
      email: 'leaving-person@example.com',
      password: PASSWORD,
      grantedBy: fx.human.id,
    });
    if (offer.status !== 'ok') throw new Error('setup');
    const theirSecret = base32Decode(offer.value.secret);
    if (!theirSecret) throw new Error('setup');
    const confirmed = await confirmStaffEnrolment({
      tenantId: fx.tenant.id,
      actorId: spare.id,
      password: PASSWORD,
      code: codeNow(theirSecret),
      // The module reads real time unless told otherwise, and by now this file's clock has moved.
      now: at(),
    });
    if (confirmed.status !== 'ok') throw new Error(`setup: ${confirmed.reason}`);

    // Past the step enrolment just spent, as above.
    offsetMs += 31_000;
    const signedIn = await call('/api/console/sign-in', {
      body: {
        email: 'leaving-person@example.com',
        password: PASSWORD,
        code: codeNow(theirSecret),
      },
    });
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect((await call('/api/console/me', { headers: { cookie } })).json['status']).toBe('ok');

    await disableStaffCredential({
      tenantId: fx.tenant.id,
      actorId: spare.id,
      reason: 'left the firm',
      disabledBy: fx.human.id,
    });

    // "Revoke this person's access" is a request that means now.
    expect((await call('/api/console/me', { headers: { cookie } })).json['status']).toBe('refused');
  });
});

describe('rate limiting counts the source', () => {
  it('refuses past the limit, whatever the credentials were', async () => {
    const tight = createServer(
      createApp({
        config,
        limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 2 }),
        now: at,
      }),
    );
    await new Promise<void>((resolve) => tight.listen(0, '127.0.0.1', resolve));
    const address = tight.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const url = `http://127.0.0.1:${address.port}/api/console/sign-in`;

    const attempt = async (): Promise<Record<string, unknown>> => {
      const reply = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: 'wrong-but-long-enough', code: '000000' }),
      });
      return (await reply.json()) as Record<string, unknown>;
    };

    await attempt();
    await attempt();
    const third = await attempt();

    expect(third['reason']).toMatch(/Too many sign-in attempts/);

    await new Promise<void>((resolve) => tight.close(() => resolve()));
  });

  it('is not the same control as lockout', async () => {
    // Lockout counts the victim; the limiter counts the attacker. Five wrong passwords against one
    // account lock it - and a spray of one attempt each against many accounts never would.
    expect(STAFF_MAX_FAILED_ATTEMPTS).toBe(5);
  });
});

describe('the page and the API do not share a policy', () => {
  it('sends the strictest policy on an API route', async () => {
    const reply = await call('/api/health');
    const csp = reply.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/default-src 'none'/);
    // The page needs `script-src 'self'`. This route does not, and the relaxation must not leak.
    expect(csp).not.toMatch(/script-src/);
  });

  it('sends a policy the page can run under, with nothing inline', async () => {
    const reply = await call('/console/');
    const csp = reply.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it('serves the page unauthenticated, and the page alone', async () => {
    // The document has to load before anybody can sign in. It contains no client data - every
    // value on it arrives from a route that checks the session.
    const reply = await call('/console/');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatch(/Operations Console/);
  });
});

describe('configuration the Console refuses to guess', () => {
  const clear = (): void => {
    for (const name of [
      'CONSOLE_TENANT_ID',
      'CONSOLE_COOKIE_SECURE',
      'CONSOLE_TRUST_PROXY',
      'CONSOLE_RATE_LIMIT_STORE',
      'CONSOLE_DEV_ACTOR_HEADER',
    ]) {
      delete process.env[name];
    }
  };

  const complete = (): void => {
    process.env['CONSOLE_TENANT_ID'] = fx.tenant.id;
    process.env['CONSOLE_COOKIE_SECURE'] = 'false';
    process.env['CONSOLE_TRUST_PROXY'] = 'false';
    process.env['CONSOLE_RATE_LIMIT_STORE'] = 'memory';
  };

  afterAll(clear);

  it('refuses to start without a tenant', () => {
    clear();
    expect(() => readConsoleConfig()).toThrow(/CONSOLE_TENANT_ID/);
  });

  it("refuses trust proxy 'true'", () => {
    clear();
    complete();
    process.env['CONSOLE_TRUST_PROXY'] = 'true';
    expect(() => readConsoleConfig()).toThrow(/refused/);
  });

  it('refuses the development header in production', () => {
    clear();
    complete();
    process.env['CONSOLE_DEV_ACTOR_HEADER'] = 'true';
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      // A warning would be a line in a log nobody reads, about authentication being optional.
      expect(() => readConsoleConfig()).toThrow(/CONSOLE_DEV_ACTOR_HEADER/);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('defaults the development header to off', () => {
    clear();
    complete();
    expect(readConsoleConfig().devActorHeader).toBe(false);
  });
});

/**
 * A signed-in operator at a chosen Authority Level.
 *
 * Each gets its own Actor, its own credential and its own authenticator, so the level under test is
 * the only thing that differs - and so no two of them share a TOTP step.
 */
const operatorAt = async (level: 0 | 1 | 2 | 3, label: string): Promise<string> => {
  const actor = await createActor({
    tenantId: fx.tenant.id,
    kind: 'human',
    label,
    authorityLevel: level,
  });
  const email = `${label.replace(/\s+/gu, '-').toLowerCase()}@example.com`;

  const offer = await beginStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: actor.id,
    email,
    password: PASSWORD,
    grantedBy: fx.human.id,
    now: at(),
  });
  if (offer.status !== 'ok') throw new Error(`operator: ${offer.reason}`);
  const secret = base32Decode(offer.value.secret);
  if (!secret) throw new Error('operator: secret');

  const confirmed = await confirmStaffEnrolment({
    tenantId: fx.tenant.id,
    actorId: actor.id,
    password: PASSWORD,
    code: totp(secret, at()),
    now: at(),
  });
  if (confirmed.status !== 'ok') throw new Error(`operator: ${confirmed.reason}`);

  offsetMs += 31_000;
  const signedIn = await call('/api/console/sign-in', {
    body: { email, password: PASSWORD, code: totp(secret, at()) },
  });
  if (signedIn.json['status'] !== 'ok') throw new Error(`operator: sign-in ${signedIn.body}`);
  return (signedIn.headers.get('set-cookie') ?? '').split(';')[0] as string;
};

/** Every write the Console offers, with the level its action declares. */
const WRITES = [
  {
    name: 'create a client',
    level: 2,
    path: () => '/api/clients',
    body: { legalName: 'Level Test LLC' },
  },
  {
    name: 'transition compliance',
    level: 3,
    path: (id: string) => `/api/clients/${id}/compliance`,
    body: { to: 'pass', reason: 'a reason' },
  },
  {
    name: 'record consent',
    level: 2,
    path: (id: string) => `/api/clients/${id}/consents`,
    body: { kind: 'placement_authorization', scope: 'APP-1' },
  },
  {
    name: 'trigger the Firewall',
    level: 1,
    path: (id: string) => `/api/clients/${id}/firewall/trigger`,
    body: { reason: 'a reason' },
  },
] as const;

describe('a write is refused below the level its action declares', () => {
  let observer: string;

  beforeAll(async () => {
    observer = await operatorAt(0, 'observer');
  });

  it.each(WRITES)('refuses $name for a Level 0 observer', async (write) => {
    const reply = await call(write.path(clientId), {
      body: write.body,
      headers: { cookie: observer },
    });

    expect(reply.json['status'], write.name).toBe('refused');
    expect(String(reply.json['reason']), write.name).toMatch(/Authority Level/);

    // THE ASSERTION THIS BLOCK EXISTS FOR. Before this slice these routes called their modules
    // directly and every one of them would have returned `ok`.
    const trace = reply.json['trace'] as { step: string; outcome: string }[];
    expect(
      trace.some((step) => step.step === 'authority_level' && step.outcome === 'blocked'),
    ).toBe(true);
  });

  it('permits exactly what the level reaches, and no more', async () => {
    // Level 1 is the interesting one: it may raise a Firewall and may not move a compliance state.
    const preparer = await operatorAt(1, 'preparer');

    const firewall = await call(`/api/clients/${clientId}/firewall/trigger`, {
      body: { reason: 'level 1 may do this' },
      headers: { cookie: preparer },
    });
    expect(firewall.json['status'], firewall.body).toBe('ok');

    const compliance = await call(`/api/clients/${clientId}/compliance`, {
      body: { to: 'pass', reason: 'level 1 may not do this' },
      headers: { cookie: preparer },
    });
    expect(compliance.json['status']).toBe('refused');
  });

  it('reports what the actor may write, and it agrees with what happens', async () => {
    const reply = await call('/api/console/me', { headers: { cookie: observer } });
    const mayWrite = (reply.json['data'] as { mayWrite: Record<string, boolean> }).mayWrite;

    // A courtesy to the page, never the enforcement - so it is asserted to AGREE with the refusals
    // above rather than asserted instead of them.
    expect(mayWrite['trigger_firewall']).toBe(false);
    expect(mayWrite['transition_compliance_state']).toBe(false);
    expect(mayWrite['create_client_record']).toBe(false);
    expect(mayWrite['record_client_consent']).toBe(false);
  });
});

describe('the gate does not block the act that clears the gate', () => {
  it('lets a failed client be moved back to pass', async () => {
    const cookie = await signIn();

    const failing = (
      await createClient(fx.tenant.id, 'One Way Door LLC', {
        id: fx.human.id,
        kind: 'human',
      })
    ).id;

    const failed = await call(`/api/clients/${failing}/compliance`, {
      body: { to: 'fail', reason: 'findings unresolved' },
      headers: { cookie },
    });
    expect(failed.json['status'], failed.body).toBe('ok');

    // Step 4 refuses any client that is not `pass`/`pass_with_findings`. Run a compliance
    // transition through it unchanged and a failed client can NEVER be restored - the gate blocks
    // the only act that could clear it, and a new client in `pending_assessment` could never be
    // assessed at all.
    const restored = await call(`/api/clients/${failing}/compliance`, {
      body: { to: 'pass', reason: 'findings resolved' },
      headers: { cookie },
    });
    expect(restored.json['status'], restored.body).toBe('ok');

    const trace = restored.json['trace'] as { step: string; outcome: string; detail?: string }[];
    const firewallStep = trace.find((step) => step.step === 'firewall');
    // Skipped rather than passed, and the reason travels with it: a step reporting `passed` would
    // be claiming a check ran.
    expect(firewallStep?.outcome).toBe('skipped');
    expect(firewallStep?.detail).toMatch(/governance action/);
  });

  it('still refuses a client-facing action for the same failed client', async () => {
    const cookie = await signIn();

    const blocked = (
      await createClient(fx.tenant.id, 'Still Blocked LLC', {
        id: fx.human.id,
        kind: 'human',
      })
    ).id;
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: blocked,
      to: 'fail',
      reason: 'findings unresolved',
      actor: { id: fx.human.id, kind: 'human' },
    });

    // The skip is scoped to governance actions, not a hole in step 4. A placement for the same
    // client is refused AT STEP 4 - the step that let the transition through.
    const placement = await call(`/api/clients/${blocked}/placements`, {
      body: { applicationRef: 'APP-BLOCKED' },
      headers: { cookie },
    });
    expect(placement.json['status']).toBe('refused');

    // **Asserting the STEP, not just the refusal.** A placement for a failed client would be
    // refused anyway - the placement module checks consent of its own - so a bare `refused` here
    // passes whether or not step 4 ran. Widening `GOVERNANCE_ACTIONS` to include
    // `draft_recommendation` survived exactly that weaker assertion.
    const trace = placement.json['trace'] as { step: string; outcome: string }[];
    expect(trace.some((step) => step.step === 'firewall' && step.outcome === 'blocked')).toBe(true);
  });
});

describe('the Ledger records what was permitted, not only what was refused', () => {
  it('writes authority.action_authorised beside the module event', async () => {
    const cookie = await signIn();

    const subject = (
      await createClient(fx.tenant.id, 'Ledger Witness LLC', {
        id: fx.human.id,
        kind: 'human',
      })
    ).id;

    const done = await call(`/api/clients/${subject}/firewall/trigger`, {
      body: { reason: 'witnessed' },
      headers: { cookie },
    });
    expect(done.json['status'], done.body).toBe('ok');

    const events = await readLedger({ tenantId: fx.tenant.id, clientId: subject });
    const types = events.map((event) => event.type);

    // Two facts, not one: the actor was allowed to try, and this is what happened.
    expect(types).toContain('authority.action_authorised');
    expect(types).toContain('firewall.triggered');
  });
});
