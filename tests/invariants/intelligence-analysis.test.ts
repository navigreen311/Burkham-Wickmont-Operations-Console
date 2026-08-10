/**
 * Invariants for 3.3's analysis half — the part that is buildable while every vendor is ungated.
 *
 * Pure functions over synthetic normalized data, so these run without a database or a vendor.
 * That is the point of normalizing on our own shape: the intelligence is testable today.
 */

import { describe, expect, it } from 'vitest';
import { isUnverified, type Provenance } from '@bwc/core';
import {
  CATEGORIES,
  LARGE_DEPOSIT_MULTIPLE,
  MINIMUM_COVERAGE,
  REVENUE_MISMATCH_TOLERANCE,
  analyzeBalanceTrend,
  analyzeFeed,
  analyzeLargeDeposits,
  analyzeNsf,
  analyzeOwnerTransfers,
  analyzeRevenue,
  categorize,
  categorizeAll,
  coverageRatio,
  hasSufficientCoverage,
  reconcileStatedRevenue,
  type NormalizedFeed,
  type NormalizedTransaction,
} from '@bwc/intelligence';

const FEED_PROVENANCE: Provenance = {
  tag: 'vendor_feed',
  vendor: 'plaid',
  retrievedAt: '2026-08-09',
  consentReference: 'consent-abc',
};

const tx = (
  postedOn: string,
  amount: number,
  description: string,
  accountRef = 'acct-1',
): NormalizedTransaction => ({ accountRef, postedOn, amount, description, currency: 'USD' });

const feedOf = (
  transactions: readonly NormalizedTransaction[],
  monthsCovered = 12,
  monthsRequested = 12,
): NormalizedFeed => ({
  source: 'plaid',
  provenance: FEED_PROVENANCE,
  accounts: [
    {
      accountRef: 'acct-1',
      kind: 'checking',
      name: 'Operating',
      maskedIdentifier: '••1234',
      currentBalance: 42_000,
      availableBalance: 41_000,
      currency: 'USD',
    },
  ],
  transactions,
  monthsRequested,
  monthsCovered,
});

/** Twelve months of steady revenue, roughly $30k/month. */
const steadyRevenue = (): NormalizedTransaction[] => {
  const rows: NormalizedTransaction[] = [];
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, '0');
    rows.push(tx(`2026-${mm}-05`, 15_000, 'ACH CREDIT customer payment'));
    rows.push(tx(`2026-${mm}-20`, 15_000, 'STRIPE deposit'));
    rows.push(tx(`2026-${mm}-28`, -8_000, 'PAYROLL gusto'));
  }
  return rows;
};

describe('categorization is deterministic and total', () => {
  it('assigns every transaction a known category', () => {
    const summary = categorizeAll(steadyRevenue());
    expect(summary.total).toBe(36);
    for (const item of summary.categorized) {
      expect(CATEGORIES).toContain(item.category);
    }
  });

  it('returns the same category for the same input every time', () => {
    const transaction = tx('2026-03-01', 5_000, 'STRIPE deposit');
    const first = categorize(transaction);
    const second = categorize(transaction);
    expect(second.category).toBe(first.category);
    expect(second.basis).toBe(first.basis);
  });

  it('states a basis for every category it assigns', () => {
    // A category feeding a funding recommendation must be explainable to a client who disputes
    // it. Only `uncategorized` may have no basis.
    for (const item of categorizeAll(steadyRevenue()).categorized) {
      if (item.category === 'uncategorized') continue;
      expect(item.basis.length).toBeGreaterThan(10);
    }
  });

  it('matches the specific rule before the general one', () => {
    // NSF before bank fee: both are outbound institution charges.
    expect(categorize(tx('2026-01-01', -35, 'NSF FEE')).category).toBe('nsf_fee');
    expect(categorize(tx('2026-01-01', -12, 'MONTHLY FEE')).category).toBe('bank_fee');
  });

  it('excludes internal transfers from revenue', () => {
    // Counting a transfer between the client's own accounts as revenue is the most common way
    // bank-derived revenue innocently diverges from reality.
    expect(categorize(tx('2026-01-01', 20_000, 'ONLINE TRANSFER from savings')).category).toBe(
      'transfer_internal',
    );
  });

  it('reports uncategorized share rather than hiding it', () => {
    const summary = categorizeAll([
      tx('2026-01-01', 500, 'ZZQX 4471 REF'),
      tx('2026-01-02', 5_000, 'STRIPE deposit'),
    ]);
    expect(summary.uncategorized).toBe(1);
    expect(summary.coverage).toBeCloseTo(0.5);
  });
});

