/**
 * 7.5 Legal Hold & Record Retention, end to end and against the vault it governs.
 *
 * Four properties carry this file, and the first one is the module's whole reason for existing.
 *
 * **A hold covers a document uploaded after the hold was placed.** The obvious build - set a
 * boolean on every document in scope - passes every test anybody would think to write and destroys
 * evidence in production, because nothing re-runs the propagation. The test at the top of
 * `describe('a hold is a matter')` is the one that distinguishes the two designs, and it is the
 * reason holds are evaluated rather than copied.
 *
 * **Absence of a hold means not held; absence of a schedule means not permitted.** The two
 * absences point in opposite directions and both are asserted, because getting one of them
 * backwards is silent in exactly the direction that matters.
 *
 * **An unverified schedule does not authorise destruction.** An assumption is a legitimate thing to
 * hold and it is not evidence for shredding a record.
 *
 * **A refused deletion request is a record.** "We received your request and did not act on it" is
 * the answer a regulator asks for, and a request quietly dropped produces no answer at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { read as readLedger } from '@bwc/ledger';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  generateKek,
  read as readDocument,
  recordScanResult,
  remove,
  setRetention,
  store,
  type VaultConfig,
} from '@bwc/vault';
import {
  VERIFICATION_STALE_AFTER_DAYS,
  activeHolds,
  assessEligibility,
  decideRequest,
  describeHolds,
  holdsCovering,
  holdsDueForReview,
  isHeld,
  placeHold,
  recordCompletion,
  recordReview,
  recordSchedule,
  releaseHold,
  requestDeletion,
  requestsFor,
  resolveRetention,
  schedules,
  undecidedRequests,
  unverifiedSchedules,
} from '@bwc/retention';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;
let otherClientId: string;
let root: string;
let config: VaultConfig;

const NOW = new Date('2026-08-11T00:00:00.000Z');
const CONTENT = Buffer.from('a statement, in bytes');

const human = () => ({ id: fx.human.id, kind: 'human' as const });

/** A citation somebody checked recently. The shape a real retention rule takes. */
const verified = (daysAgo = 30) => ({
  tag: 'issuer_rule' as const,
  sourceUrl: 'https://www.ecfr.gov/example-retention-rule',
  lastVerified: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  verifiedBy: 'Compliance counsel',
});

beforeAll(async () => {
  fx = await makeFixture('retention');
  clientId = (await createClient(fx.tenant.id, 'Held Co', human())).id;
  otherClientId = (await createClient(fx.tenant.id, 'Unheld Co', human())).id;

  root = await mkdtemp(join(tmpdir(), 'bwc-retention-'));
  process.env['VAULT_RETENTION_KEK'] = generateKek();
  config = {
    store: new LocalEncryptedStore(root),
    kek: new EnvKekProvider('VAULT_RETENTION_KEK'),
  };
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
  await rm(root, { recursive: true, force: true });
});

const storeClean = async (kind = 'bank_statement', owner = clientId) => {
  const stored = await store(config, {
    tenantId: fx.tenant.id,
    clientId: owner,
    kind: kind as never,
    filename: 'statement.pdf',
    contentType: 'application/pdf',
    content: CONTENT,
    actorId: fx.human.id,
  });
  if (stored.status !== 'ok') throw new Error(`store failed: ${stored.status}`);
  await recordScanResult(fx.tenant.id, stored.value.id, 'clean', fx.human.id);
  return stored.value;
};

const litigationHold = (overrides: Record<string, unknown> = {}) =>
  placeHold({
    tenantId: fx.tenant.id,
    kind: 'litigation',
    scope: 'client',
    clientId,
    matterReference: 'LIT-2026-014',
    reason: 'Complaint filed in the Northern District; all records preserved.',
    placedBy: fx.human.id,
    now: NOW,
    ...overrides,
  });

