/**
 * Capital Stack Health Score — blueprint 5.1.
 *
 * Blueprint 5.1 names a score, so a number is specified. Decision E removed a *different* score
 * (compliance state) for a reason that still applies here: a bare number hides what a reader needs
 * in order to act. "Your stack health is 62" tells an operator nothing about what to fix.
 *
 * So the score carries its components, and there is no constructor that omits them. The number is
 * a summary *of* the components rather than a replacement *for* them — the Decision E lesson
 * applied without contradicting the blueprint.
 *
 * The thresholds below are judgements, stated explicitly so a reader can disagree with a specific
 * line rather than with an opaque total.
 */

import type { Provenance, Sourced } from '@bwc/core';
import { aggregateUtilization, pgExposureMap, type CapitalPosition } from './positions.js';
import { promoRunway } from './calendar.js';

export type ComponentName =
  | 'utilization'
  | 'promo_runway'
  | 'guarantee_concentration'
  | 'cost_of_capital'
  | 'account_hygiene';

export interface HealthComponent {
  readonly name: ComponentName;
  /** 0 to 100, higher is healthier. */
  readonly score: number;
  readonly weight: number;
  /** What drove this component, in a sentence an operator can act on. */
  readonly rationale: string;
}

export interface HealthScore {
  readonly score: Sourced<number>;
  readonly components: readonly HealthComponent[];
  readonly band: 'strong' | 'adequate' | 'strained' | 'distressed';
}

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/**
 * Utilization.
 *
 * Below 30% is healthy on essentially every issuer model; above 80% is where credit-line
 * decreases and adverse action begin. Over-limit scores zero outright, because it is a different
 * condition rather than a worse degree of the same one.
 */
const utilizationComponent = (positions: readonly CapitalPosition[]): HealthComponent => {
  const aggregate = aggregateUtilization(positions);

  if (aggregate.ratio === null) {
    return {
      name: 'utilization',
      score: 100,
      weight: 0.3,
      rationale: 'No revolving positions, so utilization does not apply.',
    };
  }

  const ratio = aggregate.ratio;
  const score = ratio <= 0.3 ? 100 : ratio >= 0.8 ? 0 : clamp(100 - ((ratio - 0.3) / 0.5) * 100);

  return {
    name: 'utilization',
    score: aggregate.overLimitCount > 0 ? 0 : score,
    weight: 0.3,
    rationale:
      aggregate.overLimitCount > 0
        ? `${aggregate.overLimitCount} position(s) are over their limit.`
        : `Aggregate revolving utilization is ${Math.round(ratio * 100)}%.`,
  };
};

/**
 * Promotional runway.
 *
 * A 0% balance with 30 days left is a different position from the same balance with 300 — the
 * first is about to start accruing at the go-to rate. Runway is what makes a promotional balance
 * either an asset or a countdown.
 */
const promoComponent = (positions: readonly CapitalPosition[], today: string): HealthComponent => {
  const runways = promoRunway(positions, today);

  if (runways.length === 0) {
    return {
      name: 'promo_runway',
      score: 100,
      weight: 0.2,
      rationale: 'No promotional windows in the stack.',
    };
  }

  const shortest = runways.reduce((min, entry) =>
    entry.daysRemaining < min.daysRemaining ? entry : min,
  );

  const score =
    shortest.daysRemaining >= 180
      ? 100
      : shortest.daysRemaining <= 0
        ? 0
        : clamp((shortest.daysRemaining / 180) * 100);

  return {
    name: 'promo_runway',
    score,
    weight: 0.2,
    rationale: `Shortest promotional runway is ${shortest.daysRemaining} day(s) on ${shortest.label}, after which the rate becomes ${(shortest.goToAnnualRate * 100).toFixed(2)}%.`,
  };
};

/**
 * Guarantee concentration.
 *
 * Personal guarantees are not inherently unhealthy — most small-business capital requires one.
 * What matters is concentration on a single owner, and whether any guarantee is unlimited, since
 * unlimited exposure grows with draws the owner has not yet made.
 */
