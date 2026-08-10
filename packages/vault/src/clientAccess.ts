/**
 * Vault access by a CLIENT, on their own file - 3.2 with 11.10.
 *
 * The follow-on named in ADR-0021. A client user is deliberately not an `Actor`, so `store` and
 * `read` - which resolve one and check its authority level - could not serve them. This is the
 * ownership-based path alongside the level-based one.
 *
 * **One gate differs, and that is the whole difference.** For staff, `MINIMUM_LEVEL_TO_READ`
 * decides: a Level 2 analyst reads tax returns across the book, and ownership is not the question.
 * For a client, the level is meaningless and ownership is the only question - this file, and no
 * other.
 *
 * Everything else is identical and deliberately so: the same tenant check, the same scan-status
 * rule, the same legal-hold rule, the same watermark on export, the same access log written before
 * the bytes are handed over. Where the rules are the same they are the same CODE, because two
 * copies of a gate is how the copies stop agreeing.
 *
 * ## The legal-hold decision, and what is assumed
 *
 * A hold blocks **export and not view**, for a client exactly as for staff. The reasoning
 * transfers without modification: a hold exists to stop material being destroyed or leaving the
 * system, and viewing does neither.
 *
 * **The client is not told a hold exists.** A litigation-hold notice is frequently confidential,
 * and the hold may relate to a dispute with the very client asking. So the refusal is truthful and
 * declines to explain - the same shape as authentication's single answer to every failure. The
 * real reason goes to the access log, where an auditor reads it.
 *
 * **ASSUMPTION FOR COUNSEL:** that a client may *view* their own document while it is under a
 * legal hold, and may not *download* it. That is the consistent reading of the staff rule and it
 * is not a settled legal question. Counsel should confirm before a hold is placed on a file whose
 * client has portal access.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { failed, noData, ok, refused, type Outcome } from '@bwc/core';
import { decrypt, encrypt } from '@bwc/crypto';
import { newBlobKey } from './store.js';
import { watermarkPdf, type WatermarkResult } from './watermark.js';
import {
  toDocument,
  type AccessAction,
  type DocumentKind,
  type ReadResult,
  type VaultConfig,
  type VaultDocument,
} from './vault.js';

/**
 * A client acting on their own file.
 *
 * Carries the client user's own id, not an internal actor's. A hundred clients sharing one service
 * account would make every access-log row say the same thing, which is the opposite of what an
 * access log is for.
 */
export interface ClientAccessor {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientUserId: string;
  readonly displayName: string;
}

const logClientAccess = async (
  documentId: string,
  tenantId: string,
  clientId: string | null,
  accessor: ClientAccessor,
  action: AccessAction,
  granted: boolean,
  reason?: string,
  watermarked = false,
): Promise<void> => {
  await db().vaultAccessLog.create({
    data: {
      documentId,
      tenantId,
      actorId: accessor.clientUserId,
      actorKind: 'client',
      action,
      granted,
      reason: reason ?? null,
      watermarked,
    },
  });

  await append({
    tenantId,
    type: granted ? 'vault.document_accessed' : 'vault.access_refused',
    actor: { id: accessor.clientUserId, kind: 'client' },
    ...(clientId !== null ? { clientId } : {}),
    payload: { documentId, action, granted, ...(reason !== undefined ? { reason } : {}) },
  });
};

export interface ClientStoreInput {
  readonly accessor: ClientAccessor;
  readonly kind: DocumentKind;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
  readonly now?: Date;
}

/**
 * Store a document a client uploaded.
 *
 * Ownership is not checked here because it cannot fail: the document is written against the
 * accessor's own `clientId`, and there is no parameter for a different one. That is the check,
 * expressed as an absence.
 *
 * WHICH KINDS a client may upload stays in the portal. It is a policy about what a client supplies
 * rather than about how bytes are stored, and a second copy here would be a second list to keep
 * in step with the first.
 *
 * The document lands `pending` and is unreadable until scanned - by 3.2's own rule, not by
 * anything this function does.
 */
export const storeForClient = async (
  config: VaultConfig,
  input: ClientStoreInput,
): Promise<Outcome<VaultDocument>> => {
  if (input.content.length === 0) {
    return refused('Refusing to store an empty document.', 'Blueprint 3.2 - input validation');
  }

  const payload = await encrypt(input.content, config.kek);
  const blobKey = newBlobKey(input.accessor.tenantId);
  await config.store.put(blobKey, payload.ciphertext);

  const row = await db().vaultDocument.create({
    data: {
      tenantId: input.accessor.tenantId,
      // The accessor's own client. No parameter exists for another one.
      clientId: input.accessor.clientId,
      kind: input.kind,
      filename: input.filename,
      contentType: input.contentType,
      byteSize: input.content.length,
      sha256: payload.sha256,
      blobKey,
      wrappedDek: payload.wrappedDek,
      iv: payload.iv,
      authTag: payload.authTag,
      uploadedBy: input.accessor.clientUserId,
      ...(input.now !== undefined ? { createdAt: input.now } : {}),
    },
  });

  await append({
    tenantId: input.accessor.tenantId,
    type: 'vault.document_stored',
    actor: { id: input.accessor.clientUserId, kind: 'client' },
    clientId: input.accessor.clientId,
    payload: {
      documentId: row.id,
      kind: input.kind,
      byteSize: input.content.length,
      uploadedByClient: true,
    },
  });

  return ok(toDocument(row));
};

