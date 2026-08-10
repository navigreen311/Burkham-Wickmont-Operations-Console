/**
 * The compliance KPI - blueprint 9.1, and the one metric the specification changed between
 * versions specifically to stop somebody averaging it.
 *
 * > **Change from v1:** Compliance KPI is now percentage of clients per categorical state
 * > (Pass / Pass with Findings / Needs Review / Fail), **not average numeric score**.
 * > Target: 90%+ in Pass or Pass with Findings.
 *
 * So this file returns a DISTRIBUTION, and takes some care that no average can be produced from
 * it. `ComplianceDistribution` has no field of type `number` that summarises the whole - the
 * healthy share exists because the blueprint states a target against it, and it is a share of a
 * named subset rather than a score.
 *
 * The reason is Decision E's and it is worth restating where somebody will read it while looking
 * at a dashboard: an average needs an ordering, an ordering implies the states are points on a
 * scale, and they are not. "Needs Review" is not halfway between "Pass with Findings" and "Fail" -
 * it is a different kind of statement, about whether anybody has looked. A tenant at 60% Pass and
 * 40% Fail and a tenant at 100% Pass with Findings would score identically on any sensible
 * numeric mapping, and one of them has a serious problem.
 *
 * @see packages/core/src/compliance.ts - which deliberately exposes no ordering helper
 */

import { db } from '@bwc/db';
import { COMPLIANCE_STATES, type ComplianceState } from '@bwc/core';
import { measured, unmeasurable, type Metric, type Period } from './metric.js';

/** Blueprint 9.1: "Target: 90%+ in Pass or Pass with Findings." */
export const HEALTHY_SHARE_TARGET = 0.9;

/** The states that count toward the target. Named, not derived from an ordering. */
export const HEALTHY_STATES: readonly ComplianceState[] = ['pass', 'pass_with_findings'];

export interface ComplianceDistribution {
  /** One count per state. Every state appears, including the ones at zero. */
  readonly counts: Readonly<Record<ComplianceState, number>>;
  readonly shares: Readonly<Record<ComplianceState, number>>;
  readonly clients: number;
  /**
   * The share in Pass or Pass with Findings.
   *
   * Present because blueprint 9.1 states a target against it. It is a share of two NAMED states,
   * not a score - there is no weighting here, and adding one would be the numeric compliance
   * measure Decision E exists to prevent.
   */
  readonly healthyShare: number;
  readonly meetsTarget: boolean;
}

/**
 * The distribution of clients across compliance states.
 *
 * Every state appears in `counts` even at zero. A dashboard that omits `fail` when it is empty
 * teaches its reader that the absence of a row means the absence of a problem, and the day a
 * client lands in `fail` the row appears somewhere nobody was looking.
 */
export const complianceDistribution = async (
  tenantId: string,
  period: Period,
): Promise<Metric<ComplianceDistribution>> => {
  const rows = await db().client.findMany({
    where: { tenantId },
    select: { complianceState: true },
  });

  if (rows.length === 0) {
    return unmeasurable({
      key: 'compliance_distribution',
      label: 'Clients by compliance state',
      period,
      denominator: 0,
      note: 'No clients are on record, so there is no distribution. This is an empty book, not a clean one.',
    });
  }

  const counts = Object.fromEntries(COMPLIANCE_STATES.map((state) => [state, 0])) as Record<
    ComplianceState,
    number
  >;

  for (const row of rows) counts[row.complianceState as ComplianceState] += 1;

  const shares = Object.fromEntries(
    COMPLIANCE_STATES.map((state) => [state, counts[state] / rows.length]),
  ) as Record<ComplianceState, number>;

  const healthy = HEALTHY_STATES.reduce((total, state) => total + counts[state], 0);
  const healthyShare = healthy / rows.length;

  // `pending_assessment` is called out because it is the state that most looks like a problem and
  // most often is not - a client created yesterday. Reading it as a compliance failure would push
  // somebody to assess clients faster than the assessment is worth doing.
  const pending = counts['pending_assessment'];

  return measured({
    key: 'compliance_distribution',
    label: 'Clients by compliance state',
    value: {
      counts,
      shares,
      clients: rows.length,
      healthyShare,
      meetsTarget: healthyShare >= HEALTHY_SHARE_TARGET,
    },
    numerator: healthy,
    denominator: rows.length,
    period,
    note: `${healthy} of ${rows.length} clients are in Pass or Pass with Findings (${(healthyShare * 100).toFixed(1)}%; target ${HEALTHY_SHARE_TARGET * 100}%). ${counts['fail']} in Fail, ${counts['needs_review']} in Needs Review, ${pending} not yet assessed. These are counts per state, never an average - the states are categories, not points on a scale.`,
  });
};

/**
 * Clients whose compliance state changed during the period, by direction.
 *
 * Direction is `improved` / `worsened` / `lateral`, and it is computed from a HARD-CODED PAIRWISE
 * TABLE rather than from an ordering, because the moment an ordering exists somebody averages it.
 * The table only knows about transitions worth reporting as movement; everything else is lateral,
 * which is the honest answer for "pending_assessment -> needs_review" (nothing improved or
 * worsened; somebody finally looked).
 */
export type TransitionDirection = 'improved' | 'worsened' | 'lateral';

const DIRECTIONS: Readonly<Record<string, TransitionDirection>> = {
  'fail>pass': 'improved',
  'fail>pass_with_findings': 'improved',
  'fail>needs_review': 'improved',
  'needs_review>pass': 'improved',
  'needs_review>pass_with_findings': 'improved',
  'pass_with_findings>pass': 'improved',
  'pass>pass_with_findings': 'worsened',
  'pass>needs_review': 'worsened',
  'pass>fail': 'worsened',
  'pass_with_findings>needs_review': 'worsened',
  'pass_with_findings>fail': 'worsened',
  'needs_review>fail': 'worsened',
};

export const directionOf = (from: ComplianceState, to: ComplianceState): TransitionDirection =>
  DIRECTIONS[`${from}>${to}`] ?? 'lateral';

export interface TransitionSummary {
  readonly improved: number;
  readonly worsened: number;
  readonly lateral: number;
  readonly total: number;
}

export const transitionSummary = async (
  tenantId: string,
  period: Period,
): Promise<Metric<TransitionSummary>> => {
  const events = await db().ledgerEvent.findMany({
    where: {
      tenantId,
      type: 'client.compliance_state_changed',
      createdAt: { gte: period.from, lt: period.to },
    },
    select: { payload: true },
  });

  if (events.length === 0) {
    return unmeasurable({
      key: 'compliance_transitions',
      label: 'Compliance state movement',
      period,
      denominator: 0,
      note: 'No compliance state changed in this period. That is a fact about the period, not about the book - the distribution says where clients actually stand.',
    });
  }

  const summary = { improved: 0, worsened: 0, lateral: 0, total: events.length };

  for (const event of events) {
    const payload = event.payload as { from?: string; to?: string };
    if (payload.from === undefined || payload.to === undefined) {
      summary.lateral += 1;
      continue;
    }
    summary[directionOf(payload.from as ComplianceState, payload.to as ComplianceState)] += 1;
  }

  return measured({
    key: 'compliance_transitions',
    label: 'Compliance state movement',
    value: summary,
    numerator: summary.improved,
    denominator: summary.total,
    period,
    note: `${summary.improved} improved, ${summary.worsened} worsened, ${summary.lateral} lateral across ${summary.total} transitions. Lateral includes a first assessment, where nothing improved or worsened - somebody finally looked.`,
  });
};
