/**
 * The attempt record - blueprint 5.5.
 *
 * **The whole module exists because of one shape, and the shape is the point.** Every table in this
 * system that touched placement before today recorded an *approval*: `billing.funding_outcomes` has
 * an approved credit limit and an approval date and no column at all for a denial. 9.1 read that,
 * saw a denominator that could only be the numerator, and refused to publish an approval rate -
 * correctly, because a rate computed from it reads 100% forever, and "our approval rate is 100%" is
 * the exact claim 7.4 bans and 6.2 exists downstream of.
 *
 * So the record here is an ATTEMPT. A decline is a row. A withdrawal is a row. The denominator is
 * the thing that was missing, not the arithmetic.
 *
 * Three rules shape the file.
 *
 *  1. **`requestedCents` and `approvedCreditLimitCents` are different facts and neither defaults to
 *     the other.** The Seek Capital lesson in its original form. A success fee computed against what
 *     was *asked for* rather than what was *granted* overbills every client whose approval came in
 *     under their request, and it reads as a rounding difference in every report that would catch
 *     it. There is no parameter here that sets both.
 *
 *  2. **Recording a decision writes every consequence of it, synchronously.** An approval produces
 *     the `billing.funding_outcomes` row the 60-day refund trigger runs against, and every decision
 *     produces the 5.2 `LenderOutcome` row the approval-rate tracker runs on. Neither is left for a
 *     caller to remember. ADR-0034 is the reason: `autoListForComplianceFail` was exported, tested
 *     and called by nothing for the whole life of this system, and `recordOutcome` in 5.2 is in
 *     exactly that state today - a feedback loop with no production caller. This closes it.
 *
 *  3. **Null is not zero and pending is not declined.** An attempt sitting with a provider counts in
 *     neither half of a rate. A declined attempt has no approved amount rather than an approved
 *     amount of nothing.
 *
 * Time to approval and time to funding are derived on read. A stored duration is a second copy of a
 * fact already in the row, and it goes stale the moment somebody corrects a date.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { recordFundingOutcome, markFunded as markBillingFunded, type Cents } from '@bwc/billing';
import { recordOutcome as recordLenderOutcome, type ProductKind } from '@bwc/lenders';

export type AttemptOutcome = 'pending' | 'approved' | 'declined' | 'withdrawn';
export type Satisfaction = 'not_asked' | 'delighted' | 'satisfied' | 'dissatisfied';

/**
 * Outcomes that count in the denominator of an approval rate.
 *
 * `pending` is excluded because it has not happened yet; `withdrawn` because it never will. Counting
 * a withdrawal as a non-approval makes a provider look worse the more clients change their minds,
 * which is the reasoning 5.2 already applies to its own rate and is repeated here rather than
 * imported, because the two rates are computed over different tables and a shared constant would
 * hide that they could drift.
 */
export const DECIDED_OUTCOMES = [
  'approved',
  'declined',
] as const satisfies readonly AttemptOutcome[];

const DAY_MS = 24 * 60 * 60 * 1000;

const wholeDaysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);

export interface Attempt {
  readonly id: string;
  readonly clientId: string;
  readonly engagementId: string;
  readonly providerId: string;
  readonly productKind: ProductKind;
  readonly requestedCents: number;
  readonly submittedAt: string;
  readonly outcome: AttemptOutcome;
  readonly decidedAt: string | null;
  /** Null unless approved. Never a zero standing in for "no approval". */
  readonly approvedCreditLimitCents: number | null;
  readonly declineReason: string | null;
  readonly fundedOn: string | null;
  readonly fundedCents: number | null;
  readonly clientProfileKey: string;
  readonly underwritingNotes: string | null;
  readonly nextRecommendedMove: string | null;
  readonly satisfaction: Satisfaction;
  /** Derived. Null while undecided - not zero, which would read as "approved instantly". */
  readonly daysToApproval: number | null;
  /** Derived. Null until funded. */
  readonly daysToFunding: number | null;
  /** Derived: approved, still unfunded, and past the window 1.4's refund trigger names. */
  readonly approvedAndUnfunded: boolean;
}

