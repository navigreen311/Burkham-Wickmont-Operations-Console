/**
 * Enrichment — blueprint 3.3 step 3: "categorization, revenue reconciliation, anomaly detection".
 *
 * Pure functions over normalized data. That is what makes this half of 3.3 buildable while every
 * vendor in the module's flow is still ungated.
 *
 * Two disciplines run through all of it:
 *
 *   - **Every derived fact carries provenance**, including the feed timestamp. Blueprint 3.3 says
 *     so explicitly and principle 8 requires it. `Sourced<T>` makes it structural.
 *   - **Coverage travels with the claim.** A reconciliation over 3 of 24 months is a different
 *     statement from one over 24, and analysis that reported them identically would be the
 *     silent-partial-data failure the field exists to prevent.
 */

import type { Sourced } from '@bwc/core';
import { amountIn, categorizeAll, type CategorizationSummary } from './categorize.js';
import {
  coverageRatio,
  hasSufficientCoverage,
  monthOf,
  type NormalizedFeed,
  type NormalizedTransaction,
} from './normalized.js';

export type FindingKind =
  | 'nsf_event'
  | 'large_deposit'
  | 'owner_transfer'
  | 'revenue_mismatch'
  | 'balance_deterioration'
  | 'missing_document'
  | 'bureau_bank_disagreement';

export type FindingSeverity = 'informational' | 'attention' | 'urgent';

/**
 * A finding.
 *
 * `detail` is `Sourced`, so a finding cannot be constructed without saying where it came from.
 * `summary` is written for a human and **never contains a transaction description** — descriptions
 * carry counterparty names, and findings reach the Event Ledger, which is retained indefinitely.
 */
export interface Finding {
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly detail: Sourced<Record<string, unknown>>;
  readonly occurredOn?: string;
}

const sourcedDetail = (
  feed: NormalizedFeed,
  detail: Record<string, unknown>,
): Sourced<Record<string, unknown>> => ({ value: detail, provenance: feed.provenance });

// --- Revenue reconciliation ----------------------------------------------

export interface MonthlyRevenue {
  readonly month: string;
  readonly amount: number;
}

