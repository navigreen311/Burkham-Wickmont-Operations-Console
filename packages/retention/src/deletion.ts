/**
 * Client data deletion requests - blueprint 7.5's "GDPR / CCPA analog".
 *
 * **The request is recorded before it is answered, and it is recorded even when the answer is no.**
 * That is the whole shape. "We received your request on the 3rd and refused it on the 5th because
 * these records are under litigation hold LIT-2026-014" is the sentence a regulator wants; a
 * request that was considered and quietly dropped produces no sentence at all, and looks identical
 * to one that never arrived.
 *
 * This module decides eligibility and records the decision. **It does not delete anything.** The
 * vault owns the bytes and owns the destruction, and it already refuses to destroy a document under
 * hold or inside its retention period - so putting a second deletion path here would create exactly
 * the second door ADR-0034 is about, on the one operation in this system that cannot be undone.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { describeHolds, reviewDueAt } from './holds.js';

export type DeletionStatus = 'received' | 'refused' | 'approved' | 'completed';

/** The authority a deletion decision takes. Level 3, as everywhere a record can be destroyed. */
export const DELETION_AUTHORITY_LEVEL = 3;

export interface DeletionRequest {
  readonly id: string;
  readonly clientId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly requestDetail: string;
  readonly status: DeletionStatus;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly completedAt: string | null;
  readonly documentsDeleted: number | null;
}

interface RequestRow {
  id: string;
  clientId: string;
  requestedBy: string;
  requestedAt: Date;
  requestDetail: string;
  status: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionReason: string | null;
  completedAt: Date | null;
  documentsDeleted: number | null;
}

const toRequest = (row: RequestRow): DeletionRequest => ({
  id: row.id,
  clientId: row.clientId,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt.toISOString(),
  requestDetail: row.requestDetail,
  status: row.status as DeletionStatus,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  decidedBy: row.decidedBy,
  decisionReason: row.decisionReason,
  completedAt: row.completedAt?.toISOString() ?? null,
  documentsDeleted: row.documentsDeleted,
});

/**
 * Record a request.
 *
 * Never refused on eligibility. Whether the records can be destroyed is a question for the
 * decision, and a request rejected at intake leaves no evidence that it was ever made - which is
 * the one thing a data-subject-rights regime asks you to be able to show.
 */
export const requestDeletion = async (input: {
  tenantId: string;
  clientId: string;
  requestedBy: string;
  requestDetail: string;
  requestedAt: Date;
  actor: EventActor;
}): Promise<Outcome<DeletionRequest>> => {
  if (input.requestDetail.trim().length < 5) {
    return refused(
      'A deletion request needs to say what is being asked for, in the words it was asked in.',
      'Blueprint 7.5 - client data deletion request workflow',
    );
  }

  const row = await db().deletionRequest.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      requestedBy: input.requestedBy,
      requestedAt: input.requestedAt,
      requestDetail: input.requestDetail,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'retention.deletion.requested',
    actor: input.actor,
    clientId: input.clientId,
    // The detail is the client's own words about their own file. It stays in the row.
    payload: { requestId: row.id },
  });

  return ok(toRequest(row));
};

export interface Eligibility {
  readonly deletable: boolean;
  /** Holds in force over this client's records, as a sentence. Null when there are none. */
  readonly heldBy: string | null;
  readonly note: string;
}

/**
 * Whether a client's records could be destroyed today.
 *
 * Answers only the hold half. **Retention is per document and cannot be answered per client**: one
 * client's file holds a signed authorization whose period ran out years ago and a tax return whose
 * period has not, so a single client-level "retention says yes" would be false about half the file
 * and there is no honest way to average it. The vault resolves retention document by document, and
 * this function says so rather than implying it has checked.
 */
export const assessEligibility = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<Eligibility> => {
  // Deliberately wider than `holdsCovering`, which answers about ONE document and therefore needs a
  // document kind. A whole-file question has no single kind, and a hold scoped to `tax_return`
  // still means this client's file cannot be destroyed in full - so every live kind-scoped hold
  // counts here. Narrowing this to one kind is how a deletion sweeps past the holds it did not ask
  // about.
  const rows = await db().legalHold.findMany({
    where: {
      tenantId,
      releasedAt: null,
      OR: [{ scope: 'tenant' }, { scope: 'client', clientId }, { scope: 'document_kind' }],
    },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
  });

  if (rows.length > 0) {
    const heldBy = describeHolds(
      rows.map((row) => ({
        kind: row.kind,
        matterReference: row.matterReference,
        reviewOverdue: now.getTime() > reviewDueAt(row).getTime(),
      })),
    );
    return {
      deletable: false,
      heldBy,
      note: `Records are preserved under ${heldBy}. A hold outranks a deletion request, and the request is recorded and refused rather than deferred - the client is entitled to know that we have their request and are not acting on it.`,
    };
  }

  return {
    deletable: true,
    heldBy: null,
    note: 'No legal hold covers this client. Each document is still subject to its own retention schedule, which the vault resolves per document at the point of deletion - retention runs from the record and cannot be answered for a whole file at once.',
  };
};

