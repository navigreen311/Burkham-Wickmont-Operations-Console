/**
 * 5.6 Cost of Capital Calculator.
 *
 * This module exists because the cost of small-business capital is routinely hidden in plain
 * sight. A merchant cash advance quoted as a "1.4 factor" sounds like 40%. Repaid daily over six
 * months it is an APR north of 90%, because the borrower is repaying principal from day one and
 * never has the full advance for the full term.
 *
 * Surfacing that gap is the point. Getting the arithmetic wrong would make the Console a more
 * confident source of the same error, which is worse than not computing it at all.
 *
 * **The method: solve the real cash flows, do not approximate.** An MCA has no interest rate — it
 * has a purchase price, a remittance, and a schedule. The only honest comparison to a term loan's
 * APR is the internal rate of return of the actual cash flows.
 */

import type { Provenance, Sourced } from '@bwc/core';

export type RepaymentCadence = 'daily' | 'weekly' | 'biweekly' | 'monthly';

/** Periods per year, using banking-day conventions for the sub-monthly cadences. */
export const PERIODS_PER_YEAR: Record<RepaymentCadence, number> = {
  daily: 252, // banking days, not calendar days - remittances do not run on weekends
  weekly: 52,
  biweekly: 26,
  monthly: 12,
};

export interface CashFlow {
  /** Period index; 0 is the advance. */
  readonly period: number;
  /** Positive is money to the borrower, negative is money repaid. */
  readonly amount: number;
}

/**
 * Net present value of a cash-flow vector at a periodic rate.
 *
 * Exported because it is the thing being solved for, and a caller checking our arithmetic should
 * be able to evaluate NPV at the returned rate and see it land near zero.
 */
export const npv = (rate: number, flows: readonly CashFlow[]): number =>
  flows.reduce((sum, flow) => sum + flow.amount / (1 + rate) ** flow.period, 0);

/**
 * Solve for the periodic rate where NPV is zero, by bisection.
 *
 * **Bisection rather than Newton–Raphson**, deliberately. Newton is faster and has two failure
 * modes that matter here: it needs a derivative that is easy to get subtly wrong, and it diverges
 * on the steep curves that high-factor short-term products produce — exactly the products whose
 * cost this module exists to expose. Bisection cannot diverge; given a bracketing interval it
 * converges every time.
 *
 * Performance is irrelevant: a capital stack has a handful of positions, not a million.
 *
 * Returns null only when no rate brackets the flows at all — an all-inflow or all-outflow vector.
 * A schedule that repays *less* than the advance has a perfectly real, **negative** rate, and
 * returning it is correct: a negative effective APR is a data-quality signal worth surfacing, not
 * an error to suppress.
 *
 * **The NPV tolerance is relative, not absolute.** These flows are denominated in tens or hundreds
 * of thousands, so an absolute threshold like 1e-10 dollars is unreachable at double precision and
 * silently degrades into "run all the iterations" — while the same absolute threshold would be far
 * too loose on a $500 advance. Scaling to the initial flow makes the tolerance mean the same thing
 * at every magnitude.
 */
export const solvePeriodicRate = (
  flows: readonly CashFlow[],
  relativeTolerance = 1e-12,
  maxIterations = 200,
): number | null => {
  let low = -0.9999;
  let high = 10; // 1000% per period; nothing legitimate approaches this

  let npvLow = npv(low, flows);
  const npvHigh = npv(high, flows);

  if (Number.isNaN(npvLow) || Number.isNaN(npvHigh)) return null;
  // No sign change means no root in the interval - the flows never cross zero.
  if (npvLow * npvHigh > 0) return null;

  const scale = Math.max(1, Math.abs(flows[0]?.amount ?? 1));
  const npvTolerance = scale * relativeTolerance;
  const rateTolerance = 1e-12;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid, flows);

    if (Math.abs(npvMid) < npvTolerance || (high - low) / 2 < rateTolerance) return mid;

    if (npvLow * npvMid <= 0) {
      high = mid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }

  return (low + high) / 2;
};

/**
 * Annualize a periodic rate by compounding.
 *
 * `(1 + r)^n - 1`, not `r × n`. The simple form understates short-cadence products badly: a daily
 * product's periodic rate compounds 252 times a year, and treating that linearly is precisely the
 * flattery this module exists to remove.
 */
