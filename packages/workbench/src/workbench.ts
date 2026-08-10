/**
 * 11.11 Founder / Executive Workbench.
 *
 * "Curated view across operations for executive decision-making; alerts requiring founder
 * attention; approval queue for founder-level decisions; cross-department status."
 *
 * **Stores nothing.** Like 7.1 and 9.1, this is assembly over modules that own their facts. A
 * workbench with its own tables would be a third place the same numbers live.
 *
 * **The decision queue is the part that needed a decision.** A workbench that listed everything
 * would become a second inbox, and two inboxes means both get ignored - 11.4 already has a task
 * queue, and the failure mode of adding another is not that the second one is wrong but that the
 * first one stops being read.
 *
 * So an item reaches this queue only if all three hold:
 *
 *   1. it requires a LEVEL 3 HUMAN - something an operator genuinely cannot resolve
 *   2. it is BLOCKING something - work is stopped, not merely pending
 *   3. it carries WHAT HAPPENS IF NOBODY ACTS
 *
 * The third is what makes it a queue rather than a feed. "Three items need your attention" is a
 * notification; "a client cannot be placed until this is reviewed, and they have been waiting
 * eleven days" is a decision.
 */

import { db } from '@bwc/db';
import { ok, type Outcome } from '@bwc/core';
import { listingsDueForReview } from '@bwc/risk';
import { openObligations } from '@bwc/calls';
import { stagedChanges } from '@bwc/admin';
import { unresolvedRefunds } from '@bwc/billing';
import { systemHealth, type HealthSummary } from '@bwc/observability';
import { executiveDashboard, gardnerRollup, periodOf, type GardnerRollup } from '@bwc/dashboards';

export type DecisionUrgency = 'overdue' | 'due_soon' | 'open';

export interface FounderDecision {
  readonly key: string;
  readonly kind: string;
  readonly summary: string;
  /** What happens if nobody acts. The field that makes this a queue rather than a feed. */
  readonly costOfInaction: string;
  readonly urgency: DecisionUrgency;
  readonly dueAt: string | null;
  /** Where to go to resolve it. A decision with no route is an anxiety. */
  readonly resolveIn: string;
}

const urgencyOf = (dueAt: Date | null, now: Date): DecisionUrgency => {
  if (dueAt === null) return 'open';
  if (dueAt.getTime() < now.getTime()) return 'overdue';
  if (dueAt.getTime() - now.getTime() < 48 * 60 * 60 * 1000) return 'due_soon';
  return 'open';
};

const URGENCY_ORDER: readonly DecisionUrgency[] = ['overdue', 'due_soon', 'open'];

/**
 * Decisions only a founder or senior human can make.
 *
 * Five sources, each already gated on a Level 3 human by the module that owns it. Nothing is
 * invented here: if a module did not already require a person, it does not appear.
 */
