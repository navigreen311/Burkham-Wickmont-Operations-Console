/**
 * The Capital Product Governance Board - blueprint 5.4.
 *
 * The approval workflow a provider passes before any agent may recommend it. Every
 * transition writes two records: a `GovernanceDecision` row (the board's own minute book)
 * and a Ledger event (the tenant-wide chain). Both, deliberately - the decision row carries
 * the from/to states and rationale in queryable form, and the ledger entry puts the decision
 * in the same hash chain as everything else that happened that day, which is what makes a
 * "who approved this and when" question answerable without trusting this schema.
 *
 * Decision D is enforced here rather than at registration. Recording what we know about
 * PenFed is the V1.5 research work and should not be blocked; deciding that agents may place
 * clients there is a different act, and it is the one V1 restricts.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { isWithinV1CreditUnionScope, providerById } from '@bwc/lenders';
import { noData, ok, refused, type EventActor, type EventType, type Outcome } from '@bwc/core';
import {
  MAXIMUM_REVIEW_CADENCE_DAYS,
  standing,
  type GovernanceSnapshot,
  type GovernanceStatus,
  type Standing,
} from './standing.js';

export interface GovernanceRecord {
  readonly providerId: string;
  readonly status: GovernanceStatus;
  readonly lastReviewedAt: string | null;
  readonly reviewCadenceDays: number;
  readonly approvedStates: readonly string[];
  readonly restrictedStates: readonly string[];
  readonly requiredDisclosures: readonly string[];
  readonly complaintCount: number;
  readonly blacklistReason: string | null;
}

interface GovernanceRow {
  providerId: string;
  status: string;
  lastReviewedAt: Date | null;
  reviewCadenceDays: number;
  approvedStates: string[];
  restrictedStates: string[];
  requiredDisclosures: string[];
  complaintCount: number;
  blacklistReason: string | null;
}

const toRecord = (row: GovernanceRow): GovernanceRecord => ({
  providerId: row.providerId,
  status: row.status as GovernanceStatus,
  lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
  reviewCadenceDays: row.reviewCadenceDays,
  approvedStates: row.approvedStates,
  restrictedStates: row.restrictedStates,
  requiredDisclosures: row.requiredDisclosures,
  complaintCount: row.complaintCount,
  blacklistReason: row.blacklistReason,
});

const toSnapshot = (row: GovernanceRow): GovernanceSnapshot => ({
  providerId: row.providerId,
  status: row.status as GovernanceStatus,
  lastReviewedAt: row.lastReviewedAt,
  reviewCadenceDays: row.reviewCadenceDays,
  approvedStates: row.approvedStates,
  restrictedStates: row.restrictedStates,
  blacklistReason: row.blacklistReason,
  requiredDisclosures: row.requiredDisclosures,
});

/** Record a decision in the board's minute book and in the tenant ledger. */
const recordDecision = async (input: {
  tenantId: string;
  providerId: string;
  fromStatus: GovernanceStatus | null;
  toStatus: GovernanceStatus;
  rationale: string;
  decidedBy: string;
  actor: EventActor;
  eventType: EventType;
  extraPayload?: Record<string, unknown>;
}): Promise<void> => {
  await db().governanceDecision.create({
    data: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      fromStatus: (input.fromStatus ?? null) as never,
      toStatus: input.toStatus as never,
      rationale: input.rationale,
      decidedBy: input.decidedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: input.eventType,
    actor: input.actor,
    payload: {
      providerId: input.providerId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      decidedBy: input.decidedBy,
      rationale: input.rationale,
      ...(input.extraPayload ?? {}),
    },
  });
};

export interface SubmitInput {
  readonly tenantId: string;
  readonly providerId: string;
  readonly submittedBy: string;
  readonly rationale: string;
  readonly actor: EventActor;
}

