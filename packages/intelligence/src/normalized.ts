/**
 * The normalized shape — blueprint 3.3, step 3 onward.
 *
 * Analysis takes *this*, not Plaid's payload. Three reasons, in order of weight:
 *
 *   1. It is the only way to build the module at all today. Every vendor in 3.3's flow is
 *      ungated (§11.4, §12.3), so vendor-shaped input would make every test a fixture of a
 *      payload nobody has seen.
 *   2. Decision A's V2 roadmap replaces Plaid for parsing. If the analysis spoke Plaid, V2 would
 *      rewrite the analysis rather than swap the source.
 *   3. Bureau and bank data have to meet somewhere — step 6 correlates them.
 *
 * Each adapter's job therefore becomes "produce this shape", which is a far smaller and more
 * testable contract than "be Plaid".
 */

import type { Provenance, Sourced } from '@bwc/core';

export type AccountKind = 'checking' | 'savings' | 'credit_card' | 'line_of_credit' | 'loan';

export interface NormalizedAccount {
  /** Stable within a source. Never the vendor's raw account number. */
  readonly accountRef: string;
  readonly kind: AccountKind;
  readonly name: string;
  /** Last four only. §6.2 field-level encryption covers the full number; this never holds one. */
  readonly maskedIdentifier: string;
  readonly currentBalance: number;
  readonly availableBalance: number | null;
  readonly currency: string;
}

export interface NormalizedTransaction {
  readonly accountRef: string;
  /** ISO date. JSON-native, for the same reason provenance timestamps are. */
  readonly postedOn: string;
  /** Positive is money in, negative is money out. One sign convention, stated once. */
  readonly amount: number;
  /**
   * The counterparty as the source described it.
   *
   * Kept for categorization, and deliberately **never copied into a finding** — a description
   * can carry a person's name, and findings reach the Ledger.
   */
  readonly description: string;
  readonly currency: string;
}

/**
 * A window of data from one source, with how much of it actually arrived.
 *
 * `monthsCovered` is not decoration. A revenue reconciliation over 3 of 24 requested months is a
 * different claim from one over all 24, and analysis that averaged the two into "reconciled"
 * would be the silent-partial-data failure this field exists to prevent.
 */
export interface NormalizedFeed {
  readonly source: 'plaid' | 'business_bureau' | 'personal_credit' | 'uploaded_document';
  readonly provenance: Provenance;
  readonly accounts: readonly NormalizedAccount[];
  readonly transactions: readonly NormalizedTransaction[];
  readonly monthsRequested: number;
  readonly monthsCovered: number;
}

/** Bureau data, normalized. Only the fields step 6 correlates against bank data. */
export interface NormalizedBureauProfile {
  readonly source: 'business_bureau' | 'personal_credit';
  readonly provenance: Provenance;
  /** Bureau-reported monthly revenue, when the bureau reports one. */
  readonly reportedMonthlyRevenue: number | null;
  readonly reportedMonthlyDebtService: number | null;
  readonly openTradelines: number | null;
  readonly derogatoryMarks: number | null;
}

export const coverageRatio = (feed: NormalizedFeed): number =>
  feed.monthsRequested === 0 ? 0 : feed.monthsCovered / feed.monthsRequested;

/**
 * Is there enough data to make a claim at all?
 *
 * Two thirds is a judgement, and it is stated here rather than buried in each analysis so the
 * threshold can be argued with in one place. Below it, analyses report their coverage and
 * downgrade their confidence rather than staying silent — a caller that asked for revenue and
 * got nothing back cannot tell "no revenue" from "not enough data".
 */
export const MINIMUM_COVERAGE = 2 / 3;

export const hasSufficientCoverage = (feed: NormalizedFeed): boolean =>
  coverageRatio(feed) >= MINIMUM_COVERAGE;

/** Convenience for building a `Sourced` fact from a feed, so the feed's provenance travels. */
export const fromFeed = <T>(feed: NormalizedFeed, value: T): Sourced<T> => ({
  value,
  provenance: feed.provenance,
});

export const monthOf = (postedOn: string): string => postedOn.slice(0, 7);

export const inflows = (transactions: readonly NormalizedTransaction[]): NormalizedTransaction[] =>
  transactions.filter((transaction) => transaction.amount > 0);

export const outflows = (transactions: readonly NormalizedTransaction[]): NormalizedTransaction[] =>
  transactions.filter((transaction) => transaction.amount < 0);
