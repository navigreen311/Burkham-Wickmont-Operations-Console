/**
 * 5.3 Funding Recommendation Engine - the recommendation itself.
 *
 * The refusal shipped with the walking skeleton and has been returning `not_built`, naming
 * 5.2 as the reason. 5.2 now exists, so that refusal has become a false statement the system
 * was making about itself - this file replaces it.
 *
 * The pipeline, and what each stage is for:
 *
 *   catalogue      every active offering in the tenant                       (5.2)
 *   governance     may we recommend this provider, in this state, today?     (5.4)
 *   eligibility    does the client fit the underwriting box, and if not, why (5.2)
 *   suitability    should they take this product for this need               (5.2)
 *   assembly       provenance carried through to the output                  (Decision D)
 *
 * Governance runs *before* eligibility on purpose. A blacklisted provider must not have a
 * client's revenue evaluated against it at all - the answer is "no" for a reason that has
 * nothing to do with the client, and computing an eligibility verdict would produce a
 * "you don't qualify" that is both wrong and insulting.
 */

import {
  catalogue,
  evaluateEligibility,
  assessSuitability,
  missingProfileFields,
  type CatalogueEntry,
  type ClientProfile,
  type EligibilityResult,
  type SuitabilityAssessment,
} from '@bwc/lenders';
import { standingFor, type Standing } from '@bwc/governance';
import {
  describeProvenance,
  isUnverified,
  noData,
  ok,
  sourced,
  type Outcome,
  type Provenance,
  type Sourced,
} from '@bwc/core';

/** A candidate that did not survive, and the stage that removed it. */
export interface RejectedAlternative {
  readonly providerName: string;
  readonly offeringName: string;
  readonly stage: 'governance' | 'eligibility' | 'suitability';
  /**
   * Why, in the words a memo should use. Blueprint 5.3's data model names "alternatives
   * rejected"; a list of provider names is not reviewable, because a compliance officer
   * cannot tell a sound rejection from a bug and neither can the client.
   */
  readonly reason: string;
}

export interface RankedRecommendation {
  readonly provider: Sourced<string>;
  readonly product: Sourced<string>;
  readonly offeringId: string;
  readonly requestedCreditLimit: number;
  readonly rationale: string;
  readonly suitability: SuitabilityAssessment;
  /** Disclosures the Governance Board attached to this provider. */
  readonly requiredDisclosures: readonly string[];
  /** True when any input rests on an unresearched default. Decision D. */
  readonly containsUnverifiedInputs: boolean;
  /** Rendered provenance, so a deliverable template does not have to know the shapes. */
  readonly provenanceNotes: readonly string[];
}

export interface RecommendationSet {
  readonly recommendations: readonly RankedRecommendation[];
  readonly rejected: readonly RejectedAlternative[];
  /**
   * Fields whose absence left otherwise-viable providers unresolved. The actionable inverse
   * of a short list: "record the entity's revenue and four more providers resolve".
   */
  readonly missingProfileFields: readonly string[];
}

export interface RecommendInput {
  readonly tenantId: string;
  readonly profile: ClientProfile;
  readonly today?: Date;
  /** Cap on how many survive into the memo. Rejections are never truncated. */
  readonly limit?: number;
}

/**
 * Build the ranked set.
 *
 * Separated from `requestRecommendation` so the ranking is testable without a firewall, a
 * consent record or a ledger - and so the gate cannot be accidentally bypassed by a caller
 * reaching for the cheaper function: this one takes no actor, so it cannot write anything.
 */
