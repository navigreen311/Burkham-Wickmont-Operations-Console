/**
 * What a partner is owed, and whether it is lawful to pay it - blueprint 8.2.
 *
 * This file replaces the `not_built` that stood in `referrals.ts` for the whole of V1, and the
 * sentence it stood on is the specification for what is here:
 *
 *   > A figure produced without them would look payable without anybody having checked whether
 *   > it is lawful to pay.
 *
 * So the shape of this module is not "compute a payout, then validate it". It is **a computation
 * that cannot produce a figure until every jurisdiction in it has answered**, because a total
 * with one unchecked state in it is exactly the figure that sentence warns about - it looks
 * complete, and the part nobody checked is invisible in the number.
 *
 * Four things carry it.
 *
 * **The state rules are PULLED from 7.2, never held here.** `referralFeeRuleFor` is 7.2's. A copy
 * of the restrictions living beside the calculator would be a second set of state rules, and the
 * drift between them would surface as money that had already moved.
 *
 * **A state that cannot answer stops the whole payout, not just its own line.** Dropping the
 * unanswerable line and paying the rest would produce a smaller number that still looks like a
 * complete answer. The refusal names the states.
 *
 * **We pay on money received, not money invoiced.** Gross is the sum of `payment` records, not
 * `charge` records. Paying a share of an invoice the client never honoured means paying out real
 * money against revenue that never arrived, and recovering it means clawing back from a partner
 * who has spent it.
 *
 * **Automatic in, human out.** The computation runs unattended and produces `pending_approval`.
 * There is no path in this file that moves money, and no status meaning `paid` - money movement
 * is not this system's act, and a `paid` we could set without anybody moving money would be a
 * figure two sets of books disagreed about.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { referralFeeRuleFor, type ReferralFeePosture } from '@bwc/regulatory';
import { loadGraph } from '@bwc/graph';
import { engagementsForClient, recordsFor } from '@bwc/billing';
import { findPartner } from './partners.js';
import { leadsAttributedTo } from './attributed.js';
import { activeAgreement } from './agreements.js';

/** Approving money out is a Level 3 decision. */
export const PAYOUT_AUTHORITY_LEVEL = 3;

const BASIS_POINT_DIVISOR = 10_000;

/**
 * Apply a share to an amount in cents.
 *
 * Floor, deliberately. Rounding a fraction of a cent up would pay the partner a cent we did not
 * earn on every line, and the direction of a rounding rule should favour the party that did not
 * write it - ADR-0011's reasoning about rounding to the client, applied the same way here.
 */
export const applyShare = (amountCents: number, basisPoints: number): number =>
  Math.floor((amountCents * basisPoints) / BASIS_POINT_DIVISOR);

export interface PayoutLine {
  readonly leadId: string;
  readonly clientId: string;
  readonly state: string;
  readonly grossFeeCents: number;
  readonly appliedBasisPoints: number;
  readonly amountCents: number;
  readonly rulePosture: ReferralFeePosture;
  readonly ruleCitation: string;
  readonly ruleConditions: readonly string[];
  readonly moduleVersion: number;
  /** True when the state cap bound harder than the agreement. Worth seeing on the evidence. */
  readonly cappedByState: boolean;
}

export interface PayoutComputation {
  readonly payoutId: string;
  readonly partnerId: string;
  readonly agreementVersion: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly grossCents: number;
  readonly clawbackCents: number;
  readonly netCents: number;
  readonly lines: readonly PayoutLine[];
  /**
   * Referrals deliberately excluded, with the reason. Present so a partner asking "why is this
   * smaller than I expected" is answered by the record rather than by whoever remembers.
   */
  readonly excluded: readonly { readonly leadId: string; readonly reason: string }[];
}

