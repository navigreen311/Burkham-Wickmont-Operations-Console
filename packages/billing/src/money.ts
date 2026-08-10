/**
 * Money, as integer cents.
 *
 * Every figure in this module is owed by or to a client, and floating point is the wrong
 * representation for that. Not as an abstract objection - as three concrete failures:
 *
 *   - 8.5% of $1,040.11 is $88.40935 exactly; floating point computes 88.40934999999999. And a
 *     value that looks like an exact half-cent is often slightly below it in binary, so the
 *     language's own rounding sends it the wrong way: `(0.615).toFixed(2)` is `'0.61'`.
 *   - A refund computed as `paid - earned` can come out as `0.004`, or as `-0.001`. A negative
 *     refund is nonsense and a sub-cent refund is unpayable; both are unreachable in cents.
 *   - Credit across an upgrade is repeated subtraction, which is where float drift compounds.
 *
 * Dollars exist at exactly one boundary in this package: building the fee exhibit input for 7.3,
 * which takes them.
 */

/** An amount in whole cents. Negative values are legitimate - a credit is a negative charge. */
export type Cents = number;

export const isCents = (value: unknown): value is Cents =>
  typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Convert dollars to cents at a trust boundary.
 *
 * Throws on a value that is not representable, rather than silently truncating. A caller handing
 * in `19.999` means something, and quietly making it $19.99 decides on their behalf which cent
 * they lose.
 */
export const fromDollars = (dollars: number): Cents => {
  if (!Number.isFinite(dollars)) {
    throw new Error(`${dollars} is not a finite amount of money.`);
  }
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`${dollars} does not convert to a safe integer number of cents.`);
  }
  if (Math.abs(dollars * 100 - cents) > 1e-6) {
    throw new Error(
      `${dollars} carries a fraction of a cent. Round it deliberately before converting, so the decision about which cent is lost is made where it can be seen.`,
    );
  }
  return cents;
};

/** For the one boundary that needs dollars: 7.3's fee exhibit. */
export const toDollars = (cents: Cents): number => cents / 100;

export const formatMoney = (cents: Cents): string => {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(remainder).padStart(2, '0')}`;
};

/**
 * Which way a fractional cent goes.
 *
 * One rule, in one place: **fees we charge round down, refunds we owe round up.** It costs at most
 * a cent per line item, which across a portfolio is negligible, and it means no client is ever
 * overcharged by rounding.
 *
 * The alternative - rounding in our own favour on a figure the client signs - would be true of
 * every invoice rather than a one-off, and is exactly the kind of detail that reads badly when
 * somebody goes looking.
 */
export type RoundingDirection = 'toward_client' | 'away_from_client';

/**
 * A percentage of an amount, rounded in the stated direction.
 *
 * `basisPoints` rather than a percentage, because 8.5% is `850` exactly while `8.5` is not. The
 * multiplication then happens entirely in integers, so the only rounding is the one this function
 * names.
 */
export const percentageOf = (
  amount: Cents,
  basisPoints: number,
  direction: RoundingDirection,
): Cents => {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`${amount} is not a whole number of cents.`);
  }
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new Error(
      `${basisPoints} is not a whole number of basis points. 8.5% is 850; a fractional basis point is a rate nobody agreed.`,
    );
  }

  const numerator = amount * basisPoints;
  const rounded =
    direction === 'toward_client' ? Math.floor(numerator / 10_000) : Math.ceil(numerator / 10_000);

  if (!Number.isSafeInteger(rounded)) {
    throw new Error('The result exceeds the safe integer range for cents.');
  }
  return rounded;
};

/** Percentage points to basis points, for a caller holding a human-facing rate. */
export const basisPointsFromPercent = (percent: number): number => {
  const points = Math.round(percent * 100);
  if (Math.abs(percent * 100 - points) > 1e-9) {
    throw new Error(
      `${percent}% is finer than a basis point. Express the rate as basis points so the agreed figure is exact.`,
    );
  }
  return points;
};

/**
 * A proportion of an amount, by elapsed time - the unearned-prepay computation.
 *
 * Rounds toward the client, because the case this exists for is a refund: an annual prepay
 * cancelled part way through, where the client gets back what they paid for and did not receive.
 */
export const proportionOf = (
  amount: Cents,
  numerator: number,
  denominator: number,
  direction: RoundingDirection,
): Cents => {
  if (denominator <= 0) {
    throw new Error('A proportion needs a positive denominator.');
  }
  if (numerator < 0) {
    throw new Error('A proportion needs a non-negative numerator.');
  }

  const scaled = amount * Math.min(numerator, denominator);
  return direction === 'toward_client'
    ? Math.floor(scaled / denominator)
    : Math.ceil(scaled / denominator);
};

/** Sum, with the integer invariant checked rather than assumed. */
export const sum = (amounts: readonly Cents[]): Cents => {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`${amount} is not a whole number of cents.`);
    }
    total += amount;
  }
  if (!Number.isSafeInteger(total)) {
    throw new Error('The total exceeds the safe integer range for cents.');
  }
  return total;
};

/** Never below zero. For the many places where a negative would be nonsense. */
export const atLeastZero = (amount: Cents): Cents => (amount < 0 ? 0 : amount);
