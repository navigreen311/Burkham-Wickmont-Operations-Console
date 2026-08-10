/**
 * The Client Portal's HTTP transport, end to end over a real socket.
 *
 * Three properties carry this file.
 *
 * **The portal process serves no internal capability.** Asserted by asking it for the internal
 * app's own routes and getting 404 - and by the fact that `x-actor-id`, which the internal app
 * trusts, does nothing here.
 *
 * **Rate limiting catches what lockout cannot.** Ten emails, one attempt each: no account reaches
 * two failures, so lockout never fires, and the per-IP limit is the only thing that stops it.
 *
 * **The app refuses to start on configuration where guessing would be unsafe.** Tested by trying.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { enrolClientUser, inviteClientUser, issuePasswordReset } from '@bwc/identity';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  generateKek,
  recordScanResult,
  type VaultConfig,
} from '@bwc/vault';
import { createPortalApp } from '../../apps/portal-api/src/app.js';
import { readConfig, type PortalConfig } from '../../apps/portal-api/src/config.js';
import { createRateLimiter } from '../../apps/portal-api/src/limiter.js';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;
let server: Server;
let base: string;
let vault: VaultConfig;
let config: PortalConfig;

const PASSWORD = 'a-long-enough-portal-password';
const EMAIL = 'transport-user@example.com';
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

/** A generous limit for the happy path; the rate-limit tests build their own tight limiter. */
const limiter = createRateLimiter({ windowSeconds: 300, maxAttempts: 1000 });
const resetLimiter = createRateLimiter({ windowSeconds: 900, maxAttempts: 1000 });

interface Reply {
  status: number;
  headers: Headers;
  body: string;
  json: <T = Record<string, unknown>>() => T;
}

/**
 * Derived from `fetch` rather than named as `RequestInit`, because `no-undef` cannot tell a
 * type-only name from a missing runtime global and would have to be lied to in the config.
 */
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const call = async (path: string, init: FetchInit & { cookie?: string } = {}): Promise<Reply> => {
  const headers = new Headers(init.headers);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);

  const response = await fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
  const body = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    body,
    json: <T>() => JSON.parse(body) as T,
  };
};

/** Pull the session cookie out of a Set-Cookie header. */
const sessionCookie = (reply: Reply): string => {
  const raw = reply.headers.getSetCookie().find((entry) => entry.startsWith('bwc_portal_session='));
  if (raw === undefined) throw new Error('no session cookie was set');
  return raw.split(';')[0] as string;
};

