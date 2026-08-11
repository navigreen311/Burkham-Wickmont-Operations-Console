/**
 * The browser UI, as the portal process serves it.
 *
 * Three properties carry this file.
 *
 * **The relaxation the page needs does not leak onto the API.** `default-src 'none'` was chosen when
 * nothing served a document; a JSON route still serves no document, so it keeps the strict policy.
 *
 * **Nothing is inline, so `'unsafe-inline'` is never needed.** A nonce would be a mechanism to keep
 * correct on every response; having nothing inline is a mechanism that cannot be got wrong - and it
 * only stays true if something checks.
 *
 * **Every route the page calls exists.** A page written against an endpoint that was renamed is a
 * page that fails in a browser and passes every server test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { EnvKekProvider, LocalEncryptedStore, generateKek, type VaultConfig } from '@bwc/vault';
import { createPortalApp } from '../../apps/portal-api/src/app.js';
import { type PortalConfig } from '../../apps/portal-api/src/config.js';
import { createRateLimiter } from '@bwc/http';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let server: Server;
let base: string;

const PUBLIC = join(process.cwd(), 'apps', 'portal-api', 'public');

beforeAll(async () => {
  fx = await makeFixture('portal-ui');
  const root = await mkdtemp(join(tmpdir(), 'bwc-ui-'));
  process.env['VAULT_UI_KEK'] = generateKek();
  const vault: VaultConfig = {
    store: new LocalEncryptedStore(root),
    kek: new EnvKekProvider('VAULT_UI_KEK'),
  };

  await createClient(fx.tenant.id, 'UI Test LLC', { id: fx.human.id, kind: 'human' });

  const config: PortalConfig = {
    port: 0,
    tenantId: fx.tenant.id,
    cookieName: 'bwc_portal_session',
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    maxUploadBytes: 1024 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 1000,
    resetWindowSeconds: 900,
    resetMaxAttempts: 1000,
    rateLimitStore: 'memory',
    rpId: 'localhost',
    rpName: 'Burkham Wickmont',
    origin: 'http://localhost',
  };

  server = createServer(
    createPortalApp({
      config,
      vault,
      limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 1000 }),
      resetLimiter: createRateLimiter({ windowSeconds: 900, maxAttempts: 1000 }),
      changeLimiter: createRateLimiter({ windowSeconds: 900, maxAttempts: 1000 }),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('setup: no address');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupTenant(fx.tenant.id);
});

describe('the page is served', () => {
  it('serves the document at the root', async () => {
    const response = await fetch(base);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/u);

    const body = await response.text();
    expect(body).toContain('Client Portal');
    expect(body).toContain('<script type="module" src="/portal.js">');
  });

  it('serves its script and its stylesheet', async () => {
    for (const [path, type] of [
      ['/portal.js', /javascript/u],
      ['/encoding.js', /javascript/u],
      ['/api.js', /javascript/u],
      ['/portal.css', /css/u],
    ] as const) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toMatch(type);
    }
  });
});

describe('the policy relaxes exactly as far as the page needs', () => {
  it('allows this origin for scripts and styles, and nothing inline', async () => {
    const policy = (await fetch(base)).headers.get('content-security-policy') ?? '';

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    // Every submission goes through fetch, so a form that posted anywhere is a form nobody wrote.
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'none'");

    // THE ASSERTION. A nonce is a mechanism to keep correct on every response; nothing inline is a
    // mechanism that cannot be got wrong.
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('nonce-');
  });

  it('leaves the API on the strict policy it has always had', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. The relaxation is for the document; a JSON route still
    // serves no document, and a policy that leaked would be one nobody noticed until it mattered.
    const policy =
      (await fetch(`${base}/portal/health`)).headers.get('content-security-policy') ?? '';

    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('script-src');
    expect(policy).not.toContain('style-src');
  });
});

describe('the source', () => {
  it('assigns nothing to innerHTML, anywhere', async () => {
    // A document name or a message body reaching the page as markup is the one XSS this design has
    // to avoid, and it holds a session cookie. A structural check, because a rule like this survives
    // a rewrite only if something is watching it.
    for (const file of ['portal.js', 'api.js', 'encoding.js']) {
      const source = await readFile(join(PUBLIC, file), 'utf8');
      expect(source, file).not.toContain('innerHTML');
      expect(source, file).not.toContain('outerHTML');
      expect(source, file).not.toContain('insertAdjacentHTML');
      expect(source, file).not.toContain('document.write');
      expect(source, file).not.toContain('eval(');
    }
  });

  it('has no inline script and no inline style in the document', async () => {
    const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');

    // A `<script>` with a body, rather than one with only a src.
    expect(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/u.test(html)).toBe(false);
    expect(html).not.toContain('<style');
    expect(/\sstyle="/u.test(html)).toBe(false);
    expect(/\son[a-z]+="/u.test(html)).toBe(false);
  });

  it('loads nothing from another host', async () => {
    const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
    const css = await readFile(join(PUBLIC, 'portal.css'), 'utf8');

    // No CDN, no font service, no analytics. `default-src 'none'` would refuse them anyway; this
    // says nobody tried, which is the difference between a policy and a rule.
    for (const source of [html, css]) {
      expect(source).not.toContain('http://');
      expect(source).not.toContain('https://');
      expect(source).not.toContain('//cdn');
    }
  });
});

describe('every route the page calls exists', () => {
  it('gets something other than a 404 from each of them', async () => {
    const source = await readFile(join(PUBLIC, 'api.js'), 'utf8');
    const paths = [...source.matchAll(/'(\/portal[^']*)'/gu)].map((match) => match[1] as string);

    expect(paths.length).toBeGreaterThan(15);

    for (const path of new Set(paths)) {
      // Both verbs: a GET-only route answers a POST with 404 and vice versa, which would be
      // indistinguishable from the failure being looked for.
      const [posted, fetched] = await Promise.all([
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        fetch(`${base}${path}`),
      ]);

      // THE ASSERTION. Unauthenticated calls are refused (409) or report a missing capability (501);
      // 404 from BOTH verbs means the page is written against a route that is not there - which
      // fails in a browser and passes every server test.
      expect(posted.status === 404 && fetched.status === 404, path).toBe(false);
    }
  });
});
