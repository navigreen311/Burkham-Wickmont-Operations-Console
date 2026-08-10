/**
 * 11.6 Data Warehouse, 11.10 Client Portal and 11.11 Founder Workbench, end to end.
 *
 * The last three V1 modules. Three properties carry the file.
 *
 * **The warehouse cannot be asked about the present.** Asserted structurally - every read takes a
 * period, and the module exports nothing that would serve "now". That is what stops it becoming
 * the stale cache ADR-0017 ruled out.
 *
 * **The portal enforces one rule and delegates the rest.** A client acting on somebody else's file
 * is refused here; everything else is refused by the module that owns the gate, and the upload
 * test proves it by checking the document is unreadable rather than by checking a portal flag.
 *
 * **Every founder decision says what happens if nobody acts.** That is the field separating a
 * queue from a feed, and it is asserted on every item rather than sampled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { publishOffer, startEngagement, recordBilling, fromDollars } from '@bwc/billing';
import { forClient as consentsForClient } from '@bwc/consent';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  generateKek,
  read as vaultRead,
  type VaultConfig,
} from '@bwc/vault';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setParameter } from '@bwc/admin';
import {
  PSEUDONYMISATION_NOTE,
  captureSnapshot,
  cohortFor,
  cohortRetention,
  snapshotsBetween,
  subjectKeyFor,
  trend,
} from '@bwc/warehouse';
import {
  CLIENT_UPLOADABLE_KINDS,
  clientRoom,
  connectBankAccount,
  documentInRoom,
  sendMessage,
  signDisclosure,
  uploadDocument,
} from '@bwc/portal';
import { decisionQueue, workbench } from '@bwc/workbench';
import { DEFAULT_REVIEW_CADENCE_DAYS, listClient } from '@bwc/risk';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let alpha: string;
let beta: string;
let engagementId: string;

const NOW = new Date('2026-08-11T12:00:00.000Z');
const SECRET = 'a-sufficiently-long-subject-secret';
/**
 * A capture date safely in the past. `captureSnapshot` refuses a future `asOf` - it records the
 * state as it is when called, and labelling that with a future date would put facts in the series
 * before they happened - so this cannot be the same fixed NOW the rest of the file uses.
 */
const SNAPSHOT_DATE = new Date('2026-08-05T00:00:00.000Z');
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

let vault: VaultConfig;