describe('a hold is a matter, not a flag on a document', () => {
  it('covers a document uploaded AFTER the hold was placed', async () => {
    // **The assertion this module exists for.**
    //
    // A design that propagated `legalHold = true` onto the documents in scope at placement time
    // passes every other test in this file and fails this one - silently, in production, on the
    // statement a client uploads the morning after a complaint is filed. That is the classic way
    // an organisation destroys evidence while believing it preserved it: the hold exists, the
    // document exists, and no row connects them.
    const placed = await litigationHold();
    expect(placed.status).toBe('ok');

    const uploadedAfterwards = await storeClean();
    await setRetention(fx.tenant.id, uploadedAfterwards.id, new Date('2020-01-01'));

    const removed = await remove({
      tenantId: fx.tenant.id,
      documentId: uploadedAfterwards.id,
      actorId: fx.human.id,
      now: NOW,
    });

    expect(removed.status).toBe('refused');
    if (removed.status === 'refused') {
      // Names the matter, because the operator's next action is to go and ask somebody about it.
      expect(removed.reason).toMatch(/LIT-2026-014/);
    }
  });

  it('locks export as well as deletion', async () => {
    const doc = await storeClean();
    const exported = await readDocument(config, {
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      action: 'export',
      now: NOW,
    });
    expect(exported.status).toBe('refused');
    if (exported.status === 'refused') expect(exported.reason).toMatch(/LIT-2026-014/);
  });

  it('does not reach a client it does not name', async () => {
    // A client-scoped hold that leaked onto every client would look like caution and would be a
    // hold nobody could release without releasing all the others.
    expect(
      await isHeld(
        { tenantId: fx.tenant.id, clientId: otherClientId, documentKind: 'bank_statement' },
        NOW,
      ),
    ).toBe(false);
  });

  it('stops covering once released, and the row survives', async () => {
    const holds = await holdsCovering(
      { tenantId: fx.tenant.id, clientId, documentKind: 'bank_statement' },
      NOW,
    );
    const hold = holds[0];
    if (hold === undefined) throw new Error('setup: no hold');

    const released = await releaseHold({
      tenantId: fx.tenant.id,
      holdId: hold.id,
      releasedBy: fx.human.id,
      reason: 'Matter concluded; counsel confirmed preservation may end.',
      now: NOW,
    });
    expect(released.status).toBe('ok');

    expect(
      await isHeld({ tenantId: fx.tenant.id, clientId, documentKind: 'bank_statement' }, NOW),
    ).toBe(false);

    // Which hold was in force when a document was destroyed is what a spoliation claim turns on.
    const all = await activeHolds(fx.tenant.id, NOW);
    expect(all.some((entry) => entry.id === hold.id)).toBe(false);
    if (released.status === 'ok') {
      expect(released.value.releasedAt).not.toBeNull();
      expect(released.value.releaseReason).toMatch(/counsel confirmed/);
    }
  });
});

describe('hold scope', () => {
  it('refuses a client-scoped hold with no client', async () => {
    // Without the check this falls through to the tenant-wide branch of `holdsCovering` and holds
    // every client in the tenant, silently.
    const result = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'complaint',
      scope: 'client',
      matterReference: 'CMP-1',
      reason: 'A complaint that names one client.',
      placedBy: fx.human.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/hold every client silently/);
  });

  it('refuses a tenant-scoped hold that carries a client', async () => {
    const result = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'regulator_request',
      scope: 'tenant',
      clientId,
      matterReference: 'REG-1',
      reason: 'A regulator asking for everything.',
      placedBy: fx.human.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/narrower in a listing/);
  });

  it('holds a whole document kind across clients', async () => {
    const placed = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'regulator_request',
      scope: 'document_kind',
      documentKind: 'tax_return',
      matterReference: 'REG-2026-002',
      reason: 'Examiner requested every tax return on file.',
      placedBy: fx.human.id,
      now: NOW,
    });
    if (placed.status !== 'ok') throw new Error(`setup: ${placed.status}`);

    expect(
      await isHeld(
        { tenantId: fx.tenant.id, clientId: otherClientId, documentKind: 'tax_return' },
        NOW,
      ),
    ).toBe(true);
    expect(
      await isHeld(
        { tenantId: fx.tenant.id, clientId: otherClientId, documentKind: 'credit_report' },
        NOW,
      ),
    ).toBe(false);

    await releaseHold({
      tenantId: fx.tenant.id,
      holdId: placed.value.id,
      releasedBy: fx.human.id,
      reason: 'Examination closed and the request was satisfied.',
      now: NOW,
    });
  });

  it('refuses an agent placing or releasing a hold', async () => {
    const result = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'litigation',
      scope: 'tenant',
      matterReference: 'LIT-X',
      reason: 'An agent decided this on its own.',
      placedBy: fx.agent.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/requires a human/);
  });

  it('refuses a hold with no matter reference', async () => {
    const result = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'litigation',
      scope: 'tenant',
      matterReference: '   ',
      reason: 'Something happened and we should keep everything.',
      placedBy: fx.human.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/matter reference/);
  });
});

