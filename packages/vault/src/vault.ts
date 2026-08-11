/**
 * @bwc/vault - 3.2 Secure Document Vault.
 *
 * Holds the most sensitive data class in the portfolio: bank statements, tax returns, government
 * IDs, credit reports, debt schedules, signed authorizations. Specification §10.5 makes "zero
 * data breaches" and "zero cross-tenant data leaks" success criteria.
 *
 * Everything built before this protected *decisions*, which can be corrected. This protects
 * *documents*, and a leaked tax return cannot be.
 *
 * Reads pass four gates, all required: tenant (principle 5), Authority Level (principle 4), virus
 * scan, and legal hold. The access is logged **before** the bytes are returned - if the log write
 * fails the caller gets nothing, because an access nobody recorded did not happen as far as an
 * audit is concerned.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { assertSameTenant } from '@bwc/tenancy';
import { failed, noData, ok, refused, type AuthorityLevel, type Outcome } from '@bwc/core';
import { decrypt, encrypt, sha256, type KekProvider } from '@bwc/crypto';
// 7.5. The direction is wrong on a layer diagram - 3.2 is storage and 7.5 is governance - and it is
// taken knowingly, for the reason ADR-0034 took the same import in the other pair: a hold that the
// gate does not consult is not a hold. `@bwc/retention` imports core, db, identity and ledger, and
// none of them reaches back, so there is no cycle.
import { describeHolds, holdsCovering, resolveRetention } from '@bwc/retention';
import { newBlobKey, type BlobStore } from './store.js';
import { watermarkPdf, type WatermarkResult } from './watermark.js';

export type DocumentKind =
  | 'bank_statement'
  | 'tax_return'
  | 'government_id'
  | 'entity_document'
  | 'credit_report'
  | 'profit_and_loss'
  | 'balance_sheet'
  | 'debt_schedule'
  | 'lender_application'
  | 'signed_authorization'
  | 'adverse_action_notice'
  | 'other';

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'scan_unavailable';

/**
 * Minimum Authority Level to read each kind.
 *
 * Government IDs, tax returns and credit reports sit above the rest: they are the documents whose
 * disclosure is least recoverable, and least often actually needed by an agent doing analytical
 * work. Least privilege (§6.2) applied per document class rather than as a blanket setting.
 */
export const MINIMUM_LEVEL_TO_READ: Record<DocumentKind, AuthorityLevel> = {
  bank_statement: 0,
  profit_and_loss: 0,
  balance_sheet: 0,
  debt_schedule: 0,
  entity_document: 0,
  lender_application: 1,
  adverse_action_notice: 1,
  signed_authorization: 1,
  other: 1,
  credit_report: 2,
  tax_return: 2,
  government_id: 3,
};

export interface VaultConfig {
  readonly store: BlobStore;
  readonly kek: KekProvider;
}

export interface VaultDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: DocumentKind;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly scanStatus: ScanStatus;
  readonly legalHold: boolean;
  readonly retainUntil: Date | null;
  readonly deletedAt: Date | null;
}

interface DocumentRow {
  id: string;
  tenantId: string;
  clientId: string;
  kind: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  scanStatus: string;
  legalHold: boolean;
  retainUntil: Date | null;
  deletedAt: Date | null;
}

/**
 * Exported so the client-access path maps rows the same way rather than keeping a second copy.
 * Two mappings of one row is how a field ends up present on one surface and absent on the other.
 */
export const toDocument = (row: DocumentRow): VaultDocument => ({
  id: row.id,
  tenantId: row.tenantId,
  clientId: row.clientId,
  kind: row.kind as DocumentKind,
  filename: row.filename,
  contentType: row.contentType,
  byteSize: row.byteSize,
  sha256: row.sha256,
  scanStatus: row.scanStatus as ScanStatus,
  legalHold: row.legalHold,
  retainUntil: row.retainUntil,
  deletedAt: row.deletedAt,
});

// --- Upload ---------------------------------------------------------------

export interface StoreInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: DocumentKind;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
  readonly actorId: string;
  readonly now?: Date;
}