export interface ClientReadInput {
  readonly accessor: ClientAccessor;
  readonly documentId: string;
  readonly action?: AccessAction;
  readonly now?: Date;
}

/**
 * Read a document as the client who owns it.
 *
 * The gates, in order:
 *
 *   1. tenant     - against the DOCUMENT's tenant, not the caller's claim
 *   2. OWNERSHIP  - this is the one that differs from `read`. No authority level is consulted,
 *                   because a client does not hold one
 *   3. scan       - `pending` and `scan_unavailable` both block; neither means clean
 *   4. legal hold - blocks export, not view, and the refusal does not say why
 *
 * A document belonging to another client returns the same answer as one that does not exist.
 * Distinguishing them would confirm that a document id belongs to somebody, which is the same
 * enumeration the portal's `documentInRoom` already refuses to enable.
 */
export const readForClient = async (
  config: VaultConfig,
  input: ClientReadInput,
): Promise<Outcome<ReadResult>> => {
  const action = input.action ?? 'view';
  const now = input.now ?? new Date();
  const { accessor } = input;

  const row = await db().vaultDocument.findUnique({ where: { id: input.documentId } });
  if (!row || row.deletedAt !== null) return noData('No such document in your file.');

  // 1. Tenant, and 2. ownership. Both refuse identically and both are logged - a run of denied
  // attempts against documents a client does not own is exactly the signal an audit wants, and it
  // exists only if the refusals are recorded.
  if (row.tenantId !== accessor.tenantId) {
    await logClientAccess(
      row.id,
      row.tenantId,
      row.clientId,
      accessor,
      action,
      false,
      'cross_tenant',
    );
    return noData('No such document in your file.');
  }

  if (row.clientId !== accessor.clientId) {
    await logClientAccess(row.id, row.tenantId, row.clientId, accessor, action, false, 'not_owner');
    // Same answer as a document that does not exist.
    return noData('No such document in your file.');
  }

  // 3. Scan status. Same rule as staff, said in words a client can act on.
  if (row.scanStatus !== 'clean') {
    await logClientAccess(
      row.id,
      row.tenantId,
      row.clientId,
      accessor,
      action,
      false,
      `scan_${row.scanStatus}`,
    );
    return refused(
      row.scanStatus === 'infected'
        ? 'This file did not pass our security scan and cannot be opened. Please upload a replacement.'
        : 'We are still checking this file for malware. It will be available shortly - you do not need to upload it again.',
      'Blueprint 3.2 - an unscanned document is not a clean document',
    );
  }

  // 4. Legal hold. Blocks export and not view, as for staff - a hold stops material being
  //    destroyed or leaving, and viewing does neither.
  //
  //    The client is NOT told a hold exists. A litigation-hold notice is frequently confidential
  //    and the hold may concern a dispute with this very client, so the refusal is truthful and
  //    declines to explain. The real reason is in the access log, where an auditor reads it.
  if (row.legalHold && action === 'export') {
    await logClientAccess(
      row.id,
      row.tenantId,
      row.clientId,
      accessor,
      action,
      false,
      'legal_hold',
    );
    return refused(
      'This document cannot be downloaded at the moment. You can still view it here, and your Concierge Desk contact can help if you need a copy.',
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
    await logClientAccess(
      row.id,
      row.tenantId,
      row.clientId,
      accessor,
      action,
      false,
      'decrypt_failed',
    );
    return failed(
      'Could not open this document.',
      error instanceof Error ? error.message : String(error),
    );
  }

  let content = plaintext;
  let watermark: WatermarkResult = { watermarked: false, content: plaintext };

  if (action === 'export') {
    // Watermarked for the same reason a staff export is: a copy leaving the system carries who
    // took it and when. That a client is taking a copy of their own document does not change what
    // the watermark is for - the copy still leaves.
    watermark = await watermarkPdf(plaintext, {
      viewer: `${accessor.displayName} (client user ${accessor.clientUserId})`,
      at: now,
      documentId: row.id,
      contentType: row.contentType,
    });
    content = watermark.content;
  }

  // Logged before the bytes are handed over. If this throws, the caller gets nothing.
  await logClientAccess(
    row.id,
    row.tenantId,
    row.clientId,
    accessor,
    action,
    true,
    undefined,
    watermark.watermarked,
  );

  if (action === 'export') {
    await append({
      tenantId: row.tenantId,
      type: 'vault.document_exported',
      actor: { id: accessor.clientUserId, kind: 'client' },
      clientId: row.clientId,
      payload: { documentId: row.id, watermarked: watermark.watermarked, byClient: true },
    });
  }

  return ok({ document: toDocument(row), content, watermarked: watermark.watermarked });
};