export const annualize = (periodicRate: number, periodsPerYear: number): number =>
  (1 + periodicRate) ** periodsPerYear - 1;

// --- Product cost --------------------------------------------------------

export type ProductKind =
  'credit_card' | 'line_of_credit' | 'term_loan' | 'merchant_cash_advance' | 'equipment_finance';

/**
 * A capital product, described by what it actually does rather than by its headline.
 *
 * `factorRate` and `annualRate` are mutually exclusive and separately named on purpose: a factor
 * rate is not a rate, and a type that let one be assigned to the other would allow the exact
 * confusion this module exists to prevent.
 */
export interface ProductTerms {
  readonly kind: ProductKind;
  /** Amount the borrower receives, before fees are netted out. */
  readonly principal: number;
  /** Deducted from the advance at funding, so the borrower never receives it. */
  readonly originationFee: number;
  readonly cadence: RepaymentCadence;
  readonly termPeriods: number;
  /** Term products: nominal annual interest rate, e.g. 0.18 for 18%. */
  readonly annualRate?: number;
  /** MCAs: total repayment multiple, e.g. 1.4 means repay 140% of the advance. */
  readonly factorRate?: number;
}

export interface CostOfCapital {
  readonly kind: ProductKind;
  /** What actually reaches the borrower's account. */
  readonly netProceeds: number;
  readonly totalRepaid: number;
  readonly totalCost: number;
  readonly paymentPerPeriod: number;
  readonly cadence: RepaymentCadence;
  readonly termPeriods: number;
  /**
   * The comparable number. Solved from the real schedule, so a factor rate and an interest rate
   * can finally be put side by side.
   */
  readonly effectiveApr: number | null;
  /** `totalCost / principal`. What a headline factor rate actually describes. */
  readonly simpleCostRatio: number;
  readonly flows: readonly CashFlow[];
}

const level = (amount: number, periods: number): number => (periods <= 0 ? 0 : amount / periods);

/**
 * Amortizing payment for a nominal annual rate. Standard annuity formula, with the zero-rate case
 * handled separately because the formula divides by the rate.
 */
const amortizingPayment = (
  principal: number,
  annualRate: number,
  cadence: RepaymentCadence,
  periods: number,
): number => {
  const periodic = annualRate / PERIODS_PER_YEAR[cadence];
  if (periodic === 0) return level(principal, periods);
  return (principal * periodic) / (1 - (1 + periodic) ** -periods);
};

/**
 * Compute the true cost of a product.
 *
 * The origination fee is netted from proceeds rather than added to the repayment, because that is
 * what actually happens: the borrower receives less and repays the full principal. Adding it to
 * the repayment instead would understate the APR, since it would ignore that the borrower never
 * had the fee to use.
 */
export const costOfCapital = (terms: ProductTerms): CostOfCapital => {
  const netProceeds = terms.principal - terms.originationFee;

  const paymentPerPeriod =
    terms.factorRate !== undefined
      ? level(terms.principal * terms.factorRate, terms.termPeriods)
      : amortizingPayment(terms.principal, terms.annualRate ?? 0, terms.cadence, terms.termPeriods);

  const totalRepaid = paymentPerPeriod * terms.termPeriods;

  const flows: CashFlow[] = [
    { period: 0, amount: netProceeds },
    ...Array.from({ length: terms.termPeriods }, (_, index) => ({
      period: index + 1,
      amount: -paymentPerPeriod,
    })),
  ];

  const periodicRate = solvePeriodicRate(flows);

  return {
    kind: terms.kind,
    netProceeds,
    totalRepaid,
    totalCost: totalRepaid - netProceeds,
    paymentPerPeriod,
    cadence: terms.cadence,
    termPeriods: terms.termPeriods,
    effectiveApr:
      periodicRate === null ? null : annualize(periodicRate, PERIODS_PER_YEAR[terms.cadence]),
    simpleCostRatio: terms.principal === 0 ? 0 : (totalRepaid - netProceeds) / terms.principal,
    flows,
  };
};

/**
 * What a factor rate means once the schedule is known.
 *
 * The same 1.4 factor is a very different cost over 6 months than over 18 — which is exactly why a
 * factor rate quoted without a term tells a borrower nothing, and why this function requires one.
 */