/**
 * Store a document.
 *
 * Encrypt first, then write. The store receives ciphertext and nothing else, so a bug in the
 * store cannot spill plaintext - the guarantee does not depend on the store being correct.
 *
 * The document lands `pending` scan status and is therefore **unreadable** until scanned. Blueprint
 * 3.2 requires virus scanning on upload; no engine is wired, so the honest position is that
 * nothing has been scanned yet, not that everything is clean.
 */
export const store = async (
  config: VaultConfig,
  input: StoreInput,
): Promise<Outcome<VaultDocument>> => {
  const actor = await findActor(input.actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1 - authentication');

  const scope = assertSameTenant(actor.tenantId, input.tenantId);
  if (scope.status !== 'ok') return scope as Outcome<VaultDocument>;

  if (input.content.length === 0) {
    return refused('Refusing to store an empty document.', 'Blueprint 3.2 - input validation');
  }

  const payload = await encrypt(input.content, config.kek);
  const blobKey = newBlobKey(input.tenantId);
  await config.store.put(blobKey, payload.ciphertext);

  const row = await db().vaultDocument.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.content.length,
      sha256: payload.sha256,
      blobKey,
      wrappedDek: payload.wrappedDek,
      iv: payload.iv,
      authTag: payload.authTag,
      uploadedBy: actor.id,
      ...(input.now !== undefined ? { createdAt: input.now } : {}),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'vault.document_stored',
    actor: { id: actor.id, kind: actor.kind },
    clientId: input.clientId,
    payload: {
      documentId: row.id,
      kind: input.kind,
      byteSize: input.content.length,
      // The filename is client-supplied and may name a person. The digest identifies the
      // document without describing it.
      sha256: payload.sha256,
    },
  });

  return ok(toDocument(row));
};

/**
 * Record a virus-scan result.
 *
 * The scanner itself is not built - blueprint 3.2 requires one and no engine is available here.
 * This is the seam it reports through, and `scan_unavailable` is a distinct status from `clean`
 * so "we could not check" never reads as "we checked and it was fine".
 */
export const recordScanResult = async (
  tenantId: string,
  documentId: string,
  status: Exclude<ScanStatus, 'pending'>,
  actorId: string,
  detail?: string,
  now: Date = new Date(),
): Promise<Outcome<VaultDocument>> => {
  const actor = await findActor(actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1');

  const existing = await db().vaultDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!existing) return noData('No such document in this tenant.');

  const row = await db().vaultDocument.update({
    where: { id: documentId },
    data: { scanStatus: status, scannedAt: now, scanDetail: detail ?? null },
  });

  await append({
    tenantId,
    type: 'vault.scan_completed',
    actor: { id: actor.id, kind: actor.kind },
    clientId: existing.clientId,
    payload: { documentId, status, ...(detail !== undefined ? { detail } : {}) },
  });

  return ok(toDocument(row));
};

// --- Access ---------------------------------------------------------------

export type AccessAction = 'view' | 'export' | 'delete';

const logAccess = async (
  documentId: string,
  tenantId: string,
  clientId: string | null,
  actor: { id: string; kind: string },
  action: AccessAction,
  granted: boolean,
  reason?: string,
  watermarked = false,
): Promise<void> => {
  await db().vaultAccessLog.create({
    data: {
      documentId,
      tenantId,
      actorId: actor.id,
      actorKind: actor.kind,
      action,
      granted,
      reason: reason ?? null,
      watermarked,
    },
  });

  await append({
    tenantId,
    type: granted ? 'vault.document_accessed' : 'vault.access_refused',
    actor: { id: actor.id, kind: actor.kind as 'village_agent' | 'human' | 'client' },
    ...(clientId !== null ? { clientId } : {}),
    payload: {
      documentId,
      action,
      granted,
      ...(reason !== undefined ? { reason } : {}),
      watermarked,
    },
  });
};

export interface ReadResult {
  readonly document: VaultDocument;
  readonly content: Buffer;
  readonly watermarked: boolean;
}

export interface ReadInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly actorId: string;
  readonly action?: AccessAction;
  readonly now?: Date;
}

/**
 * Read a document, subject to every gate.
 *
 * The gates run in a fixed order and each refusal is logged, including the refusals. A pattern of
 * denied cross-tenant attempts is exactly the signal an audit wants, and it exists only if the
 * failures are recorded as carefully as the successes.
 */
