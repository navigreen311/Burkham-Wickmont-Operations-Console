/**
 * 5.1 Capital Stack & Monitoring - the stack itself.
 *
 * Per-client composition, utilization, promo periods and personal-guarantee exposure.
 *
 * Every position carries `asOf` and provenance. Blueprint 5.1's v2 change is that monitoring
 * inputs now come primarily from Plaid feeds rather than assumed issuer feeds, which means a
 * position can be stale in a way that matters - a utilization figure from three months ago is not
 * a utilization figure. So the data says how old it is rather than implying it is current.
 */

import type { Provenance, Sourced } from '@bwc/core';
import type { ProductKind, RepaymentCadence } from './cost.js';

export interface PromoWindow {
  /** ISO date the promotional rate ends. JSON-native, like every other stored timestamp. */
  readonly endsOn: string;
  /** Usually 0 for a promotional balance-transfer or purchase window. */
  readonly promoAnnualRate: number;
  /** What the rate becomes on expiry. This is what makes the runway matter. */
  readonly goToAnnualRate: number;
}

export interface PersonalGuarantee {
  readonly ownerName: string;
  /** Full or limited. A limited PG caps exposure at an amount. */
  readonly limitAmount: number | null;
}

export interface CapitalPosition {
  readonly id: string;
  readonly provider: string;
  readonly kind: ProductKind;
  readonly label: string;

  /** Null for a term loan or MCA, which have no revolving limit. */
  readonly creditLimit: number | null;
  readonly outstandingBalance: number;

  readonly annualRate: number | null;
  readonly factorRate: number | null;
  readonly cadence: RepaymentCadence;
  readonly paymentPerPeriod: number;

  readonly promo: PromoWindow | null;
  readonly personalGuarantee: PersonalGuarantee | null;

  /** When this position was last observed. A stack is only as current as its oldest position. */
  readonly asOf: string;
  readonly provenance: Provenance;
}

export interface Utilization {
  readonly positionId: string;
  readonly label: string;
  /** Null when the position has no limit - a term loan cannot be "utilized". */
  readonly ratio: number | null;
  readonly overLimit: boolean;
}

/**
 * Per-position utilization.
 *
 * An over-limit position reports a ratio above 1 and is flagged, rather than being clamped to
 * 100%. Clamping would hide the condition that matters most: a client already past their limit is
 * in a different situation from one exactly at it, and the two must not render identically.
 */
export const utilizationOf = (position: CapitalPosition): Utilization => {
  if (position.creditLimit === null || position.creditLimit <= 0) {
    return { positionId: position.id, label: position.label, ratio: null, overLimit: false };
  }
  const ratio = position.outstandingBalance / position.creditLimit;
  return {
    positionId: position.id,
    label: position.label,
    ratio,
    overLimit: ratio > 1,
  };
};

export interface AggregateUtilization {
  readonly totalLimit: number;
  readonly totalRevolvingBalance: number;
  readonly ratio: number | null;
  readonly perPosition: readonly Utilization[];
  readonly overLimitCount: number;
}

/**
 * Aggregate utilization across revolving positions only.
 *
 * Term loans and MCAs are excluded: they carry balances but no limit, and including their balance
 * in the numerator while contributing nothing to the denominator would inflate the ratio without
 * bound. That is the arithmetic that turns a healthy client into an alarming one on paper.
 */
export const aggregateUtilization = (
  positions: readonly CapitalPosition[],
): AggregateUtilization => {
  const revolving = positions.filter(
    (position) => position.creditLimit !== null && position.creditLimit > 0,
  );

  const totalLimit = revolving.reduce((sum, position) => sum + (position.creditLimit ?? 0), 0);
  const totalRevolvingBalance = revolving.reduce(
    (sum, position) => sum + position.outstandingBalance,
    0,
  );

  const perPosition = positions.map(utilizationOf);

  return {
    totalLimit,
    totalRevolvingBalance,
    ratio: totalLimit === 0 ? null : totalRevolvingBalance / totalLimit,
    perPosition,
    overLimitCount: perPosition.filter((item) => item.overLimit).length,
  };
};

export interface OwnerExposure {
  readonly ownerName: string;
  readonly guaranteedPositions: number;
  /** Sum of guaranteed balances, capped per position where the guarantee is limited. */
  readonly exposureAmount: Sourced<number>;
  readonly hasUnlimitedGuarantee: boolean;
}

/**
 * PG Exposure Map - blueprint 5.1.
 *
 * Aggregated by owner across positions, because the number that matters to a guarantor is what
 * they are on the hook for in total, not per facility. A limited guarantee contributes the lesser
 * of its cap and the balance; an unlimited one contributes the whole balance and is flagged, since
 * exposure there grows with future draws the owner has not yet made.
 */
export const pgExposureMap = (
  positions: readonly CapitalPosition[],
  provenance: Provenance,
): OwnerExposure[] => {
  const byOwner = new Map<string, { amount: number; count: number; unlimited: boolean }>();

  for (const position of positions) {
    const guarantee = position.personalGuarantee;
    if (guarantee === null) continue;

    const contribution =
      guarantee.limitAmount === null
        ? position.outstandingBalance
        : Math.min(guarantee.limitAmount, position.outstandingBalance);

    const existing = byOwner.get(guarantee.ownerName) ?? { amount: 0, count: 0, unlimited: false };
    byOwner.set(guarantee.ownerName, {
      amount: existing.amount + contribution,
      count: existing.count + 1,
      unlimited: existing.unlimited || guarantee.limitAmount === null,
    });
  }

  return [...byOwner.entries()]
    .map(([ownerName, entry]) => ({
      ownerName,
      guaranteedPositions: entry.count,
      exposureAmount: { value: entry.amount, provenance },
      hasUnlimitedGuarantee: entry.unlimited,
    }))
    .sort((a, b) => b.exposureAmount.value - a.exposureAmount.value);
};

/** The oldest observation in the stack. A stack is only as current as its stalest position. */
export const stackAsOf = (positions: readonly CapitalPosition[]): string | null =>
  positions.length === 0
    ? null
    : positions.reduce(
        (oldest, position) => (position.asOf < oldest ? position.asOf : oldest),
        positions[0]?.asOf ?? '',
      );
