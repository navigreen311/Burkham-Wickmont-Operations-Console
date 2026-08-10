/**
 * 3.4 Deliverable Approval Workflow.
 *
 * "Every deliverable passes: agent draft → QA check → Communication Compliance Scanner → human
 * review (if required by risk or content type) → final PDF generation → client delivery log"
 * - blueprint 3.4.
 *
 * The pipeline is enforced by **state**, not by the order a caller happens to invoke things in.
 * `deliver()` does not check "did you remember to scan"; it checks that the row reached
 * `approved`, which is only reachable from `scanned`, which is only reachable from `qa_checked`.
 * A caller cannot skip a step by calling the last function first, and a new caller added later
 * inherits the ordering for free.
 *
 * Every transition writes a ledger event, because the Compliance Evidence Vault (7.1) builds the
 * regulator-ready file from exactly this history.
 */

import { createHash } from 'node:crypto';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { find as findClient } from '@bwc/clients';
import { raise as raiseNotification } from '@bwc/notifications';
import { scanForTenant, type ScanResult } from '@bwc/scanner';
import { failed, noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { canonicalJson, scannableText, type DeliverableDocument } from './content.js';

export type DeliverableStatus =
  | 'draft'
  | 'qa_checked'
  | 'scanned'
  | 'blocked'
  | 'awaiting_human'
  | 'approved'
  | 'rejected'
  | 'delivered';

export interface Deliverable {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly version: number;
  readonly status: DeliverableStatus;
  readonly content: DeliverableDocument;
  readonly contentHash: string;
  readonly scanResult: ScanResult | null;
  readonly reviewedBy: string | null;
  readonly deliveredAt: Date | null;
}

interface DeliverableRow {
  id: string;
  tenantId: string;
  clientId: string;
  templateKey: string;
  templateVersion: number;
  version: number;
  status: string;
  content: unknown;
  contentHash: string;
  scanResult: unknown;
  reviewedBy: string | null;
  deliveredAt: Date | null;
}

const toDeliverable = (row: DeliverableRow): Deliverable => ({
  id: row.id,
  tenantId: row.tenantId,
  clientId: row.clientId,
  templateKey: row.templateKey,
  templateVersion: row.templateVersion,
  version: row.version,
  status: row.status as DeliverableStatus,
  content: row.content as DeliverableDocument,
  contentHash: row.contentHash,
  scanResult: (row.scanResult ?? null) as ScanResult | null,
  reviewedBy: row.reviewedBy,
  deliveredAt: row.deliveredAt,
});

/**
 * sha256 over the canonical JSON of the content document.
 *
 * Hashing the *content*, not the rendered bytes. A font substitution or a pdfkit upgrade changes
 * the bytes without changing a word the client read, and the evidence must survive that.
 */
export const hashContent = (document: DeliverableDocument): string =>
  createHash('sha256').update(canonicalJson(document)).digest('hex');

// --- Templates ------------------------------------------------------------

export interface TemplateInput {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  /** Anything carrying funding recommendations or compliance state should be true. */
  readonly requiresHumanReview?: boolean;
}

export const registerTemplate = async (input: TemplateInput): Promise<{ id: string }> => {
  const row = await db().deliverableTemplate.upsert({
    where: { key_version: { key: input.key, version: input.version } },
    create: {
      key: input.key,
      version: input.version,
      title: input.title,
      description: input.description,
      requiresHumanReview: input.requiresHumanReview ?? true,
    },
    update: {
      title: input.title,
      description: input.description,
      requiresHumanReview: input.requiresHumanReview ?? true,
    },
  });
  return { id: row.id };
};

// --- 1. Draft -------------------------------------------------------------

export interface DraftInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly document: DeliverableDocument;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Create a new deliverable version.
 *
 * Always a new version, never an edit: the previous version may already have been delivered, and
 * mutating it would rewrite what a client was told. Same reasoning as the Ledger's append-only
 * discipline, applied to the artifact rather than the event.
 */
export const draft = async (input: DraftInput): Promise<Outcome<Deliverable>> => {
  const client = await findClient(input.tenantId, input.clientId);
  if (client.status !== 'ok') return client as Outcome<Deliverable>;

  const template = await db().deliverableTemplate.findUnique({
    where: {
      key_version: {
        key: input.document.templateKey,
        version: input.document.templateVersion,
      },
    },
  });
  if (!template) {
    return noData(`No template ${input.document.templateKey} v${input.document.templateVersion}.`);
  }

  const latest = await db().deliverable.findFirst({
    where: {
      clientId: input.clientId,
      templateKey: input.document.templateKey,
    },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const row = await db().deliverable.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      templateKey: input.document.templateKey,
      templateVersion: input.document.templateVersion,
      version: (latest?.version ?? 0) + 1,
      status: 'draft',
      content: input.document as unknown as object,
      contentHash: hashContent(input.document),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'deliverable.drafted',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      deliverableId: row.id,
      templateKey: row.templateKey,
      version: row.version,
      contentHash: row.contentHash,
    },
  });

  return ok(toDeliverable(row));
};