interface AttemptRow {
  id: string;
  clientId: string;
  engagementId: string;
  providerId: string;
  productKind: string;
  requestedCents: number;
  submittedAt: Date;
  outcome: string;
  decidedAt: Date | null;
  approvedCreditLimitCents: number | null;
  declineReason: string | null;
  fundedOn: Date | null;
  fundedCents: number | null;
  clientProfileKey: string;
  underwritingNotes: string | null;
  nextRecommendedMove: string | null;
  satisfaction: string;
}

/**
 * Blueprint 5.5: "refund logic trigger when approved capital fails to fund within 60 days".
 *
 * The same sixty days 1.4 already counts, and deliberately the same number rather than a second
 * one - two windows that were meant to agree and drifted apart would produce a client the ledger
 * says is owed a refund and billing says is not.
 */
export const APPROVED_NOT_FUNDED_DAYS = 60;

const toAttempt = (row: AttemptRow, now: Date): Attempt => ({
  id: row.id,
  clientId: row.clientId,
  engagementId: row.engagementId,
  providerId: row.providerId,
  productKind: row.productKind as ProductKind,
  requestedCents: row.requestedCents,
  submittedAt: row.submittedAt.toISOString(),
  outcome: row.outcome as AttemptOutcome,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  approvedCreditLimitCents: row.approvedCreditLimitCents,
  declineReason: row.declineReason,
  fundedOn: row.fundedOn?.toISOString() ?? null,
  fundedCents: row.fundedCents,
  clientProfileKey: row.clientProfileKey,
  underwritingNotes: row.underwritingNotes,
  nextRecommendedMove: row.nextRecommendedMove,
  satisfaction: row.satisfaction as Satisfaction,
  daysToApproval:
    row.outcome === 'approved' && row.decidedAt !== null
      ? wholeDaysBetween(row.submittedAt, row.decidedAt)
      : null,
  daysToFunding:
    row.fundedOn !== null && row.decidedAt !== null
      ? wholeDaysBetween(row.decidedAt, row.fundedOn)
      : null,
  approvedAndUnfunded:
    row.outcome === 'approved' &&
    row.fundedOn === null &&
    row.decidedAt !== null &&
    wholeDaysBetween(row.decidedAt, now) > APPROVED_NOT_FUNDED_DAYS,
});

export interface SubmitAttemptInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly engagementId: string;
  readonly providerId: string;
  readonly productKind: ProductKind;
  /** What the client asked for. This figure never becomes an approved amount. */
  readonly requestedCents: Cents;
  readonly clientProfileKey: string;
  readonly submittedAt: Date;
  readonly recordedBy: string;
  readonly actor: EventActor;
  readonly underwritingNotes?: string;
}

/**
 * Open an attempt.
 *
 * Recorded at submission rather than at decision, because "time to approval" is a question 5.5 is
 * asked and it cannot be answered by a record that starts existing when the answer arrives. It also
 * means an application that is never decided is visible as an application that was never decided,
 * rather than as nothing at all.
 */
