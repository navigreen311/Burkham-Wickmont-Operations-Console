/**
 * Invariants for money arithmetic - 1.4.
 *
 * Pure, and worth testing exhaustively because every other figure in the module is built on these
 * five functions. The cases below are the specific failures integer cents exists to make
 * unreachable, stated as the floating-point results they would otherwise produce.
 */

import { describe, expect, it } from 'vitest';
import {
  atLeastZero,
  basisPointsFromPercent,
  formatMoney,
  fromDollars,
  isCents,
  percentageOf,
  proportionOf,
  sum,
  toDollars,
} from '@bwc/billing';

describe('the failures integer cents makes unreachable', () => {
  it('rounds a half-cent the way the arithmetic says, not the way the binary does', () => {
    // The claim first written here was that 8.5% of $47,300 is inexact in floating point. It is
    // not - that one happens to land exactly, and asserting otherwise was a fabricated example.
    //
    // The real hazard is sharper and better known: a value that looks like an exact half-cent is
    // often slightly below it in binary, so the language's own rounding sends it the wrong way.
    // $0.615 is stored as 0.61499999999999999..., and `toFixed` therefore rounds it DOWN.
    expect((0.615).toFixed(2)).toBe('0.61');
    expect(1.1 * 3).not.toBe(3.3);

    // In cents there is no half-cent to misread: the multiplication is integer and the single
    // rounding is the one this module names out loud.
    const fee = percentageOf(fromDollars(47_300), basisPointsFromPercent(8.5), 'toward_client');
    expect(fee).toBe(402_050);
    expect(formatMoney(fee)).toBe('$4,020.50');
  });

  it('keeps a percentage exact where floating point drifts', () => {
    // 8.5% of $1,040.11 is $88.40935 exactly. Floating point computes 88.40934999999999, below
    // the true value - and every such result feeds the next subtraction.
    //
    // Note where the error enters: `1040.11 * 8.5` is exact, and the division by 100 is what
    // loses it. Two earlier versions of this test asserted inexactness on expressions that were
    // exact, which is why this one names the whole expression rather than a factor of it.
    expect((1_040.11 * 8.5) / 100).not.toBe(88.40935);

    const fee = percentageOf(fromDollars(1_040.11), basisPointsFromPercent(8.5), 'toward_client');
    // 104011 cents x 850 bp = 88,409,350 / 10,000 = 8,840.935 cents, floored toward the client.
    expect(fee).toBe(8_840);
    expect(
      percentageOf(fromDollars(1_040.11), basisPointsFromPercent(8.5), 'away_from_client'),
    ).toBe(8_841);
  });

  it('cannot produce a sub-cent or negative refund from paid minus earned', () => {
    // `0.1 + 0.2 - 0.3` is 5.55e-17 in floating point. A refund of 0.00000000000000006 dollars is
    // unpayable, and the same subtraction the other way round produces a negative refund, which is
    // nonsense. Both are unreachable when the operands are integers.
    expect(0.1 + 0.2 - 0.3).not.toBe(0);

    const paid = fromDollars(0.1) + fromDollars(0.2);
    const earned = fromDollars(0.3);
    expect(paid - earned).toBe(0);
  });

  it('keeps a long chain of subtractions exact', () => {
    // Credit across an upgrade is repeated subtraction, which is where float drift compounds.
    let floating = 2495.0;
    let cents = fromDollars(2495);

    for (let i = 0; i < 100; i += 1) {
      floating -= 24.95;
      cents -= fromDollars(24.95);
    }

    expect(floating).not.toBe(0);
    expect(cents).toBe(0);
  });
});

describe('rounding goes to the client', () => {
  it('rounds a fee down and a refund up on the same figure', () => {
    // The one rule, in one place. 8.55% of $1,000.01 is 8550.0855 cents - a fraction either way.
    const amount = fromDollars(1_000.01);
    const rate = basisPointsFromPercent(8.55);

    const fee = percentageOf(amount, rate, 'toward_client');
    const refund = percentageOf(amount, rate, 'away_from_client');

    expect(fee).toBe(8_550);
    expect(refund).toBe(8_551);
    // It costs at most one cent per line, and no client is ever overcharged by rounding.
    expect(refund - fee).toBe(1);
  });

  it('rounds a proration toward the client', () => {
    // $1,000 over 365 days, 200 days unused: 547.945... dollars.
    const refund = proportionOf(fromDollars(1_000), 200, 365, 'toward_client');
    expect(refund).toBe(54_794);
    expect(formatMoney(refund)).toBe('$547.94');
  });

  it('never prorates beyond the whole amount', () => {
    // A numerator past the denominator would otherwise refund more than was paid.
    expect(proportionOf(fromDollars(500), 400, 365, 'toward_client')).toBe(fromDollars(500));
  });
});

describe('conversion refuses rather than truncating', () => {
  it('rejects a value carrying a fraction of a cent', () => {
    // Quietly making $19.999 into $19.99 decides on the caller's behalf which cent they lose.
    expect(() => fromDollars(19.999)).toThrow(/fraction of a cent/);
  });

  it('rejects a non-finite amount', () => {
    expect(() => fromDollars(Number.POSITIVE_INFINITY)).toThrow(/not a finite amount/);
    expect(() => fromDollars(Number.NaN)).toThrow(/not a finite amount/);
  });

  it('rejects a rate finer than a basis point', () => {
    // 8.5% is 850 exactly. A rate nobody could have agreed should not be silently representable.
    expect(() => basisPointsFromPercent(8.505)).toThrow(/finer than a basis point/);
    expect(basisPointsFromPercent(8.5)).toBe(850);
    expect(basisPointsFromPercent(10)).toBe(1_000);
  });

  it('rejects fractional basis points and negative rates', () => {
    expect(() => percentageOf(1_000, 8.5, 'toward_client')).toThrow(/whole number of basis points/);
    expect(() => percentageOf(1_000, -100, 'toward_client')).toThrow(/basis points/);
  });

  it('rejects a non-integer amount reaching the arithmetic', () => {
    expect(() => percentageOf(100.5, 850, 'toward_client')).toThrow(/whole number of cents/);
    expect(() => sum([100, 0.5])).toThrow(/whole number of cents/);
  });

  it('round-trips through dollars at the rendering boundary', () => {
    expect(toDollars(fromDollars(2_495))).toBe(2_495);
    expect(toDollars(402_050)).toBe(4_020.5);
  });
});

describe('formatting', () => {
  it('renders cents with a thousands separator and two places', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(5)).toBe('$0.05');
    expect(formatMoney(100)).toBe('$1.00');
    expect(formatMoney(1_234_567)).toBe('$12,345.67');
  });

  it('renders a negative amount with the sign outside the dollar mark', () => {
    // A credit is a negative charge, and "-$25.00" is how a statement reads.
    expect(formatMoney(-2_500)).toBe('-$25.00');
  });
});

describe('small guards', () => {
  it('recognises whole cents and rejects anything else', () => {
    expect(isCents(100)).toBe(true);
    expect(isCents(-100)).toBe(true);
    expect(isCents(100.5)).toBe(false);
    expect(isCents('100')).toBe(false);
  });

  it('floors at zero where a negative would be nonsense', () => {
    expect(atLeastZero(-1)).toBe(0);
    expect(atLeastZero(0)).toBe(0);
    expect(atLeastZero(5)).toBe(5);
  });

  it('sums an empty list to zero rather than throwing', () => {
    expect(sum([])).toBe(0);
  });
});