export const decisionQueue = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly FounderDecision[]> => {
  const [dnfReviews, obligations, staged, clientsAtFail, engagements] = await Promise.all([
    listingsDueForReview(tenantId, now),
    openObligations(tenantId, now),
    stagedChanges(tenantId),
    db().client.count({ where: { tenantId, complianceState: 'fail' } }),
    db().engagement.findMany({ where: { tenantId }, select: { id: true } }),
  ]);

  // 1.4 derives refund entitlement rather than storing it, so "unresolved" is asked per
  // engagement. A count over a table would have to invent a column that module deliberately
  // does not have.
  const openRefunds = (
    await Promise.all(
      engagements.map((engagement) => unresolvedRefunds(tenantId, engagement.id, now)),
    )
  ).flat().length;

  const decisions: FounderDecision[] = [];

  for (const listing of dnfReviews) {
    decisions.push({
      key: `dnf_review:${listing.id}`,
      kind: 'do_not_fund_review',
      summary: `Do Not Fund listing for a client (${listing.trigger}) is past its review date of ${listing.reviewDueAt.slice(0, 10)}.`,
      costOfInaction:
        'The listing keeps blocking, which is the safe direction - but it blocks on a determination nobody has revisited, and the client stays unfundable on reasoning that may no longer hold.',
      urgency: 'overdue',
      dueAt: listing.reviewDueAt,
      resolveIn: '6.4 Do Not Fund Governance - record a review or remove the listing',
    });
  }

  for (const obligation of obligations.filter((entry) => entry.severity === 'critical')) {
    decisions.push({
      key: `correction:${obligation.id}`,
      kind: 'call_promise_correction',
      summary: `A critical promise made on a call to a client has not been corrected: "${obligation.excerpt}"`,
      costOfInaction:
        'The client is planning on what they were told. A correction that arrives after they have acted on it is a record of diligence rather than a correction.',
      urgency: urgencyOf(new Date(obligation.dueAt), now),
      dueAt: obligation.dueAt,
      resolveIn: '4.3 Promise Tracking - record the correction, or dismiss it with a reason',
    });
  }

  for (const change of staged) {
    decisions.push({
      key: `config:${change.id}`,
      kind: 'staged_configuration',
      summary: `A high-risk configuration change to '${change.key}' (${change.previousValue} to ${change.newValue}) is staged and not in force.`,
      costOfInaction:
        'The system keeps running on the previous value. Nothing breaks; the change somebody asked for simply has not happened, and they may believe it has.',
      urgency: 'open',
      dueAt: null,
      resolveIn: '11.7 Admin Configuration Center - promote it, or roll the proposal back',
    });
  }

  if (clientsAtFail > 0) {
    decisions.push({
      key: 'compliance_fail',
      kind: 'clients_at_fail',
      summary: `${clientsAtFail} client(s) are at compliance state Fail.`,
      costOfInaction:
        'Each is auto-listed on Do Not Fund per Decision E and cannot be placed. They remain clients we are engaged with and cannot serve, which is a commercial position as much as a compliance one.',
      urgency: 'open',
      dueAt: null,
      resolveIn: '1.1 Client Lifecycle - resolve the findings, or end the engagement',
    });
  }

  if (openRefunds > 0) {
    decisions.push({
      key: 'refunds_unresolved',
      kind: 'refunds_unresolved',
      summary: `${openRefunds} refund entitlement(s) are neither paid nor declined.`,
      costOfInaction:
        'The default in 1.4 is to PAY. An entitlement left open is money owed that has not moved, and declining it later takes a Level 3 human and a recorded reason - which is harder to give the longer it sits.',
      urgency: 'open',
      dueAt: null,
      resolveIn: '1.4 Pricing & Billing - pay the refund, or decline it with a basis',
    });
  }

  return decisions.sort(
    (a, b) =>
      URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency) ||
      (a.dueAt ?? '').localeCompare(b.dueAt ?? ''),
  );
};

export interface Workbench {
  readonly tenantId: string;
  readonly generatedAt: string;
  /** Decisions only a founder can make, worst-overdue first. */
  readonly decisions: readonly FounderDecision[];
  /** The portfolio-level numbers, PII-stripped by construction (9.1). */
  readonly rollup: GardnerRollup;
  readonly health: HealthSummary;
  /** One line per department, so "who is behind" is answerable without five surfaces. */
  readonly crossDepartment: readonly { readonly department: string; readonly status: string }[];
}

/**
 * The whole surface.
 *
 * Reuses 9.1's Gardner rollup rather than assembling a second executive view. The rollup is
 * already PII-stripped by construction, and building a richer founder-only version would create a
 * second thing to keep honest - the founder can open a client file, and does not need the numbers
 * to carry one.
 */
export const workbench = async (input: {
  tenantId: string;
  now?: Date;
}): Promise<Outcome<Workbench>> => {
  const now = input.now ?? new Date();
  const period = periodOf(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), now, now);

  const [decisions, dashboard, health] = await Promise.all([
    decisionQueue(input.tenantId, now),
    executiveDashboard({ tenantId: input.tenantId, period, now }),
    systemHealth(input.tenantId, now),
  ]);

  if (dashboard.status !== 'ok') return dashboard as Outcome<never>;

  const overdue = decisions.filter((decision) => decision.urgency === 'overdue').length;

  return ok({
    tenantId: input.tenantId,
    generatedAt: now.toISOString(),
    decisions,
    rollup: gardnerRollup(dashboard.value),
    health,
    crossDepartment: [
      {
        department: 'Compliance & Evidence',
        status: `${dashboard.value.complianceDistribution.value?.counts['fail'] ?? 0} at Fail, ${dashboard.value.complianceDistribution.value?.counts['needs_review'] ?? 0} at Needs Review.`,
      },
      {
        department: 'Concierge Desk',
        status: `${dashboard.value.openCorrectionObligations.value ?? 0} open call-promise correction(s).`,
      },
      {
        department: 'Risk & Defense',
        status: `${decisions.filter((decision) => decision.kind === 'do_not_fund_review').length} Do Not Fund listing(s) overdue for review.`,
      },
      {
        department: 'CapitalForge Ops',
        status: `System health: ${health.overall}. ${health.counts.unmonitored} component(s) unmonitored.`,
      },
      {
        department: 'Founder / Executive',
        status:
          overdue > 0
            ? `${overdue} decision(s) overdue.`
            : `${decisions.length} decision(s) open, none overdue.`,
      },
    ],
  });
};