/** Open a governance file on a provider. Creates the record in `pending_review`. */
export const submitForReview = async (input: SubmitInput): Promise<Outcome<GovernanceRecord>> => {
  const provider = await providerById(input.tenantId, input.providerId);
  if (provider.status !== 'ok') return provider as Outcome<GovernanceRecord>;

  const existing = await db().providerGovernance.findFirst({
    where: { tenantId: input.tenantId, providerId: input.providerId },
  });

  const row = await db().providerGovernance.upsert({
    where: {
      tenantId_providerId: { tenantId: input.tenantId, providerId: input.providerId },
    },
    create: { tenantId: input.tenantId, providerId: input.providerId, status: 'pending_review' },
    update: { status: 'pending_review' },
  });

  await recordDecision({
    tenantId: input.tenantId,
    providerId: input.providerId,
    fromStatus: (existing?.status as GovernanceStatus | undefined) ?? null,
    toStatus: 'pending_review',
    rationale: input.rationale,
    decidedBy: input.submittedBy,
    actor: input.actor,
    eventType: 'governance.provider.submitted',
    extraPayload: { providerName: provider.value.name },
  });

  return ok(toRecord(row));
};

export interface ApproveInput {
  readonly tenantId: string;
  readonly providerId: string;
  readonly approvedBy: string;
  readonly rationale: string;
  readonly actor: EventActor;
  /** Restrict approval to these states. Empty means no restriction beyond the provider's own. */
  readonly approvedStates?: readonly string[];
  readonly restrictedStates?: readonly string[];
  readonly requiredDisclosures?: readonly string[];
  readonly referralAgreementRef?: string;
  /** Shorter than the 90-day maximum for a higher-risk provider. Never longer. */
  readonly reviewCadenceDays?: number;
  readonly now?: Date;
}

/**
 * Approve a provider for recommendation.
 *
 * Four refusals, each protecting something different:
 *
 *  - **No rationale.** A decision nobody can explain cannot be appealed, taught, or revisited
 *    when the provider fixes the problem. Same reasoning as a banned marketing phrase.
 *  - **Decision D.** A credit union other than Navy Federal cannot be approved in V1, by name
 *    and citing the decision, so the refusal is traceable to the rule rather than to an
 *    anonymous guard.
 *  - **Cadence longer than quarterly.** Blueprint 5.4 says "quarterly minimum"; a caller
 *    asking for 180 days is asking for the guarantee to be weaker than specified, and
 *    silently clamping would hide that they tried.
 *  - **Approving out of blacklist.** A blacklisted provider must be explicitly reinstated
 *    first, so the reversal is its own decision with its own rationale rather than a side
 *    effect of a routine approval.
 */
export const approve = async (input: ApproveInput): Promise<Outcome<GovernanceRecord>> => {
  if (input.rationale.trim() === '') {
    return refused(
      'A governance approval needs a rationale.',
      'Blueprint 5.4 - audit trail on every decision; a decision nobody can explain calcifies into folklore',
    );
  }

  const provider = await providerById(input.tenantId, input.providerId);
  if (provider.status !== 'ok') return provider as Outcome<GovernanceRecord>;

  if (!isWithinV1CreditUnionScope(provider.value.kind, provider.value.name)) {
    return refused(
      `'${provider.value.name}' is a credit union outside V1 scope. V1 credit-union placement is restricted to Navy Federal; the others are in the V1.5 research workstream and cannot be approved until that research completes and the restriction is lifted.`,
      'Decision D - V1 CU placement restricted to Navy Federal only',
    );
  }

  if (
    input.reviewCadenceDays !== undefined &&
    input.reviewCadenceDays > MAXIMUM_REVIEW_CADENCE_DAYS
  ) {
    return refused(
      `A review cadence of ${input.reviewCadenceDays} days exceeds the ${MAXIMUM_REVIEW_CADENCE_DAYS}-day maximum.`,
      'Blueprint 5.4 - periodic re-review cadence, quarterly minimum',
    );
  }

  const existing = await db().providerGovernance.findFirst({
    where: { tenantId: input.tenantId, providerId: input.providerId },
  });

  if (existing?.status === 'blacklisted') {
    return refused(
      `'${provider.value.name}' is blacklisted (${existing.blacklistReason ?? 'no reason recorded'}) and must be explicitly reinstated before it can be approved.`,
      'Blueprint 5.4 - reversing a blacklist is its own decision, not a side effect of an approval',
    );
  }

  const now = input.now ?? new Date();

  const row = await db().providerGovernance.upsert({
    where: {
      tenantId_providerId: { tenantId: input.tenantId, providerId: input.providerId },
    },
    create: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      status: 'approved',
      lastReviewedAt: now,
      reviewCadenceDays: input.reviewCadenceDays ?? MAXIMUM_REVIEW_CADENCE_DAYS,
      approvedStates: [...(input.approvedStates ?? [])],
      restrictedStates: [...(input.restrictedStates ?? [])],
      requiredDisclosures: [...(input.requiredDisclosures ?? [])],
      referralAgreementRef: input.referralAgreementRef ?? null,
      // Approval resets the complaint window: the board has just weighed what came in.
      complaintCount: 0,
      complaintWindowStart: now,
    },
    update: {
      status: 'approved',
      lastReviewedAt: now,
      reviewCadenceDays: input.reviewCadenceDays ?? MAXIMUM_REVIEW_CADENCE_DAYS,
      approvedStates: [...(input.approvedStates ?? [])],
      restrictedStates: [...(input.restrictedStates ?? [])],
      requiredDisclosures: [...(input.requiredDisclosures ?? [])],
      referralAgreementRef: input.referralAgreementRef ?? null,
      complaintCount: 0,
      complaintWindowStart: now,
    },
  });

  await recordDecision({
    tenantId: input.tenantId,
    providerId: input.providerId,
    fromStatus: (existing?.status as GovernanceStatus | undefined) ?? null,
    toStatus: 'approved',
    rationale: input.rationale,
    decidedBy: input.approvedBy,
    actor: input.actor,
    eventType: 'governance.provider.approved',
    extraPayload: {
      providerName: provider.value.name,
      approvedStates: input.approvedStates ?? [],
      restrictedStates: input.restrictedStates ?? [],
    },
  });

  return ok(toRecord(row));
};