/** Half-open [start, end), like every other window in this system. */
export interface Period {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The jurisdiction a referral falls under: the client's primary entity's state of formation.
 *
 * `null` when it cannot be determined, and the caller refuses on that. This is
 * `jurisdictionOf`'s rule applied to money - "we could not tell which state this client is in"
 * and "no state rule applies" are different statements, and collapsing them here would pay a fee
 * into a state nobody identified.
 */
const jurisdictionFor = async (tenantId: string, clientId: string): Promise<string | null> => {
  const graph = await loadGraph(tenantId, clientId);
  const primary = graph.entities.find((entity) => entity.isPrimary) ?? graph.entities[0];
  const state = primary?.stateOfFormation?.trim().toUpperCase();
  return state !== undefined && state !== '' ? state : null;
};

/**
 * What this client actually PAID us in the window. Payments, not charges - see the header.
 *
 * Goes through `@bwc/billing`'s API rather than querying `billing_records`, because no service
 * reaches into another service's database. The join would have been one line and one invariant.
 */
const receivedInPeriod = async (
  tenantId: string,
  clientId: string,
  period: Period,
): Promise<number> => {
  const engagements = await engagementsForClient(tenantId, clientId);

  let total = 0;
  for (const engagement of engagements) {
    const records = await recordsFor(tenantId, engagement.id);
    for (const record of records) {
      if (record.kind !== 'payment') continue;
      const at = new Date(record.occurredOn).getTime();
      if (at >= period.start.getTime() && at < period.end.getTime()) {
        total += record.amountCents;
      }
    }
  }
  return total;
};

export interface ComputeInput {
  readonly tenantId: string;
  readonly partnerId: string;
  readonly period: Period;
  readonly computedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Compute what a partner is owed for a period.
 *
 * Refuses, rather than producing a partial figure, when:
 *
 *   - the partner has no agreement in force (nobody agreed what they are owed)
 *   - any attributed client's jurisdiction cannot be determined
 *   - any jurisdiction's referral-fee rule cannot be obtained from 7.2
 *
 * A `prohibited` state is NOT a refusal - it is an answer. That referral contributes nothing and
 * appears in `excluded` naming the statute, which is a different thing from a state we failed to
 * ask.
 */
export const computePayout = async (input: ComputeInput): Promise<Outcome<PayoutComputation>> => {
  const now = input.now ?? new Date();

  if (input.period.end.getTime() <= input.period.start.getTime()) {
    return refused(
      'A payout period ends after it starts. An empty or inverted window would produce a zero that looks like "nothing was earned".',
      'Blueprint 8.2 - payout dates',
    );
  }

  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner as Outcome<never>;

  if (partner.value.status === 'terminated') {
    // Not a refusal to compute: a terminated partner is still owed what they earned before they
    // were terminated, and withholding it because the relationship ended would be this company
    // deciding a commercial dispute in its own favour by not running a calculation.
    // Recorded here so the reasoning is visible rather than looking like an oversight.
  }

  const agreement = await activeAgreement(input.tenantId, input.partnerId);
  if (agreement.status !== 'ok') return agreement as Outcome<never>;

  const leads = await leadsAttributedTo(input.tenantId, input.partnerId);

  const lines: PayoutLine[] = [];
  const excluded: { leadId: string; reason: string }[] = [];
  const unanswerable: string[] = [];

  for (const lead of leads) {
    if (lead.clientId === null || lead.converted !== true) {
      excluded.push({
        leadId: lead.leadId,
        reason: 'Not converted to a client in this period, so nothing was earned on it.',
      });
      continue;
    }

    const gross = await receivedInPeriod(input.tenantId, lead.clientId, input.period);
    if (gross === 0) {
      excluded.push({
        leadId: lead.leadId,
        reason:
          'The client paid nothing in this window. Nothing is owed on money we have not received - a share of an unpaid invoice is real money against revenue that never arrived.',
      });
      continue;
    }

    const state = await jurisdictionFor(input.tenantId, lead.clientId);
    if (state === null) {
      unanswerable.push(
        `lead ${lead.leadId}: the client's state of formation is not recorded, so no jurisdiction's rule can be applied`,
      );
      continue;
    }

    const rule = await referralFeeRuleFor(input.tenantId, state);
    if (rule.status !== 'ok') {
      unanswerable.push(`${state}: ${rule.reason}`);
      continue;
    }

    if (rule.value.posture === 'prohibited') {
      excluded.push({
        leadId: lead.leadId,
        reason: `${state} prohibits a referral fee on these facts (${rule.value.citation}). This referral contributes nothing, and that is an answer rather than a gap.`,
      });
      continue;
    }

    const cap = rule.value.maxShareBasisPoints;
    const applied =
      cap === null
        ? agreement.value.shareBasisPoints
        : Math.min(agreement.value.shareBasisPoints, cap);

    lines.push({
      leadId: lead.leadId,
      clientId: lead.clientId,
      state,
      grossFeeCents: gross,
      appliedBasisPoints: applied,
      amountCents: applyShare(gross, applied),
      rulePosture: rule.value.posture,
      ruleCitation: rule.value.citation,
      ruleConditions: rule.value.conditions,
      moduleVersion: rule.value.moduleVersion,
      cappedByState: cap !== null && cap < agreement.value.shareBasisPoints,
    });
  }

  if (unanswerable.length > 0) {
    // The whole payout stops. Paying the answerable lines would produce a smaller number that
    // still reads as a complete answer, and the part nobody checked would be invisible in it.
    return refused(
      `This payout cannot be computed because ${unanswerable.length} referral(s) fall in jurisdictions that cannot answer whether a fee is lawful: ${unanswerable.join('; ')}. The rest of the period is not paid either - a total with an unchecked state left out of it looks complete, and what is missing does not show in the number.`,
      'Blueprint 8.2 with 7.2 - state-aware referral fee compliance',
    );
  }

  const grossCents = lines.reduce((total, line) => total + line.amountCents, 0);

  const outstanding = await db().payoutClawback.findMany({
    where: { tenantId: input.tenantId, partnerId: input.partnerId, settledAt: null },
    select: { id: true, amountCents: true },
  });
  const clawbackCents = outstanding.reduce((total, row) => total + row.amountCents, 0);

  // Never negative. A period whose clawbacks exceed its earnings leaves the remainder outstanding
  // on the clawback rows, so the next period picks it up - rather than producing a payout that
  // owes us money, which is not a payout.
  const netCents = Math.max(0, grossCents - clawbackCents);
  const absorbed = Math.min(grossCents, clawbackCents);

  const row = await db().$transaction(async (tx) => {
    const payout = await tx.partnerPayout.create({
      data: {
        tenantId: input.tenantId,
        partnerId: input.partnerId,
        agreementId: agreement.value.id,
        periodStart: input.period.start,
        periodEnd: input.period.end,
        status: 'pending_approval',
        grossCents,
        clawbackCents: absorbed,
        netCents,
        computedAt: now,
      },
    });

    for (const line of lines) {
      await tx.payoutLine.create({
        data: {
          tenantId: input.tenantId,
          payoutId: payout.id,
          leadId: line.leadId,
          clientId: line.clientId,
          state: line.state,
          grossFeeCents: line.grossFeeCents,
          appliedBasisPoints: line.appliedBasisPoints,
          amountCents: line.amountCents,
          rulePosture: line.rulePosture,
          ruleCitation: line.ruleCitation,
          ruleConditions: [...line.ruleConditions],
          moduleVersion: line.moduleVersion,
          cappedByState: line.cappedByState,
        },
      });
    }

    return payout;
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.payout.computed',
    actor: input.actor,
    payload: {
      payoutId: row.id,
      partnerId: input.partnerId,
      agreementVersion: agreement.value.version,
      lineCount: lines.length,
      grossCents,
      clawbackCents: absorbed,
      netCents,
      // States, not clients. A jurisdiction is not PII; the client list would be.
      states: [...new Set(lines.map((line) => line.state))].sort(),
    },
  });

  return ok({
    payoutId: row.id,
    partnerId: input.partnerId,
    agreementVersion: agreement.value.version,
    periodStart: input.period.start.toISOString(),
    periodEnd: input.period.end.toISOString(),
    grossCents,
    clawbackCents: absorbed,
    netCents,
    lines,
    excluded,
  });
};

/**
 * Approve a computed payout.
 *
 * The human end of "automatic in, human out". Nothing here moves money; it records that a Level 3
 * human looked at a figure and stood behind it, which is what the finance system downstream needs
 * before it pays anybody.
 */
export const approvePayout = async (input: {
  tenantId: string;
  payoutId: string;
  approvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ payoutId: string; netCents: number }>> => {
  const now = input.now ?? new Date();

  const row = await db().partnerPayout.findFirst({
    where: { tenantId: input.tenantId, id: input.payoutId },
  });
  if (!row) return noData(`No payout ${input.payoutId} is on record.`);

  if (row.status !== 'pending_approval') {
    return refused(
      `That payout is already '${row.status}'. Approving it twice would be a second authorisation for one figure.`,
      'Blueprint 8.2 - automatic payout workflow with human approval',
    );
  }

  const actor = await findActor(input.approvedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < PAYOUT_AUTHORITY_LEVEL) {
    return refused(
      `Approving a partner payout requires a human at Authority Level ${PAYOUT_AUTHORITY_LEVEL}. The computation is unattended, so the approval is the only point a person sees the figure before money leaves.`,
      'Principle 4 with blueprint 8.2 - automatic in, human out',
    );
  }

  const updated = await db().$transaction(async (tx) => {
    const payout = await tx.partnerPayout.update({
      where: { id: row.id },
      data: { status: 'approved', decidedBy: input.approvedBy, decidedAt: now },
    });
    // The clawbacks this payout absorbed are settled by it, so the next period does not deduct
    // them twice. Only up to what the payout actually absorbed.
    if (payout.clawbackCents > 0) {
      let remaining = payout.clawbackCents;
      const open = await tx.payoutClawback.findMany({
        where: { tenantId: input.tenantId, partnerId: row.partnerId, settledAt: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const clawback of open) {
        if (remaining < clawback.amountCents) break;
        remaining -= clawback.amountCents;
        await tx.payoutClawback.update({
          where: { id: clawback.id },
          data: { settledAt: now, settledByPayoutId: payout.id },
        });
      }
    }
    return payout;
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.payout.approved',
    actor: input.actor,
    payload: {
      payoutId: row.id,
      partnerId: row.partnerId,
      netCents: updated.netCents,
      approvedBy: input.approvedBy,
    },
  });

  return ok({ payoutId: row.id, netCents: updated.netCents });
};

/** Decline a computed payout. Needs a reason: declining what the terms say is owed is the decision that needs oversight. */
export const declinePayout = async (input: {
  tenantId: string;
  payoutId: string;
  reason: string;
  declinedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ payoutId: string }>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 10) {
    return refused(
      'Declining a payout needs a reason somebody can read back. The terms said this was owed, so the departure from them is what has to be explained.',
      'Blueprint 8.2 - payout approval records',
    );
  }

  const row = await db().partnerPayout.findFirst({
    where: { tenantId: input.tenantId, id: input.payoutId },
  });
  if (!row) return noData(`No payout ${input.payoutId} is on record.`);
  if (row.status !== 'pending_approval') {
    return refused(`That payout is already '${row.status}'.`, 'Blueprint 8.2 - payout approval');
  }

  const actor = await findActor(input.declinedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < PAYOUT_AUTHORITY_LEVEL) {
    return refused(
      `Declining a partner payout requires a human at Authority Level ${PAYOUT_AUTHORITY_LEVEL}.`,
      'Principle 4 with blueprint 8.2',
    );
  }

  await db().partnerPayout.update({
    where: { id: row.id },
    data: {
      status: 'declined',
      decidedBy: input.declinedBy,
      decidedAt: now,
      declineReason: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.payout.declined',
    actor: input.actor,
    payload: { payoutId: row.id, partnerId: row.partnerId, declinedBy: input.declinedBy },
  });

  return ok({ payoutId: row.id });
};

export interface ClawbackInput {
  readonly tenantId: string;
  readonly partnerId: string;
  readonly engagementId: string;
  readonly amountCents: number;
  readonly reason: string;
  readonly refundRecordId?: string;
  readonly recordedBy: string;
  readonly actor: EventActor;
}

/**
 * Record money owed back because the engagement that earned it was refunded or charged back.
 *
 * Its own row rather than a negative line on a past payout, for ADR-0041's reason: a clawback is
 * a thing that happened, and netting it into an earlier figure loses that it happened at all -
 * along with when, and against which engagement.
 */
export const recordClawback = async (input: ClawbackInput): Promise<Outcome<{ id: string }>> => {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refused(
      `A clawback is a positive amount in integer cents; received ${input.amountCents}. The direction is carried by the row being a clawback, not by the sign - ADR-0011.`,
      'ADR-0011 - money is integer cents',
    );
  }

  if (input.reason.trim().length < 10) {
    return refused(
      'A clawback needs a reason somebody can read back. It reduces what a partner is paid, and they will ask.',
      'Blueprint 8.2 - chargeback / refund clawback logic',
    );
  }

  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner as Outcome<never>;

  const row = await db().payoutClawback.create({
    data: {
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      engagementId: input.engagementId,
      amountCents: input.amountCents,
      reason: input.reason,
      refundRecordId: input.refundRecordId ?? null,
      createdBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.payout.clawback_recorded',
    actor: input.actor,
    payload: {
      clawbackId: row.id,
      partnerId: input.partnerId,
      engagementId: input.engagementId,
      amountCents: input.amountCents,
    },
  });

  return ok({ id: row.id });
};

/** Clawbacks not yet absorbed by an approved payout. What the next computation will deduct. */
export const outstandingClawbacks = async (
  tenantId: string,
  partnerId: string,
): Promise<
  readonly { id: string; engagementId: string; amountCents: number; reason: string }[]
> => {
  const rows = await db().payoutClawback.findMany({
    where: { tenantId, partnerId, settledAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    engagementId: row.engagementId,
    amountCents: row.amountCents,
    reason: row.reason,
  }));
};

export const payoutsFor = async (
  tenantId: string,
  partnerId: string,
): Promise<readonly { id: string; status: string; netCents: number; computedAt: string }[]> => {
  const rows = await db().partnerPayout.findMany({
    where: { tenantId, partnerId },
    orderBy: [{ periodStart: 'desc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    netCents: row.netCents,
    computedAt: row.computedAt.toISOString(),
  }));
};