describe('an overdue review keeps holding', () => {
  it('flags the hold and does not narrow what it covers', async () => {
    // ADR-0013 applied to a third cadenced record. 5.4 makes a stale provider approval STOP being
    // usable; 6.4 makes a stale Do Not Fund listing KEEP blocking. This is 6.4's direction, and for
    // the same reason: nothing is preserved by a hold lapsing in silence, and the thing on the
    // other side of the decision is destroyed records.
    const placed = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'complaint',
      scope: 'client',
      clientId: otherClientId,
      matterReference: 'CMP-2026-009',
      reason: 'Client complaint under investigation by the concierge desk.',
      placedBy: fx.human.id,
      reviewCadenceDays: 30,
      now: NOW,
    });
    if (placed.status !== 'ok') throw new Error(`setup: ${placed.status}`);

    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);

    const covering = await holdsCovering(
      { tenantId: fx.tenant.id, clientId: otherClientId, documentKind: 'bank_statement' },
      later,
    );
    expect(covering).toHaveLength(1);
    expect(covering[0]?.reviewOverdue).toBe(true);

    // Still holding, and the refusal says the review is overdue so somebody knows to act.
    expect(describeHolds(covering)).toMatch(/review overdue/);

    const due = await holdsDueForReview(fx.tenant.id, later);
    expect(due.map((entry) => entry.id)).toEqual([placed.value.id]);

    // A review restarts the cadence and changes nothing else.
    const reviewed = await recordReview({
      tenantId: fx.tenant.id,
      holdId: placed.value.id,
      reviewedBy: fx.human.id,
      notes: 'Still open with counsel.',
      now: later,
    });
    expect(reviewed.status).toBe('ok');
    if (reviewed.status === 'ok') expect(reviewed.value.reviewOverdue).toBe(false);
    expect(await holdsDueForReview(fx.tenant.id, later)).toEqual([]);

    await releaseHold({
      tenantId: fx.tenant.id,
      holdId: placed.value.id,
      releasedBy: fx.human.id,
      reason: 'Complaint resolved and closed by the concierge desk.',
      now: later,
    });
  });
});

describe('a schedule is an authorisation, so its absence blocks', () => {
  it('resolves nothing rather than assuming a period', async () => {
    // A fallback invented here would be indistinguishable from a researched one at the moment
    // somebody destroys a record.
    const result = await resolveRetention({
      tenantId: fx.tenant.id,
      documentKind: 'entity_document',
      documentDate: new Date('2020-01-01T00:00:00.000Z'),
      now: NOW,
    });
    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') expect(result.reason).toMatch(/indistinguishable/);
  });

  it('lets a state rule beat the default, including when it is shorter', async () => {
    // Deliberately NOT "longest wins". A state period shorter than the default is still the rule
    // that applies there, and picking the longer one would look conservative while being wrong
    // about the law.
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'signed_authorization',
      retainMonths: 84,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'signed_authorization',
      stateCode: 'TX',
      retainMonths: 24,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });

    const federal = await resolveRetention({
      tenantId: fx.tenant.id,
      documentKind: 'signed_authorization',
      documentDate: new Date('2024-01-15T00:00:00.000Z'),
      now: NOW,
    });
    const texan = await resolveRetention({
      tenantId: fx.tenant.id,
      documentKind: 'signed_authorization',
      stateCode: 'TX',
      documentDate: new Date('2024-01-15T00:00:00.000Z'),
      now: NOW,
    });

    if (federal.status !== 'ok' || texan.status !== 'ok') throw new Error('resolve failed');
    expect(federal.value.retainMonths).toBe(84);
    expect(federal.value.appliedStateCode).toBeNull();
    expect(texan.value.retainMonths).toBe(24);
    expect(texan.value.appliedStateCode).toBe('TX');
    // Retention runs from the record, not from today.
    expect(texan.value.retainUntil.slice(0, 10)).toBe('2026-01-15');
  });

  it('refuses a period with no provenance a lawyer would accept', async () => {
    const result = await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'credit_report',
      retainMonths: 12,
      provenance: {
        tag: 'vendor_feed',
        vendor: 'personal_credit',
        retrievedAt: NOW.toISOString(),
        consentReference: 'c-1',
      },
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/not sources of law/);
  });

  it('refuses a malformed state code rather than silently applying the default', async () => {
    const result = await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'credit_report',
      stateCode: 'Texas',
      retainMonths: 12,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/two-letter state code/);
  });

  it('supersedes rather than overwrites, so an audit can read what applied then', async () => {
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'debt_schedule',
      retainMonths: 36,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'debt_schedule',
      retainMonths: 60,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: new Date(NOW.getTime() + 1000),
    });

    const live = await schedules(fx.tenant.id);
    const forKind = live.filter((entry) => entry.documentKind === 'debt_schedule');
    expect(forKind).toHaveLength(1);
    expect(forKind[0]?.retainMonths).toBe(60);
  });
});

