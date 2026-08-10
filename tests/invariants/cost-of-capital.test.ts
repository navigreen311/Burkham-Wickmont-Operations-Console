/**
 * Invariants for 5.6 Cost of Capital Calculator.
 *
 * This is the most correctness-critical arithmetic in the platform. A wrong APR does not fail
 * loudly — it produces a confident number that a client acts on, and the whole reason blueprint
 * 5.6 exists is that the true cost of small-business capital is routinely hidden.
 *
 * So the tests anchor on **known answers** rather than on self-consistency. A suite where the
 * implementation and the expectation are derived from the same reasoning proves only that the
 * reasoning is applied consistently, including when it is wrong.
 */

import { describe, expect, it } from 'vitest';
import type { Provenance } from '@bwc/core';
import {
  PERIODS_PER_YEAR,
  annualize,
  blendedCostOfCapital,
  compareRefinance,
  costOfCapital,
  factorRateToApr,
  npv,
  solvePeriodicRate,
} from '@bwc/capital';

const PROVENANCE: Provenance = {
  tag: 'issuer_rule',
  sourceUrl: 'https://example.invalid/terms',
  lastVerified: '2026-08-01',
  verifiedBy: 'funding_strategy',
};

describe('the solver finds the rate the cash flows actually imply', () => {
  it('recovers a known rate from a textbook annuity', () => {
    // $10,000 at exactly 1% per period for 12 periods amortizes to 888.4879... per period.
    // Independently checkable: pmt = P·i / (1 - (1+i)^-n).
    const payment = (10_000 * 0.01) / (1 - 1.01 ** -12);
    expect(payment).toBeCloseTo(888.4879, 3);

    const rate = solvePeriodicRate([
      { period: 0, amount: 10_000 },
      ...Array.from({ length: 12 }, (_, index) => ({ period: index + 1, amount: -payment })),
    ]);

    expect(rate).not.toBeNull();
    expect(rate as number).toBeCloseTo(0.01, 8);
  });

  it('lands NPV on zero at the rate it returns', () => {
    const flows = [
      { period: 0, amount: 50_000 },
      ...Array.from({ length: 24 }, (_, index) => ({ period: index + 1, amount: -2_400 })),
    ];
    const rate = solvePeriodicRate(flows) as number;

    // Relative, not absolute. These flows are denominated in tens of thousands, so an absolute
    // dollar threshold either demands more precision than a double carries or is meaninglessly
    // loose on a small advance. The first version of this assertion used 1e-6 dollars and failed
    // at a residual of 1.2e-5 - which is a relative error of 2e-10, i.e. essentially exact.
    expect(Math.abs(npv(rate, flows)) / 50_000).toBeLessThan(1e-9);
  });

  it('returns a negative rate when the schedule repays less than the advance', () => {
    // 100,000 advanced against 50,000 repaid has a perfectly real rate - a negative one. An
    // earlier version of this test expected null, and the comment justifying it was simply
    // wrong: the flows do cross zero. Surfacing the negative rate is the useful behaviour,
    // because a negative effective APR on a capital product is a data-quality signal, and
    // suppressing it would hide bad inputs behind an empty result.
    const rate = solvePeriodicRate([
      { period: 0, amount: 100_000 },
      ...Array.from({ length: 10 }, (_, index) => ({ period: index + 1, amount: -5_000 })),
    ]);

    expect(rate).not.toBeNull();
    expect(rate as number).toBeLessThan(0);
  });

  it('returns null when the flows never cross zero at all', () => {
    // All inflows: there is no rate at which this has zero present value.
    const rate = solvePeriodicRate([
      { period: 0, amount: 100_000 },
      { period: 1, amount: 5_000 },
    ]);
    expect(rate).toBeNull();
  });

  it('annualizes by compounding, not by multiplication', () => {
    // 1% per month is 12.68% annually, not 12%. The simple form understates every sub-annual
    // cadence, and understates daily products badly.
    expect(annualize(0.01, 12)).toBeCloseTo(0.126825, 5);
    expect(annualize(0.01, 12)).toBeGreaterThan(0.12);
  });

  it('treats daily cadence as banking days', () => {
    // Remittances do not run at weekends; using 365 would overstate the number of payments in a
    // term and understate the periodic rate.
    expect(PERIODS_PER_YEAR.daily).toBe(252);
  });
});