describe('revenue analysis carries provenance and coverage', () => {
  it('attaches the feed provenance to every derived figure', () => {
    const analysis = analyzeRevenue(feedOf(steadyRevenue()));

    // Principle 8 and blueprint 3.3: provenance preservation on every enriched fact.
    expect(analysis.averageMonthly.provenance).toEqual(FEED_PROVENANCE);
    expect(analysis.medianMonthly.provenance).toEqual(FEED_PROVENANCE);
    expect(isUnverified(analysis.averageMonthly.provenance)).toBe(false);
  });

  it('computes monthly revenue excluding payroll and transfers', () => {
    const analysis = analyzeRevenue(feedOf(steadyRevenue()));
    expect(analysis.monthly).toHaveLength(12);
    expect(analysis.averageMonthly.value).toBeCloseTo(30_000, 0);
  });

  it('reports low volatility for steady revenue and high for lumpy', () => {
    const steady = analyzeRevenue(feedOf(steadyRevenue()));
    expect(steady.volatility).toBeLessThan(0.05);

    const lumpy = analyzeRevenue(
      feedOf([
        tx('2026-01-05', 90_000, 'ACH CREDIT customer payment'),
        tx('2026-02-05', 1_000, 'ACH CREDIT customer payment'),
        tx('2026-03-05', 1_000, 'ACH CREDIT customer payment'),
      ]),
    );
    expect(lumpy.volatility).toBeGreaterThan(0.9);
  });

  it('reports partial coverage rather than presenting it as complete', () => {
    // Three of twenty-four months is a different claim from twenty-four of twenty-four.
    const thin = feedOf(steadyRevenue().slice(0, 9), 3, 24);
    const analysis = analyzeRevenue(thin);

    expect(analysis.coverage).toBeCloseTo(3 / 24);
    expect(analysis.sufficient).toBe(false);
    expect(hasSufficientCoverage(thin)).toBe(false);
    expect(coverageRatio(thin)).toBeCloseTo(0.125);
  });

  it('treats two thirds as the sufficiency line', () => {
    expect(hasSufficientCoverage(feedOf(steadyRevenue(), 16, 24))).toBe(true);
    expect(hasSufficientCoverage(feedOf(steadyRevenue(), 15, 24))).toBe(false);
    expect(MINIMUM_COVERAGE).toBeCloseTo(2 / 3);
  });
});

describe('stated revenue reconciliation', () => {
  it('passes when stated and observed agree within tolerance', () => {
    expect(reconcileStatedRevenue(feedOf(steadyRevenue()), 31_000)).toBeNull();
  });

  it('flags a mismatch beyond tolerance, proportionally', () => {
    const finding = reconcileStatedRevenue(feedOf(steadyRevenue()), 60_000);

    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe('revenue_mismatch');
    expect(finding?.severity).toBe('urgent');
    expect(finding?.detail.provenance).toEqual(FEED_PROVENANCE);
    expect(REVENUE_MISMATCH_TOLERANCE).toBeCloseTo(0.15);
  });

  it('downgrades severity when coverage is thin rather than suppressing the finding', () => {
    // Three months disagreeing is worth surfacing, but it is not the same claim as
    // twenty-four months disagreeing.
    const thin = feedOf(steadyRevenue().slice(0, 9), 3, 24);
    const finding = reconcileStatedRevenue(thin, 100_000);

    expect(finding?.severity).toBe('informational');
    expect(finding?.detail.value['sufficientCoverage']).toBe(false);
  });

  it('does not flag when no revenue was stated', () => {
    expect(reconcileStatedRevenue(feedOf(steadyRevenue()), 0)).toBeNull();
  });
});