export const submitAttempt = async (input: SubmitAttemptInput): Promise<Outcome<Attempt>> => {
  if (!Number.isInteger(input.requestedCents) || input.requestedCents <= 0) {
    return refused(
      'A funding attempt needs a requested amount in whole cents above zero. An application for nothing is not an application.',
      'Blueprint 5.5 with 1.4 - money is an integer number of cents',
    );
  }
  if (input.clientProfileKey.trim() === '') {
    return refused(
      'A funding attempt needs the cohort key it was submitted under, so the outcome can be compared with attempts like it. Compute it with 5.2 `profileKey`.',
      'Blueprint 5.5 - cohort analysis',
    );
  }

  const row = await db().fundingAttempt.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      engagementId: input.engagementId,
      providerId: input.providerId,
      productKind: input.productKind as never,
      requestedCents: input.requestedCents,
      submittedAt: input.submittedAt,
      clientProfileKey: input.clientProfileKey,
      underwritingNotes: input.underwritingNotes ?? null,
      recordedBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'outcomes.attempt.submitted',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      attemptId: row.id,
      providerId: input.providerId,
      productKind: input.productKind,
      requestedCents: input.requestedCents,
      clientProfileKey: input.clientProfileKey,
    },
  });

  return ok(toAttempt(row, input.submittedAt));
};

/** Read an attempt, or say plainly that there is no such attempt in this tenant. */
export const findAttempt = async (
  tenantId: string,
  attemptId: string,
  now: Date = new Date(),
): Promise<Outcome<Attempt>> => {
  const row = await db().fundingAttempt.findFirst({ where: { tenantId, id: attemptId } });
  return row ? ok(toAttempt(row, now)) : noData('No such funding attempt in this tenant.');
};

const alreadyDecided = (row: { outcome: string; decidedAt: Date | null }): boolean =>
  row.outcome !== 'pending';

/**
 * Feed the decision back into 5.2.
 *
 * Called from inside each decision function rather than beside them. 5.2's `recordOutcome` has been
 * exported, tested and called by nothing since it was written - the same state ADR-0034 found
 * `autoListForComplianceFail` in, and the same fix: there is no way to record a decision here
 * without the appetite tracker learning about it.
 *
 * A failure to write it is reported rather than swallowed. The attempt row and its Ledger event are
 * already written and the Ledger is append-only, so nothing can be rolled back - what must not
 * happen is a caller believing 5.2 has a fact it does not.
 */
const feedBackToLenderIntelligence = async (input: {
  tenantId: string;
  providerId: string;
  productKind: ProductKind;
  clientProfileKey: string;
  outcome: 'approved' | 'declined' | 'withdrawn';
  decidedAt: Date;
  actor: EventActor;
}): Promise<Outcome<{ id: string }>> =>
  recordLenderOutcome({
    tenantId: input.tenantId,
    providerId: input.providerId,
    productKind: input.productKind,
    clientProfileKey: input.clientProfileKey,
    outcome: input.outcome,
    decidedAt: input.decidedAt,
    actor: input.actor,
  });

export interface ApproveInput {
  readonly tenantId: string;
  readonly attemptId: string;
  /**
   * What the provider granted.
   *
   * There is no parameter that copies the requested figure into this one, and there will not be.
   * `approvedCreditLimit` is the only figure a success fee may compute against, and the failure
   * mode this guards is invisible in every report: a fee against what was asked for looks exactly
   * like a fee against what was granted, only larger.
   */
  readonly approvedCreditLimitCents: Cents;
  readonly decidedAt: Date;
  readonly actor: EventActor;
  readonly nextRecommendedMove?: string;
}

/**
 * Record an approval.
 *
 * Writes three things and gives the caller no way to write two of them: the attempt row, the
 * `billing.funding_outcomes` row the 60-day refund trigger runs against, and the 5.2 outcome the
 * approval-rate tracker runs on. An approval recorded here but not in billing is a refund that
 * never fires, and the client owed it is by construction the one least likely to chase it.
 */
