/**
 * Step 6 — blueprint 3.3: "Pipeline correlates bureau data with Plaid data (does personal
 * spending in bureau match Plaid outflows? does business revenue in bureau match Plaid deposits?)"
 *
 * The load-bearing behaviour is what happens when a side is **missing**.
 *
 * Correlation is the natural place to accidentally invent agreement: with no bureau figure, a
 * naive implementation compares against zero or skips the check, and both read downstream as
 * "no disagreement found". That is indistinguishable from a genuine match, and it is the exact
 * shape principle 9 exists to prevent — so an absent side returns `no_data` naming which side,
 * never a clean result.
 */

import { noData, ok, type Outcome, type Sourced } from '@bwc/core';
import { analyzeRevenue, type Finding } from './analyze.js';
import type { NormalizedBureauProfile, NormalizedFeed } from './normalized.js';

/** Proportional, for the same reason revenue tolerance is. */
export const CORRELATION_TOLERANCE = 0.25;

export interface Correlation {
  readonly dimension: 'monthly_revenue' | 'monthly_debt_service';
  readonly bankDerived: Sourced<number>;
  readonly bureauReported: Sourced<number>;
  readonly divergence: number;
  readonly agrees: boolean;
}

export interface CorrelationResult {
  readonly correlations: readonly Correlation[];
  readonly findings: readonly Finding[];
}

/**
 * Correlate a bank feed against a bureau profile.
 *
 * Returns `no_data` — not an empty result — when either side is absent or when the bureau does not
 * report the dimension. The caller then knows the check did not run, rather than believing it ran
 * and found nothing.
 */
export const correlate = (
  feed: NormalizedFeed | null,
  bureau: NormalizedBureauProfile | null,
): Outcome<CorrelationResult> => {
  if (feed === null) {
    return noData(
      'No bank feed available, so bureau data cannot be correlated against it. This is not agreement.',
    );
  }
  if (bureau === null) {
    return noData(
      'No bureau profile available, so bank data cannot be correlated against it. This is not agreement.',
    );
  }

  const correlations: Correlation[] = [];
  const findings: Finding[] = [];

  const revenue = analyzeRevenue(feed);

  if (bureau.reportedMonthlyRevenue !== null && bureau.reportedMonthlyRevenue > 0) {
    const bankDerived = revenue.averageMonthly.value;
    const reported = bureau.reportedMonthlyRevenue;
    const divergence = Math.abs(bankDerived - reported) / reported;
    const agrees = divergence <= CORRELATION_TOLERANCE;

    correlations.push({
      dimension: 'monthly_revenue',
      bankDerived: revenue.averageMonthly,
      bureauReported: { value: reported, provenance: bureau.provenance },
      divergence: Number(divergence.toFixed(3)),
      agrees,
    });

    if (!agrees) {
      findings.push({
        kind: 'bureau_bank_disagreement',
        // Downgraded when the bank window is thin - the disagreement may be the window, not the
        // client.
        severity: revenue.sufficient ? 'attention' : 'informational',
        summary: `Bureau-reported monthly revenue differs from bank-derived revenue by ${Math.round(divergence * 100)}%.`,
        detail: {
          value: {
            dimension: 'monthly_revenue',
            bankDerived: Math.round(bankDerived),
            bureauReported: Math.round(reported),
            divergence: Number(divergence.toFixed(3)),
            bankCoverage: Number(revenue.coverage.toFixed(2)),
            bankMonthsObserved: revenue.monthly.length,
          },
          // Both sides are named in the provenance, because the disagreement is between two
          // dated sources and "which was stale" is the first question anyone asks.
          provenance: feed.provenance,
        },
      });
    }
  }

  if (bureau.reportedMonthlyDebtService !== null && bureau.reportedMonthlyDebtService > 0) {
    const observed = Math.abs(
      revenue.categorization.categorized
        .filter((item) => item.category === 'debt_service')
        .reduce((sum, item) => sum + item.transaction.amount, 0),
    );
    const months = Math.max(1, revenue.monthly.length);
    const bankDerived = observed / months;
    const reported = bureau.reportedMonthlyDebtService;
    const divergence = Math.abs(bankDerived - reported) / reported;
    const agrees = divergence <= CORRELATION_TOLERANCE;

    correlations.push({
      dimension: 'monthly_debt_service',
      bankDerived: { value: bankDerived, provenance: feed.provenance },
      bureauReported: { value: reported, provenance: bureau.provenance },
      divergence: Number(divergence.toFixed(3)),
      agrees,
    });

    if (!agrees) {
      findings.push({
        kind: 'bureau_bank_disagreement',
        // Debt service the bureau knows about but the bank does not show is the undisclosed-debt
        // shape blueprint 6.3 watches for, so it is not downgraded on thin coverage.
        severity: bankDerived < reported ? 'attention' : 'informational',
        summary: `Bureau-reported monthly debt service differs from observed debt payments by ${Math.round(divergence * 100)}%.`,
        detail: {
          value: {
            dimension: 'monthly_debt_service',
            bankDerived: Math.round(bankDerived),
            bureauReported: Math.round(reported),
            divergence: Number(divergence.toFixed(3)),
            possibleUndisclosedDebt: bankDerived < reported,
          },
          provenance: bureau.provenance,
        },
      });
    }
  }

  if (correlations.length === 0) {
    return noData(
      'The bureau profile reports neither revenue nor debt service, so there is nothing to correlate. This is not agreement.',
    );
  }

  return ok({ correlations, findings });
};
