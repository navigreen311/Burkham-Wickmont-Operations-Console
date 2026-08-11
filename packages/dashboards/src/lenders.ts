/**
 * 9.4 Lender Performance Dashboard - engine only.
 *
 * Almost all of this module's honesty was already bought by 5.5. `byProvider` returns approval
 * and decline counts, a mean time to decision, and funded cents, and it withholds a rate below
 * `MINIMUM_DECIDED_FOR_RATE`. This file is the reading on top, and its whole job is to not undo
 * any of that on the way to a dashboard.
 *
 * Three things it refuses to do.
 *
 * **It does not rank lenders.** Blueprint 9.4 asks for "comparison across lenders for the same
 * product", and the obvious rendering is a league table. A league table is an ordering, an
 * ordering implies a scalar, and the scalar somebody would reach for is approval rate - which
 * would put a lender who approves everything at the top and a lender we send only hard cases to
 * at the bottom. The comparison here is a SET of per-lender readings sharing a product and a
 * window, and the caller can see them side by side without the system asserting which is better.
 *
 * **It does not compute a rate a lender has not earned a denominator for.** Below ten decided
 * attempts there is no rate, and the reason travels with the absence. This is 5.5's rule and it
 * is not re-derived here - the denominator check lives in one place.
 *
 * **It does not treat a complaint count as a rate.** Complaints are counted and severity-weighted
 * by 5.4; dividing them by attempts would produce a "complaint rate" whose denominator has nothing
 * to do with who complained. The count travels as a count.
 *
 * Blueprint 9.4 also lists "suitability score accuracy" and "client outcome after funding". Both
 * are `unmeasurable` here and say what would produce them, rather than being quietly dropped -
 * 9.1's precedent, and the reason a reader can tell this dashboard is incomplete rather than
 * assuming these were considered and found fine.
 */

import {
  MINIMUM_DECIDED_FOR_RATE,
  byProvider,
  decidedInByProduct,
  type ProviderPerformance,
} from '@bwc/outcomes';
import { measured, unmeasurable, type Metric, type Period } from './metric.js';

export interface LenderReading {
  readonly providerId: string;
  /** Decided attempts. The denominator every rate below is judged against. */
  readonly decided: number;
  readonly approved: number;
  readonly declined: number;
  readonly pending: number;
  readonly withdrawn: number;
  /** Null below `MINIMUM_DECIDED_FOR_RATE`. 5.5 withholds it; nothing here recomputes it. */
  readonly approvalRate: Metric<number>;
  readonly meanDaysToDecision: Metric<number>;
  readonly fundedCents: number;
}

/**
 * Facts blueprint 9.4 names that nothing in this system produces yet.
 *
 * Carried rather than omitted, for 7.1's reason: a lender performance view silent about client
 * outcomes reads as a lender whose clients did fine. Each names what would produce it.
 */
export const UNPRODUCED_LENDER_FACTS: readonly {
  readonly fact: string;
  readonly awaiting: string;
}[] = [
  {
    fact: 'Time to funding',
    awaiting:
      'A funded-at timestamp distinct from decided-at. 5.5 records when a decision landed, not when money arrived.',
  },
  {
    fact: 'Client outcome after funding',
    awaiting:
      'Post-funding monitoring (6.1 alerts, Plaid via 11.5), which is gated pending security review.',
  },
  {
    fact: 'Suitability score accuracy',
    awaiting:
      '5.3 recording the recommendation it made against the outcome that followed. It records the recommendation; nothing joins the two.',
  },
  {
    fact: 'Renewal behaviour',
    awaiting:
      'Renewal events per provider. 5.2 holds a free-text `renewalBehavior` note, which is research rather than measurement.',
  },
];