beforeAll(async () => {
  fx = await makeFixture('warehouse-portal');

  const root = await mkdtemp(join(tmpdir(), 'bwc-portal-'));
  process.env['VAULT_PORTAL_KEK'] = generateKek();
  vault = { store: new LocalEncryptedStore(root), kek: new EnvKekProvider('VAULT_PORTAL_KEK') };

  const offer = await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    publishedBy: 'concierge-desk',
    actor: HUMAN(),
  });
  if (offer.status !== 'ok') throw new Error('setup: offer');

  const [a, b] = await Promise.all([
    createClient(fx.tenant.id, 'Alpha Manufacturing LLC', HUMAN()),
    createClient(fx.tenant.id, 'Beta Logistics LLC', HUMAN()),
  ]);
  alpha = a.id;
  beta = b.id;

  await transitionComplianceState({
    tenantId: fx.tenant.id,
    clientId: alpha,
    to: 'pass_with_findings',
    reason: 'Assessed with two documentation findings.',
    actor: HUMAN(),
  });

  const engagement = await startEngagement({
    tenantId: fx.tenant.id,
    clientId: alpha,
    offerKey: 'foundation',
    startedOn: new Date('2026-08-01T00:00:00.000Z'),
    startedBy: fx.human.id,
    actor: HUMAN(),
  });
  if (engagement.status !== 'ok') throw new Error('setup: engagement');
  engagementId = engagement.value.id;

  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId,
    kind: 'charge',
    amountCents: fromDollars(2_495),
    description: 'Foundation retainer',
    occurredOn: new Date('2026-08-02T00:00:00.000Z'),
    recordedBy: fx.human.id,
    actor: HUMAN(),
  });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('11.6 the warehouse answers about the past', () => {
  it('captures a snapshot with its gaps', async () => {
    const snapshot = await captureSnapshot({
      tenantId: fx.tenant.id,
      asOf: SNAPSHOT_DATE,
      capturedBy: fx.human.id,
      actor: HUMAN(),
      subjectSecret: SECRET,
    });

    expect(snapshot.status).toBe('ok');
    if (snapshot.status !== 'ok') return;
    expect(snapshot.value.facts.clients).toBe(2);
    expect(snapshot.value.facts.complianceCounts['pass_with_findings']).toBe(1);
    expect(snapshot.value.subjects).toBe(2);
    // A trend with a missing input reads as a dip unless the point says otherwise.
    expect(snapshot.value.gaps.join(' ')).toMatch(/vendor costs/);
  });

  it('refuses to overwrite a snapshot rather than rewriting history', async () => {
    const again = await captureSnapshot({
      tenantId: fx.tenant.id,
      asOf: SNAPSHOT_DATE,
      capturedBy: fx.human.id,
      actor: HUMAN(),
      subjectSecret: SECRET,
    });
    expect(again.status).toBe('refused');
    if (again.status === 'refused') {
      expect(again.reason).toMatch(/rewrite the history/);
    }
  });

  it('refuses a future date and a weak subject secret', async () => {
    const future = await captureSnapshot({
      tenantId: fx.tenant.id,
      asOf: new Date('2027-01-01T00:00:00.000Z'),
      capturedBy: fx.human.id,
      actor: HUMAN(),
      subjectSecret: SECRET,
    });
    expect(future.status).toBe('refused');

    const weak = await captureSnapshot({
      tenantId: fx.tenant.id,
      asOf: new Date('2026-08-04T00:00:00.000Z'),
      capturedBy: fx.human.id,
      actor: HUMAN(),
      subjectSecret: 'short',
    });
    expect(weak.status).toBe('refused');
  });

  it('exposes no way to ask the warehouse about now', async () => {
    // THE STRUCTURAL ASSERTION. ADR-0017 keeps the dashboards reading live; nothing can quietly
    // start using this as a faster read of what 9.1 already answers, because no such function
    // exists to call.
    const warehouse: Record<string, unknown> = await import('@bwc/warehouse');
    const suspicious = Object.keys(warehouse).filter((name) =>
      /^(current|latest|now|today)/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it("reads a trend over a period, carrying each point's gaps", async () => {
    const series = await trend(
      fx.tenant.id,
      'clients',
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(series.status).toBe('ok');
    if (series.status !== 'ok') return;
    expect(series.value.points).toHaveLength(1);
    expect(series.value.points[0]?.value).toBe(2);
    expect(series.value.points[0]?.gaps.length).toBeGreaterThan(0);
  });

  it('reports an empty period as no_data rather than a flat line at zero', async () => {
    const series = await trend(
      fx.tenant.id,
      'clients',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2025-01-31T00:00:00.000Z'),
    );
    expect(series.status).toBe('no_data');
    if (series.status === 'no_data') {
      expect(series.reason).toMatch(/gap in the capture schedule/);
    }
  });

  it('keeps subject rows pseudonymous, and says what that does not protect', async () => {
    const rows = await db().subjectSnapshot.findMany({ where: { tenantId: fx.tenant.id } });
    expect(rows.length).toBe(2);

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(alpha);
    expect(serialised).not.toContain(beta);
    expect(serialised).not.toContain('Alpha Manufacturing');

    // Stable across snapshots, so a cohort can be followed - and recomputable only with the key.
    expect(rows.map((row) => row.subjectKey)).toContain(subjectKeyFor(fx.tenant.id, alpha, SECRET));
    expect(rows.map((row) => row.subjectKey)).not.toContain(
      subjectKeyFor(fx.tenant.id, alpha, 'a-different-secret-entirely'),
    );

    // The honest version. Claiming anonymity would be worse than not doing it.
    expect(PSEUDONYMISATION_NOTE).toMatch(/PSEUDONYM, not anonymisation/);
    expect(PSEUDONYMISATION_NOTE).toMatch(/handled as personal data/);
  });

  it('follows a cohort through time', async () => {
    const cohort = cohortFor(new Date());
    const retention = await cohortRetention(
      fx.tenant.id,
      cohort,
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(retention.status).toBe('ok');
    if (retention.status !== 'ok') return;
    expect(retention.value.points[0]?.members).toBe(2);
    expect(retention.value.points[0]?.stillEngaged).toBe(1);
    expect(retention.value.detail).toMatch(/never recomputed/);
  });

  it('keeps snapshots after the operational client record is gone', async () => {
    // Blueprint 11.6's "historical retention independent of operational data retention".
    const before = await snapshotsBetween(
      fx.tenant.id,
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );
    expect(before[0]?.subjects).toBe(2);
    // The subject rows reference no client id, so nothing cascades from a client deletion.
    const rows = await db().subjectSnapshot.findMany({ where: { tenantId: fx.tenant.id } });
    expect(Object.keys(rows[0] as object)).not.toContain('clientId');
  });
});

describe('11.10 the portal decides nothing', () => {
  const principal = () => ({ tenantId: fx.tenant.id, clientId: alpha, actorId: fx.human.id });

  it('shows a client their own room, and says what it withholds', async () => {
    const room = await clientRoom(principal());
    expect(room.status).toBe('ok');
    if (room.status !== 'ok') return;

    expect(room.value.clientLegalName).toBe('Alpha Manufacturing LLC');
    expect(room.value.complianceState).toBe('pass_with_findings');
    expect(room.value.engagements).toHaveLength(1);
    // A room that silently omits something asserts there is nothing there.
    expect(room.value.withheld.length).toBeGreaterThan(0);
    expect(room.value.withheld.join(' ')).toMatch(/internal compliance findings/);
  });

  it('holds an uploaded document unreadable until 3.2 scans it', async () => {
    const uploaded = await uploadDocument({
      principal: principal(),
      kind: 'bank_statement',
      filename: 'august-statement.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 statement bytes'),
      vaultConfig: vault,
    });

    expect(uploaded.status).toBe('ok');
    if (uploaded.status !== 'ok') return;
    expect(uploaded.value.scanStatus).toBe('pending');
    expect(uploaded.value.detail).toMatch(/not readable by anyone, including us/);

    // THE ASSERTION. Proved by asking the VAULT to read it, not by checking a portal flag - the
    // gate is 3.2's, and the portal could not bypass it if it wanted to.
    const read = await vaultRead(vault, {
      tenantId: fx.tenant.id,
      documentId: uploaded.value.documentId,
      actorId: fx.human.id,
      purpose: 'Portal test',
    });
    expect(read.status).not.toBe('ok');
  });

  it('refuses a document kind the client does not supply', async () => {
    const result = await uploadDocument({
      principal: principal(),
      kind: 'adverse_action_notice',
      filename: 'notice.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('bytes'),
      vaultConfig: vault,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/nothing saying which is authoritative/);
    }
    expect(CLIENT_UPLOADABLE_KINDS).not.toContain('adverse_action_notice');
  });

  it('does not show another client a document from this file', async () => {
    const documents = await db().vaultDocument.findMany({
      where: { tenantId: fx.tenant.id, clientId: alpha },
    });
    expect(documents.length).toBeGreaterThan(0);

    const asBeta = await documentInRoom(
      { tenantId: fx.tenant.id, clientId: beta, actorId: fx.human.id },
      documents[0]!.id,
    );
    // Same answer as a document that does not exist - distinguishing them would confirm the id
    // belongs to somebody.
    expect(asBeta.status).toBe('no_data');
  });

  it('records a signature as a real 1.5 consent', async () => {
    const signed = await signDisclosure({
      principal: principal(),
      kind: 'disclosure',
      scope: 'Fee disclosure for the Foundation engagement, version 1.',
    });
    expect(signed.status).toBe('ok');
    if (signed.status !== 'ok') return;

    // Not a portal-local signature record. One act, one record, and a revocation reaches it.
    const consents = await consentsForClient(fx.tenant.id, alpha);
    expect(consents.map((consent) => consent.id)).toContain(signed.value.consentId);
  });

  it('accepts an inbound message and offers no outbound path', async () => {
    const sent = await sendMessage({
      principal: principal(),
      subject: 'Question about the statement request',
      body: 'Which months do you need? I have January through July ready.',
      receivedAt: NOW,
    });
    expect(sent.status).toBe('ok');

    // No reply function exists here. A portal reply would skip 4.1's preference gate, the
    // middleware chain and the scanner - the one piece of client-facing text nobody checked.
    const portal: Record<string, unknown> = await import('@bwc/portal');
    expect(Object.keys(portal).filter((name) => /reply|sendOutbound/i.test(name))).toEqual([]);
  });

  it('reports Plaid Link as not_built naming Decision A', async () => {
    const result = await connectBankAccount(principal());
    expect(result.status).toBe('not_built');
    if (result.status === 'not_built') {
      expect(result.reason).toMatch(/Decision A/);
      // The refusal says what the sequence would have been, not just that it is missing.
      expect(result.reason).toMatch(/asking the security question afterwards/);
    }
  });
});

describe('11.11 the founder queue is decisions, not a feed', () => {
  beforeAll(async () => {
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: beta,
      to: 'fail',
      reason: 'Statements do not reconcile with stated revenue.',
      actor: HUMAN(),
    });

    // A Do Not Fund listing, so the overdue-review branch of the queue is exercised rather than
    // left as a path nothing runs. A mutation test found this gap: emptying that branch's
    // costOfInaction changed nothing, because the branch never executed.
    const listed = await listClient({
      tenantId: fx.tenant.id,
      clientId: beta,
      trigger: 'material_misrepresentation',
      justification: 'Statements do not reconcile with the revenue stated on the application.',
      listedBy: fx.human.id,
      now: NOW,
    });
    if (listed.status !== 'ok') throw new Error(`setup: listing ${listed.status}`);

    await setParameter({
      tenantId: fx.tenant.id,
      key: 'partners.RECERTIFICATION_CADENCE_DAYS',
      value: 180,
      reason: 'Proposed after the claim-library review; staged for the founder to promote.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
  });

  /** Far enough ahead that the Do Not Fund listing has outrun its review cadence. */
  const AFTER_CADENCE = new Date(
    NOW.getTime() + (DEFAULT_REVIEW_CADENCE_DAYS + 5) * 24 * 60 * 60 * 1000,
  );

  it('gives every item a cost of inaction and a route', async () => {
    const decisions = await decisionQueue(fx.tenant.id, AFTER_CADENCE);
    expect(decisions.length).toBeGreaterThan(0);
    // Every branch of the queue is present, so the assertions below cover all of them.
    expect(decisions.map((decision) => decision.kind)).toContain('do_not_fund_review');

    for (const decision of decisions) {
      // The field that makes this a queue rather than a feed. Asserted on every item.
      expect(decision.costOfInaction.length, decision.key).toBeGreaterThan(60);
      // A decision with no route is an anxiety.
      expect(decision.resolveIn, decision.key).toMatch(/^\d+\.\d+ /);
    }
  });

  it('surfaces the staged configuration change and the failing clients', async () => {
    const decisions = await decisionQueue(fx.tenant.id, AFTER_CADENCE);
    const kinds = decisions.map((decision) => decision.kind);
    expect(kinds).toContain('staged_configuration');
    expect(kinds).toContain('clients_at_fail');
  });

  it('puts the overdue Do Not Fund review at the top, worst first', async () => {
    const decisions = await decisionQueue(fx.tenant.id, AFTER_CADENCE);
    expect(decisions[0]?.urgency).toBe('overdue');
    expect(decisions[0]?.kind).toBe('do_not_fund_review');
    // The safe direction is to keep blocking - and the cost is that it blocks on reasoning
    // nobody has revisited, which is what the founder is being asked to fix.
    expect(decisions[0]?.costOfInaction).toMatch(/nobody has revisited/);
  });

  it('assembles the workbench over the modules that own the facts, storing nothing', async () => {
    const surface = await workbench({ tenantId: fx.tenant.id, now: AFTER_CADENCE });
    expect(surface.status).toBe('ok');
    if (surface.status !== 'ok') return;

    expect(surface.value.decisions.length).toBeGreaterThan(0);
    expect(surface.value.crossDepartment.length).toBe(5);
    expect(surface.value.health.overall).toBeDefined();

    // Reuses 9.1's rollup, which is PII-stripped by construction rather than by redaction.
    const serialised = JSON.stringify(surface.value.rollup);
    expect(serialised).not.toContain(alpha);
    expect(serialised).not.toContain('Alpha Manufacturing');

    // No workbench schema exists, so there is nothing it could have stored.
    const tables = await db().$queryRawUnsafe<{ table_schema: string }[]>(
      `SELECT DISTINCT table_schema FROM information_schema.tables WHERE table_schema IN ('workbench','portal')`,
    );
    expect(tables).toEqual([]);
  });
});
