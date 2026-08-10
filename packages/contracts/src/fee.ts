/**
 * The all-in fee exhibit - blueprint 1.4, generated here.
 *
 * This file exists because of one sentence in the blueprint:
 *
 * > "success fees on cards computed from CapitalForge's `approvedCreditLimit` field, never
 * > `creditLimit`" (Seek Capital lesson).
 *
 * A success fee charged on what a client *asked for* rather than what an issuer *granted* is the
 * failure that ended another company. It is also an easy failure to reproduce, because the two
 * figures sit next to each other on every application record and differ by a character.
 *
 * So the arithmetic never sees the requested figure. `successFeeBasis` takes a single numeric
 * argument - there is no second number to pass by mistake - and this module carries that discipline
 * into the document a client signs.
 */

import { successFeeBasis } from '@bwc/placement';
import { ok, refused, type Outcome } from '@bwc/core';

export interface FeeLine {
  readonly label: string;
  /** Null for a fee that is contingent and not yet determinable. */
  readonly amount: number | null;
  /** How it is computed, in the words the exhibit will carry. */
  readonly basis: string;
  readonly whenCharged: string;
}

export interface FeeExhibit {
  readonly lines: readonly FeeLine[];
  /**
   * Everything the client will pay that is known today. Contingent lines are excluded from the
   * total and named separately - a total that quietly includes a fee nobody has incurred is a
   * misstatement, and one that omits a contingent fee without saying so is another.
   */
  readonly knownTotal: number;
  readonly contingentLines: readonly string[];
  /** Rendered for the exhibit's summary paragraph. */
  readonly summary: string;
}

export interface FeeExhibitInput {
  readonly offerTier: string;
  /** The engagement retainer, if any. */
  readonly retainer?: { amount: number; whenCharged: string };
  /** Recurring engagement fee, if any. */
  readonly monthly?: { amount: number; months: number };
  /**
   * Success fee terms. The rate applies to the **approved** limit, and the approved figure is
   * supplied only when an approval exists - so an exhibit prepared before any approval reports
   * the fee as contingent rather than estimating it from what was requested.
   */
  readonly successFee?: {
    readonly ratePercent: number;
    readonly approvedCreditLimit?: number;
  };
  readonly otherLines?: readonly FeeLine[];
}

const money = (value: number): string =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Build the exhibit.
 *
 * Refuses a success-fee rate outside 0-100%, because a rate that is not a rate produces a figure
 * that looks like money and is not.
 *
 * Note what the input type does **not** have: any field for a requested or applied-for limit.
 * There is nowhere to put one, so there is nothing for the arithmetic to reach for.
 */
export const buildFeeExhibit = (input: FeeExhibitInput): Outcome<FeeExhibit> => {
  if (input.successFee !== undefined) {
    const rate = input.successFee.ratePercent;
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return refused(
        `A success fee rate of ${rate} is not a percentage. The exhibit would present a figure that looks like money and is not.`,
        'Blueprint 1.4 - the fee exhibit is a client-facing economic statement',
      );
    }
  }

  const lines: FeeLine[] = [];
  const contingent: string[] = [];
  let knownTotal = 0;

  if (input.retainer !== undefined) {
    lines.push({
      label: 'Engagement retainer',
      amount: input.retainer.amount,
      basis: `Fixed fee for the ${input.offerTier} engagement.`,
      whenCharged: input.retainer.whenCharged,
    });
    knownTotal += input.retainer.amount;
  }

  if (input.monthly !== undefined) {
    const total = input.monthly.amount * input.monthly.months;
    lines.push({
      label: 'Monthly engagement fee',
      amount: total,
      basis: `${money(input.monthly.amount)} per month for ${input.monthly.months} months.`,
      whenCharged: 'Monthly, in advance.',
    });
    knownTotal += total;
  }

  if (input.successFee !== undefined) {
    const { ratePercent, approvedCreditLimit } = input.successFee;

    if (approvedCreditLimit === undefined) {
      // No approval yet, so no figure. Estimating from the requested amount is exactly the
      // failure this module is built against, and an estimate in a fee exhibit reads as a price.
      lines.push({
        label: 'Success fee',
        amount: null,
        basis: `${ratePercent}% of the credit limit actually approved by the provider. Not the amount applied for.`,
        whenCharged: 'On approval.',
      });
      contingent.push(
        `Success fee of ${ratePercent}% of any approved credit limit, payable on approval. No amount is stated because no approval has been issued.`,
      );
    } else {
      // The single-argument call is the guard: there is no second figure to pass by mistake.
      const basis = successFeeBasis(approvedCreditLimit);
      const amount = (basis * ratePercent) / 100;
      lines.push({
        label: 'Success fee',
        amount,
        basis: `${ratePercent}% of the ${money(basis)} credit limit approved by the provider. Not the amount applied for.`,
        whenCharged: 'On approval.',
      });
      knownTotal += amount;
    }
  }

  for (const line of input.otherLines ?? []) {
    lines.push(line);
    if (line.amount === null) contingent.push(line.label);
    else knownTotal += line.amount;
  }

  if (lines.length === 0) {
    return refused(
      'A fee exhibit with no fee lines states nothing. An engagement with no fees should say so in the service agreement rather than shipping an empty exhibit.',
      'Blueprint 1.4 - the exhibit is an all-in statement, and an empty one is not a statement',
    );
  }

  return ok({
    lines,
    knownTotal,
    contingentLines: contingent,
    summary:
      contingent.length === 0
        ? `Total fees for this engagement: ${money(knownTotal)}.`
        : `Fees determinable today: ${money(knownTotal)}. In addition, ${contingent.length} contingent item(s) apply, described above.`,
  });
};
