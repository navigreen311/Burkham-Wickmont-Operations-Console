/**
 * The export record - blueprint 7.1's "export packages".
 *
 * The one thing this module owns. Everything else it reports is another module's fact, but
 * **"who took a copy of this client's file, when, and why" exists nowhere else** - and it is
 * precisely the question asked when a file turns up somewhere it should not have.
 *
 * The record carries ids, a purpose, a hash and the coverage map. It does **not** carry the file.
 * The file contains a client's compliance history by necessity; the record of the file does not
 * need to, and a table that duplicated it would be a second copy of the most sensitive assembly
 * the system produces.
 */

import { db, type Prisma } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { assembleEvidenceFile, hashEvidenceFile, type EvidenceFile } from './assemble.js';

export interface ExportRecord {
  readonly id: string;
  readonly scope: 'client' | 'engagement';
  readonly clientId: string;
  readonly engagementId: string | null;
  readonly purpose: string;
  readonly requestedBy: string;
  readonly contentHash: string;
  readonly exportedAt: string;
}

export interface ExportResult {
  readonly record: ExportRecord;
  readonly file: EvidenceFile;
}

/**
 * Assemble a file and record that it was taken.
 *
 * A purpose is required. "Who took a copy of this client's file and why" is the question this
 * table exists to answer, and an export with no stated purpose answers only half of it - which is
 * the half that matters least.
 *
 * The file is returned to the caller and not stored. Storing it would create a second copy of the
 * client's whole compliance history, ageing from the moment it was written, and the stored copy is
 * the one somebody would later read.
 */
export const exportEvidenceFile = async (input: {
  tenantId: string;
  clientId: string;
  engagementId?: string;
  purpose: string;
  requestedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ExportResult>> => {
  if (input.purpose.trim() === '') {
    return refused(
      'An evidence export requires a stated purpose. The record exists to answer who took a copy of this client file and why, and without the why it answers only half of it.',
      'Blueprint 7.1 - export packages are themselves audit artifacts',
    );
  }
  if (input.requestedBy.trim() === '') {
    return refused(
      'An evidence export requires the name of whoever requested it.',
      'Blueprint 7.1 - export packages are themselves audit artifacts',
    );
  }

  const file = await assembleEvidenceFile({
    tenantId: input.tenantId,
    clientId: input.clientId,
    ...(input.engagementId !== undefined ? { engagementId: input.engagementId } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (file.status !== 'ok') return file as Outcome<ExportResult>;

  const contentHash = hashEvidenceFile(file.value);
  const exportedAt = input.now ?? new Date();

  const row = await db().evidenceExport.create({
    data: {
      tenantId: input.tenantId,
      scope: file.value.scope as never,
      clientId: input.clientId,
      engagementId: input.engagementId ?? null,
      purpose: input.purpose,
      requestedBy: input.requestedBy,
      contentHash,
      coverage: file.value.coverage as unknown as Prisma.InputJsonValue,
      exportedAt,
    },
  });

  // Ids, a purpose and a hash. No client data: the file carries that, and the Ledger is retained
  // indefinitely.
  await append({
    tenantId: input.tenantId,
    type: 'evidence.file.exported',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      exportId: row.id,
      scope: file.value.scope,
      engagementId: input.engagementId ?? null,
      purpose: input.purpose,
      requestedBy: input.requestedBy,
      contentHash,
      gapCount: file.value.gaps.length,
      ledgerIntact: file.value.ledgerIntegrity.intact,
    },
  });

  return ok({ record: toRecord(row), file: file.value });
};

interface ExportRow {
  id: string;
  scope: string;
  clientId: string;
  engagementId: string | null;
  purpose: string;
  requestedBy: string;
  contentHash: string;
  exportedAt: Date;
}

const toRecord = (row: ExportRow): ExportRecord => ({
  id: row.id,
  scope: row.scope as 'client' | 'engagement',
  clientId: row.clientId,
  engagementId: row.engagementId,
  purpose: row.purpose,
  requestedBy: row.requestedBy,
  contentHash: row.contentHash,
  exportedAt: row.exportedAt.toISOString(),
});

/** Every export of a client's file. The answer to "who has seen this". */
export const exportHistory = async (
  tenantId: string,
  clientId: string,
): Promise<readonly ExportRecord[]> => {
  const rows = await db().evidenceExport.findMany({
    where: { tenantId, clientId },
    orderBy: [{ exportedAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toRecord);
};

export interface ReconciliationResult {
  readonly matches: boolean;
  readonly exportedHash: string;
  readonly currentHash: string;
  readonly detail: string;
}

/**
 * Compare a past export against what the system would produce now.
 *
 * A mismatch is **expected and not an error**: the file is assembled live, so any new document,
 * deliverable or state transition changes it. What the comparison establishes is whether a file
 * somebody is holding is the current picture - which is the question asked when a stale copy turns
 * up in a dispute.
 *
 * Reported as a fact rather than a verdict, for that reason.
 */
export const reconcileExport = async (
  tenantId: string,
  exportId: string,
  now?: Date,
): Promise<Outcome<ReconciliationResult>> => {
  const row = await db().evidenceExport.findFirst({ where: { tenantId, id: exportId } });
  if (!row) return noData('No such export in this tenant.');

  const current = await assembleEvidenceFile({
    tenantId,
    clientId: row.clientId,
    ...(row.engagementId !== null ? { engagementId: row.engagementId } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  if (current.status !== 'ok') return current as Outcome<ReconciliationResult>;

  const currentHash = hashEvidenceFile(current.value);

  return ok({
    matches: currentHash === row.contentHash,
    exportedHash: row.contentHash,
    currentHash,
    detail:
      currentHash === row.contentHash
        ? `The file exported on ${row.exportedAt.toISOString().slice(0, 10)} still matches what the system produces today.`
        : `The file exported on ${row.exportedAt.toISOString().slice(0, 10)} differs from what the system produces today. This is expected where evidence has been added since; it means the holder of that copy does not have the current picture.`,
  });
};