export const read = async (config: VaultConfig, input: ReadInput): Promise<Outcome<ReadResult>> => {
  const action = input.action ?? 'view';
  const now = input.now ?? new Date();

  const actor = await findActor(input.actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1 - authentication');

  const row = await db().vaultDocument.findUnique({ where: { id: input.documentId } });
  if (!row || row.deletedAt !== null) return noData('No such document.');

  const actorRef = { id: actor.id, kind: actor.kind };

  // 1. Tenant. Checked against the DOCUMENT's tenant, not the caller's claim about it.
  if (row.tenantId !== actor.tenantId || row.tenantId !== input.tenantId) {
    await logAccess(row.id, row.tenantId, row.clientId, actorRef, action, false, 'cross_tenant');
    return refused(
      'Document belongs to another tenant.',
      'Principle 5 - multi-tenant isolation is strict',
    );
  }

  // 2. Authority Level, by document class.
  const required = MINIMUM_LEVEL_TO_READ[row.kind as DocumentKind];
  if (actor.authorityLevel < required) {
    await logAccess(row.id, row.tenantId, row.clientId, actorRef, action, false, 'below_level');
    return refused(
      `Reading a ${row.kind} requires Authority Level ${required}; actor holds ${actor.authorityLevel}.`,
      'Principle 4 - least privilege by document class (§6.2)',
    );
  }

  // 3. Virus scan. `pending` and `scan_unavailable` both block: neither means clean.
  if (row.scanStatus !== 'clean') {
    await logAccess(
      row.id,
      row.tenantId,
      row.clientId,
      actorRef,
      action,
      false,
      `scan_${row.scanStatus}`,
    );
    return refused(
      row.scanStatus === 'infected'
        ? 'Document failed virus scanning and cannot be read.'
        : `Document has not been confirmed clean (scan status: ${row.scanStatus}). Blueprint 3.2 requires virus scanning on upload.`,
      'Blueprint 3.2 - an unscanned document is not a clean document',
    );
  }

  // 4. Legal hold blocks export specifically. Viewing during litigation is normal; taking a copy
  //    out of the system is what a hold exists to prevent.
  //
  //    TWO SOURCES, and the second one is the point of 7.5. `row.legalHold` is this document's own
  //    flag, set by `setLegalHold` on one document at a time. `holdsCovering` is the matter-level
  //    hold, which covers a category of record - so a statement uploaded the morning after a
  //    litigation hold was placed is held without anybody having touched its row. The flag alone
  //    would miss it, silently, which is how evidence gets destroyed by an organisation that
  //    believes it preserved it. See ADR-0042.
  if (action === 'export') {
    const matterHolds = await holdsCovering(
      { tenantId: row.tenantId, clientId: row.clientId, documentKind: row.kind },
      now,
    );
    const held = describeHolds(matterHolds);

    if (row.legalHold || held !== null) {
      await logAccess(row.id, row.tenantId, row.clientId, actorRef, action, false, 'legal_hold');
      const because =
        held !== null ? held : (row.legalHoldReason ?? 'a hold recorded against this document');
      return refused(
        `Document is under legal hold: ${because}. Export is locked out.`,
        'Blueprint 3.2 with 7.5 - legal hold with export lockout',
      );
    }
  }

  let plaintext: Buffer;
  try {
    const ciphertext = await config.store.get(row.blobKey);
    plaintext = await decrypt(
      ciphertext,
      { wrappedDek: row.wrappedDek, iv: row.iv, authTag: row.authTag },
      row.sha256,
      config.kek,
    );
  } catch (error) {
    await logAccess(row.id, row.tenantId, row.clientId, actorRef, action, false, 'decrypt_failed');
    return failed(
      'Could not decrypt the stored document.',
      error instanceof Error ? error.message : String(error),
    );
  }

  let content = plaintext;
  let watermark: WatermarkResult = { watermarked: false, content: plaintext };

  if (action === 'export') {
    // §6.2: every document exported is watermarked with viewer identity and timestamp. A
    // watermark that is only a log line would be a watermark in name.
    watermark = await watermarkPdf(plaintext, {
      viewer: `${actor.label} (${actor.id})`,
      at: now,
      documentId: row.id,
      contentType: row.contentType,
    });
    content = watermark.content;
  }

  // Logged before the bytes are handed over. If this throws, the caller gets nothing.
  await logAccess(
    row.id,
    row.tenantId,
    row.clientId,
    actorRef,
    action,
    true,
    undefined,
    watermark.watermarked,
  );

  if (action === 'export') {
    await append({
      tenantId: row.tenantId,
      type: 'vault.document_exported',
      actor: { id: actor.id, kind: actor.kind },
      clientId: row.clientId,
      payload: { documentId: row.id, watermarked: watermark.watermarked },
    });
  }

  return ok({
    document: toDocument(row),
    content,
    watermarked: watermark.watermarked,
  });
};

// --- Legal hold and retention ---------------------------------------------

export const setLegalHold = async (
  tenantId: string,
  documentId: string,
  reason: string,
  actorId: string,
  now: Date = new Date(),
): Promise<Outcome<VaultDocument>> => {
  const actor = await findActor(actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1');
  if (actor.kind !== 'human') {
    return refused(
      'Only a human actor may place or release a legal hold.',
      'Blueprint 3.2 - legal hold is a governance act, not an automated one',
    );
  }
  if (reason.trim() === '') {
    return refused('A legal hold requires a stated reason.', 'Blueprint 3.2');
  }

  const existing = await db().vaultDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!existing) return noData('No such document in this tenant.');

  const row = await db().vaultDocument.update({
    where: { id: documentId },
    data: { legalHold: true, legalHoldReason: reason, legalHoldSetAt: now },
  });

  await append({
    tenantId,
    type: 'vault.legal_hold_set',
    actor: { id: actor.id, kind: actor.kind },
    clientId: existing.clientId,
    payload: { documentId, reason },
  });

  return ok(toDocument(row));
};

export const releaseLegalHold = async (
  tenantId: string,
  documentId: string,
  actorId: string,
): Promise<Outcome<VaultDocument>> => {
  const actor = await findActor(actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1');
  if (actor.kind !== 'human') {
    return refused(
      'Only a human actor may place or release a legal hold.',
      'Blueprint 3.2 - legal hold is a governance act',
    );
  }

  const existing = await db().vaultDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!existing) return noData('No such document in this tenant.');

  const row = await db().vaultDocument.update({
    where: { id: documentId },
    data: { legalHold: false, legalHoldReason: null, legalHoldSetAt: null },
  });

  await append({
    tenantId,
    type: 'vault.legal_hold_released',
    actor: { id: actor.id, kind: actor.kind },
    clientId: existing.clientId,
    payload: { documentId },
  });

  return ok(toDocument(row));
};

export const setRetention = async (
  tenantId: string,
  documentId: string,
  retainUntil: Date,
): Promise<Outcome<VaultDocument>> => {
  const existing = await db().vaultDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!existing) return noData('No such document in this tenant.');

  const row = await db().vaultDocument.update({
    where: { id: documentId },
    data: { retainUntil },
  });
  return ok(toDocument(row));
};