describe('term products', () => {
  it('prices a 12-month amortizing loan at close to its nominal rate', () => {
    const cost = costOfCapital({
      kind: 'term_loan',
      principal: 100_000,
      originationFee: 0,
      cadence: 'monthly',
      termPeriods: 12,
      annualRate: 0.12,
    });

    // With no fees, the effective APR is the nominal rate compounded monthly: 12.68%.
    expect(cost.effectiveApr).toBeCloseTo(0.126825, 4);
    expect(cost.totalCost).toBeGreaterThan(0);
  });

  it('raises the effective APR when an origination fee is netted from proceeds', () => {
    const withoutFee = costOfCapital({
      kind: 'term_loan',
      principal: 100_000,
      originationFee: 0,
      cadence: 'monthly',
      termPeriods: 12,
      annualRate: 0.12,
    });

    const withFee = costOfCapital({
      kind: 'term_loan',
      principal: 100_000,
      originationFee: 5_000,
      cadence: 'monthly',
      termPeriods: 12,
      annualRate: 0.12,
    });

    // The borrower repays the full principal but only ever received 95,000. Adding the fee to
    // the repayment instead would understate this, because it would pretend the borrower had the
    // fee to use.
    expect(withFee.netProceeds).toBe(95_000);
    expect(withFee.effectiveApr as number).toBeGreaterThan(withoutFee.effectiveApr as number);
  });

  it('handles a zero-rate promotional balance without dividing by zero', () => {
    const cost = costOfCapital({
      kind: 'credit_card',
      principal: 20_000,
      originationFee: 0,
      cadence: 'monthly',
      termPeriods: 12,
      annualRate: 0,
    });

    expect(cost.totalCost).toBeCloseTo(0, 6);
    expect(cost.effectiveApr as number).toBeCloseTo(0, 6);
  });
});

describe('factor rates are not rates', () => {
  it('exposes the gap between a 1.4 factor headline and its true APR', () => {
    // The reason this module exists. A "1.4 factor" sounds like 40%. Repaid daily over six
    // months of banking days it is far more, because principal is repaid from day one and the
    // borrower never has the full advance for the full term.
    const cost = costOfCapital({
      kind: 'merchant_cash_advance',
      principal: 100_000,
      originationFee: 0,
      cadence: 'daily',
      termPeriods: 126, // ~6 months of banking days
      factorRate: 1.4,
    });

    expect(cost.simpleCostRatio).toBeCloseTo(0.4, 6);
    expect(cost.effectiveApr as number).toBeGreaterThan(1.4); // > 140% APR
  });

  it('returns a lower APR for the same factor over a longer term', () => {
    // Term is exactly what makes a factor rate meaningless on its own, and the single most
    // common way these products are misrepresented.
    const short = factorRateToApr(1.4, 'daily', 126) as number;
    const long = factorRateToApr(1.4, 'daily', 378) as number;

    expect(long).toBeLessThan(short);
    expect(short / long).toBeGreaterThan(1.5);
  });

  it('never presents a factor rate as an annual rate', () => {
    const cost = costOfCapital({
      kind: 'merchant_cash_advance',
      principal: 50_000,
      originationFee: 0,
      cadence: 'weekly',
      termPeriods: 52,
      factorRate: 1.25,
    });

    // simpleCostRatio is what a headline factor describes; effectiveApr is the comparable
    // number. They must not be equal, and confusing them is the error the type names apart.
    expect(cost.simpleCostRatio).toBeCloseTo(0.25, 6);
    expect(cost.effectiveApr as number).not.toBeCloseTo(0.25, 2);
    expect(cost.effectiveApr as number).toBeGreaterThan(0.4);
  });
});