// --- 2. QA check ----------------------------------------------------------

export interface QaIssue {
  readonly code: string;
  readonly detail: string;
}

/**
 * Structural QA, before the Scanner sees it. Checks the shape of the document rather than its
 * language: an empty section or a missing client name is not a compliance problem, it is a
 * broken document, and sending it to a human reviewer wastes the scarcest resource in the
 * pipeline.
 */
export const qaIssues = (document: DeliverableDocument): QaIssue[] => {
  const issues: QaIssue[] = [];

  if (document.title.trim() === '') {
    issues.push({ code: 'EMPTY_TITLE', detail: 'Document has no title.' });
  }
  if (document.clientLegalName.trim() === '') {
    issues.push({ code: 'NO_CLIENT', detail: 'Document does not name the client.' });
  }
  if (document.sections.length === 0) {
    issues.push({ code: 'NO_SECTIONS', detail: 'Document has no sections.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(document.preparedOn)) {
    issues.push({
      code: 'BAD_DATE',
      detail: 'preparedOn must be an ISO date (YYYY-MM-DD). Deliverables are signed and dated.',
    });
  }

  document.sections.forEach((section, index) => {
    if (section.heading.trim() === '') {
      issues.push({ code: 'EMPTY_HEADING', detail: `Section ${index} has no heading.` });
    }
    if (section.blocks.length === 0) {
      issues.push({
        code: 'EMPTY_SECTION',
        detail: `Section '${section.heading}' has no content.`,
      });
    }
  });

  return issues;
};

export const runQaCheck = async (
  tenantId: string,
  deliverableId: string,
  actor: EventActor,
): Promise<Outcome<Deliverable>> => {
  const existing = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  if (!existing) return noData('No such deliverable in this tenant.');
  if (existing.status !== 'draft') {
    return refused(
      `Deliverable is '${existing.status}'; QA runs on a draft.`,
      'Blueprint 3.4 - the pipeline order is enforced by state',
    );
  }

  const issues = qaIssues(existing.content as unknown as DeliverableDocument);
  if (issues.length > 0) {
    return refused(
      `QA found ${issues.length} issue(s): ${issues.map((issue) => `${issue.code} ${issue.detail}`).join('; ')}`,
      'Blueprint 3.4 - agent draft must pass QA before the Scanner',
    );
  }

  const row = await db().deliverable.update({
    where: { id: deliverableId },
    data: { status: 'qa_checked' },
  });

  await append({
    tenantId,
    type: 'deliverable.qa_checked',
    actor,
    clientId: existing.clientId,
    payload: { deliverableId, version: existing.version },
  });

  return ok(toDeliverable(row));
};

// --- 3. Compliance scan ---------------------------------------------------

/**
 * Scan the assembled content.
 *
 * Scans the content model, not the template and not the rendered output: a banned phrase
 * interpolated from client data would pass a template scan, and one introduced by a rendering
 * step would pass a model scan done too early.
 *
 * A block is terminal for this version. The remedy is a new draft with different language, not a
 * retry of the same bytes - which is why `blocked` has no edge back to `scanned`.
 */
export const runComplianceScan = async (
  tenantId: string,
  deliverableId: string,
  actor: EventActor,
  jurisdiction?: string,
  now: Date = new Date(),
): Promise<Outcome<Deliverable>> => {
  const existing = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  if (!existing) return noData('No such deliverable in this tenant.');
  if (existing.status !== 'qa_checked') {
    return refused(
      `Deliverable is '${existing.status}'; the scan runs after QA.`,
      'Blueprint 3.4 - the pipeline order is enforced by state',
    );
  }

  const document = existing.content as unknown as DeliverableDocument;

  const scan = await scanForTenant({
    tenantId,
    text: scannableText(document),
    actor,
    clientId: existing.clientId,
    context: `deliverable ${existing.templateKey} v${existing.version}`,
    ...(jurisdiction !== undefined ? { jurisdiction } : {}),
  });

  // An empty claim library refuses rather than reporting clean. Forward it unchanged - a
  // reworded "scan unavailable" would lose the reason.
  if (scan.status !== 'ok') return scan as Outcome<Deliverable>;

  const blocked = scan.value.verdict === 'blocked';

  const row = await db().deliverable.update({
    where: { id: deliverableId },
    data: {
      status: blocked ? 'blocked' : 'scanned',
      scanResult: scan.value as unknown as object,
      scannedAt: now,
    },
  });

  await append({
    tenantId,
    type: blocked ? 'deliverable.blocked' : 'deliverable.scanned',
    actor,
    clientId: existing.clientId,
    payload: {
      deliverableId,
      version: existing.version,
      verdict: scan.value.verdict,
      findingCount: scan.value.findings.length,
      libraryEntriesChecked: scan.value.libraryEntriesChecked,
    },
  });

  if (blocked) {
    return refused(
      `Deliverable blocked by the Communication Compliance Scanner: ${scan.value.findings
        .filter((finding) => finding.disposition === 'banned')
        .map((finding) => `'${finding.phrase}' (${finding.rationale})`)
        .join('; ')}`,
      'Blueprint 4.2 - banned language does not reach a client',
    );
  }

  return ok(toDeliverable(row));
};

// --- 4. Human review ------------------------------------------------------

export const requestHumanReview = async (
  tenantId: string,
  deliverableId: string,
  actor: EventActor,
  slaDueAt?: Date,
): Promise<Outcome<Deliverable>> => {
  const existing = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  if (!existing) return noData('No such deliverable in this tenant.');
  if (existing.status !== 'scanned') {
    return refused(
      `Deliverable is '${existing.status}'; human review follows a clean scan.`,
      'Blueprint 3.4 - the pipeline order is enforced by state',
    );
  }

  const row = await db().deliverable.update({
    where: { id: deliverableId },
    data: { status: 'awaiting_human' },
  });

  await raiseNotification({
    tenantId,
    assignedTo: 'compliance_and_evidence',
    kind: 'deliverable_review',
    summary: `Review ${existing.templateKey} v${existing.version} before delivery`,
    actor,
    clientId: existing.clientId,
    ...(slaDueAt !== undefined ? { slaDueAt } : {}),
  });

  return ok(toDeliverable(row));
};

/**
 * Approve.
 *
 * Requires a **human** actor. Blueprint 3.4 places human review before client delivery, and an
 * agent approving its own draft would make the step ceremonial - the same reasoning that stops an
 * agent clearing the Funding Ethics Firewall it triggered.
 */
export const approve = async (
  tenantId: string,
  deliverableId: string,
  actor: EventActor,
  now: Date = new Date(),
): Promise<Outcome<Deliverable>> => {
  if (actor.kind !== 'human') {
    return refused(
      'Only a human actor may approve a deliverable for client delivery.',
      'Blueprint 3.4 - human review precedes client delivery',
    );
  }

  const existing = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  if (!existing) return noData('No such deliverable in this tenant.');
  if (existing.status !== 'awaiting_human' && existing.status !== 'scanned') {
    return refused(
      `Deliverable is '${existing.status}'; approval follows a clean scan.`,
      'Blueprint 3.4 - the pipeline order is enforced by state',
    );
  }

  const row = await db().deliverable.update({
    where: { id: deliverableId },
    data: { status: 'approved', reviewedBy: actor.id, reviewedAt: now },
  });

  await append({
    tenantId,
    type: 'deliverable.approved',
    actor,
    clientId: existing.clientId,
    payload: {
      deliverableId,
      version: existing.version,
      contentHash: existing.contentHash,
      approvedBy: actor.id,
    },
  });

  return ok(toDeliverable(row));
};

export const reject = async (
  tenantId: string,
  deliverableId: string,
  reason: string,
  actor: EventActor,
  now: Date = new Date(),
): Promise<Outcome<Deliverable>> => {
  const existing = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  if (!existing) return noData('No such deliverable in this tenant.');

  const row = await db().deliverable.update({
    where: { id: deliverableId },
    data: { status: 'rejected', reviewedBy: actor.id, reviewedAt: now, rejectionReason: reason },
  });

  await append({
    tenantId,
    type: 'deliverable.rejected',
    actor,
    clientId: existing.clientId,
    payload: { deliverableId, version: existing.version, reason },
  });

  return ok(toDeliverable(row));
};

// --- 5. Deliver -----------------------------------------------------------

/**
 * Record delivery to the client.
 *
 * The only path to `delivered` runs through `approved`, which runs through `scanned`, which runs
 * through `qa_checked`. There is no argument that skips a step and no flag that bypasses one.
 *
 * The ledger event carries the content hash, so "what exactly did we send this client, and who
 * approved it" is answerable from the Ledger alone - which is what blueprint 7.1 needs to build a
 * regulator-ready file in minutes rather than from a document archive.
 */
export const deliver = async (
  tenantId: string,
  deliverableId: string,
  actor: EventActor,
  now: Date = new Date(),
): Promise<Outcome<Deliverable>> => {
  const existing = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  if (!existing) return noData('No such deliverable in this tenant.');

  if (existing.status !== 'approved') {
    return refused(
      `Deliverable is '${existing.status}'. Only an approved deliverable may be delivered - it must pass QA, the Communication Compliance Scanner, and human review first.`,
      'Blueprint 3.4 - the approval pipeline is the precondition for delivery',
    );
  }

  // Belt and braces: the hash is recomputed from the stored content, so a row edited outside the
  // pipeline is caught before anything reaches a client.
  const recomputed = hashContent(existing.content as unknown as DeliverableDocument);
  if (recomputed !== existing.contentHash) {
    return failed(
      'Deliverable content hash does not match its recorded hash; the stored content changed after approval.',
    );
  }

  const row = await db().deliverable.update({
    where: { id: deliverableId },
    data: { status: 'delivered', deliveredAt: now },
  });

  await append({
    tenantId,
    type: 'deliverable.delivered',
    actor,
    clientId: existing.clientId,
    payload: {
      deliverableId,
      templateKey: existing.templateKey,
      version: existing.version,
      contentHash: existing.contentHash,
      approvedBy: existing.reviewedBy,
    },
  });

  return ok(toDeliverable(row));
};

export const find = async (
  tenantId: string,
  deliverableId: string,
): Promise<Outcome<Deliverable>> => {
  const row = await db().deliverable.findFirst({ where: { id: deliverableId, tenantId } });
  return row ? ok(toDeliverable(row)) : noData('No such deliverable in this tenant.');
};

export const forClient = async (tenantId: string, clientId: string): Promise<Deliverable[]> => {
  const rows = await db().deliverable.findMany({
    where: { tenantId, clientId },
    orderBy: [{ templateKey: 'asc' }, { version: 'desc' }],
  });
  return rows.map(toDeliverable);
};