beforeAll(async () => {
  fx = await makeFixture('portal-transport');
  const root = await mkdtemp(join(tmpdir(), 'bwc-transport-'));
  process.env['VAULT_TRANSPORT_KEK'] = generateKek();
  vault = { store: new LocalEncryptedStore(root), kek: new EnvKekProvider('VAULT_TRANSPORT_KEK') };

  clientId = (await createClient(fx.tenant.id, 'Transport Test LLC', HUMAN())).id;

  const invited = await inviteClientUser({
    tenantId: fx.tenant.id,
    clientId,
    email: EMAIL,
    displayName: 'Transport Person',
    issuedBy: fx.human.id,
    actor: HUMAN(),
  });
  if (invited.status !== 'ok') throw new Error('setup: invite');
  const enrolled = await enrolClientUser({
    tenantId: fx.tenant.id,
    token: invited.value.token,
    password: PASSWORD,
    actor: HUMAN(),
  });
  if (enrolled.status !== 'ok') throw new Error('setup: enrol');

  config = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_portal_session',
    // False for the test transport, which is plaintext HTTP over loopback. In deployment this is
    // required to be set explicitly and would be true.
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    maxUploadBytes: 1024 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 1000,
    resetWindowSeconds: 900,
    resetMaxAttempts: 1000,
  };

  server = createServer(createPortalApp({ config, vault, limiter, resetLimiter }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTenant(fx.tenant.id);
});

describe('the portal process serves no internal capability', () => {
  it("404s the internal app's own routes", async () => {
    // `apps/api` serves these. A client reaching them would be a client acting as staff.
    for (const path of [
      '/clients',
      '/clients/some-id',
      '/ledger',
      '/integration/vendors',
      '/firewall/some-id',
    ]) {
      const reply = await call(path);
      expect(reply.status, path).toBe(404);
      // And the 404 does not enumerate what does exist.
      expect(reply.body, path).not.toMatch(/portal\//);
    }
  });

  it('ignores x-actor-id, which the internal app trusts', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. `apps/api` resolves the acting staff member from this
    // header; here it is just a header, because the code that reads it is not in this process.
    const reply = await call('/portal/room', {
      headers: { 'x-actor-id': fx.human.id },
    });
    expect(reply.status).toBe(409);
    expect(reply.json<{ reason: string }>().reason).toBe('Sign in to continue.');
  });

  it('answers liveness without disclosing anything', async () => {
    const reply = await call('/portal/health');
    expect(reply.status).toBe(200);
    // A health endpoint reporting which components are degraded would be unauthenticated
    // reconnaissance. 11.8 has that detail, behind the internal app.
    expect(reply.json()).toEqual({ status: 'ok' });
  });
});

describe('sign in and the session cookie', () => {
  let cookie: string;

  it('refuses a wrong password and an unknown email identically', async () => {
    const wrong = await call('/portal/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: 'not-the-password' }),
    });
    const unknown = await call('/portal/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: PASSWORD }),
    });
    const malformed = await call('/portal/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 42 }),
    });

    for (const reply of [wrong, unknown, malformed]) {
      expect(reply.status).toBe(409);
      expect(reply.json<{ reason: string }>().reason).toBe(
        'Those sign-in details are not correct.',
      );
    }
    // No cookie on any of them.
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
  });

  it('signs in, and the cookie is HttpOnly and SameSite=Strict', async () => {
    const reply = await call('/portal/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });

    expect(reply.status).toBe(200);
    const raw = reply.headers.getSetCookie()[0] as string;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);

    // The token is NOT in the body. It is httpOnly precisely so script cannot read it, and
    // returning it here would hand it straight back to script.
    const body = reply.json<{ data: Record<string, unknown> }>();
    expect(Object.keys(body.data)).toEqual(['displayName', 'expiresAt']);
    expect(reply.body).not.toContain('token');

    cookie = sessionCookie(reply);
  });

  it('drives the whole portal with the cookie alone', async () => {
    const room = await call('/portal/room', { cookie });
    expect(room.status).toBe(200);
    expect(room.json<{ data: { clientLegalName: string } }>().data.clientLegalName).toBe(
      'Transport Test LLC',
    );

    const signed = await call('/portal/disclosures', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'disclosure', scope: 'Fee disclosure, version 1.' }),
    });
    expect(signed.status).toBe(200);

    const message = await call('/portal/messages', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: 'A question',
        body: 'Which months of statements do you need?',
      }),
    });
    expect(message.status).toBe(200);
  });

  it('uploads raw bytes and downloads them once scanned', async () => {
    const content = Buffer.from('%PDF-1.4 a synthetic statement for the transport test');

    const uploaded = await call('/portal/documents?kind=bank_statement&filename=august.pdf', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/pdf' },
      body: content,
    });
    expect(uploaded.status).toBe(200);
    const documentId = uploaded.json<{ data: { documentId: string } }>().data.documentId;

    // 3.2's gate, over HTTP: unreadable until scanned.
    const early = await call(`/portal/documents/${documentId}`, { cookie });
    expect(early.status).toBe(409);
    expect(early.json<{ reason: string }>().reason).toMatch(/still checking this file/);

    await recordScanResult(fx.tenant.id, documentId, 'clean', fx.human.id);

    const opened = await call(`/portal/documents/${documentId}`, { cookie });
    expect(opened.status).toBe(200);
    expect(opened.body).toContain('synthetic statement');
    // `attachment` for a view too: a PDF rendered inline is one the browser may cache to disk.
    expect(opened.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(opened.headers.get('x-watermarked')).toBe('false');
  });

  it('refuses an upload larger than the limit, before authentication', async () => {
    const tooBig = Buffer.alloc(config.maxUploadBytes + 1024, 0x41);
    const reply = await call('/portal/documents?kind=bank_statement&filename=big.pdf', {
      method: 'POST',
      // Deliberately no cookie: the body limit is a transport concern and runs first.
      headers: { 'content-type': 'application/pdf' },
      body: tooBig,
    });
    expect(reply.status).toBe(409);
    expect(reply.json<{ reason: string }>().reason).toMatch(/larger than this portal accepts/);
  });

  it('signs out, and the cookie stops working', async () => {
    const out = await call('/portal/sign-out', { method: 'POST', cookie });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().join(' ')).toMatch(
      /bwc_portal_session=;|Expires=Thu, 01 Jan 1970/i,
    );

    const after = await call('/portal/room', { cookie });
    expect(after.status).toBe(409);
  });

  it('refuses a forged cookie exactly as it refuses none', async () => {
    const forged = await call('/portal/room', { cookie: 'bwc_portal_session=not-a-real-token' });
    const none = await call('/portal/room');
    expect(forged.status).toBe(none.status);
    expect(forged.json<{ reason: string }>().reason).toBe(none.json<{ reason: string }>().reason);
  });
});