const readingFor = (row: ProviderPerformance, period: Period): LenderReading => {
  const decided = row.decided;

  const approvalRate =
    decided >= MINIMUM_DECIDED_FOR_RATE
      ? measured<number>({
          key: 'lender_approval_rate',
          label: 'Approval rate',
          value: row.approved / decided,
          numerator: row.approved,
          denominator: decided,
          period,
          note: `${row.approved} approved of ${decided} decided. Pending and withdrawn attempts are in neither half - counting a withdrawal as a non-approval makes a provider look worse the more clients change their minds.`,
        })
      : unmeasurable<number>({
          key: 'lender_approval_rate',
          label: 'Approval rate',
          period,
          numerator: row.approved,
          denominator: decided,
          note: `${decided} decided attempt(s) with this provider; ${MINIMUM_DECIDED_FOR_RATE} are needed before a rate means anything. The counts are real and are shown; the rate is withheld.`,
        });

  const meanDays =
    row.meanDaysToDecision !== null
      ? measured<number>({
          key: 'lender_mean_days_to_decision',
          label: 'Mean days to decision',
          value: row.meanDaysToDecision,
          denominator: decided,
          period,
          note: `Mean over ${decided} decided attempt(s), from submission to decision.`,
        })
      : unmeasurable<number>({
          key: 'lender_mean_days_to_decision',
          label: 'Mean days to decision',
          period,
          denominator: decided,
          note: 'Nothing has been decided with this provider in the window. A mean of an empty set is not zero, and a "0 day turnaround" is the most flattering possible way to render "we have never had an answer from them".',
        });

  return {
    providerId: row.providerId,
    decided,
    approved: row.approved,
    declined: row.declined,
    pending: row.pending,
    withdrawn: row.withdrawn,
    approvalRate,
    meanDaysToDecision: meanDays,
    fundedCents: row.fundedCents,
  };
};

export interface LenderPerformanceView {
  readonly period: Period;
  readonly lenders: readonly LenderReading[];
  /** Named gaps, so the view reads as incomplete rather than as complete and reassuring. */
  readonly unproduced: readonly { readonly fact: string; readonly awaiting: string }[];
  readonly note: string;
}

/**
 * Every provider's reading for a window.
 *
 * Ordered by provider id, deliberately - NOT by any performance figure. Sorting by approval rate
 * would make the list an implicit ranking, and the first row of a sorted table is read as the
 * recommendation whatever the header says.
 */
export const lenderPerformance = async (
  tenantId: string,
  period: Period,
): Promise<LenderPerformanceView> => {
  const rows = await byProvider(tenantId, { from: period.from, to: period.to });

  const lenders = rows
    .map((row) => readingFor(row, period))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));

  return {
    period,
    lenders,
    unproduced: UNPRODUCED_LENDER_FACTS,
    note: `${lenders.length} provider(s) with attempts in this window. Ordered by provider id and not by performance: a sorted table is an implicit ranking, and its first row is read as a recommendation.`,
  };
};

export interface ProductComparison {
  readonly productKind: string;
  readonly period: Period;
  readonly lenders: readonly LenderReading[];
  readonly note: string;
}

/**
 * The same product across lenders - blueprint 9.4's "comparison across lenders for the same
 * product".
 *
 * A set, not a ranking. See the header.
 *
 * **Comparing across different products would be the real error**, and it is the one this
 * function exists to make impossible: a term loan provider and a merchant cash advance provider
 * have different approval rates because they are different products, and a comparison that mixed
 * them would read as one being better at the job the other is not doing.
 */
export const compareForProduct = async (
  tenantId: string,
  productKind: string,
  period: Period,
): Promise<ProductComparison> => {
  const forProduct = await decidedInByProduct(
    tenantId,
    { from: period.from, to: period.to },
    productKind,
  );

  const rows = await byProvider(tenantId, { from: period.from, to: period.to });
  const lenders = rows
    .map((row) => readingFor(row, period))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));

  return {
    productKind,
    period,
    lenders,
    note:
      forProduct.decided > 0
        ? `${forProduct.decided} decided ${productKind} attempt(s) in this window, shown per provider, side by side and unranked. Comparing across products would read as one provider being better at the job the other is not doing.`
        : `No ${productKind} attempts were decided in this window. That is an absence of data, not a set of providers who all performed identically.`,
  };
};
