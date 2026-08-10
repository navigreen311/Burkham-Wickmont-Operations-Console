/**
 * Refunds - blueprint 1.4: "refund logic driven by objective triggers (60-day approved-but-unfunded,
 * engagement quality failure)."
 *
 * **Objective** is the load-bearing word, and it decides the shape of this file. A trigger is a
 * predicate over recorded facts, so entitlement is *derived* rather than requested - `refundsDue`
 * answers "what does the record say we owe" without anybody having asked.
 *
 * The asymmetry that follows is the whole design:
 *
 *   - **granting** an objectively-triggered refund needs nobody's approval, because it is already
 *     owed;
 *   - **declining** one needs a Level 3 human and a recorded reason.
 *
 * A system where refunds are discretionary is a system where refunds do not happen. And the client
 * owed one is, by construction, the client least happy about chasing it.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { atLeastZero, formatMoney, proportionOf, sum, type Cents } from './money.js';

/**
 * Blueprint 1.4 names this one directly. Sixty days from approval; the trigger fires on day 61,
 * because "within 60 days" includes the sixtieth.
 */
export const APPROVED_NOT_FUNDED_DAYS = 60;

export type RefundTrigger =
  'approved_not_funded_60_days' | 'engagement_quality_failure' | 'unearned_prepay_on_cancellation';