describe('an unverified schedule does not authorise destruction', () => {
  it('refuses deletion on an assumption, and says it is one', async () => {
    const doc = await storeClean('profit_and_loss', otherClientId);
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'profit_and_loss',
      retainMonths: 1,
      provenance: {
        tag: 'unresearched_default',
        rationale: 'Assumed from the general business-records period; nobody has checked.',
      },
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });

    const later = new Date('2027-08-11T00:00:00.000Z');
    const removed = await remove({
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      now: later,
    });

    expect(removed.status).toBe('refused');
    if (removed.status === 'refused') {
      expect(removed.reason).toMatch(/not verified/);
      expect(removed.reason).toMatch(/not evidence for destroying a record/);
    }
  });

  it('treats a citation nobody has checked in a year as unverified', async () => {
    const stale = await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'balance_sheet',
      retainMonths: 12,
      provenance: verified(VERIFICATION_STALE_AFTER_DAYS + 1),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });
    expect(stale.status).toBe('ok');

    const resolved = await resolveRetention({
      tenantId: fx.tenant.id,
      documentKind: 'balance_sheet',
      documentDate: new Date('2020-01-01T00:00:00.000Z'),
      now: NOW,
    });
    if (resolved.status !== 'ok') throw new Error('resolve failed');
    expect(resolved.value.unverified).toBe(true);
    expect(resolved.value.note).toMatch(/not current evidence/);

    const queue = await unverifiedSchedules(fx.tenant.id, NOW);
    expect(queue.map((entry) => entry.documentKind)).toContain('balance_sheet');
  });

  it('permits deletion on a verified schedule whose period has run', async () => {
    // The counterpart every refusal suite needs: a module that refused everything would pass all
    // of the tests above and none of the ones that matter.
    //
    // Note the two clocks, because the first draft of this test got them confused and failed
    // honestly. `retainMonths` runs from the DOCUMENT's date; the verification window runs from
    // when somebody last checked the CITATION. Deleting a year after storage would have found a
    // citation gone stale in the meantime and refused - correctly. That interaction is real and
    // deliberate: a schedule nobody has re-checked stops authorising destruction even for
    // documents whose period has run. See ADR-0042.
    const doc = await storeClean('lender_application', otherClientId);
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'lender_application',
      retainMonths: 1,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });

    const twoMonthsOn = new Date('2026-10-11T00:00:00.000Z');
    const removed = await remove({
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      now: twoMonthsOn,
    });
    expect(removed.status).toBe('ok');
  });

  it('refuses once the citation goes stale, even though the period has run', async () => {
    // The interaction the test above steps around, asserted directly rather than left implicit.
    // A retention period that elapsed is a necessary condition for destruction and not a
    // sufficient one: the rule authorising it has to be one somebody still stands behind.
    const doc = await storeClean('adverse_action_notice', otherClientId);
    await recordSchedule({
      tenantId: fx.tenant.id,
      documentKind: 'adverse_action_notice',
      retainMonths: 1,
      provenance: verified(),
      recordedBy: fx.human.id,
      actor: human(),
      now: NOW,
    });

    const aYearOn = new Date('2027-08-11T00:00:00.000Z');
    const removed = await remove({
      tenantId: fx.tenant.id,
      documentId: doc.id,
      actorId: fx.human.id,
      now: aYearOn,
    });

    expect(removed.status).toBe('refused');
    if (removed.status === 'refused') expect(removed.reason).toMatch(/not verified/);
  });
});