export interface RevenueAnalysis {
  readonly monthly: readonly MonthlyRevenue[];
  readonly averageMonthly: Sourced<number>;
  readonly medianMonthly: Sourced<number>;
  /** Coefficient of variation. High means lumpy revenue, which changes product suitability. */
  readonly volatility: number;
  readonly coverage: number;
  readonly categorization: CategorizationSummary;
  /** True when there is enough data to make the claim at all. */
  readonly sufficient: boolean;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/**
 * Revenue by month, from categorized inflows.
 *
 * Internal transfers and owner contributions are excluded, which is the whole reason
 * categorization exists upstream: counting a transfer between the client's own accounts as
 * revenue would inflate the figure a funding recommendation rests on, and it is the single most
 * common way stated revenue and bank revenue diverge innocently.
 */
export const analyzeRevenue = (feed: NormalizedFeed): RevenueAnalysis => {
  const categorization = categorizeAll(feed.transactions);
  const revenueItems = categorization.categorized.filter((item) => item.category === 'revenue');

  const byMonth = new Map<string, number>();
  for (const item of revenueItems) {
    const month = monthOf(item.transaction.postedOn);
    byMonth.set(month, (byMonth.get(month) ?? 0) + item.transaction.amount);
  }

  const monthly = [...byMonth.entries()]
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const amounts = monthly.map((entry) => entry.amount);
  const average = amounts.length === 0 ? 0 : amounts.reduce((a, b) => a + b, 0) / amounts.length;

  const variance =
    amounts.length === 0
      ? 0
      : amounts.reduce((sum, value) => sum + (value - average) ** 2, 0) / amounts.length;

  return {
    monthly,
    averageMonthly: { value: average, provenance: feed.provenance },
    medianMonthly: { value: median(amounts), provenance: feed.provenance },
    volatility: average === 0 ? 0 : Math.sqrt(variance) / average,
    coverage: coverageRatio(feed),
    categorization,
    sufficient: hasSufficientCoverage(feed),
  };
};

/**
 * Compare bank-derived revenue against what the client stated.
 *
 * Tolerance is proportional, not absolute: a $2,000 gap means something very different on $10,000
 * of monthly revenue than on $500,000.
 */
export const REVENUE_MISMATCH_TOLERANCE = 0.15;

export const reconcileStatedRevenue = (
  feed: NormalizedFeed,
  statedMonthlyRevenue: number,
): Finding | null => {
  const analysis = analyzeRevenue(feed);
  const observed = analysis.averageMonthly.value;

  if (statedMonthlyRevenue <= 0) return null;

  const divergence = Math.abs(observed - statedMonthlyRevenue) / statedMonthlyRevenue;
  if (divergence <= REVENUE_MISMATCH_TOLERANCE) return null;

  // Insufficient coverage downgrades severity rather than suppressing the finding: three months
  // of data disagreeing with the stated figure is worth surfacing, but it is not the same claim
  // as twenty-four months disagreeing.
  const severity: FindingSeverity = !analysis.sufficient
    ? 'informational'
    : divergence > 0.4
      ? 'urgent'
      : 'attention';

  return {
    kind: 'revenue_mismatch',
    severity,
    summary: `Bank-derived revenue differs from stated revenue by ${Math.round(divergence * 100)}% over ${analysis.monthly.length} month(s).`,
    detail: sourcedDetail(feed, {
      statedMonthlyRevenue,
      observedMonthlyRevenue: Math.round(observed),
      divergence: Number(divergence.toFixed(3)),
      monthsObserved: analysis.monthly.length,
      coverage: Number(analysis.coverage.toFixed(2)),
      categorizationCoverage: Number(analysis.categorization.coverage.toFixed(2)),
      sufficientCoverage: analysis.sufficient,
    }),
  };
};

// --- Anomalies ------------------------------------------------------------

/**
 * NSF events. Blueprint 6.1 sources Risk & Defense alerts from exactly these.
 *
 * One is informational; a pattern is not. Three or more in the observed window is the point at
 * which it stops looking like a timing accident.
 */
export const analyzeNsf = (feed: NormalizedFeed): Finding[] => {
  const categorization = categorizeAll(feed.transactions);
  const events = categorization.categorized.filter((item) => item.category === 'nsf_fee');
  if (events.length === 0) return [];

  const severity: FindingSeverity =
    events.length >= 5 ? 'urgent' : events.length >= 3 ? 'attention' : 'informational';

  return [
    {
      kind: 'nsf_event',
      severity,
      summary: `${events.length} NSF or overdraft event(s) observed across ${feed.monthsCovered} month(s).`,
      detail: sourcedDetail(feed, {
        count: events.length,
        // Dates and amounts only. Descriptions carry counterparty names and findings reach
        // the Ledger.
        dates: events.map((item) => item.transaction.postedOn),
        totalFees: Math.abs(events.reduce((sum, item) => sum + item.transaction.amount, 0)),
        monthsCovered: feed.monthsCovered,
      }),
      ...(events[0] !== undefined ? { occurredOn: events[0].transaction.postedOn } : {}),
    },
  ];
};

/**
 * Deposits far above the client's normal inflow.
 *
 * Relative to the client's own median rather than a fixed threshold: $80,000 is unremarkable for
 * one client and the single most interesting event of the year for another. A fixed number would
 * be noise for the first and silence for the second.
 */
export const LARGE_DEPOSIT_MULTIPLE = 3;

export const analyzeLargeDeposits = (feed: NormalizedFeed): Finding[] => {
  const deposits = feed.transactions.filter((transaction) => transaction.amount > 0);
  if (deposits.length < 4) return [];

  const typical = median(deposits.map((transaction) => transaction.amount));
  if (typical <= 0) return [];

  const large = deposits.filter(
    (transaction) => transaction.amount >= typical * LARGE_DEPOSIT_MULTIPLE,
  );
  if (large.length === 0) return [];

  return large.map((transaction) => ({
    kind: 'large_deposit' as const,
    severity: 'attention' as const,
    summary: `Deposit of ${Math.round(transaction.amount)} is ${(transaction.amount / typical).toFixed(1)}x the client's typical deposit.`,
    detail: sourcedDetail(feed, {
      amount: transaction.amount,
      typicalDeposit: Math.round(typical),
      multiple: Number((transaction.amount / typical).toFixed(2)),
      accountRef: transaction.accountRef,
    }),
    occurredOn: transaction.postedOn,
  }));
};

/**
 * Owner draws and contributions.
 *
 * Blueprint 3.3 lists "owner transfer detections" among what this pipeline owns, and the reason
 * is underwriting rather than curiosity: draws reduce the cash available to service debt, and
 * contributions can make revenue look stronger than the business generated.
 */
export const analyzeOwnerTransfers = (feed: NormalizedFeed): Finding[] => {
  const categorization = categorizeAll(feed.transactions);

  const draws = categorization.categorized.filter((item) => item.category === 'owner_draw');
  const contributions = categorization.categorized.filter(
    (item) => item.category === 'owner_contribution',
  );

  if (draws.length === 0 && contributions.length === 0) return [];

  const drawTotal = Math.abs(amountIn(draws, 'owner_draw'));
  const contributionTotal = amountIn(contributions, 'owner_contribution');

  return [
    {
      kind: 'owner_transfer',
      severity: 'informational',
      summary: `${draws.length} owner draw(s) and ${contributions.length} owner contribution(s) observed.`,
      detail: sourcedDetail(feed, {
        drawCount: draws.length,
        drawTotal: Math.round(drawTotal),
        contributionCount: contributions.length,
        contributionTotal: Math.round(contributionTotal),
        monthsCovered: feed.monthsCovered,
      }),
    },
  ];
};

/**
 * Balance trend across the observed window.
 *
 * Compares the first and last month's closing position per account. A steady decline is what
 * blueprint 6.1 calls cash balance deterioration.
 */
export const BALANCE_DETERIORATION_THRESHOLD = -0.3;

export const analyzeBalanceTrend = (feed: NormalizedFeed): Finding[] => {
  const findings: Finding[] = [];

  for (const account of feed.accounts) {
    const transactions = feed.transactions
      .filter((transaction) => transaction.accountRef === account.accountRef)
      .sort((a, b) => a.postedOn.localeCompare(b.postedOn));

    if (transactions.length < 2) continue;

    const months = [...new Set(transactions.map((t) => monthOf(t.postedOn)))].sort();
    if (months.length < 2) continue;

    const net = (month: string): number =>
      transactions
        .filter((t) => monthOf(t.postedOn) === month)
        .reduce((sum, t) => sum + t.amount, 0);

    const first = net(months[0] as string);
    const last = net(months[months.length - 1] as string);
    if (first <= 0) continue;

    const change = (last - first) / first;
    if (change > BALANCE_DETERIORATION_THRESHOLD) continue;

    findings.push({
      kind: 'balance_deterioration',
      severity: change < -0.6 ? 'urgent' : 'attention',
      summary: `Net monthly cash flow on ${account.name} fell ${Math.round(Math.abs(change) * 100)}% between ${months[0]} and ${months[months.length - 1]}.`,
      detail: sourcedDetail(feed, {
        accountRef: account.accountRef,
        firstMonth: months[0],
        lastMonth: months[months.length - 1],
        firstMonthNet: Math.round(first),
        lastMonthNet: Math.round(last),
        change: Number(change.toFixed(3)),
      }),
    });
  }

  return findings;
};

/** Every anomaly analysis, in one pass. */
export const analyzeFeed = (feed: NormalizedFeed): Finding[] => [
  ...analyzeNsf(feed),
  ...analyzeLargeDeposits(feed),
  ...analyzeOwnerTransfers(feed),
  ...analyzeBalanceTrend(feed),
];

export { type NormalizedTransaction };