export const rankCandidates = async (
  input: RecommendInput,
): Promise<Outcome<RecommendationSet>> => {
  const entries = await catalogue(input.tenantId);

  if (entries.length === 0) {
    return noData(
      'The Lender Intelligence Database holds no active product offerings for this tenant, so there is nothing to recommend from.',
    );
  }

  const today = input.today ?? new Date();
  const providerIds = [...new Set(entries.map((entry) => entry.provider.id))];
  const standings = await standingFor(input.tenantId, providerIds, today, input.profile.state);

  const rejected: RejectedAlternative[] = [];
  const eligible: { entry: CatalogueEntry; standing: Standing; eligibility: EligibilityResult }[] =
    [];
  const unresolved: EligibilityResult[] = [];

  for (const entry of entries) {
    const providerStanding = standings.get(entry.provider.id);

    // Absent from the map is impossible by construction - standingFor returns an entry per id
    // - but treating it as not recommendable rather than asserting keeps the failure mode
    // safe if that ever changes.
    if (!providerStanding || providerStanding.verdict !== 'recommendable') {
      rejected.push({
        providerName: entry.provider.name,
        offeringName: entry.offering.name,
        stage: 'governance',
        reason:
          providerStanding?.explanation ??
          'No governance standing could be determined for this provider.',
      });
      continue;
    }

    const eligibility = evaluateEligibility(
      {
        offeringId: entry.offering.id,
        providerName: entry.provider.name,
        offeringName: entry.offering.name,
        minAmount: entry.offering.minAmount,
        maxAmount: entry.offering.maxAmount,
        minTimeInBusinessMonths: entry.offering.minTimeInBusinessMonths,
        minAnnualRevenue: entry.offering.minAnnualRevenue,
        minPersonalCreditScore: entry.offering.minPersonalCreditScore,
        excludedIndustries: entry.offering.excludedIndustries,
        statesServed: entry.provider.statesServed,
      },
      input.profile,
    );

    if (eligibility.verdict === 'eligible') {
      eligible.push({ entry, standing: providerStanding, eligibility });
      continue;
    }

    unresolved.push(eligibility);
    rejected.push({
      providerName: entry.provider.name,
      offeringName: entry.offering.name,
      stage: 'eligibility',
      reason: eligibility.reasons.map((reason) => reason.detail).join(' '),
    });
  }

  const ranked = eligible
    .map(({ entry, standing: providerStanding }) => {
      const suitability = assessSuitability(entry.offering.productKind, input.profile.need);
      return { entry, standing: providerStanding, suitability };
    })
    // Highest suitability first; ties broken by the cheaper product, and an unpriced product
    // ranks below a priced one of equal suitability because an unknown cost is not a low one.
    .sort((a, b) => {
      if (b.suitability.score !== a.suitability.score) {
        return b.suitability.score - a.suitability.score;
      }
      return costRank(a.entry) - costRank(b.entry);
    });

  const limit = input.limit ?? ranked.length;

  const recommendations = ranked.slice(0, limit).map(({ entry, standing: s, suitability }) => {
    const provenance: Provenance = entry.offering.provenance;
    return {
      provider: sourced(entry.provider.name, provenance),
      product: sourced(entry.offering.name, provenance),
      offeringId: entry.offering.id,
      requestedCreditLimit: input.profile.requestedAmount,
      rationale: buildRationale(entry, suitability),
      suitability,
      requiredDisclosures: s.requiredDisclosures,
      containsUnverifiedInputs: isUnverified(provenance),
      provenanceNotes: [describeProvenance(provenance)],
    } satisfies RankedRecommendation;
  });

  // Candidates that ranked but fell outside the limit are still rejected alternatives - a memo
  // claiming three options were considered when eleven were is a smaller lie than an empty
  // list, and still a lie.
  for (const { entry } of ranked.slice(limit)) {
    rejected.push({
      providerName: entry.provider.name,
      offeringName: entry.offering.name,
      stage: 'suitability',
      reason: `Eligible and approved, but ranked below the ${limit} option(s) presented for a ${readable(input.profile.need)} need.`,
    });
  }

  if (recommendations.length === 0) {
    // The missing fields belong in the reason, not only in a set nobody reaches when the
    // outcome is not `ok`.
    //
    // Found by a test that expected a recommendation and got `no_data`: with revenue and
    // credit score blank, every provider resolves to `unknown` and nothing survives - which
    // is correct, and was being reported as "none survived" with no hint that the cause was
    // an incomplete file rather than an unsuitable client. An operator reading that would
    // conclude there is nothing for this client, when four providers are one field away.
    const missing = missingProfileFields(unresolved);
    const remedy =
      missing.length > 0
        ? ` Several were left unresolved rather than rejected: record ${missing.map(readable).join(' and ')} and ask again.`
        : '';

    return noData(
      `${entries.length} offering(s) were considered and none survived: ${summarize(rejected)}${remedy}`,
    );
  }

  return ok({
    recommendations,
    rejected,
    missingProfileFields: missingProfileFields(unresolved),
  });
};

/**
 * Cheaper first among equally suitable products. Unpriced ranks last.
 *
 * A factor rate is not comparable to an APR without the repayment schedule 5.6 needs, and
 * this function does not have one - so a factored product is ranked as unpriced rather than
 * by pretending its factor is a rate. Getting that wrong is exactly the confusion 5.6 exists
 * to remove.
 */
const costRank = (entry: CatalogueEntry): number =>
  entry.offering.typicalAnnualRate ?? Number.POSITIVE_INFINITY;

const readable = (need: string): string => need.replace(/_/g, ' ');

const buildRationale = (entry: CatalogueEntry, suitability: SuitabilityAssessment): string => {
  const parts = [
    `${entry.provider.name} - ${entry.offering.name}.`,
    suitability.rationale,
    `Repayment: ${entry.offering.repaymentStructure}. Fees: ${entry.offering.feeModel}.`,
  ];

  if (suitability.caution) {
    parts.push(
      `Presented with a caution: this product works against a ${readable(suitability.need)} need, and is included because it is available rather than because it is a good fit.`,
    );
  }

  if (isUnverified(entry.offering.provenance)) {
    parts.push(
      `The terms above rest on an unresearched default and have not been verified against ${entry.provider.name}'s published materials.`,
    );
  }

  return parts.join(' ');
};

/** A one-line summary of why nothing survived, grouped by stage. */
const summarize = (rejected: readonly RejectedAlternative[]): string => {
  const counts = new Map<string, number>();
  for (const entry of rejected) {
    counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
  }
  return (
    [...counts.entries()].map(([stage, count]) => `${count} at ${stage}`).join(', ') +
    '. The rejected list carries the reason for each.'
  );
};