export const approveAttempt = async (input: ApproveInput): Promise<Outcome<Attempt>> => {
  if (!Number.isInteger(input.approvedCreditLimitCents) || input.approvedCreditLimitCents <= 0) {
    return refused(
      'An approval needs an approved amount in whole cents above zero. An approval for nothing is a decline, and it should be recorded as one so the reason survives.',
      'Blueprint 5.5 - approvedCreditLimit is what was granted',
    );
  }

  const existing = await db().fundingAttempt.findFirst({
    where: { tenantId: input.tenantId, id: input.attemptId },
  });
  if (!existing) return noData('No such funding attempt in this tenant.');
  if (alreadyDecided(existing)) {
    return refused(
      `This attempt was already decided (${existing.outcome}). Record a second application to the same provider as a second attempt, so both decisions survive.`,
      'Blueprint 5.5 - one outcome per attempt',
    );
  }
  if (input.decidedAt.getTime() < existing.submittedAt.getTime()) {
    return refused(
      'An attempt cannot be decided before it was submitted. Check the dates: time to approval is computed from them and a negative one would be published.',
      'Blueprint 5.5 - time to approval',
    );
  }

  const billing = await recordFundingOutcome({
    tenantId: input.tenantId,
    engagementId: existing.engagementId,
    clientId: existing.clientId,
    provider: existing.providerId,
    approvedCreditLimitCents: input.approvedCreditLimitCents,
    approvedOn: input.decidedAt,
    actor: input.actor,
  });
  if (billing.status !== 'ok') return billing;

  const row = await db().fundingAttempt.update({
    where: { id: existing.id },
    data: {
      outcome: 'approved' as never,
      decidedAt: input.decidedAt,
      approvedCreditLimitCents: input.approvedCreditLimitCents,
      billingOutcomeId: billing.value.id,
      nextRecommendedMove: input.nextRecommendedMove ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'outcomes.attempt.approved',
    actor: input.actor,
    clientId: existing.clientId,
    payload: {
      attemptId: existing.id,
      providerId: existing.providerId,
      productKind: existing.productKind,
      requestedCents: existing.requestedCents,
      approvedCreditLimitCents: input.approvedCreditLimitCents,
      daysToApproval: wholeDaysBetween(existing.submittedAt, input.decidedAt),
    },
  });

  const fedBack = await feedBackToLenderIntelligence({
    tenantId: input.tenantId,
    providerId: existing.providerId,
    productKind: existing.productKind as ProductKind,
    clientProfileKey: existing.clientProfileKey,
    outcome: 'approved',
    decidedAt: input.decidedAt,
    actor: input.actor,
  });
  if (fedBack.status !== 'ok') {
    return {
      status: 'failed',
      reason:
        "The approval was recorded and billed, and 5.2 was not told about it - so this provider's approval rate is now short one approval until somebody replays it.",
      cause: fedBack.status,
    };
  }

  return ok(toAttempt(row, input.decidedAt));
};

export interface DeclineInput {
  readonly tenantId: string;
  readonly attemptId: string;
  /** In the provider's words where they gave them. Required - see the refusal below. */
  readonly reason: string;
  readonly decidedAt: Date;
  readonly actor: EventActor;
  readonly nextRecommendedMove?: string;
}

/**
 * Record a decline.
 *
 * **This is the row that did not exist, and it is the reason this module was built.** A decline with
 * no stated reason teaches 5.2 nothing about appetite and leaves the client with no explanation to
 * put in an adverse-action notice, so the reason is required rather than optional.
 */
export const declineAttempt = async (input: DeclineInput): Promise<Outcome<Attempt>> => {
  if (input.reason.trim().length < 5) {
    return refused(
      'A decline needs a reason somebody can read back. It is what 5.2 learns appetite from and what the client is owed as an explanation.',
      'Blueprint 5.5 - declined reason, with 5.2 appetite signals',
    );
  }

  const existing = await db().fundingAttempt.findFirst({
    where: { tenantId: input.tenantId, id: input.attemptId },
  });
  if (!existing) return noData('No such funding attempt in this tenant.');
  if (alreadyDecided(existing)) {
    return refused(
      `This attempt was already decided (${existing.outcome}).`,
      'Blueprint 5.5 - one outcome per attempt',
    );
  }
  if (input.decidedAt.getTime() < existing.submittedAt.getTime()) {
    return refused(
      'An attempt cannot be decided before it was submitted.',
      'Blueprint 5.5 - time to approval',
    );
  }

  const row = await db().fundingAttempt.update({
    where: { id: existing.id },
    data: {
      outcome: 'declined' as never,
      decidedAt: input.decidedAt,
      declineReason: input.reason,
      nextRecommendedMove: input.nextRecommendedMove ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'outcomes.attempt.declined',
    actor: input.actor,
    clientId: existing.clientId,
    payload: {
      attemptId: existing.id,
      providerId: existing.providerId,
      productKind: existing.productKind,
      requestedCents: existing.requestedCents,
      // The reason itself stays in the row. It is free text a provider wrote about a named
      // applicant, and the Ledger is the one store here that cannot be corrected.
      daysToDecision: wholeDaysBetween(existing.submittedAt, input.decidedAt),
    },
  });

  const fedBack = await feedBackToLenderIntelligence({
    tenantId: input.tenantId,
    providerId: existing.providerId,
    productKind: existing.productKind as ProductKind,
    clientProfileKey: existing.clientProfileKey,
    outcome: 'declined',
    decidedAt: input.decidedAt,
    actor: input.actor,
  });
  if (fedBack.status !== 'ok') {
    return {
      status: 'failed',
      reason:
        "The decline was recorded and 5.2 was not told about it, so this provider's approval rate is now flattered by one decline until somebody replays it.",
      cause: fedBack.status,
    };
  }

  return ok(toAttempt(row, input.decidedAt));
};

/**
 * Record a withdrawal.
 *
 * Counted in neither half of a rate, and recorded anyway: an attempt the client pulled is a fact
 * about the engagement even though it is not a fact about the provider.
 */
export const withdrawAttempt = async (input: {
  tenantId: string;
  attemptId: string;
  reason: string;
  decidedAt: Date;
  actor: EventActor;
}): Promise<Outcome<Attempt>> => {
  const existing = await db().fundingAttempt.findFirst({
    where: { tenantId: input.tenantId, id: input.attemptId },
  });
  if (!existing) return noData('No such funding attempt in this tenant.');
  if (alreadyDecided(existing)) {
    return refused(
      `This attempt was already decided (${existing.outcome}).`,
      'Blueprint 5.5 - one outcome per attempt',
    );
  }

  const row = await db().fundingAttempt.update({
    where: { id: existing.id },
    data: {
      outcome: 'withdrawn' as never,
      decidedAt: input.decidedAt,
      declineReason: null,
      nextRecommendedMove: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'outcomes.attempt.withdrawn',
    actor: input.actor,
    clientId: existing.clientId,
    payload: { attemptId: existing.id, providerId: existing.providerId },
  });

  const fedBack = await feedBackToLenderIntelligence({
    tenantId: input.tenantId,
    providerId: existing.providerId,
    productKind: existing.productKind as ProductKind,
    clientProfileKey: existing.clientProfileKey,
    outcome: 'withdrawn',
    decidedAt: input.decidedAt,
    actor: input.actor,
  });
  if (fedBack.status !== 'ok') {
    return {
      status: 'failed',
      reason: 'The withdrawal was recorded here and not in 5.2.',
      cause: fedBack.status,
    };
  }

  return ok(toAttempt(row, input.decidedAt));
};

/**
 * Record that approved capital actually landed.
 *
 * Retires the 60-day refund entitlement, which is why it writes through to billing rather than only
 * here: 1.4's `refundsDue` reads its own table, and an attempt marked funded in 5.5 alone would
 * leave a refund owing that nobody owes.
 *
 * `fundedCents` may legitimately differ from the approved limit - a client can draw less than they
 * were granted - so it is its own figure and not a copy.
 */
export const markAttemptFunded = async (input: {
  tenantId: string;
  attemptId: string;
  fundedOn: Date;
  fundedCents: Cents;
  actor: EventActor;
}): Promise<Outcome<Attempt>> => {
  if (!Number.isInteger(input.fundedCents) || input.fundedCents <= 0) {
    return refused(
      'A funding needs an amount in whole cents above zero. Capital that did not arrive is an approval that has not funded, which is already what the record says.',
      'Blueprint 5.5 with 1.4 - money is an integer number of cents',
    );
  }

  const existing = await db().fundingAttempt.findFirst({
    where: { tenantId: input.tenantId, id: input.attemptId },
  });
  if (!existing) return noData('No such funding attempt in this tenant.');
  if (existing.outcome !== 'approved') {
    return refused(
      `Only an approved attempt can fund. This one is '${existing.outcome}'.`,
      'Blueprint 5.5 - funding follows approval',
    );
  }
  if (existing.fundedOn !== null) {
    return refused(
      `This attempt already funded on ${existing.fundedOn.toISOString().slice(0, 10)}.`,
      'Blueprint 5.5 - one funding per attempt',
    );
  }
  if (existing.decidedAt !== null && input.fundedOn.getTime() < existing.decidedAt.getTime()) {
    return refused(
      'Capital cannot fund before it was approved. Check the dates: time to funding is computed from them.',
      'Blueprint 5.5 - time to funding',
    );
  }

  if (existing.billingOutcomeId !== null) {
    const billed = await markBillingFunded({
      tenantId: input.tenantId,
      outcomeId: existing.billingOutcomeId,
      fundedOn: input.fundedOn,
      fundedCents: input.fundedCents,
      actor: input.actor,
    });
    if (billed.status !== 'ok') return billed;
  }

  const row = await db().fundingAttempt.update({
    where: { id: existing.id },
    data: { fundedOn: input.fundedOn, fundedCents: input.fundedCents },
  });

  await append({
    tenantId: input.tenantId,
    type: 'outcomes.attempt.funded',
    actor: input.actor,
    clientId: existing.clientId,
    payload: {
      attemptId: existing.id,
      providerId: existing.providerId,
      fundedCents: input.fundedCents,
      approvedCreditLimitCents: existing.approvedCreditLimitCents,
      daysToFunding:
        existing.decidedAt === null ? null : wholeDaysBetween(existing.decidedAt, input.fundedOn),
    },
  });

  return ok(toAttempt(row, input.fundedOn));
};

/**
 * Record what the client thought.
 *
 * Separate from every other write because it arrives separately - weeks later, from a person, about
 * an outcome already recorded. Categorical, and `not_asked` is the state a row starts in rather than
 * a value somebody has to remember to set.
 */
export const recordSatisfaction = async (input: {
  tenantId: string;
  attemptId: string;
  satisfaction: Exclude<Satisfaction, 'not_asked'>;
}): Promise<Outcome<Attempt>> => {
  const existing = await db().fundingAttempt.findFirst({
    where: { tenantId: input.tenantId, id: input.attemptId },
  });
  if (!existing) return noData('No such funding attempt in this tenant.');

  const row = await db().fundingAttempt.update({
    where: { id: existing.id },
    data: { satisfaction: input.satisfaction as never },
  });
  return ok(toAttempt(row, new Date()));
};

/** Every attempt for a client, oldest first. */
export const attemptsForClient = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<readonly Attempt[]> => {
  const rows = await db().fundingAttempt.findMany({
    where: { tenantId, clientId },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toAttempt(row, now));
};

/**
 * Approvals that have not funded inside the window.
 *
 * The queue behind blueprint 5.5's "refund logic trigger". It reports; 1.4 decides what is owed,
 * because entitlement is computed against the fee that was actually charged and that lives there.
 */
export const approvedAndUnfunded = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Attempt[]> => {
  const rows = await db().fundingAttempt.findMany({
    where: { tenantId, outcome: 'approved', fundedOn: null },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toAttempt(row, now)).filter((attempt) => attempt.approvedAndUnfunded);
};
