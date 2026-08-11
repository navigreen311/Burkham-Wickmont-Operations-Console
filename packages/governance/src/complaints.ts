/**
 * Complaint tracking and the auto-flag threshold - blueprint 5.4.
 *
 * "Complaint threshold auto-flag" is one line in the blueprint and two decisions in practice:
 * what counts toward the threshold, and what happens at it.
 *
 * **Severity is weighted, not counted.** Three low-severity billing gripes and three CFPB
 * complaints about undisclosed fees are not the same signal, and a flat count says they are.
 * A severe complaint alone crosses the threshold, because one is enough to warrant a look.
 *
 * **Crossing it flags for review; it does not suspend.** Auto-suspension would let a
 * competitor or a single unhappy client remove a provider from the platform without a human
 * ever weighing the complaint. Flagging pauses recommendations - `under_review` is not
 * recommendable - and puts the decision in front of the board, which is the body the
 * blueprint makes responsible for it.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, type EventActor, type Outcome } from '@bwc/core';
import { flagForReview, type GovernanceRecord } from './board.js';

export type ComplaintSeverity = 'low' | 'moderate' | 'severe';

/** Weight per severity. A single severe complaint reaches the threshold on its own. */
export const COMPLAINT_WEIGHTS: Readonly<Record<ComplaintSeverity, number>> = {
  low: 1,
  moderate: 2,
  severe: 5,
};

/**
 * Weighted score at which a provider is flagged.
 *
 * Five, so one severe complaint, or three moderates, or five low-severity ones inside a
 * review window trip it. A judgement, stated here rather than buried in a condition.
 */
export const COMPLAINT_FLAG_THRESHOLD = 5;

export interface ComplaintInput {
  readonly tenantId: string;
  readonly providerId: string;
  readonly source: string;
  readonly summary: string;
  readonly severity: ComplaintSeverity;
  readonly receivedAt: Date;
  readonly actor: EventActor;
}

export interface ComplaintResult {
  readonly complaintId: string;
  readonly weightedScore: number;
  readonly thresholdCrossed: boolean;
  /** The governance record after any auto-flag, or null if the provider is not governed. */
  readonly governance: GovernanceRecord | null;
}

/**
 * Record a complaint and auto-flag if the window's weighted score crosses the threshold.
 *
 * A complaint against a provider with no governance record is still recorded. It is
 * evidence, and losing it because nobody had opened a governance file would mean the file,
 * when opened, starts blind.
 */
export const recordComplaint = async (input: ComplaintInput): Promise<Outcome<ComplaintResult>> => {
  if (input.summary.trim() === '') {
    return noData('A complaint with no summary carries no information and was not recorded.');
  }

  const complaint = await db().providerComplaint.create({
    data: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      source: input.source,
      summary: input.summary,
      severity: input.severity as never,
      receivedAt: input.receivedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'governance.complaint.recorded',
    actor: input.actor,
    payload: {
      providerId: input.providerId,
      severity: input.severity,
      source: input.source,
      complaintId: complaint.id,
    },
  });

  const record = await db().providerGovernance.findFirst({
    where: { tenantId: input.tenantId, providerId: input.providerId },
  });

  if (!record) {
    return ok({
      complaintId: complaint.id,
      weightedScore: COMPLAINT_WEIGHTS[input.severity],
      thresholdCrossed: false,
      governance: null,
    });
  }

  const weightedScore = await windowScore(
    input.tenantId,
    input.providerId,
    record.complaintWindowStart,
  );

  await db().providerGovernance.update({
    where: { id: record.id },
    data: { complaintCount: { increment: 1 } },
  });

  const crossed = weightedScore >= COMPLAINT_FLAG_THRESHOLD;

  // Already under review, suspended or blacklisted - flagging again would add a decision row
  // saying nothing changed, and the board's minute book is more useful without them.
  if (!crossed || record.status !== 'approved') {
    return ok({
      complaintId: complaint.id,
      weightedScore,
      thresholdCrossed: crossed,
      governance: null,
    });
  }

  const flagged = await flagForReview({
    tenantId: input.tenantId,
    providerId: input.providerId,
    decidedBy: 'system:complaint-threshold',
    rationale: `Weighted complaint score reached ${weightedScore} in the current review window, at or above the threshold of ${COMPLAINT_FLAG_THRESHOLD}. Flagged for board review; recommendations are paused until it concludes.`,
    actor: input.actor,
  });

  return ok({
    complaintId: complaint.id,
    weightedScore,
    thresholdCrossed: true,
    governance: flagged.status === 'ok' ? flagged.value : null,
  });
};

/**
 * Weighted complaint score since the window opened.
 *
 * Recomputed from the complaint rows rather than incremented on the governance record. The
 * running count on the record is a convenience for reads; this is the figure decisions are
 * made on, because a stored counter and its source rows drift the first time a window resets
 * mid-write - and the stored one is the one that would silently be wrong.
 */
export const windowScore = async (
  tenantId: string,
  providerId: string,
  windowStart: Date | null,
): Promise<number> => {
  const rows = await db().providerComplaint.findMany({
    where: {
      tenantId,
      providerId,
      ...(windowStart !== null ? { receivedAt: { gte: windowStart } } : {}),
    },
    select: { severity: true },
  });

  return rows.reduce(
    (total, row) => total + COMPLAINT_WEIGHTS[row.severity as ComplaintSeverity],
    0,
  );
};

export interface ComplaintRecord {
  readonly id: string;
  readonly providerId: string;
  readonly source: string;
  readonly summary: string;
  readonly severity: ComplaintSeverity;
  readonly receivedAt: string;
}

/**
 * Complaint history for a provider - blueprint 5.2 lists this on the provider profile, and
 * 5.2 reads it through here rather than by cross-schema join. Specification 5.1.
 */
export const complaintHistory = async (
  tenantId: string,
  providerId: string,
): Promise<readonly ComplaintRecord[]> => {
  const rows = await db().providerComplaint.findMany({
    where: { tenantId, providerId },
    orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    source: row.source,
    summary: row.summary,
    severity: row.severity as ComplaintSeverity,
    receivedAt: row.receivedAt.toISOString(),
  }));
};