const requireApprover = async (actorId: string, what: string): Promise<Outcome<{ id: string }>> => {
  const actor = await findActor(actorId);
  if (!actor) {
    return refused(
      `No actor ${actorId} is on record, so ${what} cannot be attributed to anyone.`,
      'Blueprint 7.5 - deletion approval workflow',
    );
  }
  if (actor.kind !== 'human') {
    return refused(
      `${actor.label} is a Village agent. ${what} requires a human.`,
      'Blueprint 7.5 - deletion approval workflow',
    );
  }
  if (actor.authorityLevel < DELETION_AUTHORITY_LEVEL) {
    return refused(
      `${actor.label} holds authority level ${actor.authorityLevel}. ${what} requires level ${DELETION_AUTHORITY_LEVEL}.`,
      'Blueprint 2.1 with 7.5 - Level 3 human approval',
    );
  }
  return ok({ id: actor.id });
};

/**
 * Decide a request.
 *
 * **Approval is checked against the holds at the moment of the decision, not at the moment of the
 * request**, and it is re-checked rather than trusted: a hold placed between the two is exactly the
 * case that matters, and it is the one a cached eligibility result would miss.
 *
 * An approval here authorises the vault to proceed. It does not destroy anything, and it does not
 * override a retention period the vault will find on an individual document.
 */
export const decideRequest = async (input: {
  tenantId: string;
  requestId: string;
  approve: boolean;
  decidedBy: string;
  reason: string;
  now?: Date;
}): Promise<Outcome<DeletionRequest>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 10) {
    return refused(
      'A deletion decision needs a reason somebody can read back. On a refusal it is what the client is told; on an approval it is what authorised destroying their file.',
      'Blueprint 7.5 - deletion approval workflow',
    );
  }

  const existing = await db().deletionRequest.findFirst({
    where: { tenantId: input.tenantId, id: input.requestId },
  });
  if (!existing) return noData('No such deletion request in this tenant.');
  if (existing.status !== 'received') {
    return refused(
      `This request was already ${existing.status}.`,
      'Blueprint 7.5 - one decision per request',
    );
  }

  const approver = await requireApprover(input.decidedBy, 'deciding a deletion request');
  if (approver.status !== 'ok') return approver;

  if (input.approve) {
    const eligibility = await assessEligibility(input.tenantId, existing.clientId, now);
    if (!eligibility.deletable) {
      return refused(
        `This client's records are under ${eligibility.heldBy}. A hold outranks a deletion request, including one a Level 3 human has decided to grant.`,
        'Blueprint 7.5 - legal hold overrides retention and deletion',
      );
    }
  }

  const row = await db().deletionRequest.update({
    where: { id: existing.id },
    data: {
      status: (input.approve ? 'approved' : 'refused') as never,
      decidedAt: now,
      decidedBy: input.decidedBy,
      decisionReason: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: input.approve ? 'retention.deletion.approved' : 'retention.deletion.refused',
    actor: { id: input.decidedBy, kind: 'human' },
    clientId: existing.clientId,
    payload: { requestId: existing.id, reason: input.reason },
  });

  return ok(toRequest(row));
};

/**
 * Record what was actually destroyed.
 *
 * Takes a count from the caller that did the destroying. "We deleted everything" is not a claim
 * anybody should have to take on trust, and a zero here is a real and reportable answer: an
 * approved request that destroyed nothing means every document was inside its retention period,
 * which the client is entitled to be told.
 */
export const recordCompletion = async (input: {
  tenantId: string;
  requestId: string;
  documentsDeleted: number;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<DeletionRequest>> => {
  const now = input.now ?? new Date();

  if (!Number.isInteger(input.documentsDeleted) || input.documentsDeleted < 0) {
    return refused(
      'A completion needs a whole count of documents destroyed, and zero is a legitimate one.',
      'Blueprint 7.5 - client data deletion request workflow',
    );
  }

  const existing = await db().deletionRequest.findFirst({
    where: { tenantId: input.tenantId, id: input.requestId },
  });
  if (!existing) return noData('No such deletion request in this tenant.');
  if (existing.status !== 'approved') {
    return refused(
      `Only an approved request can complete. This one is '${existing.status}'.`,
      'Blueprint 7.5 - deletion approval workflow',
    );
  }

  const row = await db().deletionRequest.update({
    where: { id: existing.id },
    data: {
      status: 'completed' as never,
      completedAt: now,
      documentsDeleted: input.documentsDeleted,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'retention.deletion.completed',
    actor: input.actor,
    clientId: existing.clientId,
    payload: { requestId: existing.id, documentsDeleted: input.documentsDeleted },
  });

  return ok(toRequest(row));
};

/** Requests for a client, newest first. Refused ones included - they are the record. */
export const requestsFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly DeletionRequest[]> => {
  const rows = await db().deletionRequest.findMany({
    where: { tenantId, clientId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toRequest);
};

/** Requests nobody has decided. The queue blueprint 7.5's workflow produces. */
export const undecidedRequests = async (tenantId: string): Promise<readonly DeletionRequest[]> => {
  const rows = await db().deletionRequest.findMany({
    where: { tenantId, status: 'received' },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toRequest);
};
