/**
 * Test setup and fixtures.
 *
 * Every test run creates its own tenant with a unique slug. That is not tidiness - the
 * Event Ledger is append-only, so tests cannot delete their events afterwards, and a shared
 * tenant would accumulate entries across runs until sequence-contiguity assertions started
 * failing for reasons unrelated to the code under test.
 *
 * Isolation by tenant is also what the system claims to provide, so the test harness
 * exercises the same property the product asserts.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db, disconnect } from '@bwc/db';
import { createActor, type Actor } from '@bwc/identity';
import { create as createTenant, type Tenant } from '@bwc/tenancy';
import { afterAll } from 'vitest';

if (!process.env['DATABASE_URL']) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env before running tests.');
}
if (!process.env['LEDGER_SIGNING_KEY']) {
  throw new Error('LEDGER_SIGNING_KEY is not set. Copy .env.example to .env before running tests.');
}

export interface Fixture {
  readonly tenant: Tenant;
  /** Village agent at Authority Level 1 - may draft, may not send or submit. */
  readonly agent: Actor;
  /** Village agent at Authority Level 0 - observe only. */
  readonly observer: Actor;
  /** Human compliance officer at Level 3. */
  readonly human: Actor;
}

export const makeFixture = async (label: string): Promise<Fixture> => {
  const tenant = await createTenant(`test-${label}-${randomUUID().slice(0, 8)}`, `Test ${label}`);

  const [agent, observer, human] = await Promise.all([
    createActor({
      tenantId: tenant.id,
      kind: 'village_agent',
      label: 'Funding Strategy agent',
      authorityLevel: 1,
      department: 'funding_strategy',
    }),
    createActor({
      tenantId: tenant.id,
      kind: 'village_agent',
      label: 'Observer agent',
      authorityLevel: 0,
      department: 'capital_readiness',
    }),
    createActor({
      tenantId: tenant.id,
      kind: 'human',
      label: 'Compliance officer',
      authorityLevel: 3,
      department: 'compliance_and_evidence',
    }),
  ]);

  return { tenant, agent, observer, human };
};

/** Non-ledger cleanup. Ledger events intentionally survive - they are append-only. */
export const cleanupTenant = async (tenantId: string): Promise<void> => {
  const prisma = db();
  // Governance first: it references providers by id across a schema boundary, so there is
  // no FK to cascade and the rows would otherwise outlive what they describe.
  await prisma.providerComplaint.deleteMany({ where: { tenantId } });
  await prisma.governanceDecision.deleteMany({ where: { tenantId } });
  await prisma.providerGovernance.deleteMany({ where: { tenantId } });
  await prisma.researchWorkstream.deleteMany({ where: { tenantId } });
  // Rules, offerings, appetite, outcomes and contacts cascade from the provider.
  await prisma.provider.deleteMany({ where: { tenantId } });
  await prisma.communication.deleteMany({ where: { tenantId } });
  await prisma.messageTemplate.deleteMany({ where: { tenantId } });
  await prisma.notificationPreference.deleteMany({ where: { tenantId } });
  await prisma.evidenceExport.deleteMany({ where: { tenantId } });
  // Risk: overrides cascade from the listing.
  await prisma.doNotFundListing.deleteMany({ where: { tenantId } });
  await prisma.riskObservation.deleteMany({ where: { tenantId } });
  // Sales: activities, corrections and outcomes cascade from the lead.
  await prisma.leadOutcome.deleteMany({ where: { tenantId } });
  await prisma.attributionCorrection.deleteMany({ where: { tenantId } });
  await prisma.readinessReading.deleteMany({ where: { tenantId } });
  await prisma.leadActivity.deleteMany({ where: { tenantId } });
  await prisma.lead.deleteMany({ where: { tenantId } });
  await prisma.taskNotification.deleteMany({ where: { tenantId } });
  // Billing: credits reference billing records; records cascade from the engagement.
  await prisma.creditApplication.deleteMany({ where: { tenantId } });
  await prisma.refundRecord.deleteMany({ where: { tenantId } });
  await prisma.fundingOutcome.deleteMany({ where: { tenantId } });
  await prisma.billingRecord.deleteMany({ where: { tenantId } });
  await prisma.engagement.deleteMany({ where: { tenantId } });
  await prisma.offerDefinition.deleteMany({ where: { tenantId } });
  // Contracts: generated documents and clauses reference templates and states by key.
  await prisma.generatedContract.deleteMany({ where: { tenantId } });
  await prisma.clause.deleteMany({ where: { tenantId } });
  await prisma.templateReview.deleteMany({ where: { tenantId } });
  await prisma.contractTemplate.deleteMany({ where: { tenantId } });
  // Regulatory: disclosures cascade from the module; activations and reviews reference a state
  // by code rather than by FK.
  await prisma.stateActivation.deleteMany({ where: { tenantId } });
  await prisma.counselReview.deleteMany({ where: { tenantId } });
  await prisma.stateLawChange.deleteMany({ where: { tenantId } });
  await prisma.stateModule.deleteMany({ where: { tenantId } });
  // Entity graph: edges reference nodes by id without an FK (they are polymorphic), so the
  // edges have to go first or they outlive what they describe.
  await prisma.graphEdge.deleteMany({ where: { tenantId } });
  await prisma.entity.deleteMany({ where: { tenantId } });
  await prisma.owner.deleteMany({ where: { tenantId } });
  await prisma.consent.deleteMany({ where: { tenantId } });
  await prisma.clientFirewallState.deleteMany({ where: { tenantId } });
  await prisma.client.deleteMany({ where: { tenantId } });
  await prisma.actor.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
};

afterAll(async () => {
  await disconnect();
});
