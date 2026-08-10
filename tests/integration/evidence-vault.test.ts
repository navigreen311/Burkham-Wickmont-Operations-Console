/**
 * 7.1 Compliance Evidence Vault, end to end.
 *
 * The property that makes a generated file worth anything: **it names what it could not include.**
 *
 * A regulator-ready file with a silent gap is worse than no file, because it asserts a completeness
 * it does not have. So most of this suite is about coverage rather than content - specifically that
 * `empty` and `not_built` stay distinguishable, since "this client has no complaints" and "we have
 * no complaints module" both produce zero rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { grant as grantConsent, revoke as revokeConsent } from '@bwc/consent';
import { read } from '@bwc/ledger';
import { publishOffer, startEngagement, recordBilling, fromDollars } from '@bwc/billing';
import {
  EVIDENCE_SOURCES,
  assembleEvidenceFile,
  exportEvidenceFile,
  exportHistory,
  hashEvidenceFile,
  reconcileExport,
  runSource,
  type EvidenceSource,
} from '@bwc/evidence';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;
let engagementId: string;
let bareClientId: string;

const NOW = new Date('2026-08-10T00:00:00.000Z');

beforeAll(async () => {
  fx = await makeFixture('evidence');

  const client = await createClient(fx.tenant.id, 'Evidenced Co', human());
  clientId = client.id;

  // A client with a history: a state transition, an authorization since revoked, an engagement
  // with money against it.
  await transitionComplianceState({
    tenantId: fx.tenant.id,
    clientId,
    to: 'pass_with_findings',
    reason: 'Two open findings on document freshness; neither blocks placement.',
    actor: human(),
  });

  await grantConsent({
    tenantId: fx.tenant.id,
    clientId,
    kind: 'application',
    scope: 'app-evidence-1',
    actor: human(),
  });
  const revocable = await grantConsent({
    tenantId: fx.tenant.id,
    clientId,
    kind: 'business_bureau_pull',
    scope: 'bureau-evidence-1',
    actor: human(),
  });
  if (revocable.status === 'ok') {
    await revokeConsent(fx.tenant.id, revocable.value.id, human());
  }

  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    publishedBy: 'concierge-desk',
    actor: human(),
  });

  const engagement = await startEngagement({
    tenantId: fx.tenant.id,
    clientId,
    offerKey: 'foundation',
    startedOn: new Date('2026-02-01T00:00:00.000Z'),
    actor: human(),
  });
  if (engagement.status !== 'ok') throw new Error('fixture engagement failed');
  engagementId = engagement.value.id;

  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'charge',
    amountCents: fromDollars(2_495),
    description: 'Engagement retainer',
    occurredOn: new Date('2026-02-01T00:00:00.000Z'),
    recordedBy: 'concierge-desk',
    actor: human(),
  });

  // A second client with nothing on file, so `empty` can be told from `not_built`.
  const bare = await createClient(fx.tenant.id, 'Untouched Co', human());
  bareClientId = bare.id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function human() {
  return { id: fx.human.id, kind: 'human' as const };
}

const assemble = (overrides: Record<string, unknown> = {}) =>
  assembleEvidenceFile({ tenantId: fx.tenant.id, clientId, now: NOW, ...overrides });

describe('the file names what it could not include', () => {
  it('carries a coverage entry for every source, including the ones that are not built', async () => {
    // A file that silently lacks a section asserts a completeness it does not have, and the reader
    // has no way to tell an absent section from an empty one.
    const file = await assemble();
    expect(file.status).toBe('ok');
    if (file.status !== 'ok') return;

    expect(file.value.coverage).toHaveLength(EVIDENCE_SOURCES.length);

    const notBuilt = file.value.coverage.filter((entry) => entry.coverage === 'not_built');
    expect(notBuilt.length).toBeGreaterThan(0);
    for (const entry of notBuilt) {
      expect(entry.note.length).toBeGreaterThan(40);
      expect(entry.module.length).toBeGreaterThan(0);
    }
  });

  it('distinguishes empty from not_built', async () => {
    // The load-bearing distinction. "This client has no complaints" and "we have no complaints
    // module" both produce zero rows, and a reader shown the first when the second is true has
    // been misled by an omission nobody intended.
    const file = await assemble({ clientId: bareClientId });
    if (file.status !== 'ok') throw new Error('expected a file');

    const empty = file.value.coverage.filter((entry) => entry.coverage === 'empty');
    const notBuilt = file.value.coverage.filter((entry) => entry.coverage === 'not_built');

    expect(empty.length).toBeGreaterThan(0);
    expect(notBuilt.length).toBeGreaterThan(0);
    // Both report zero items, and only the coverage verdict tells them apart.
    for (const entry of [...empty, ...notBuilt]) {
      expect(entry.itemCount).toBe(0);
    }

    const communications = notBuilt.find((entry) => entry.key === 'communications');
    expect(communications?.note).toMatch(/should not treat its absence as evidence/);
  });

  it('restates the gaps so a reader does not have to scan the coverage map', async () => {
    const file = await assemble();
    if (file.status !== 'ok') throw new Error('expected a file');

    expect(file.value.gaps.length).toBeGreaterThan(0);
    expect(file.value.gaps.every((gap) => gap.includes(':'))).toBe(true);
  });

  it('warns that provider complaints are not client complaints', async () => {
    // 5.4 holds complaints about PROVIDERS. Presenting that as a client's complaint history would
    // be a substitution nobody asked for, so the not-built note says so explicitly.
    const file = await assemble();
    if (file.status !== 'ok') throw new Error('expected a file');

    const complaints = file.value.coverage.find((entry) => entry.key === 'client_complaints');
    expect(complaints?.coverage).toBe('not_built');
    expect(complaints?.note).toMatch(/complaints about PROVIDERS/);
  });
});

describe('one failing source does not empty the file', () => {
  it('reports the failure as coverage and keeps going', async () => {
    // The file is most likely to be wanted at exactly the moment something is already wrong.
    const exploding: EvidenceSource = {
      key: 'exploding',
      module: 'test',
      description: 'A source that throws.',
      fetch: async () => {
        throw new Error('the database went away');
      },
    };

    const result = await runSource(exploding, { tenantId: fx.tenant.id, clientId });
    expect(result.coverage).toBe('failed');
    expect(result.note).toMatch(/the database went away/);
    expect(result.items).toHaveLength(0);

    // And the real assembly is unaffected by any one source's shape.
    const file = await assemble();
    expect(file.status).toBe('ok');
  });
});

describe('the file assembles live from its sources', () => {
  it('carries the compliance transition history and the reasoning with it', async () => {
    // Decision E: categorical state with the findings that produced each transition.
    const file = await assemble();
    if (file.status !== 'ok') throw new Error('expected a file');

    expect(file.value.complianceState).toBe('pass_with_findings');

    const transitions = file.value.sections.find(
      (section) => section.key === 'compliance_state_transitions',
    );
    expect(transitions?.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(transitions?.items)).toMatch(/document freshness/);
  });

  it('includes a revoked authorization rather than filtering it out', async () => {
    // "Authorized a bureau pull in March and revoked it in June" is the evidence. Filtering the
    // revoked one out would present the revocation as though it had never been granted.
    const file = await assemble();
    if (file.status !== 'ok') throw new Error('expected a file');

    const authorizations = file.value.sections.find((section) => section.key === 'authorizations');
    const serialized = JSON.stringify(authorizations?.items);
    expect(serialized).toMatch(/bureau-evidence-1/);
    expect(serialized).toMatch(/revokedAt/);
  });

  it('carries the Ledger integrity result so the file can be checked rather than trusted', async () => {
    // Without it the file is a set of claims with no evidence they were not edited afterwards.
    const file = await assemble();
    if (file.status !== 'ok') throw new Error('expected a file');

    expect(file.value.ledgerIntegrity.intact).toBe(true);
    expect(file.value.ledgerIntegrity.checked).toBeGreaterThan(0);
    expect(file.value.ledgerIntegrity.detail.length).toBeGreaterThan(10);
  });

  it('scopes the billing sections to one engagement when asked', async () => {
    const scoped = await assemble({ engagementId });
    if (scoped.status !== 'ok') throw new Error('expected a file');

    expect(scoped.value.scope).toBe('engagement');
    expect(scoped.value.engagementId).toBe(engagementId);

    const billing = scoped.value.sections.find(
      (section) => section.key === 'engagements_and_billing',
    );
    expect(billing?.items).toHaveLength(1);
  });

  it('reports no_data for a client that does not exist', async () => {
    const missing = await assemble({ clientId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe('no_data');
  });
});

describe('an export is itself an audit artifact', () => {
  it('requires a stated purpose and a requester', async () => {
    // "Who took a copy of this client's file and why" is the question the record exists to answer.
    for (const overrides of [{ purpose: '   ' }, { requestedBy: '  ' }]) {
      const result = await exportEvidenceFile({
        tenantId: fx.tenant.id,
        clientId,
        purpose: 'Regulator request BW-2026-14.',
        requestedBy: 'compliance@burkhamwickmont.test',
        actor: human(),
        now: NOW,
        ...overrides,
      });
      expect(result.status).toBe('refused');
    }
  });

  it('records who took a copy, why, and the hash of what they took', async () => {
    const result = await exportEvidenceFile({
      tenantId: fx.tenant.id,
      clientId,
      purpose: 'Regulator request BW-2026-14, California DFPI.',
      requestedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.record.contentHash).toBe(hashEvidenceFile(result.value.file));

    const history = await exportHistory(fx.tenant.id, clientId);
    expect(history[0]?.purpose).toMatch(/California DFPI/);
    expect(history[0]?.requestedBy).toBe('compliance@burkhamwickmont.test');
  });

  it('writes ids and a hash to the Ledger, never the file', async () => {
    // The file carries a client's compliance history by necessity. The record of the file does
    // not need to, and the Ledger is retained indefinitely.
    const events = await read({ tenantId: fx.tenant.id, type: 'evidence.file.exported' });
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toMatch(/Evidenced Co/);
      expect(serialized).not.toMatch(/document freshness/);
      expect(event.payload['contentHash']).toBeDefined();
      expect(event.payload['purpose']).toBeDefined();
    }
  });

  it('reconciles a past export against what the system produces now', async () => {
    const exported = await exportEvidenceFile({
      tenantId: fx.tenant.id,
      clientId: bareClientId,
      purpose: 'Baseline for the reconciliation test.',
      requestedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
      now: NOW,
    });
    if (exported.status !== 'ok') throw new Error('expected an export');

    // This assertion is what found the design flaw. The hash originally covered the whole file,
    // including the Ledger integrity count - which the act of exporting increments, so a file
    // could not match itself a second after it was written, and reconciliation was useless. The
    // hash now covers the client's evidence and not the two fields that are statements about the
    // system rather than about the client.
    const same = await reconcileExport(fx.tenant.id, exported.value.record.id, NOW);
    if (same.status !== 'ok') throw new Error('expected a reconciliation');
    expect(same.value.matches).toBe(true);

    // And it still matches when only the assembly time has moved on.
    const later = await reconcileExport(
      fx.tenant.id,
      exported.value.record.id,
      new Date('2026-09-01T00:00:00.000Z'),
    );
    if (later.status !== 'ok') throw new Error('expected a reconciliation');
    expect(later.value.matches).toBe(true);

    // Add evidence, and the file legitimately differs. That is a fact about the copy somebody
    // holds, not an error - and the detail says so rather than reporting tampering.
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: bareClientId,
      to: 'pass',
      reason: 'Assessment completed.',
      actor: human(),
    });

    const changed = await reconcileExport(fx.tenant.id, exported.value.record.id, NOW);
    if (changed.status !== 'ok') throw new Error('expected a reconciliation');
    expect(changed.value.matches).toBe(false);
    expect(changed.value.detail).toMatch(/expected where evidence has been added since/);
  });
});