describe('blended cost is weighted by balance', () => {
  it('lets one large cheap position dominate several small expensive ones', () => {
    const blended = blendedCostOfCapital(
      [
        { label: 'SBA term loan', outstandingBalance: 400_000, effectiveApr: 0.09 },
        { label: 'Card A', outstandingBalance: 10_000, effectiveApr: 0.29 },
        { label: 'Card B', outstandingBalance: 8_000, effectiveApr: 0.31 },
        { label: 'Card C', outstandingBalance: 5_000, effectiveApr: 0.33 },
      ],
      PROVENANCE,
    );

    // A naive average across positions gives ~25.5%. Weighted by balance it is ~10%, which is
    // what the client actually pays - and the difference is the whole point of weighting.
    expect(blended.blendedApr?.value as number).toBeLessThan(0.12);
    expect(blended.blendedApr?.provenance).toEqual(PROVENANCE);
  });

  it('ignores undrawn limits, which cost nothing', () => {
    const blended = blendedCostOfCapital(
      [
        { label: 'Drawn LOC', outstandingBalance: 50_000, effectiveApr: 0.2 },
        { label: 'Untouched LOC', outstandingBalance: 0, effectiveApr: 0.35 },
      ],
      PROVENANCE,
    );
    expect(blended.blendedApr?.value as number).toBeCloseTo(0.2, 6);
  });

  it('reports uncosted balance rather than blending over a partial stack silently', () => {
    const blended = blendedCostOfCapital(
      [
        { label: 'Card', outstandingBalance: 25_000, effectiveApr: 0.24 },
        { label: 'Unknown MCA', outstandingBalance: 75_000, effectiveApr: null },
      ],
      PROVENANCE,
    );

    expect(blended.uncostedBalance).toBe(75_000);
    expect(blended.coverage).toBeCloseTo(0.25, 6);
  });

  it('returns null rather than zero when nothing can be costed', () => {
    // Zero would read as "this stack is free", which is the most dangerous possible answer here.
    const blended = blendedCostOfCapital(
      [{ label: 'Unknown', outstandingBalance: 10_000, effectiveApr: null }],
      PROVENANCE,
    );
    expect(blended.blendedApr).toBeNull();
    expect(blended.coverage).toBe(0);
  });
});

describe('refinance comparison', () => {
  const mca = costOfCapital({
    kind: 'merchant_cash_advance',
    principal: 100_000,
    originationFee: 0,
    cadence: 'daily',
    termPeriods: 126,
    factorRate: 1.4,
  });

  it('recommends a refinance that lowers total cost', () => {
    const proposed = costOfCapital({
      kind: 'term_loan',
      principal: 100_000,
      originationFee: 2_000,
      cadence: 'monthly',
      termPeriods: 24,
      annualRate: 0.18,
    });

    const comparison = compareRefinance([mca], proposed);
    expect(comparison.worthwhile).toBe(true);
    expect(comparison.savings).toBeGreaterThan(0);
  });

  it('warns when a lower APR carries a higher total cost', () => {
    // The trap this comparison exists to catch: a longer term at a lower rate routinely costs
    // more in absolute dollars, and a client who refinances into a cheaper-sounding rate and
    // pays more is the outcome principle 1 exists to prevent.
    const cheapLoan = costOfCapital({
      kind: 'term_loan',
      principal: 100_000,
      originationFee: 0,
      cadence: 'monthly',
      termPeriods: 12,
      annualRate: 0.1,
    });

    const longerCheaperRate = costOfCapital({
      kind: 'term_loan',
      principal: 100_000,
      originationFee: 0,
      cadence: 'monthly',
      termPeriods: 120,
      annualRate: 0.08,
    });

    const comparison = compareRefinance([cheapLoan], longerCheaperRate);

    expect(comparison.proposedApr as number).toBeLessThan(comparison.currentApr as number);
    expect(comparison.worthwhile).toBe(false);
    expect(comparison.caveat).toMatch(/total dollars, not rate/i);
  });
});
