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
  if (row.legalHold && action === 'export') {
    await logAccess(row.id, row.tenantId, row.clientId, actorRef, action, false, 'legal_hold');
    return refused(
      `Document is under legal hold${row.legalHoldReason ? `: ${row.legalHoldReason}` : ''}. Export is locked out.`,
      'Blueprint 3.2 - legal hold with export lockout',
    );
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

/**
 * Delete a document.
 *
 * Refuses under legal hold, and refuses when no retention schedule has been resolved. The second
 * is the less obvious one and the more important: the per-state retention rules come from the
 * Regulatory Engine (7.2) and Legal Hold & Record Retention (7.5), neither of which exists. With
 * no schedule, the safe default is to keep - §6.2 calls over-retention a liability, but deleting a
 * document a regulator was entitled to see is the worse of the two failures, and the only
 * irreversible one.
 */
export const remove = async (
  tenantId: string,
  documentId: string,
  actorId: string,
  now: Date = new Date(),
): Promise<Outcome<VaultDocument>> => {
  const actor = await findActor(actorId);
  if (!actor) return refused('Unknown actor.', 'Specification v2 §5.5 step 1');

  const row = await db().vaultDocument.findFirst({ where: { id: documentId, tenantId } });
  if (!row || row.deletedAt !== null) return noData('No such document in this tenant.');

  if (row.legalHold) {
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
      `Document is under legal hold${row.legalHoldReason ? `: ${row.legalHoldReason}` : ''}.`,
      'Blueprint 3.2 - legal hold overrides retention',
    );
  }

  if (row.retainUntil === null) {
    return {
      status: 'not_built',
      module: '7.2 Regulatory Engine / 7.5 Legal Hold & Record Retention',
      reason:
        'No retention schedule has been resolved for this document, and the per-state rules that would resolve one are not built. Refusing to delete: keeping a document too long is a liability, but destroying one a regulator was entitled to see is irreversible.',
    };
  }

  if (row.retainUntil > now) {
    return refused(
      `Document must be retained until ${row.retainUntil.toISOString().slice(0, 10)}.`,
      'Blueprint 3.2 - retention rules per the Regulatory Engine',
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
    payload: { documentId, retainedUntil: row.retainUntil.toISOString() },
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
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
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