export interface RemoveInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly actorId: string;
  /**
   * The client's state, where it is known.
   *
   * Passed in rather than looked up, because 7.2's activation model and 1.1's client record
   * disagree about which state a client "is in" often enough that guessing here would silently
   * apply the wrong statute to a destruction. The caller that knows says so; a caller that does not
   * omits it and gets the default schedule, which is the conservative one.
   */
  readonly stateCode?: string;
  readonly now?: Date;
}

/**
 * Delete a document.
 *
 * Three gates, and they run in this order because that is the order of irreversibility.
 *
 *  1. **A hold, from either source.** `row.legalHold` is this document's own flag. `holdsCovering`
 *     is 7.5's matter-level hold, which covers a category of record rather than a row - so a
 *     document uploaded after a litigation hold was placed is held without anybody having touched
 *     it. Checking only the flag is how an organisation destroys evidence while believing it
 *     preserved it. See ADR-0042.
 *
 *  2. **A resolved retention period.** `retainUntil` on the row if somebody set one; otherwise
 *     7.5's schedule for this document kind and state, resolved now. **This used to return
 *     `not_built`, and that answer was correct until this commit** - 7.5 did not exist, and saying
 *     so was more honest than inventing a period. It exists now, so the refusal changes reason
 *     rather than disappearing: with no schedule recorded, this returns `no_data` naming the kind
 *     that needs one. `empty` is never `not_built`, and a module that exists must stop claiming it
 *     does not.
 *
 *  3. **The period must have run.** Unchanged.
 *
 * An unverified schedule - an assumption, or a citation nobody has checked in a year - does not
 * authorise destruction. ADR-0013's question is "if this record is stale and wrong, which way is
 * safe", and for the one irreversible operation in this system the answer is not "destroy it
 * anyway".
 */