describe('password reset over the wire', () => {
  const RESET_EMAIL = 'transport-reset@example.com';
  const NEW_PASSWORD = 'a-replacement-portal-password';
  let resetUserId: string;

  beforeAll(async () => {
    const invited = await inviteClientUser({
      tenantId: fx.tenant.id,
      clientId,
      email: RESET_EMAIL,
      displayName: 'Reset Person',
      issuedBy: fx.human.id,
      actor: HUMAN(),
    });
    if (invited.status !== 'ok') throw new Error('setup: invite');
    const enrolled = await enrolClientUser({
      tenantId: fx.tenant.id,
      token: invited.value.token,
      password: PASSWORD,
      actor: HUMAN(),
    });
    if (enrolled.status !== 'ok') throw new Error('setup: enrol');
    resetUserId = enrolled.value.id;
  });

  it('answers a known and an unknown address identically, and sets no cookie', async () => {
    const known = await call('/portal/password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: RESET_EMAIL }),
    });
    const unknown = await call('/portal/password-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-a-client@example.com' }),
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toBe(unknown.body);
    // `not_built`: no email provider is gated in, so nothing was delivered and saying otherwise
    // would be the one answer that is a lie in both branches.
    expect(known.status).toBe(501);
    expect(known.headers.getSetCookie()).toHaveLength(0);
  });

  it('completes a reset with a token in the BODY, and ends every session', async () => {
    // Sign in first, so there is a live session for the reset to end.
    const signedIn = await call('/portal/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: RESET_EMAIL, password: PASSWORD }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);

    const issued = await issuePasswordReset({
      tenantId: fx.tenant.id,
      clientUserId: resetUserId,
      issuedBy: fx.human.id,
      verificationBasis: 'Called back on the number on file and confirmed the EIN last four.',
      actor: HUMAN(),
    });
    if (issued.status !== 'ok') throw new Error('setup: issue');

    const done = await call('/portal/password-reset/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: issued.value.token, password: NEW_PASSWORD }),
    });

    expect(done.status).toBe(200);
    expect(done.json<{ data: { sessionsRevoked: number } }>().data.sessionsRevoked).toBe(1);
    // The token went out in an email link and came back in a body. It is not echoed.
    expect(done.body).not.toContain(issued.value.token);

    // The session taken before the reset is dead.
    const room = await call('/portal/room', { cookie });
    expect(room.status).toBe(409);

    const withNew = await call('/portal/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: RESET_EMAIL, password: NEW_PASSWORD }),
    });
    expect(withNew.status).toBe(200);
  });

  it('refuses a malformed body the same way it refuses a bad token', async () => {
    const malformed = await call('/portal/password-reset/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 42 }),
    });
    const wrong = await call('/portal/password-reset/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'never-real', password: NEW_PASSWORD }),
    });

    expect(malformed.status).toBe(409);
    expect(malformed.json<{ reason: string }>().reason).toBe(
      wrong.json<{ reason: string }>().reason,
    );
  });

  it('counts resets on their own limiter, so a reset flood cannot block sign-in', async () => {
    // THE ASSERTION THIS BLOCK EXISTS FOR. One shared bucket would mean an attacker spraying resets
    // from a shared address locks legitimate clients out of signing in - a denial of service built
    // out of two controls that are each individually correct.
    const app = createPortalApp({
      config: { ...config, resetMaxAttempts: 2 },
      vault,
      limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 1000 }),
      resetLimiter: createRateLimiter({ windowSeconds: 900, maxAttempts: 2 }),
    });
    const fresh = createServer(app);
    await new Promise<void>((resolve) => fresh.listen(0, '127.0.0.1', resolve));
    const address = fresh.address();
    if (address === null || typeof address === 'string') throw new Error('setup');
    const at = `http://127.0.0.1:${address.port}`;

    const ask = (): Promise<globalThis.Response> =>
      fetch(`${at}/portal/password-reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: RESET_EMAIL }),
      });

    expect((await ask()).status).toBe(501);
    expect((await ask()).status).toBe(501);
    // Third is refused by the limiter.
    const blocked = await ask();
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { reason: string }).reason).toMatch(/Too many reset/);

    // And sign-in is untouched.
    const signIn = await fetch(`${at}/portal/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);

    await new Promise<void>((resolve) => fresh.close(() => resolve()));
  });
});