/** Re-review an approved provider without changing its terms. Resets the cadence clock. */
export const recordReview = async (input: {
  tenantId: string;
  providerId: string;
  reviewedBy: string;
  rationale: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<GovernanceRecord>> => {
  const existing = await db().providerGovernance.findFirst({
    where: { tenantId: input.tenantId, providerId: input.providerId },
  });
  if (!existing) {
    return noData(
      'This provider has no governance record, so there is nothing to re-review. Submit it for review first.',
    );
  }

  const now = input.now ?? new Date();
  const row = await db().providerGovernance.update({
    where: { id: existing.id },
    data: { lastReviewedAt: now, complaintCount: 0, complaintWindowStart: now },
  });

  await recordDecision({
    tenantId: input.tenantId,
    providerId: input.providerId,
    fromStatus: existing.status as GovernanceStatus,
    toStatus: existing.status as GovernanceStatus,
    rationale: input.rationale,
    decidedBy: input.reviewedBy,
    actor: input.actor,
    eventType: 'governance.provider.reviewed',
  });

  return ok(toRecord(row));
};

export interface StatusChangeInput {
  readonly tenantId: string;
  readonly providerId: string;
  readonly decidedBy: string;
  readonly rationale: string;
  readonly actor: EventActor;
}

const transition = async (
  input: StatusChangeInput,
  toStatus: GovernanceStatus,
  eventType: EventType,
  extra?: { blacklistReason?: string },
): Promise<Outcome<GovernanceRecord>> => {
  if (input.rationale.trim() === '') {
    return refused(
      `A transition to ${toStatus} needs a rationale.`,
      'Blueprint 5.4 - audit trail on every decision',
    );
  }

  const existing = await db().providerGovernance.findFirst({
    where: { tenantId: input.tenantId, providerId: input.providerId },
  });
  if (!existing) {
    return noData(
      'This provider has no governance record. Submit it for review before changing its status.',
    );
  }

  const row = await db().providerGovernance.update({
    where: { id: existing.id },
    data: {
      status: toStatus as never,
      ...(extra?.blacklistReason !== undefined ? { blacklistReason: extra.blacklistReason } : {}),
    },
  });

  await recordDecision({
    tenantId: input.tenantId,
    providerId: input.providerId,
    fromStatus: existing.status as GovernanceStatus,
    toStatus,
    rationale: input.rationale,
    decidedBy: input.decidedBy,
    actor: input.actor,
    eventType,
  });

  return ok(toRecord(row));
};

export const flagForReview = (input: StatusChangeInput): Promise<Outcome<GovernanceRecord>> =>
  transition(input, 'under_review', 'governance.provider.flagged');

export const suspend = (input: StatusChangeInput): Promise<Outcome<GovernanceRecord>> =>
  transition(input, 'suspended', 'governance.provider.suspended');

/**
 * Blacklist. Propagates to 5.3 immediately, because 5.3 reads standing at request time
 * rather than caching an approved list - there is no propagation step that can lag.
 */
export const blacklist = (input: StatusChangeInput): Promise<Outcome<GovernanceRecord>> =>
  transition(input, 'blacklisted', 'governance.provider.blacklisted', {
    blacklistReason: input.rationale,
  });

/**
 * Lift a blacklist back to `pending_review` - never straight to approved.
 *
 * Reinstatement restores the provider's candidacy, not its approval. A provider that was
 * blacklisted has to be looked at again by someone before clients are placed with it, and
 * collapsing the two steps would let one decision do the work of two.
 */
export const reinstate = (input: StatusChangeInput): Promise<Outcome<GovernanceRecord>> =>
  transition(input, 'pending_review', 'governance.provider.reinstated');

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const governanceOf = async (
  tenantId: string,
  providerId: string,
): Promise<GovernanceRecord | null> => {
  const row = await db().providerGovernance.findFirst({ where: { tenantId, providerId } });
  return row ? toRecord(row) : null;
};

/**
 * Standing for one provider. The question 5.3 asks about every candidate.
 *
 * Note that a missing governance record is passed through as `null` rather than short-
 * circuited here: `standing()` has a blocker for exactly that case, and routing it through
 * one function keeps every "not recommendable" answer in the same shape.
 */
export const standingOf = async (
  tenantId: string,
  providerId: string,
  today: Date = new Date(),
  state?: string | null,
): Promise<Standing> => {
  const row = await db().providerGovernance.findFirst({ where: { tenantId, providerId } });
  return standing(providerId, row ? toSnapshot(row) : null, today, state);
};

/** Standing for many providers in one round trip - what 5.3 actually needs. */
export const standingFor = async (
  tenantId: string,
  providerIds: readonly string[],
  today: Date = new Date(),
  state?: string | null,
): Promise<ReadonlyMap<string, Standing>> => {
  const rows = await db().providerGovernance.findMany({
    where: { tenantId, providerId: { in: [...providerIds] } },
  });
  const byProvider = new Map(rows.map((row) => [row.providerId, toSnapshot(row)]));

  return new Map(
    providerIds.map((providerId) => [
      providerId,
      standing(providerId, byProvider.get(providerId) ?? null, today, state),
    ]),
  );
};

export interface DecisionRecord {
  readonly providerId: string;
  readonly fromStatus: GovernanceStatus | null;
  readonly toStatus: GovernanceStatus;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

/** The audit trail blueprint 5.4 requires, newest first. */
export const decisionHistory = async (
  tenantId: string,
  providerId: string,
): Promise<readonly DecisionRecord[]> => {
  const rows = await db().governanceDecision.findMany({
    where: { tenantId, providerId },
    orderBy: { decidedAt: 'desc' },
  });
  return rows.map((row) => ({
    providerId: row.providerId,
    fromStatus: (row.fromStatus as GovernanceStatus | null) ?? null,
    toStatus: row.toStatus as GovernanceStatus,
    rationale: row.rationale,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt.toISOString(),
  }));
};

/**
 * Providers whose review is due or overdue - the board's working queue.
 *
 * Computed by asking `standing()` about each approved provider rather than by a date query,
 * so the queue and the gate can never disagree about what "overdue" means.
 */
export const reviewQueue = async (
  tenantId: string,
  today: Date = new Date(),
): Promise<readonly Standing[]> => {
  const rows = await db().providerGovernance.findMany({
    where: { tenantId, status: 'approved' },
  });
  return rows
    .map((row) => standing(row.providerId, toSnapshot(row), today))
    .filter((entry) => entry.blockers.includes('review_overdue'));
};