describe('client deletion requests', () => {
  it('records a request that will be refused, and refuses it in writing', async () => {
    const hold = await placeHold({
      tenantId: fx.tenant.id,
      kind: 'litigation',
      scope: 'client',
      clientId,
      matterReference: 'LIT-2026-088',
      reason: 'Litigation reopened; all records preserved again.',
      placedBy: fx.human.id,
      now: NOW,
    });
    if (hold.status !== 'ok') throw new Error(`setup: ${hold.status}`);

    const requested = await requestDeletion({
      tenantId: fx.tenant.id,
      clientId,
      requestedBy: fx.human.id,
      requestDetail: 'Client asked by phone for their whole file to be deleted.',
      requestedAt: NOW,
      actor: human(),
    });
    expect(requested.status).toBe('ok');
    if (requested.status !== 'ok') return;

    // Never refused at intake. A request rejected on the doorstep leaves no evidence it was made,
    // which is the one thing a data-subject-rights regime asks you to be able to show.
    expect(requested.value.status).toBe('received');
    expect((await undecidedRequests(fx.tenant.id)).map((r) => r.id)).toContain(requested.value.id);

    const eligibility = await assessEligibility(fx.tenant.id, clientId, NOW);
    expect(eligibility.deletable).toBe(false);
    expect(eligibility.heldBy).toMatch(/LIT-2026-088/);

    // A hold outranks an approval, including one a Level 3 human has decided to grant.
    const approvedAnyway = await decideRequest({
      tenantId: fx.tenant.id,
      requestId: requested.value.id,
      approve: true,
      decidedBy: fx.human.id,
      reason: 'The client asked and I would like to say yes.',
      now: NOW,
    });
    expect(approvedAnyway.status).toBe('refused');

    const refusedProperly = await decideRequest({
      tenantId: fx.tenant.id,
      requestId: requested.value.id,
      approve: false,
      decidedBy: fx.human.id,
      reason: 'Records are preserved under litigation hold LIT-2026-088.',
      now: NOW,
    });
    expect(refusedProperly.status).toBe('ok');

    const history = await requestsFor(fx.tenant.id, clientId);
    expect(history[0]?.status).toBe('refused');
    expect(history[0]?.decisionReason).toMatch(/LIT-2026-088/);

    await releaseHold({
      tenantId: fx.tenant.id,
      holdId: hold.value.id,
      releasedBy: fx.human.id,
      reason: 'Litigation concluded a second time; counsel released the hold.',
      now: NOW,
    });
  });

  it('approves and completes with a count, and zero is a real answer', async () => {
    const requested = await requestDeletion({
      tenantId: fx.tenant.id,
      clientId,
      requestDetail: 'Client wrote in asking for deletion of everything we hold.',
      requestedBy: fx.human.id,
      requestedAt: NOW,
      actor: human(),
    });
    if (requested.status !== 'ok') throw new Error('setup: request');

    const decided = await decideRequest({
      tenantId: fx.tenant.id,
      requestId: requested.value.id,
      approve: true,
      decidedBy: fx.human.id,
      reason: 'No hold covers this client; each document remains subject to its own schedule.',
      now: NOW,
    });
    expect(decided.status).toBe('ok');

    // Zero is legitimate and reportable: every document was still inside its retention period,
    // which the client is entitled to be told.
    const completed = await recordCompletion({
      tenantId: fx.tenant.id,
      requestId: requested.value.id,
      documentsDeleted: 0,
      actor: human(),
      now: NOW,
    });
    expect(completed.status).toBe('ok');
    if (completed.status === 'ok') {
      expect(completed.value.status).toBe('completed');
      expect(completed.value.documentsDeleted).toBe(0);
    }
  });

  it('refuses a deletion decision by an agent', async () => {
    const requested = await requestDeletion({
      tenantId: fx.tenant.id,
      clientId: otherClientId,
      requestDetail: 'A request recorded for the authority test.',
      requestedBy: fx.human.id,
      requestedAt: NOW,
      actor: human(),
    });
    if (requested.status !== 'ok') throw new Error('setup: request');

    const result = await decideRequest({
      tenantId: fx.tenant.id,
      requestId: requested.value.id,
      approve: false,
      decidedBy: fx.agent.id,
      reason: 'An agent deciding what happens to a client file.',
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/requires a human/);
  });
});

describe('the Ledger', () => {
  it('records holds and deletion decisions without the free text about a person', async () => {
    // A hold's reason and a client's request are both free text about a named person, and the
    // Ledger is the one store here that cannot be corrected. They stay in their rows.
    const events = await readLedger(fx.tenant.id);
    const mine = events.filter((event) => event.type.startsWith('retention.'));

    expect(mine.some((event) => event.type === 'retention.hold.placed')).toBe(true);
    expect(mine.some((event) => event.type === 'retention.hold.released')).toBe(true);
    expect(mine.some((event) => event.type === 'retention.deletion.refused')).toBe(true);
    expect(mine.some((event) => event.type === 'retention.schedule.recorded')).toBe(true);

    for (const event of mine) {
      const payload = JSON.stringify(event.payload);
      expect(payload).not.toMatch(/Northern District/);
      expect(payload).not.toMatch(/asked by phone/);
    }
  });
});
