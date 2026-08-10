/**
 * The shared rate-limit store, end to end.
 *
 * Three properties carry this file.
 *
 * **Two limiters share one counter.** That is the whole point: three replicas behind a load balancer
 * were giving an attacker three times the sign-in budget, and no process could see it.
 *
 * **The count is correct under CONCURRENCY.** A counter is a read-modify-write, and two instances
 * that both read 4 and both write 5 have let six requests through on a limit of five. A sequential
 * test cannot see that, so this one fires the requests at once.
 *
 * **The per-process limiter still exists and is still per process** - asserted, because the whole
 * slice is about which of the two a deployment gets.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { clearRateLimits, rateLimitCount, sweepRateLimits } from '@bwc/identity';
import { EnvKekProvider, LocalEncryptedStore, generateKek, type VaultConfig } from '@bwc/vault';
import { createPortalApp } from '../../apps/portal-api/src/app.js';
import { readConfig, type PortalConfig } from '../../apps/portal-api/src/config.js';
import { createRateLimiter, createSharedRateLimiter } from '../../apps/portal-api/src/limiter.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let vault: VaultConfig;
let config: PortalConfig;

const NOW = new Date('2026-08-14T09:00:00.000Z');
const SCOPE = 'test.shared_limit';

beforeAll(async () => {
  fx = await makeFixture('shared-limit');
  const root = await mkdtemp(join(tmpdir(), 'bwc-limit-'));
  process.env['VAULT_LIMIT_KEK'] = generateKek();
  vault = { store: new LocalEncryptedStore(root), kek: new EnvKekProvider('VAULT_LIMIT_KEK') };

  await createClient(fx.tenant.id, 'Rate Limit Test LLC', { id: fx.human.id, kind: 'human' });

  config = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_portal_session',
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    maxUploadBytes: 1024 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 3,
    resetWindowSeconds: 900,
    resetMaxAttempts: 5,
    rateLimitStore: 'shared',
  };
});

afterAll(async () => {
  await clearRateLimits(SCOPE);
  await cleanupTenant(fx.tenant.id);
});

const shared = (scope: string, maxAttempts = 3, windowSeconds = 300) =>
  createSharedRateLimiter({ scope, windowSeconds, maxAttempts });

describe('two limiters share one counter', () => {
  it('counts a key across independently constructed limiters', async () => {
    const scope = `${SCOPE}.pair`;
    await clearRateLimits(scope);

    // As two instances behind a load balancer are: same configuration, no shared memory.
    const instanceA = shared(scope);
    const instanceB = shared(scope);

    expect((await instanceA.check('203.0.113.7', NOW)).remaining).toBe(2);
    expect((await instanceB.check('203.0.113.7', NOW)).remaining).toBe(1);
    expect((await instanceA.check('203.0.113.7', NOW)).remaining).toBe(0);

    // THE ASSERTION THIS FILE EXISTS FOR. Per process, this fourth attempt would be the second one
    // instance B had seen and would sail through.
    const fourth = await instanceB.check('203.0.113.7', NOW);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBe(300);
  });

  it('counts each key and each scope separately', async () => {
    const scope = `${SCOPE}.keys`;
    await clearRateLimits(scope);
    const other = `${SCOPE}.other`;
    await clearRateLimits(other);

    const signIn = shared(scope);
    const reset = shared(other);

    await signIn.check('198.51.100.1', NOW);
    await signIn.check('198.51.100.1', NOW);

    // A different address is a different budget.
    expect((await signIn.check('198.51.100.2', NOW)).remaining).toBe(2);
    // And a different scope is a different budget for the SAME address - sign-in and password reset
    // now share a table, so the separation has to be in the key.
    expect((await reset.check('198.51.100.1', NOW)).remaining).toBe(2);

    expect(await rateLimitCount(scope, '198.51.100.1')).toBe(2);
    expect(await rateLimitCount(other, '198.51.100.1')).toBe(1);
  });

  it('does NOT share between two in-memory limiters, which is the bug being fixed', async () => {
    const instanceA = createRateLimiter({ windowSeconds: 300, maxAttempts: 3 });
    const instanceB = createRateLimiter({ windowSeconds: 300, maxAttempts: 3 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await instanceA.check('192.0.2.9', NOW);
    }
    expect((await instanceA.check('192.0.2.9', NOW)).allowed).toBe(false);

    // The second process has never heard of this address. Written down as a test rather than only
    // in a comment, because it is the behaviour the deployment setting has to choose against.
    expect((await instanceB.check('192.0.2.9', NOW)).allowed).toBe(true);
  });
});

describe('the count is correct under concurrency', () => {
  it('never allows more than the limit when requests arrive at once', async () => {
    const scope = `${SCOPE}.concurrent`;
    await clearRateLimits(scope);

    // Ten requests, two instances, limit of three. A read-then-write counter loses increments here:
    // two callers read 1, both write 2, and the eleventh request is the fourth one allowed.
    const instances = [shared(scope), shared(scope)];
    const verdicts = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        (instances[index % 2] as ReturnType<typeof shared>).check('203.0.113.99', NOW),
      ),
    );

    const allowed = verdicts.filter((verdict) => verdict.allowed).length;
    // THE ASSERTION. Exactly three, not "about three".
    expect(allowed).toBe(3);
    expect(await rateLimitCount(scope, '203.0.113.99')).toBe(10);
  });

  it('keeps a single row rather than one per concurrent caller', async () => {
    const scope = `${SCOPE}.onerow`;
    await clearRateLimits(scope);

    const instance = shared(scope, 100);
    await Promise.all(Array.from({ length: 20 }, () => instance.check('203.0.113.50', NOW)));

    expect(await rateLimitCount(scope, '203.0.113.50')).toBe(20);
  });
});

describe('the window', () => {
  it('rolls when it expires, per key, in the same statement', async () => {
    const scope = `${SCOPE}.window`;
    await clearRateLimits(scope);

    const instance = shared(scope, 2, 60);
    await instance.check('192.0.2.30', NOW);
    await instance.check('192.0.2.30', NOW);
    expect((await instance.check('192.0.2.30', NOW)).allowed).toBe(false);

    const later = new Date(NOW.getTime() + 61 * 1000);
    const rolled = await instance.check('192.0.2.30', later);
    expect(rolled.allowed).toBe(true);
    expect(rolled.remaining).toBe(1);

    // Reset rather than a second row: a rolled window is the same counter, restarted.
    expect(await rateLimitCount(scope, '192.0.2.30')).toBe(1);
  });

  it('derives Retry-After from the STORED window, not from this request', async () => {
    const scope = `${SCOPE}.retry`;
    await clearRateLimits(scope);

    const instance = shared(scope, 1, 300);
    await instance.check('192.0.2.40', NOW);

    // Ninety seconds into a five-minute window, whichever instance answers.
    const later = new Date(NOW.getTime() + 90 * 1000);
    const blocked = await shared(scope, 1, 300).check('192.0.2.40', later);

    expect(blocked.allowed).toBe(false);
    // Two instances handing out different Retry-After values for one counter would be telling a
    // client two different things about the same state.
    expect(blocked.retryAfterSeconds).toBe(210);
  });
});

describe('the sweep', () => {
  it('removes counters past their window and leaves live ones', async () => {
    const scope = `${SCOPE}.sweep`;
    await clearRateLimits(scope);

    const instance = shared(scope, 10, 60);
    await instance.check('192.0.2.60', NOW);

    const muchLater = new Date(NOW.getTime() + 10 * 60 * 1000);
    await instance.check('192.0.2.61', muchLater);

    const removed = await sweepRateLimits({ olderThanSeconds: 120, now: muchLater });
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(await rateLimitCount(scope, '192.0.2.60')).toBe(0);
    // A row inside its window survives: the sweep is about disk, not about the limit.
    expect(await rateLimitCount(scope, '192.0.2.61')).toBe(1);
  });
});

describe('the store is chosen, never defaulted', () => {
  const withEnv = <T>(values: Record<string, string | undefined>, run: () => T): T => {
    const previous = Object.fromEntries(
      Object.keys(values).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return run();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  const BASE = {
    PORTAL_TENANT_ID: '00000000-0000-0000-0000-000000000000',
    PORTAL_COOKIE_SECURE: 'true',
    PORTAL_TRUST_PROXY: 'false',
  };

  it('refuses to start without PORTAL_RATE_LIMIT_STORE', () => {
    withEnv({ ...BASE, PORTAL_RATE_LIMIT_STORE: undefined }, () => {
      // A deployment that quietly counted per process behind three replicas would be enforcing a
      // limit nobody chose and nothing reports.
      expect(() => readConfig()).toThrow(/PORTAL_RATE_LIMIT_STORE is not set/);
    });
  });

  it('refuses a value it does not recognise rather than falling back', () => {
    withEnv({ ...BASE, PORTAL_RATE_LIMIT_STORE: 'redis' }, () => {
      expect(() => readConfig()).toThrow(/must be 'memory' or 'shared'/);
    });
  });

  it('accepts both supported stores', () => {
    for (const store of ['memory', 'shared']) {
      withEnv({ ...BASE, PORTAL_RATE_LIMIT_STORE: store }, () => {
        expect(readConfig().rateLimitStore).toBe(store);
      });
    }
  });
});

describe('over the wire, across two instances', () => {
  let first: Server;
  let second: Server;
  let firstBase: string;
  let secondBase: string;

  beforeAll(async () => {
    await clearRateLimits('portal.sign_in');

    // Two processes, as a load balancer would have. Each builds its own limiters from configuration.
    [first, second] = (await Promise.all(
      [0, 1].map(async () => {
        const server = createServer(createPortalApp({ config, vault, now: () => NOW }));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        return server;
      }),
    )) as [Server, Server];

    const address = (server: Server): string => {
      const value = server.address();
      if (value === null || typeof value === 'string') throw new Error('setup');
      return `http://127.0.0.1:${value.port}`;
    };
    firstBase = address(first);
    secondBase = address(second);
  });

  afterAll(async () => {
    await Promise.all(
      [first, second].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await clearRateLimits('portal.sign_in');
  });

  const attempt = (base: string): Promise<globalThis.Response> =>
    fetch(`${base}/portal/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sprayed@example.com', password: 'Summer2026!' }),
    });

  it('counts a spray against the first instance when it reaches the second', async () => {
    // The configured limit is three.
    for (let index = 0; index < 3; index += 1) {
      const response = await attempt(firstBase);
      const body = (await response.json()) as { reason: string };
      // Refused on credentials, not by the limiter.
      expect(body.reason).toBe('Those sign-in details are not correct.');
    }

    // THE ASSERTION. The fourth attempt goes to the OTHER process, which has served nothing.
    const blocked = await attempt(secondBase);
    const body = (await blocked.json()) as { reason: string };
    expect(blocked.status).toBe(409);
    expect(body.reason).toMatch(/Too many sign-in attempts/);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
  });
});
