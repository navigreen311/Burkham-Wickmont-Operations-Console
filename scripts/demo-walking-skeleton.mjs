#!/usr/bin/env node
/**
 * Walking-skeleton demo. Drives the whole path against a running API and prints what
 * happened at each step.
 *
 * The Output Automater artifact for this feature: one runnable command instead of a list
 * of curl invocations to paste. Idempotent - it creates a fresh tenant and clients each
 * run, so repeated runs neither collide nor need cleanup.
 *
 * Usage:
 *   pnpm dev            # in one terminal
 *   node scripts/demo-walking-skeleton.mjs
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.DEMO_BASE_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4100}`;
const prisma = new PrismaClient();

const line = (text) => console.log(text);
const head = (text) => console.log(`\n=== ${text} ===`);

async function api(method, path, { actorId, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(actorId ? { 'x-actor-id': actorId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { code: res.status, body: await res.json() };
}

function report(label, { code, body }) {
  const detail =
    body.status === 'ok'
      ? ''
      : ` -> ${body.reason ?? ''}${body.principle ? `  [${body.principle}]` : ''}${
          body.module ? `  [module: ${body.module}]` : ''
        }`;
  line(`  ${String(code).padEnd(4)} ${String(body.status).padEnd(10)} ${label}${detail}`);
  return body;
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Cannot reach the API at ${BASE}. Start it with: pnpm dev`);
    process.exit(1);
  }

  // Seed a tenant and two actors directly - Identity & Access (11.1) has no provisioning
  // endpoint yet, and inventing one for a demo would be the fiction this system avoids.
  const suffix = Math.random().toString(36).slice(2, 8);
  const tenant = await prisma.tenant.create({
    data: { slug: `demo-${suffix}`, name: 'Demo Tenant' },
  });
  const agent = await prisma.actor.create({
    data: {
      tenantId: tenant.id,
      kind: 'village_agent',
      label: 'Funding Strategy agent',
      authorityLevel: 1,
      department: 'funding_strategy',
    },
  });
  const human = await prisma.actor.create({
    data: {
      tenantId: tenant.id,
      kind: 'human',
      label: 'Compliance officer',
      authorityLevel: 3,
      department: 'compliance_and_evidence',
    },
  });

  head('Vendor activation gates (Specification v2 section 11.4)');
  const gates = await api('GET', '/api/health/integrations');
  for (const vendor of gates.body.data.vendors) {
    line(
      `  ${vendor.vendor.padEnd(18)} activated=${String(vendor.activated).padEnd(5)} outstanding: ${
        vendor.outstanding.length ? vendor.outstanding.join(', ') : 'none'
      }`,
    );
  }

  head('1. Client intake');
  const client = report(
    'create client',
    await api('POST', '/api/clients', { actorId: human.id, body: { legalName: 'Demo Operating Co' } }),
  ).data;
  line(`       compliance state: ${client.complianceState}`);

  head('2. Placement before assessment (must be refused)');
  report(
    'request placement',
    await api('POST', `/api/clients/${client.id}/placements`, {
      actorId: agent.id,
      body: { applicationRef: 'app-001' },
    }),
  );

  head('3. Compliance assessment -> needs_review (Decision E)');
  report(
    'transition to needs_review',
    await api('POST', `/api/clients/${client.id}/compliance`, {
      actorId: human.id,
      body: {
        to: 'needs_review',
        reason: 'Bank feed and stated revenue disagree by more than tolerance',
        findings: [{ code: 'REV-MISMATCH', summary: 'Stated revenue exceeds deposits by 38%' }],
      },
    }),
  );

  head('4. Placement while needs_review (must be refused, placement frozen)');
  report(
    'request placement',
    await api('POST', `/api/clients/${client.id}/placements`, {
      actorId: agent.id,
      body: { applicationRef: 'app-001' },
    }),
  );

  head('5. Human resolves the finding -> pass_with_findings');
  report(
    'transition to pass_with_findings',
    await api('POST', `/api/clients/${client.id}/compliance`, {
      actorId: human.id,
      body: { to: 'pass_with_findings', reason: 'Reconciled; discrepancy explained by intercompany transfer' },
    }),
  );

  head('6. Placement without per-application authorization (must be refused)');
  report(
    'request placement',
    await api('POST', `/api/clients/${client.id}/placements`, {
      actorId: agent.id,
      body: { applicationRef: 'app-001' },
    }),
  );

  head('7. Client authorizes this specific application');
  report(
    'grant consent',
    await api('POST', `/api/clients/${client.id}/consents`, {
      actorId: human.id,
      body: { kind: 'application', scope: 'app-001' },
    }),
  );

  head('8. Placement with everything cleared (honest not_built, never a fabrication)');
  report(
    'request placement',
    await api('POST', `/api/clients/${client.id}/placements`, {
      actorId: agent.id,
      body: { applicationRef: 'app-001' },
    }),
  );

  head('9. Firewall precedence - triggered client is refused even at pass_with_findings');
  report(
    'trigger firewall',
    await api('POST', `/api/clients/${client.id}/firewall/trigger`, {
      actorId: human.id,
      body: { reason: 'Undisclosed debt discovered in bank feed' },
    }),
  );
  report(
    'request placement',
    await api('POST', `/api/clients/${client.id}/placements`, {
      actorId: agent.id,
      body: { applicationRef: 'app-001' },
    }),
  );

  head('10. Level 4 perimeter and cross-tenant isolation');
  const otherTenant = await prisma.tenant.create({
    data: { slug: `demo-other-${suffix}`, name: 'Other Tenant' },
  });
  const otherClient = await prisma.client.create({
    data: { tenantId: otherTenant.id, legalName: 'Other Tenant Co' },
  });
  report(
    "read another tenant's client",
    await api('GET', `/api/clients/${otherClient.id}`, { actorId: agent.id }),
  );

  head('11. Event Ledger - what actually happened');
  const ledger = await api('GET', `/api/clients/${client.id}/ledger`, { actorId: human.id });
  for (const event of ledger.body.data ?? []) {
    line(`  #${String(event.seq).padStart(3)}  ${event.type}`);
  }

  head('12. Ledger integrity');
  const integrity = await api('GET', '/api/ledger/integrity', { actorId: human.id });
  line(`  intact=${integrity.body.data.intact}  entries checked=${integrity.body.data.checked}`);

  head('Done');
  line('  Every refusal above names the principle that produced it.');
  line('  Nothing returned fabricated data in place of a capability that does not exist.');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
