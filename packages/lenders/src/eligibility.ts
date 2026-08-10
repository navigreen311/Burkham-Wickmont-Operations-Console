/**
 * Funding Product Eligibility Rules - blueprint 5.2.
 *
 * Pure: an underwriting box and a client profile in, a verdict and its reasons out. No I/O,
 * so this is the part of the recommendation an operator can reason about, argue with, and
 * test exhaustively.
 *
 * The design point that matters is the three-valued verdict. `eligible` / `ineligible` is
 * the obvious model and it is wrong here, because the third case is the common one: we do
 * not know the client's revenue yet. Collapsing unknown into either answer produces a
 * specific bad outcome -
 *
 *   - unknown as ineligible silently hides every good provider until a file is complete,
 *     and the operator sees an empty list with no explanation;
 *   - unknown as eligible fabricates a recommendation the client cannot act on, which is
 *     the failure principle 1 exists to prevent.
 *
 * So `unknown` is its own verdict and names the field that is missing.
 */

import { NATIONWIDE, type ClientProfile } from './profile.js';

/** The underwriting box, as the eligibility check sees it. */
export interface UnderwritingBox {
  readonly offeringId: string;
  readonly providerName: string;
  readonly offeringName: string;
  readonly minAmount: number;
  readonly maxAmount: number;
  /** Null means the provider publishes no threshold - not a threshold of zero. */
  readonly minTimeInBusinessMonths: number | null;
  readonly minAnnualRevenue: number | null;
  readonly minPersonalCreditScore: number | null;
  readonly excludedIndustries: readonly string[];
  /** From the provider record. `*` is nationwide. */
  readonly statesServed: readonly string[];
}

export type EligibilityVerdict = 'eligible' | 'ineligible' | 'unknown';

/** Which dimension of the box produced a non-eligible verdict. */
export type EligibilityDimension =
  'state' | 'amount' | 'time_in_business' | 'annual_revenue' | 'personal_credit_score' | 'industry';

export interface EligibilityReason {
  readonly dimension: EligibilityDimension;
  readonly verdict: 'ineligible' | 'unknown';
  /** Written to be read by a client in a memo, not only by an engineer in a log. */
  readonly detail: string;
}

export interface EligibilityResult {
  readonly offeringId: string;
  readonly verdict: EligibilityVerdict;
  readonly reasons: readonly EligibilityReason[];
}

const servesState = (statesServed: readonly string[], state: string): boolean =>
  statesServed.includes(NATIONWIDE) || statesServed.includes(state);

/**
 * Evaluate one offering against one profile.
 *
 * Every dimension is evaluated even after the first failure. Stopping at the first would be
 * cheaper and would make the memo say "minimum time in business 24 months" when the client
 * also misses revenue by a factor of four - sending them away to fix the wrong thing, and
 * back again in six months for the reason nobody mentioned.
 */
export const evaluateEligibility = (
  box: UnderwritingBox,
  profile: ClientProfile,
): EligibilityResult => {
  const reasons: EligibilityReason[] = [];

  if (profile.state === null) {
    reasons.push({
      dimension: 'state',
      verdict: 'unknown',
      detail: 'The entity state is not recorded, so state coverage cannot be checked.',
    });
  } else if (!servesState(box.statesServed, profile.state)) {
    reasons.push({
      dimension: 'state',
      verdict: 'ineligible',
      detail: `${box.providerName} does not serve ${profile.state}.`,
    });
  }

  if (profile.requestedAmount < box.minAmount) {
    reasons.push({
      dimension: 'amount',
      verdict: 'ineligible',
      detail: `Requested ${money(profile.requestedAmount)} is below the ${money(box.minAmount)} minimum for ${box.offeringName}.`,
    });
  } else if (profile.requestedAmount > box.maxAmount) {
    reasons.push({
      dimension: 'amount',
      verdict: 'ineligible',
      detail: `Requested ${money(profile.requestedAmount)} exceeds the ${money(box.maxAmount)} maximum for ${box.offeringName}.`,
    });
  }

  pushThreshold(
    reasons,
    'time_in_business',
    box.minTimeInBusinessMonths,
    profile.timeInBusinessMonths,
    (min) =>
      `${box.offeringName} requires ${min} months in business; the entity's is not recorded.`,
    (min, actual) =>
      `${box.offeringName} requires ${min} months in business; the entity is at ${actual}.`,
  );

  pushThreshold(
    reasons,
    'annual_revenue',
    box.minAnnualRevenue,
    profile.annualRevenue,
    (min) => `${box.offeringName} requires ${money(min)} annual revenue; revenue is not recorded.`,
    (min, actual) =>
      `${box.offeringName} requires ${money(min)} annual revenue; the entity reports ${money(actual)}.`,
  );

  pushThreshold(
    reasons,
    'personal_credit_score',
    box.minPersonalCreditScore,
    profile.personalCreditScore,
    (min) => `${box.offeringName} requires a ${min} personal score; no authorized pull is on file.`,
    (min, actual) =>
      `${box.offeringName} requires a ${min} personal score; the owner is at ${actual}.`,
  );

  if (box.excludedIndustries.length > 0) {
    if (profile.industry === null) {
      reasons.push({
        dimension: 'industry',
        verdict: 'unknown',
        detail: `${box.offeringName} excludes ${box.excludedIndustries.length} industries and the entity's industry is not recorded.`,
      });
    } else {
      const industry = profile.industry.toLowerCase();
      const hit = box.excludedIndustries.find((excluded) => excluded.toLowerCase() === industry);
      if (hit !== undefined) {
        reasons.push({
          dimension: 'industry',
          verdict: 'ineligible',
          detail: `${box.providerName} does not fund ${hit}.`,
        });
      }
    }
  }

  // Ineligible outranks unknown. A provider that will not serve the client's state stays a
  // refusal whatever else is missing from the file - filling in the revenue will not change it,
  // and reporting "unknown" would send someone off to gather data that cannot help.
  const verdict: EligibilityVerdict = reasons.some((r) => r.verdict === 'ineligible')
    ? 'ineligible'
    : reasons.length > 0
      ? 'unknown'
      : 'eligible';

  return { offeringId: box.offeringId, verdict, reasons };
};

const pushThreshold = (
  reasons: EligibilityReason[],
  dimension: EligibilityDimension,
  minimum: number | null,
  actual: number | null,
  unknownDetail: (min: number) => string,
  belowDetail: (min: number, actual: number) => string,
): void => {
  if (minimum === null) return; // No published threshold. Not a threshold of zero.
  if (actual === null) {
    reasons.push({ dimension, verdict: 'unknown', detail: unknownDetail(minimum) });
    return;
  }
  if (actual < minimum) {
    reasons.push({ dimension, verdict: 'ineligible', detail: belowDetail(minimum, actual) });
  }
};

const money = (value: number): string =>
  `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/**
 * What is missing from the file, across every offering considered.
 *
 * The operator-facing inverse of the verdict: rather than "eleven providers are unknown",
 * this answers "record the entity's revenue and eleven providers resolve". Deduplicated,
 * because the same missing field blocks every provider that asks for it.
 */
export const missingProfileFields = (
  results: readonly EligibilityResult[],
): readonly EligibilityDimension[] => {
  const dimensions = new Set<EligibilityDimension>();
  for (const result of results) {
    for (const reason of result.reasons) {
      if (reason.verdict === 'unknown') dimensions.add(reason.dimension);
    }
  }
  return [...dimensions];
};