const guaranteeComponent = (
  positions: readonly CapitalPosition[],
  provenance: Provenance,
): HealthComponent => {
  const exposures = pgExposureMap(positions, provenance);

  if (exposures.length === 0) {
    return {
      name: 'guarantee_concentration',
      score: 100,
      weight: 0.2,
      rationale: 'No personal guarantees in the stack.',
    };
  }

  const unlimited = exposures.filter((exposure) => exposure.hasUnlimitedGuarantee).length;
  const totalGuaranteed = exposures.reduce((sum, e) => sum + e.exposureAmount.value, 0);
  const largest = exposures[0];
  const concentration =
    totalGuaranteed === 0 ? 0 : (largest?.exposureAmount.value ?? 0) / totalGuaranteed;

  return {
    name: 'guarantee_concentration',
    score: clamp(100 - concentration * 40 - unlimited * 20),
    weight: 0.2,
    rationale: `${exposures.length} guarantor(s); ${Math.round(concentration * 100)}% of guaranteed balance rests on ${largest?.ownerName ?? 'one owner'}${unlimited > 0 ? `, and ${unlimited} guarantee(s) are unlimited` : ''}.`,
  };
};

/**
 * Blended cost, banded. Above 60% APR is distressed pricing for a small business.
 *
 * An uncosted stack scores 50, not 100: an unknown must not read as good news, and scoring it
 * healthy would let a stack of uncostable products present as strong.
 */
const costComponent = (blendedApr: number | null): HealthComponent => {
  if (blendedApr === null) {
    return {
      name: 'cost_of_capital',
      score: 50,
      weight: 0.2,
      rationale: 'Blended cost could not be computed; scored as unknown rather than as healthy.',
    };
  }

  const score =
    blendedApr <= 0.12
      ? 100
      : blendedApr >= 0.6
        ? 0
        : clamp(100 - ((blendedApr - 0.12) / 0.48) * 100);

  return {
    name: 'cost_of_capital',
    score,
    weight: 0.2,
    rationale: `Blended cost of capital is ${(blendedApr * 100).toFixed(1)}% APR.`,
  };
};

/**
 * Account hygiene.
 *
 * Stale observations mean everything above is describing the past. Blueprint 5.1's v2 change makes
 * monitoring depend on Plaid feeds, so a stack can silently go stale when a connection lapses —
 * this is the component that makes that visible instead of leaving a confident score resting on
 * three-month-old balances.
 */
const hygieneComponent = (
  positions: readonly CapitalPosition[],
  today: string,
): HealthComponent => {
  if (positions.length === 0) {
    return {
      name: 'account_hygiene',
      score: 100,
      weight: 0.1,
      rationale: 'No positions to observe.',
    };
  }

  const oldest = positions.reduce(
    (min, position) => (position.asOf < min ? position.asOf : min),
    positions[0]?.asOf ?? today,
  );
  const days = Math.max(
    0,
    Math.floor((Date.parse(today) - Date.parse(oldest)) / (24 * 60 * 60 * 1000)),
  );

  return {
    name: 'account_hygiene',
    score: days <= 7 ? 100 : days >= 90 ? 0 : clamp(100 - ((days - 7) / 83) * 100),
    weight: 0.1,
    rationale: `Oldest position observation is ${days} day(s) old.`,
  };
};

export interface HealthInput {
  readonly positions: readonly CapitalPosition[];
  readonly blendedApr: number | null;
  readonly today: string;
  readonly provenance: Provenance;
}

/**
 * Compute the health score. The only constructor.
 *
 * There is no path that produces a `HealthScore` without its components, which is what stops the
 * number travelling alone into a deliverable.
 */
export const capitalStackHealth = (input: HealthInput): HealthScore => {
  const components: HealthComponent[] = [
    utilizationComponent(input.positions),
    promoComponent(input.positions, input.today),
    guaranteeComponent(input.positions, input.provenance),
    costComponent(input.blendedApr),
    hygieneComponent(input.positions, input.today),
  ];

  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  const weighted = components.reduce(
    (sum, component) => sum + component.score * component.weight,
    0,
  );
  const score = totalWeight === 0 ? 0 : weighted / totalWeight;

  return {
    score: { value: Math.round(score), provenance: input.provenance },
    components,
    band:
      score >= 80 ? 'strong' : score >= 60 ? 'adequate' : score >= 40 ? 'strained' : 'distressed',
  };
};
