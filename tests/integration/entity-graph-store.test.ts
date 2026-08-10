/**
 * The Entity Graph against a real database - 1.2.
 *
 * Two things need a database to test honestly, and both are the kind that pass in a unit test and
 * fail in production: **that an SSN survives a round trip through encryption**, and **that neither
 * the plaintext nor the ciphertext ever reaches the Event Ledger** - which is append-only, so a
 * payload written wrongly cannot be corrected, only explained.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import {
  addEdge,
  deriveProfile,
  detectRelationships,
  endEdge,
  guaranteeExposure,
  loadGraph,
  recordStatedRevenue,
  revealEin,
  revealSsn,
  setPrimaryEntity,
  upsertEntity,
  upsertOwner,
} from '@bwc/graph';
import type { Provenance } from '@bwc/core';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

/**
 * Test values. Structurally valid so the PII detectors treat them as real, and deliberately
 * reserved: 000-xx-xxxx is never issued as an SSN, and 00 is not a valid EIN prefix.
 */
const TEST_SSN = '000-12-3456';
const TEST_EIN = '00-7654321';

beforeAll(async () => {
  fx = await makeFixture('entity-graph');
  const client = await createClient(fx.tenant.id, 'Graph Test Co', actor());
  clientId = client.id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function actor() {
  return { id: fx.human.id, kind: 'human' as const };
}

const PROVENANCE: Provenance = {
  tag: 'client_stated',
  statedBy: 'A. Owner',
  statedAt: '2026-08-01T00:00:00.000Z',
};

describe('PII never leaves the store in the clear', () => {
  it('round-trips an SSN through encryption and hands back only the last four', async () => {
    const owner = await upsertOwner({
      tenantId: fx.tenant.id,
      clientId,
      fullName: 'A. Owner',
      ssn: TEST_SSN,
      actor: actor(),
    });

    expect(owner.status).toBe('ok');
    if (owner.status !== 'ok') return;

    // The Graph value carries a display last-4 and nothing else, so no traversal, finding or
    // rationale downstream can include an SSN - they were never given one.
    expect(owner.value.ssnLast4).toBe('3456');
    expect(JSON.stringify(owner.value)).not.toContain(TEST_SSN);

    const revealed = await revealSsn({
      tenantId: fx.tenant.id,
      ownerId: owner.value.id,
      actor: actor(),
      purpose: 'Preparing an application packet that requires the guarantor SSN.',
    });

    expect(revealed.status).toBe('ok');
    if (revealed.status === 'ok') expect(revealed.value).toBe(TEST_SSN);
  });

  it('refuses to reveal without a stated purpose', async () => {
    // The question a regulator asks about an encrypted field is not whether it was encrypted but
    // who read it and why.
    const owner = await upsertOwner({
      tenantId: fx.tenant.id,
      clientId,
      fullName: 'Purposeless Read',
      ssn: TEST_SSN,
      actor: actor(),
    });
    if (owner.status !== 'ok') throw new Error('fixture failed');

    const result = await revealSsn({
      tenantId: fx.tenant.id,
      ownerId: owner.value.id,
      actor: actor(),
      purpose: '   ',
    });
    expect(result.status).toBe('refused');
  });

  it('reports no_data for an owner with no SSN on file rather than an empty string', async () => {
    const owner = await upsertOwner({
      tenantId: fx.tenant.id,
      clientId,
      fullName: 'No SSN Owner',
      actor: actor(),
    });
    if (owner.status !== 'ok') throw new Error('fixture failed');

    const result = await revealSsn({
      tenantId: fx.tenant.id,
      ownerId: owner.value.id,
      actor: actor(),
      purpose: 'Checking.',
    });
    expect(result.status).toBe('no_data');
  });

  it('round-trips an EIN and logs the read', async () => {
    const entity = await upsertEntity({
      tenantId: fx.tenant.id,
      clientId,
      legalName: 'EIN Holder LLC',
      role: 'operating',
      ein: TEST_EIN,
      actor: actor(),
    });
    if (entity.status !== 'ok') throw new Error('fixture failed');

    expect(entity.value.einLast4).toBe('4321');

    const revealed = await revealEin({
      tenantId: fx.tenant.id,
      entityId: entity.value.id,
      actor: actor(),
      purpose: 'Completing a lender application form.',
    });
    if (revealed.status === 'ok') expect(revealed.value).toBe(TEST_EIN);

    const events = await read({ tenantId: fx.tenant.id, type: 'graph.ein.revealed' });
    expect(events.some((event) => event.payload['entityId'] === entity.value.id)).toBe(true);
  });

  it('writes no identifier - plaintext or ciphertext - into any Ledger payload', async () => {
    // The load-bearing assertion in this file. The Ledger is append-only: a payload written
    // wrongly cannot be corrected, only explained.
    const events = await read({ tenantId: fx.tenant.id });
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      const serialized = JSON.stringify(event.payload);
      expect(serialized, event.type).not.toContain(TEST_SSN);
      expect(serialized, event.type).not.toContain(TEST_EIN);
      expect(serialized, event.type).not.toContain('3456');
      expect(serialized, event.type).not.toContain('4321');
      // The envelope format starts `v1|`; a ciphertext leaking is as bad as a plaintext,
      // because the Ledger is retained indefinitely and keys are rotated, not retired.
      expect(serialized, event.type).not.toContain('v1|');
    }
  });

  it('records that an identifier is on file without recording the identifier', async () => {
    const events = await read({ tenantId: fx.tenant.id, type: 'graph.owner.recorded' });
    const withSsn = events.find((event) => event.payload['fullName'] === 'A. Owner');
    expect(withSsn?.payload['hasSsn']).toBe(true);
  });
});

describe('the graph persists and reloads', () => {
  it('refuses an edge whose endpoints are the wrong way round', async () => {
    const entity = await upsertEntity({
      tenantId: fx.tenant.id,
      clientId,
      legalName: 'Direction Test LLC',
      role: 'operating',
      actor: actor(),
    });
    if (entity.status !== 'ok') throw new Error('fixture failed');

    const result = await addEdge({
      tenantId: fx.tenant.id,
      clientId,
      kind: 'ownership',
      fromKind: 'entity',
      fromId: entity.value.id,
      toKind: 'owner',
      toId: entity.value.id,
      ownershipPercent: 50,
      provenanceTag: 'client_stated',
      actor: actor(),
    });

    // Refused rather than thrown: an operator entering a household by hand will get a direction
    // wrong, and the honest answer names which end was wrong.
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/starts at owner/);
  });

  it('builds a household, reloads it, and computes exposure over what was stored', async () => {
    const [op, re] = await Promise.all([
      upsertEntity({
        tenantId: fx.tenant.id,
        clientId,
        legalName: 'Persisted Operating LLC',
        role: 'operating',
        stateOfFormation: 'TX',
        formationDate: new Date('2022-02-10T00:00:00.000Z'),
        industry: 'Professional Services',
        actor: actor(),
      }),
      upsertEntity({
        tenantId: fx.tenant.id,
        clientId,
        legalName: 'Persisted Realty LLC',
        role: 'real_estate',
        stateOfFormation: 'TX',
        actor: actor(),
      }),
    ]);
    if (op.status !== 'ok' || re.status !== 'ok') throw new Error('fixture failed');

    const guarantor = await upsertOwner({
      tenantId: fx.tenant.id,
      clientId,
      fullName: 'Persisted Guarantor',
      actor: actor(),
    });
    if (guarantor.status !== 'ok') throw new Error('fixture failed');

    await addEdge({
      tenantId: fx.tenant.id,
      clientId,
      kind: 'ownership',
      fromKind: 'owner',
      fromId: guarantor.value.id,
      toKind: 'entity',
      toId: op.value.id,
      ownershipPercent: 100,
      provenanceTag: 'client_stated',
      actor: actor(),
    });
    await addEdge({
      tenantId: fx.tenant.id,
      clientId,
      kind: 'guarantee',
      fromKind: 'owner',
      fromId: guarantor.value.id,
      toKind: 'entity',
      toId: op.value.id,
      provenanceTag: 'client_stated',
      actor: actor(),
    });
    await addEdge({
      tenantId: fx.tenant.id,
      clientId,
      kind: 'debt',
      fromKind: 'entity',
      fromId: op.value.id,
      toKind: 'external',
      toLabel: 'Persisted Bank Line',
      amount: 175_000,
      provenanceTag: 'client_stated',
      actor: actor(),
    });

    const graph = await loadGraph(fx.tenant.id, clientId);
    const exposures = guaranteeExposure(graph, PROVENANCE);
    const persisted = exposures.find((e) => e.ownerName === 'Persisted Guarantor');

    expect(persisted?.exposureAmount.value).toBe(175_000);
    expect(persisted?.hasUnlimitedGuarantee).toBe(true);
  });

  it('ends an edge rather than deleting it, so history still explains the past', async () => {
    const graph = await loadGraph(fx.tenant.id, clientId);
    const guarantee = graph.edges.find(
      (candidate) => candidate.kind === 'guarantee' && candidate.endedAt === null,
    );
    if (!guarantee) throw new Error('expected a guarantee edge');

    const result = await endEdge({
      tenantId: fx.tenant.id,
      clientId,
      edgeId: guarantee.id,
      reason: 'Guarantee released on refinance.',
      actor: actor(),
      now: new Date('2026-08-09T00:00:00.000Z'),
    });
    expect(result.status).toBe('ok');

    const reloaded = await loadGraph(fx.tenant.id, clientId);
    const same = reloaded.edges.find((candidate) => candidate.id === guarantee.id);
    // Still on file, and no longer counted.
    expect(same).toBeDefined();
    expect(same?.endedAt).not.toBeNull();
  });
});

