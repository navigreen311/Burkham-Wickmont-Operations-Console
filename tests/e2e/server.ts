/**
 * The portal, running against a real database, for the browser tests.
 *
 * Playwright starts this as its `webServer`. It seeds a fresh tenant per run - the Ledger is
 * append-only and hash-chained, so a test that reused one would be writing into somebody else's
 * chain - and then serves the page and the API from one process, which is what ADR-0031 requires
 * anyway: the session cookie is `SameSite=Strict`.
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { create as createTenant } from '@bwc/tenancy';
import { createActor } from '@bwc/identity';
import { create as createClient } from '@bwc/clients';
import { enrolClientUser, inviteClientUser } from '@bwc/identity';
import { EnvKekProvider, LocalEncryptedStore, generateKek, type VaultConfig } from '@bwc/vault';
import { createPortalApp } from '../../apps/portal-api/src/app.js';
import type { PortalConfig } from '../../apps/portal-api/src/config.js';
import { createRateLimiter } from '../../apps/portal-api/src/limiter.js';
import {
  E2E_CLIENT_NAME,
  E2E_EMAIL,
  E2E_MUTABLE_ACCOUNTS,
  E2E_ORIGIN,
  E2E_PASSWORD,
  E2E_PORT,
  E2E_RP_ID,
} from './fixture.js';

const main = async (): Promise<void> => {
  const tenant = await createTenant(`e2e-${randomUUID().slice(0, 8)}`, 'End To End');

  const human = await createActor({
    tenantId: tenant.id,
    kind: 'human',
    label: 'E2E compliance officer',
    authorityLevel: 3,
    department: 'compliance',
  });

  const client = await createClient(tenant.id, E2E_CLIENT_NAME, { id: human.id, kind: 'human' });

  // The shared read-only account, plus one per test that changes an account. Registering a key and
  // turning the password off are permanent, so a shared account would leave the next test in a
  // state it did not ask for - and that failure looks like a flake rather than like two tests
  // fighting over one row.
  for (const email of [E2E_EMAIL, ...E2E_MUTABLE_ACCOUNTS]) {
    const invited = await inviteClientUser({
      tenantId: tenant.id,
      clientId: client.id,
      email,
      displayName: 'An End To End Person',
      issuedBy: human.id,
      actor: { id: human.id, kind: 'human' },
    });
    if (invited.status !== 'ok') throw new Error(`seed: invite ${email} (${invited.status})`);

    const enrolled = await enrolClientUser({
      tenantId: tenant.id,
      token: invited.value.token,
      password: E2E_PASSWORD,
      actor: { id: human.id, kind: 'human' },
    });
    if (enrolled.status !== 'ok') throw new Error(`seed: enrol ${email} (${enrolled.status})`);
  }

  const root = await mkdtemp(join(tmpdir(), 'bwc-e2e-'));
  process.env['VAULT_E2E_KEK'] = generateKek();
  process.env['MFA_SECRET_KEY'] ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddee00';

  const vault: VaultConfig = {
    store: new LocalEncryptedStore(root),
    kek: new EnvKekProvider('VAULT_E2E_KEK'),
  };

  const config: PortalConfig = {
    port: E2E_PORT,
    tenantId: tenant.id,
    cookieName: 'bwc_portal_session',
    // Plaintext over loopback. In deployment this is required to be set explicitly and would be
    // true; `localhost` is a secure context for WebAuthn without a certificate, which is why the
    // harness needs no TLS.
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    maxUploadBytes: 25 * 1024 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 1000,
    resetWindowSeconds: 900,
    resetMaxAttempts: 1000,
    rateLimitStore: 'memory',
    rpId: E2E_RP_ID,
    rpName: 'Burkham Wickmont',
    origin: E2E_ORIGIN,
  };

  const app = createPortalApp({
    config,
    vault,
    // Generous, because a browser run makes many requests and the limiter is not what is under test
    // here - `portal-transport.test.ts` and `shared-rate-limit.test.ts` cover it.
    limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 }),
    resetLimiter: createRateLimiter({ windowSeconds: 900, maxAttempts: 10_000 }),
    changeLimiter: createRateLimiter({ windowSeconds: 900, maxAttempts: 10_000 }),
  });

  createServer(app).listen(E2E_PORT, '127.0.0.1', () => {
    // Playwright waits on the port, not on this line. It is here for a human watching the run.
    console.log(`e2e portal listening on ${E2E_ORIGIN} (tenant ${tenant.id})`);
  });
};

void main().catch((error: unknown) => {
  console.error('[e2e] the portal could not start', error);
  process.exit(1);
});