export const remove = async (input: RemoveInput): Promise<Outcome<VaultDocument>> => {
  const { tenantId, documentId, actorId } = input;
  const now = input.now ?? new Date();

  const actor = await findActor(actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1');

  const row = await db().vaultDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!row || row.deletedAt !== null) return noData('No such document in this tenant.');

  const matterHolds = await holdsCovering(
    { tenantId, clientId: row.clientId, documentKind: row.kind },
    now,
  );
  const held = describeHolds(matterHolds);

  if (row.legalHold || held !== null) {
    await logAccess(
      row.id,
      tenantId,
      row.clientId,
      { id: actor.id, kind: actor.kind },
      'delete',
      false,
      'legal_hold',
    );
    return refused(
      `Document is under legal hold: ${held ?? row.legalHoldReason ?? 'a hold recorded against this document'}.`,
      'Blueprint 3.2 with 7.5 - legal hold overrides retention',
    );
  }

  let retainUntil = row.retainUntil;
  let basis = 'a retention date recorded against this document';

  if (retainUntil === null) {
    const resolved = await resolveRetention({
      tenantId,
      documentKind: row.kind,
      ...(input.stateCode !== undefined ? { stateCode: input.stateCode } : {}),
      documentDate: row.createdAt,
      now,
    });
    if (resolved.status !== 'ok') return resolved;

    if (resolved.value.unverified) {
      return refused(
        `The retention schedule for ${row.kind} is not verified: ${resolved.value.note} An assumption is a legitimate thing to hold and it is not evidence for destroying a record.`,
        'Design principle 8 with ADR-0013 - staleness moves toward the safe answer',
      );
    }

    retainUntil = new Date(resolved.value.retainUntil);
    basis = resolved.value.note;
  }

  if (retainUntil > now) {
    return refused(
      `Document must be retained until ${retainUntil.toISOString().slice(0, 10)}: ${basis}`,
      'Blueprint 3.2 with 7.5 - retention schedule',
    );
  }

  const updated = await db().vaultDocument.update({
    where: { id: documentId },
    data: { deletedAt: now },
  });

  await append({
    tenantId,
    type: 'vault.document_deleted',
    actor: { id: actor.id, kind: actor.kind },
    clientId: row.clientId,
    payload: { documentId, retainedUntil: retainUntil.toISOString(), basis },
  });

  return ok(toDocument(updated));
};

// --- Queries --------------------------------------------------------------

export const forClient = async (tenantId: string, clientId: string): Promise<VaultDocument[]> => {
  const rows = await db().vaultDocument.findMany({
    where: { tenantId, clientId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toDocument);
};

export interface AccessLogEntry {
  readonly actorId: string;
  readonly action: string;
  readonly granted: boolean;
  readonly reason: string | null;
  readonly watermarked: boolean;
  readonly at: Date;
}

export const accessLog = async (
  tenantId: string,
  documentId: string,
): Promise<AccessLogEntry[]> => {
  const rows = await db().vaultAccessLog.findMany({
    where: { tenantId, documentId },
    // One request writes several entries - a refusal, then a retry, then a read - and they share a
    // millisecond routinely. "Refused, then admitted" and "admitted, then refused" are different
    // findings, so the order here is evidence and `seq` is what makes it one (ADR-0040).
    orderBy: [{ at: 'asc' }, { seq: 'asc' }],
  });
  return rows.map((row) => ({
    actorId: row.actorId,
    action: row.action,
    granted: row.granted,
    reason: row.reason,
    watermarked: row.watermarked,
    at: row.at,
  }));
};

export { sha256 };