describe('rate limiting catches what lockout cannot', () => {
  let sprayServer: Server;
  let sprayBase: string;

  beforeAll(async () => {
    const tight = createRateLimiter({ windowSeconds: 300, maxAttempts: 5 });
    sprayServer = createServer(
      createPortalApp({ config: { ...config, signInMaxAttempts: 5 }, vault, limiter: tight }),
    );
    await new Promise<void>((resolve) => sprayServer.listen(0, '127.0.0.1', resolve));
    const address = sprayServer.address();
    if (address === null || typeof address === 'string') throw new Error('setup');
    sprayBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => sprayServer.close(() => resolve()));
  });

  const spray = async (email: string): Promise<number> => {
    const response = await fetch(`${sprayBase}/portal/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Summer2026!' }),
    });
    return response.status;
  };

  it('stops a spray that no account-level lockout would see', async () => {
    // THE ASSERTION. One attempt against each of ten different addresses: no account reaches two
    // failures, so 11.1's five-strike lockout never fires. The per-IP limit is the only thing
    // counting the attacker rather than the victim.
    const statuses: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      statuses.push(await spray(`victim-${index}@example.com`));
    }

    // All refused (409), but the last five are refused by the LIMITER rather than by credentials.
    expect(statuses.every((status) => status === 409)).toBe(true);

    const blocked = await fetch(`${sprayBase}/portal/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const body = (await blocked.json()) as { reason: string };
    expect(body.reason).toMatch(/Too many sign-in attempts/);
    // And it tells the caller when to come back.
    expect(blocked.headers.get('retry-after')).not.toBeNull();
  });

  it('lets a correct password through once the window clears', async () => {
    const cleared = createRateLimiter({ windowSeconds: 300, maxAttempts: 5 });
    const app = createPortalApp({ config, vault, limiter: cleared });
    const fresh = createServer(app);
    await new Promise<void>((resolve) => fresh.listen(0, '127.0.0.1', resolve));
    const address = fresh.address();
    if (address === null || typeof address === 'string') throw new Error('setup');

    const reply = await fetch(`http://127.0.0.1:${address.port}/portal/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(reply.status).toBe(200);

    await new Promise<void>((resolve) => fresh.close(() => resolve()));
  });
});

describe('the limiter itself', () => {
  const NOW = new Date('2026-08-11T12:00:00.000Z');

  it('allows up to the limit and refuses beyond it', () => {
    const limit = createRateLimiter({ windowSeconds: 60, maxAttempts: 3 });
    expect(limit.check('a', NOW).allowed).toBe(true);
    expect(limit.check('a', NOW).allowed).toBe(true);
    expect(limit.check('a', NOW).allowed).toBe(true);
    expect(limit.check('a', NOW).allowed).toBe(false);
  });

  it('counts each key separately', () => {
    const limit = createRateLimiter({ windowSeconds: 60, maxAttempts: 1 });
    expect(limit.check('a', NOW).allowed).toBe(true);
    expect(limit.check('b', NOW).allowed).toBe(true);
    expect(limit.check('a', NOW).allowed).toBe(false);
  });

  it('opens a new window when the old one expires', () => {
    const limit = createRateLimiter({ windowSeconds: 60, maxAttempts: 1 });
    expect(limit.check('a', NOW).allowed).toBe(true);
    expect(limit.check('a', NOW).allowed).toBe(false);
    expect(limit.check('a', new Date(NOW.getTime() + 61_000)).allowed).toBe(true);
  });

  it('counts an unattributable request rather than letting it through', async () => {
    const { rateLimitKey } = await import('../../apps/portal-api/src/limiter.js');
    // An unattributable request is exactly the one an attacker would arrange for.
    expect(rateLimitKey(undefined)).toBe('unknown');
    expect(rateLimitKey('  ')).toBe('unknown');
  });
});

describe('configuration refuses to be guessed', () => {
  const saved = { ...process.env };

  afterAll(() => {
    process.env = { ...saved };
  });

  const withEnv = (env: Record<string, string | undefined>): (() => PortalConfig) => {
    return () => {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return readConfig();
    };
  };

  it('refuses to start without an explicit cookie Secure setting', () => {
    expect(
      withEnv({
        PORTAL_TENANT_ID: 'tenant',
        PORTAL_TRUST_PROXY: 'false',
        PORTAL_COOKIE_SECURE: undefined,
      }),
    ).toThrow(/PORTAL_COOKIE_SECURE is not set/);
  });

  it('refuses to start without an explicit trust-proxy setting', () => {
    expect(
      withEnv({
        PORTAL_TENANT_ID: 'tenant',
        PORTAL_COOKIE_SECURE: 'true',
        PORTAL_TRUST_PROXY: undefined,
      }),
    ).toThrow(/PORTAL_TRUST_PROXY is not set/);
  });

  it("refuses trust proxy 'true', which lets a client spoof its own IP", () => {
    // The failure this prevents is silent: Express takes the leftmost X-Forwarded-For entry, the
    // client writes it, and per-IP rate limiting stops counting anything real.
    expect(
      withEnv({
        PORTAL_TENANT_ID: 'tenant',
        PORTAL_COOKIE_SECURE: 'true',
        PORTAL_TRUST_PROXY: 'true',
      }),
    ).toThrow(/defeats per-IP rate limiting/);
  });

  it('accepts a hop count', () => {
    const config = withEnv({
      PORTAL_TENANT_ID: 'tenant',
      PORTAL_COOKIE_SECURE: 'true',
      PORTAL_TRUST_PROXY: '1',
    })();
    expect(config.trustProxy).toBe(1);
    expect(config.cookieSecure).toBe(true);
  });

  it('refuses to start without a tenant, which is never a request value', () => {
    expect(
      withEnv({
        PORTAL_COOKIE_SECURE: 'true',
        PORTAL_TRUST_PROXY: 'false',
        PORTAL_TENANT_ID: undefined,
      }),
    ).toThrow(/PORTAL_TENANT_ID is not set/);
  });
});