export const factorRateToApr = (
  factorRate: number,
  cadence: RepaymentCadence,
  termPeriods: number,
  principal = 100_000,
): number | null =>
  costOfCapital({
    kind: 'merchant_cash_advance',
    principal,
    originationFee: 0,
    cadence,
    termPeriods,
    factorRate,
  }).effectiveApr;

// --- Blended cost of a stack ---------------------------------------------

export interface WeightedPosition {
  readonly label: string;
  /** Outstanding balance. A limit nobody has drawn costs nothing and must not be weighted. */
  readonly outstandingBalance: number;
  readonly effectiveApr: number | null;
}

export interface BlendedCost {
  readonly blendedApr: Sourced<number> | null;
  readonly totalOutstanding: number;
  /** Balance that could not be costed, so a blend over half a stack does not read as complete. */
  readonly uncostedBalance: number;
  readonly coverage: number;
  readonly contributors: readonly { readonly label: string; readonly weight: number }[];
}

/**
 * Blended cost of a stack, weighted by **outstanding balance**.
 *
 * Weighting by balance rather than by position count is the whole point: one large cheap position
 * genuinely dominates the cost of a stack, and a naive average across positions would make a
 * client with four small expensive cards and one large cheap loan look far more expensive than
 * they are — or the reverse, which is worse.
 *
 * Undrawn limits are excluded because they cost nothing until drawn.
 */
export const blendedCostOfCapital = (
  positions: readonly WeightedPosition[],
  provenance: Provenance,
): BlendedCost => {
  const costed = positions.filter(
    (position) => position.effectiveApr !== null && position.outstandingBalance > 0,
  );
  const uncostedBalance = positions
    .filter((position) => position.effectiveApr === null && position.outstandingBalance > 0)
    .reduce((sum, position) => sum + position.outstandingBalance, 0);

  const costedBalance = costed.reduce((sum, position) => sum + position.outstandingBalance, 0);
  const totalOutstanding = costedBalance + uncostedBalance;

  if (costedBalance === 0) {
    return {
      blendedApr: null,
      totalOutstanding,
      uncostedBalance,
      coverage: 0,
      contributors: [],
    };
  }

  const blended = costed.reduce(
    (sum, position) =>
      sum + (position.effectiveApr as number) * (position.outstandingBalance / costedBalance),
    0,
  );

  return {
    blendedApr: { value: blended, provenance },
    totalOutstanding,
    uncostedBalance,
    coverage: totalOutstanding === 0 ? 0 : costedBalance / totalOutstanding,
    contributors: costed.map((position) => ({
      label: position.label,
      weight: position.outstandingBalance / costedBalance,
    })),
  };
};

// --- Refinance comparison -------------------------------------------------

export interface RefinanceComparison {
  readonly worthwhile: boolean;
  readonly currentTotalCost: number;
  readonly proposedTotalCost: number;
  readonly savings: number;
  readonly currentApr: number | null;
  readonly proposedApr: number | null;
  readonly caveat: string | null;
}

/**
 * Compare a proposed refinance against what is being replaced.
 *
 * Compares **total cost**, not APR. A lower APR over a longer term routinely costs more in
 * absolute dollars, and a client who refinances into a cheaper-sounding rate and pays more is the
 * outcome principle 1 exists to prevent. The APRs are reported alongside, and a lower-APR /
 * higher-cost result gets an explicit caveat rather than being left for the reader to notice.
 */
export const compareRefinance = (
  current: readonly CostOfCapital[],
  proposed: CostOfCapital,
): RefinanceComparison => {
  const currentTotalCost = current.reduce((sum, position) => sum + position.totalCost, 0);
  const savings = currentTotalCost - proposed.totalCost;

  const currentApr =
    current.length === 0
      ? null
      : current.reduce((sum, position) => sum + (position.effectiveApr ?? 0), 0) / current.length;

  const aprLooksBetter =
    currentApr !== null && proposed.effectiveApr !== null && proposed.effectiveApr < currentApr;

  return {
    worthwhile: savings > 0,
    currentTotalCost,
    proposedTotalCost: proposed.totalCost,
    savings,
    currentApr,
    proposedApr: proposed.effectiveApr,
    caveat:
      aprLooksBetter && savings <= 0
        ? 'The proposed facility has a lower APR but a higher total cost, because it repays over a longer term. Compare total dollars, not rate.'
        : null,
  };
};