describe('anomaly detection', () => {
  it('escalates NSF severity with frequency', () => {
    const one = analyzeNsf(feedOf([tx('2026-01-10', -35, 'NSF FEE')]));
    expect(one[0]?.severity).toBe('informational');

    const many = analyzeNsf(
      feedOf([
        tx('2026-01-10', -35, 'NSF FEE'),
        tx('2026-02-10', -35, 'NSF FEE'),
        tx('2026-03-10', -35, 'OVERDRAFT FEE'),
      ]),
    );
    expect(many[0]?.severity).toBe('attention');
  });

  it('never puts a transaction description into a finding', () => {
    // Descriptions carry counterparty names and findings reach the Ledger, which is retained
    // indefinitely.
    const findings = analyzeFeed(
      feedOf([
        ...steadyRevenue(),
        tx('2026-01-10', -35, 'NSF FEE RETURNED ITEM JANE Q CUSTOMER'),
        tx('2026-06-15', 250_000, 'DEPOSIT FROM ACME HOLDINGS LLC'),
      ]),
    );

    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain('JANE Q CUSTOMER');
    expect(serialized).not.toContain('ACME HOLDINGS');
  });

  it('flags a deposit relative to the client rather than a fixed threshold', () => {
    // $80k is unremarkable for one client and the event of the year for another.
    const findings = analyzeLargeDeposits(
      feedOf(steadyRevenue().concat(tx('2026-06-15', 250_000, 'DEPOSIT'))),
    );

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.kind).toBe('large_deposit');
    expect(findings[0]?.detail.value['multiple']).toBeGreaterThanOrEqual(LARGE_DEPOSIT_MULTIPLE);
  });

  it('does not flag ordinary deposits in a steady feed', () => {
    expect(analyzeLargeDeposits(feedOf(steadyRevenue()))).toHaveLength(0);
  });

  it('detects owner draws and contributions', () => {
    const findings = analyzeOwnerTransfers(
      feedOf([
        ...steadyRevenue(),
        tx('2026-03-01', -20_000, 'OWNER DRAW'),
        tx('2026-04-01', 10_000, 'CAPITAL CONTRIBUTION'),
      ]),
    );

    expect(findings[0]?.kind).toBe('owner_transfer');
    expect(findings[0]?.detail.value['drawCount']).toBe(1);
    expect(findings[0]?.detail.value['contributionCount']).toBe(1);
  });

  it('detects a declining cash trend', () => {
    const declining = feedOf([
      tx('2026-01-05', 40_000, 'ACH CREDIT customer payment'),
      tx('2026-01-28', -5_000, 'PAYROLL gusto'),
      tx('2026-06-05', 6_000, 'ACH CREDIT customer payment'),
      tx('2026-06-28', -5_000, 'PAYROLL gusto'),
    ]);

    const findings = analyzeBalanceTrend(declining);
    expect(findings[0]?.kind).toBe('balance_deterioration');
    expect(findings[0]?.severity).toBe('urgent');
  });

  it('does not flag a steady trend', () => {
    expect(analyzeBalanceTrend(feedOf(steadyRevenue()))).toHaveLength(0);
  });

  it('attaches provenance to every finding it produces', () => {
    const findings = analyzeFeed(
      feedOf([
        ...steadyRevenue(),
        tx('2026-01-10', -35, 'NSF FEE'),
        tx('2026-03-01', -20_000, 'OWNER DRAW'),
      ]),
    );

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.detail.provenance).toBeDefined();
      expect(finding.detail.provenance.tag).toBe('vendor_feed');
    }
  });
});
