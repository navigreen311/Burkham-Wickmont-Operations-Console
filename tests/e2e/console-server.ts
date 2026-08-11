/**
 * The internal Console, running against a real database, for the browser tests.
 *
 * A second `webServer` beside the portal's, on a second port, because they are two processes and
 * two trust boundaries (ADR-0022). Sharing one would make the browser test agree with an
 * architecture the system does not have.
 *
 * Seeds its own tenant - the Ledger is append-only and hash-chained - one Level 3 human with a
 * Console credential, and a client to look at. What it cannot keep to itself is the TOTP secret:
 * the specs have to compute a code from it, so it is written to the handoff file named in
 * `fixture.ts`, where the reasoning is recorded.
 *
 * **`devActorHeader` is false here**, as it is in deployment. A harness that turned the seam on
 * would be testing a Console nobody runs.
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { create as createTenant } from '@bwc/tenancy';
import { beginStaffEnrolment, confirmStaffEnrolment, createActor, totp } from '@bwc/identity';
import { base32Decode } from '@bwc/identity';
import { create as createClient } from '@bwc/clients';
import { createRateLimiter } from '@bwc/http';
import { createApp } from '../../apps/api/src/app.js';
import type { ConsoleConfig } from '../../apps/api/src/config.js';
import {
  E2E_CONSOLE_ACCOUNTS,
  E2E_CONSOLE_CLIENTS,
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_LEVELS,
  E2E_CONSOLE_ORIGIN,
  E2E_CONSOLE_PASSWORD,
  E2E_CONSOLE_PORT,
  type ConsoleHandoff,
} from './fixture.js';

const LABEL = 'E2E operations lead';

const main = async (): Promise<void> => {
  const tenant = await createTenant(
    `e2e-console-${randomUUID().slice(0, 8)}`,
    'Console End To End',
  );

  // The one who grants the rest their access. Level 3, because that is what enrolment requires.
  const granter = await createActor({
    tenantId: tenant.id,
    kind: 'human',
    label: LABEL,
    authorityLevel: 3,
    department: 'operations',
  });

  // One per spec that changes one. See `E2E_CONSOLE_CLIENTS`.
  for (const name of E2E_CONSOLE_CLIENTS) {
    await createClient(tenant.id, name, { id: granter.id, kind: 'human' });
  }

  process.env['MFA_SECRET_KEY'] ??=
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddee00';

  const secrets: Record<string, string> = {};

  for (const email of E2E_CONSOLE_ACCOUNTS) {
    const actor = await createActor({
      tenantId: tenant.id,
      kind: 'human',
      label: LABEL,
      authorityLevel: E2E_CONSOLE_LEVELS[email] ?? 3,
      department: 'operations',
    });

    const offer = await beginStaffEnrolment({
      tenantId: tenant.id,
      actorId: actor.id,
      email,
      password: E2E_CONSOLE_PASSWORD,
      grantedBy: granter.id,
    });
    if (offer.status !== 'ok') throw new Error(`seed: enrolment ${email} (${offer.status})`);

    const secret = base32Decode(offer.value.secret);
    if (secret === null) throw new Error(`seed: secret ${email}`);

    const confirmed = await confirmStaffEnrolment({
      tenantId: tenant.id,
      actorId: actor.id,
      password: E2E_CONSOLE_PASSWORD,
      code: totp(secret, new Date()),
    });
    if (confirmed.status !== 'ok') {
      throw new Error(`seed: confirmation ${email} (${confirmed.status})`);
    }

    secrets[email] = offer.value.secret;
  }

  const handoff: ConsoleHandoff = {
    tenantId: tenant.id,
    secrets,
    clientName: E2E_CONSOLE_CLIENTS[0],
    label: LABEL,
  };
  await writeFile(E2E_CONSOLE_HANDOFF, JSON.stringify(handoff), 'utf8');

  const config: ConsoleConfig = {
    port: E2E_CONSOLE_PORT,
    tenantId: tenant.id,
    cookieName: 'bwc_console_session',
    // Plaintext over loopback. A deployment must set this explicitly and would set it true.
    cookieSecure: false,
    trustProxy: false,
    maxJsonBytes: 64 * 1024,
    signInWindowSeconds: 300,
    signInMaxAttempts: 10_000,
    rateLimitStore: 'memory',
    // As in deployment. The browser signs in.
    devActorHeader: false,
  };

  const app = createApp({
    config,
    limiter: createRateLimiter({ windowSeconds: 300, maxAttempts: 10_000 }),
  });

  // No host argument, so both stacks are listened on - see the note in `server.ts`.
  createServer(app).listen(E2E_CONSOLE_PORT, () => {
    console.log(`e2e console listening on ${E2E_CONSOLE_ORIGIN} (tenant ${tenant.id})`);
  });
};

void main().catch((error: unknown) => {
  console.error('[e2e] the console could not start', error);
  process.exit(1);
});