describe('primary entity and stated revenue', () => {
  it('keeps exactly one primary, clearing the previous in the same transaction', async () => {
    // Two primaries would make the derived profile depend on row order - a defect that behaves
    // consistently in testing and differently in production after a vacuum.
    const first = await upsertEntity({
      tenantId: fx.tenant.id,
      clientId,
      legalName: 'First Primary LLC',
      role: 'operating',
      actor: actor(),
    });
    const second = await upsertEntity({
      tenantId: fx.tenant.id,
      clientId,
      legalName: 'Second Primary LLC',
      role: 'operating',
      actor: actor(),
    });
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('fixture failed');

    await setPrimaryEntity({
      tenantId: fx.tenant.id,
      clientId,
      entityId: first.value.id,
      actor: actor(),
    });
    await setPrimaryEntity({
      tenantId: fx.tenant.id,
      clientId,
      entityId: second.value.id,
      actor: actor(),
    });

    const graph = await loadGraph(fx.tenant.id, clientId);
    const primaries = graph.entities.filter((entity) => entity.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.legalName).toBe('Second Primary LLC');
  });

  it('refuses a stated revenue with nobody attached to it', async () => {
    const graph = await loadGraph(fx.tenant.id, clientId);
    const entity = graph.entities[0];
    if (!entity) throw new Error('expected an entity');

    const result = await recordStatedRevenue({
      tenantId: fx.tenant.id,
      clientId,
      entityId: entity.id,
      annualRevenue: 1_000_000,
      statedBy: '  ',
      statedAt: new Date('2026-07-01T00:00:00.000Z'),
      actor: actor(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.principle).toMatch(/Decision D/);
  });

  it('carries a stated revenue into the derived profile as client_stated', async () => {
    const graph = await loadGraph(fx.tenant.id, clientId);
    const primary = graph.entities.find((entity) => entity.isPrimary);
    if (!primary) throw new Error('expected a primary entity');

    await recordStatedRevenue({
      tenantId: fx.tenant.id,
      clientId,
      entityId: primary.id,
      annualRevenue: 2_100_000,
      statedBy: 'A. Owner',
      statedAt: new Date('2026-07-01T00:00:00.000Z'),
      documentReference: 'FY2025 P&L uploaded 2026-07-01',
      actor: actor(),
    });

    const reloaded = await loadGraph(fx.tenant.id, clientId);
    const derived = deriveProfile({
      graph: reloaded,
      need: 'working_capital',
      requestedAmount: 250_000,
      today: new Date('2026-08-10T00:00:00.000Z'),
    });

    expect(derived.status).toBe('ok');
    if (derived.status !== 'ok') return;

    expect(derived.value.profile.annualRevenue).toBe(2_100_000);
    const source = derived.value.sources.find((s) => s.field === 'annualRevenue');
    expect(source?.provenance?.tag).toBe('client_stated');
    expect(source?.note).toMatch(/FY2025 P&L/);
  });

  it('asks who owns a company that carries debt with no cap table on file', async () => {
    // Written expecting findings over the household built above, and it produced none - correctly,
    // since every gap there was an untouched entity, which `isolatedEntities` covers as a data
    // -quality signal rather than a question. What it exposed was a real hole: an entity with
    // *debt* and no recorded owner also produced nothing, and "who owns this company?" is the
    // first question a lender asks.
    const orphan = await upsertEntity({
      tenantId: fx.tenant.id,
      clientId,
      legalName: 'Unowned Borrower LLC',
      role: 'operating',
      actor: actor(),
    });
    if (orphan.status !== 'ok') throw new Error('fixture failed');

    await addEdge({
      tenantId: fx.tenant.id,
      clientId,
      kind: 'debt',
      fromKind: 'entity',
      fromId: orphan.value.id,
      toKind: 'external',
      toLabel: 'Unowned Facility',
      amount: 90_000,
      provenanceTag: 'client_stated',
      actor: actor(),
    });

    const graph = await loadGraph(fx.tenant.id, clientId);
    const findings = detectRelationships(graph);

    const finding = findings.find(
      (entry) =>
        entry.kind === 'ownership_does_not_total' &&
        entry.observation.includes('Unowned Borrower LLC'),
    );

    expect(finding?.question).toBe('Who owns Unowned Borrower LLC?');
    expect(finding?.whyItMatters).toMatch(/missing KYC subject/);

    for (const entry of findings) {
      expect(entry.question).toMatch(/\?/);
    }
  });
});