export interface RefundEntitlement {
  readonly engagementId: string;
  readonly clientId: string;
  readonly trigger: RefundTrigger;
  readonly amountCents: Cents;
  /** The facts that produced it, in the words an operator would use with the client. */
  readonly basis: string;
  /** Set once somebody has paid or declined it. */
  readonly resolved: 'paid' | 'declined' | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/**
 * Capital approved that did not fund within sixty days.
 *
 * The refund is of the success fee charged against that approval. It is charged on approval, and
 * an approval that never funds delivered the client nothing - so the fee is not earned, whatever
 * work went into obtaining it.
 *
 * Matched to the success-fee line by its `approvedCreditLimitCents`, which is the same figure the
 * fee was computed from. Matching on amount or on date would break the moment two approvals landed
 * in one engagement.
 */
const approvedNotFunded = async (
  tenantId: string,
  engagementId: string,
  today: Date,
): Promise<RefundEntitlement[]> => {
  const engagement = await db().engagement.findFirst({
    where: { tenantId, id: engagementId },
  });
  if (!engagement) return [];

  const outcomes = await db().fundingOutcome.findMany({ where: { tenantId, engagementId } });
  const records = await db().billingRecord.findMany({
    where: { tenantId, engagementId, kind: 'charge' },
  });

  const entitlements: RefundEntitlement[] = [];

  for (const outcome of outcomes) {
    if (outcome.fundedOn !== null) continue;

    const elapsed = daysBetween(outcome.approvedOn, today);
    if (elapsed <= APPROVED_NOT_FUNDED_DAYS) continue;

    const fee = records.find(
      (record) => record.approvedCreditLimitCents === outcome.approvedCreditLimitCents,
    );
    if (!fee) continue;

    entitlements.push({
      engagementId,
      clientId: engagement.clientId,
      trigger: 'approved_not_funded_60_days',
      amountCents: fee.amountCents,
      basis: `${outcome.provider} approved ${formatMoney(outcome.approvedCreditLimitCents)} on ${outcome.approvedOn.toISOString().slice(0, 10)} and it has not funded in ${elapsed} days. The ${formatMoney(fee.amountCents)} success fee charged against that approval is not earned.`,
      resolved: null,
    });
  }

  return entitlements;
};

/**
 * Engagement quality failure.
 *
 * **The blueprint's phrase is not objective as written**, and implementing a judgement call as
 * though it were a fact would be the worst of both: a refund that looks automatic and depends on
 * an opinion nobody recorded.
 *
 * So it is given a measurable definition here, and flagged for review rather than hidden: an
 * engagement that reached the end of its committed window having produced **no funding approval at
 * all** failed to deliver the thing it was sold to deliver. The refund is of the retainer, which is
 * the fee charged for the engagement rather than for an outcome.
 *
 * What this deliberately does not attempt: assessing whether the work was *good*. That is a
 * judgement, it belongs to the Compliance Review Board's weekly agenda, and dressing it up as a
 * computation would make it less reviewable rather than more.
 */
const qualityFailure = async (
  tenantId: string,
  engagementId: string,
  today: Date,
): Promise<RefundEntitlement[]> => {
  const engagement = await db().engagement.findFirst({
    where: { tenantId, id: engagementId },
    include: { offer: true },
  });
  if (!engagement || engagement.committedThrough === null) return [];
  if (today < engagement.committedThrough) return [];

  const approvals = await db().fundingOutcome.count({ where: { tenantId, engagementId } });
  if (approvals > 0) return [];

  const retainer = await db().billingRecord.findFirst({
    where: { tenantId, engagementId, kind: 'charge', description: { contains: 'etainer' } },
  });
  if (!retainer) return [];

  return [
    {
      engagementId,
      clientId: engagement.clientId,
      trigger: 'engagement_quality_failure',
      amountCents: retainer.amountCents,
      basis: `The committed window ended ${engagement.committedThrough.toISOString().slice(0, 10)} with no funding approval obtained. The ${formatMoney(retainer.amountCents)} retainer was charged for the engagement rather than for an outcome, and the engagement did not deliver one.`,
      resolved: null,
    },
  ];
};

/**
 * Unearned prepay on cancellation.
 *
 * An annual prepay is money received for services not yet delivered. Cancel in month four of
 * twelve and eight months of it was never earned.
 *
 * Prorated by **elapsed days rather than whole months**, because a client who cancels on the
 * second of the month has not consumed that month, and rounding a part-month up to a whole one
 * would take a month's fee for a day's service. Rounded toward the client, per the module rule.
 */
const unearnedPrepay = async (
  tenantId: string,
  engagementId: string,
): Promise<RefundEntitlement[]> => {
  const engagement = await db().engagement.findFirst({
    where: { tenantId, id: engagementId },
  });
  if (!engagement) return [];
  if (!engagement.annualPrepay) return [];
  if (engagement.status !== 'cancelled' || engagement.cancelledOn === null) return [];
  if (engagement.committedThrough === null) return [];

  const payments = await db().billingRecord.findMany({
    where: { tenantId, engagementId, kind: 'payment' },
  });
  const paid = sum(payments.map((record) => record.amountCents));
  if (paid === 0) return [];

  const termDays = daysBetween(engagement.startedOn, engagement.committedThrough);
  if (termDays <= 0) return [];

  const usedDays = Math.max(0, daysBetween(engagement.startedOn, engagement.cancelledOn));
  const unusedDays = atLeastZero(termDays - usedDays);
  if (unusedDays === 0) return [];

  const amount = proportionOf(paid, unusedDays, termDays, 'toward_client');
  if (amount <= 0) return [];

  return [
    {
      engagementId,
      clientId: engagement.clientId,
      trigger: 'unearned_prepay_on_cancellation',
      amountCents: amount,
      basis: `Prepaid ${formatMoney(paid)} for a ${termDays}-day term and cancelled after ${usedDays} days. ${unusedDays} days were paid for and not delivered.`,
      resolved: null,
    },
  ];
};

/**
 * Everything the record says is owed on this engagement.
 *
 * Derived rather than stored - the fourth appearance of that reasoning in this codebase
 * (ADR-0007, 0009, 0010). A stored "refund owed" flag needs a job to set it, and a job that stops
 * leaves a client owed money that nothing in the system mentions again.
 *
 * Entitlements already paid or declined come back with `resolved` set rather than being filtered
 * out: an operator reviewing an engagement needs to see that a refund was declined, and a list that
 * silently omitted it would make the decline invisible to everyone except whoever made it.
 */
export const refundsDue = async (
  tenantId: string,
  engagementId: string,
  today: Date = new Date(),
): Promise<readonly RefundEntitlement[]> => {
  const entitlements = [
    ...(await approvedNotFunded(tenantId, engagementId, today)),
    ...(await qualityFailure(tenantId, engagementId, today)),
    ...(await unearnedPrepay(tenantId, engagementId)),
  ];

  const decided = await db().refundRecord.findMany({ where: { tenantId, engagementId } });

  return entitlements.map((entitlement) => {
    const record = decided.find(
      (candidate) =>
        candidate.trigger === entitlement.trigger &&
        candidate.amountCents === entitlement.amountCents,
    );
    return record === undefined
      ? entitlement
      : { ...entitlement, resolved: record.disposition as 'paid' | 'declined' };
  });
};

/** Entitlements nobody has acted on. The queue. */
export const unresolvedRefunds = async (
  tenantId: string,
  engagementId: string,
  today: Date = new Date(),
): Promise<readonly RefundEntitlement[]> =>
  (await refundsDue(tenantId, engagementId, today)).filter(
    (entitlement) => entitlement.resolved === null,
  );

/**
 * Pay a refund.
 *
 * Needs no approval beyond the actor being able to act at all: the money was already owed, and
 * requiring a sign-off to hand back something the record says is not ours would be the friction
 * that stops it happening.
 *
 * Writes both a `RefundRecord` (why) and a `BillingRecord` (the money), because the balance and
 * the reason are two different questions and each has a reader who does not want the other.
 */
export const payRefund = async (input: {
  tenantId: string;
  engagementId: string;
  trigger: RefundTrigger;
  amountCents: Cents;
  paidBy: string;
  paidOn: Date;
  actor: EventActor;
}): Promise<Outcome<{ refundId: string }>> => {
  const entitlements = await refundsDue(input.tenantId, input.engagementId, input.paidOn);
  const entitlement = entitlements.find(
    (candidate) =>
      candidate.trigger === input.trigger && candidate.amountCents === input.amountCents,
  );

  if (!entitlement) {
    // Not a refusal to be generous - a refusal to record a refund the system cannot explain. An
    // ex-gratia payment is a legitimate business decision and belongs in a path that says so.
    return refused(
      `The record does not show a ${input.trigger} entitlement of ${formatMoney(input.amountCents)} on this engagement. A payment the system cannot explain would appear in the ledger as an objective refund and would not be one.`,
      'Blueprint 1.4 - refund logic driven by objective triggers',
    );
  }

  const refund = await db().$transaction(async (tx) => {
    const created = await tx.refundRecord.create({
      data: {
        tenantId: input.tenantId,
        engagementId: input.engagementId,
        trigger: input.trigger,
        amountCents: input.amountCents,
        disposition: 'paid',
        decidedBy: input.paidBy,
        decidedAt: input.paidOn,
      },
    });

    await tx.billingRecord.create({
      data: {
        tenantId: input.tenantId,
        engagementId: input.engagementId,
        kind: 'refund',
        amountCents: input.amountCents,
        description: `Refund: ${input.trigger}`,
        occurredOn: input.paidOn,
        createdBy: input.paidBy,
      },
    });

    return created;
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.refund.paid',
    actor: input.actor,
    clientId: entitlement.clientId,
    payload: {
      engagementId: input.engagementId,
      refundId: refund.id,
      trigger: input.trigger,
      amountCents: input.amountCents,
      basis: entitlement.basis,
    },
  });

  return ok({ refundId: refund.id });
};

/**
 * Decline an entitlement.
 *
 * The path that needs oversight, and the only one in this file that checks authority. Declining
 * requires a Level 3 human and a reason, both read from the recorded actor rather than trusted
 * from the caller.
 *
 * The reason is written into the Ledger as well as the refund record, because a declined
 * entitlement is exactly the kind of decision that gets questioned later by somebody who does not
 * have access to the billing schema.
 */
export const declineRefund = async (input: {
  tenantId: string;
  engagementId: string;
  trigger: RefundTrigger;
  amountCents: Cents;
  reason: string;
  actor: EventActor;
  decidedBy: string;
  decidedAt: Date;
}): Promise<Outcome<{ refundId: string }>> => {
  if (input.reason.trim() === '') {
    return refused(
      'Declining a refund the record says is owed requires a reason. Granting one does not, because it was already owed - this is the asymmetry the module is built on.',
      'Blueprint 1.4 - refund logic driven by objective triggers',
    );
  }

  const actor = await findActor(input.actor.id);
  if (actor === null || actor.kind !== 'human' || actor.authorityLevel < 3) {
    return refused(
      'Declining an objectively-triggered refund requires a human at Authority Level 3. An agent able to decline one would make the trigger advisory.',
      'Design principle 4 with blueprint 1.4',
    );
  }

  const entitlements = await refundsDue(input.tenantId, input.engagementId, input.decidedAt);
  const entitlement = entitlements.find(
    (candidate) =>
      candidate.trigger === input.trigger && candidate.amountCents === input.amountCents,
  );
  if (!entitlement) {
    return noData(
      'The record does not show that entitlement on this engagement, so there is nothing to decline.',
    );
  }

  const refund = await db().refundRecord.create({
    data: {
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      trigger: input.trigger,
      amountCents: input.amountCents,
      disposition: 'declined',
      declineReason: input.reason,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.refund.declined',
    actor: input.actor,
    clientId: entitlement.clientId,
    payload: {
      engagementId: input.engagementId,
      refundId: refund.id,
      trigger: input.trigger,
      amountCents: input.amountCents,
      reason: input.reason,
      declinedBy: actor.label,
      basis: entitlement.basis,
    },
  });

  return ok({ refundId: refund.id });
};

/** Record a funding outcome, which is what the 60-day trigger runs against. */
export const recordFundingOutcome = async (input: {
  tenantId: string;
  engagementId: string;
  clientId: string;
  provider: string;
  /** The approved figure. There is no parameter for a requested one. */
  approvedCreditLimitCents: Cents;
  approvedOn: Date;
  fundedOn?: Date;
  fundedCents?: Cents;
  actor: EventActor;
}): Promise<Outcome<{ id: string }>> => {
  const row = await db().fundingOutcome.create({
    data: {
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      clientId: input.clientId,
      provider: input.provider,
      approvedCreditLimitCents: input.approvedCreditLimitCents,
      approvedOn: input.approvedOn,
      fundedOn: input.fundedOn ?? null,
      fundedCents: input.fundedCents ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.funding_outcome.recorded',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      engagementId: input.engagementId,
      provider: input.provider,
      approvedCreditLimitCents: input.approvedCreditLimitCents,
      funded: input.fundedOn !== undefined,
    },
  });

  return ok({ id: row.id });
};

/** Mark an approval as funded, which retires the 60-day entitlement. */
export const markFunded = async (input: {
  tenantId: string;
  outcomeId: string;
  fundedOn: Date;
  fundedCents: Cents;
  actor: EventActor;
}): Promise<Outcome<{ id: string }>> => {
  const existing = await db().fundingOutcome.findFirst({
    where: { tenantId: input.tenantId, id: input.outcomeId },
  });
  if (!existing) return noData('No such funding outcome in this tenant.');

  await db().fundingOutcome.update({
    where: { id: input.outcomeId },
    data: { fundedOn: input.fundedOn, fundedCents: input.fundedCents },
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.funding_outcome.funded',
    actor: input.actor,
    clientId: existing.clientId,
    payload: { outcomeId: input.outcomeId, fundedCents: input.fundedCents },
  });

  return ok({ id: input.outcomeId });
};
