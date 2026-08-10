/**
 * @bwc/placement - 5.3 Funding Recommendation Engine.
 *
 * The walking skeleton built the refusal before the recommendation, deliberately: the
 * Engine's blueprint entry says it "refuses to generate when Funding Ethics Firewall or Do
 * Not Fund Governance triggers, or when compliance categorical state is Needs Review or
 * Fail", and a recommendation built before that refusal worked would be a recommendation
 * that can escape the gate.
 *
 * The gate works, and the Lender Intelligence Database (5.2) and Governance Board (5.4) now
 * exist, so the recommendation lands here - see `recommend.ts` for the ranking itself.
 *
 * The underwriting profile comes from the Client Household / Entity Graph (1.2), which now
 * exists: state of formation, time in business derived from the formation date, industry, and
 * revenue where the client has stated it. A caller may still pass a profile explicitly, which is
 * how a what-if on a different requested amount is modelled without writing it into the household.
 *
 * What the graph cannot know stays null. A personal credit score needs an authorized bureau pull
 * and that vendor is ungated, so eligibility reports it as unknown rather than assuming a passing
 * score - which is exactly why 5.2's eligibility has three verdicts rather than two.
 */

import { check as checkConsent } from '@bwc/consent';
import { append } from '@bwc/ledger';
import { chain, type StepTrace } from '@bwc/middleware';
import type { CapitalNeed, ClientProfile } from '@bwc/lenders';
import { deriveProfile, loadGraph } from '@bwc/graph';
import {
  isUnverified,
  ok,
  type EventActor,
  type Outcome,
  type Provenance,
  type Sourced,
} from '@bwc/core';
import { rankCandidates, type RecommendationSet } from './recommend.js';

export * from './recommend.js';

export interface PlacementRequest {
  readonly actorId: string;
  readonly tenantId: string;
  readonly clientId: string;
  /** The specific application this placement is for. Consent is scoped to it. */
  readonly applicationRef: string;
  readonly correlationId?: string;
  /**
   * The underwriting profile. Optional: when absent it is derived from the client's Entity
   * Graph (1.2), which is where these attributes actually live. Supplying one explicitly is
   * still supported for a what-if - a caller modelling a different requested amount should not
   * have to write it into the household first.
   */
  readonly profile?: ClientProfile;
  /** Used when deriving a profile. Ignored when `profile` is supplied, which carries its own. */
  readonly need?: CapitalNeed;
  readonly requestedAmount?: number;
  readonly today?: Date;
  readonly limit?: number;
}

export interface Recommendation {
  readonly provider: Sourced<string>;
  readonly product: Sourced<string>;
  /** Requested. Never the basis for a success fee - see approvedCreditLimit on the outcome. */
  readonly requestedCreditLimit: number;
  readonly rationale: string;
  readonly alternativesRejected: readonly string[];
  /** True when any input rests on an unresearched default, per Decision D. */
  readonly containsUnverifiedInputs: boolean;
}

export interface PlacementResult {
  readonly recommendations: RecommendationSet;
  readonly trace: readonly StepTrace[];
}

/**
 * Request a placement recommendation.
 *
 * Order matters and is not arbitrary:
 *   1. the middleware chain, which includes the Firewall + compliance gate at step 4
 *   2. per-application client authorization (18 USC 1014/1344 - blueprint 1.4, 1.5)
 *   3. the recommendation itself
 *
 * Consent is checked after the gate rather than before, so a frozen client is refused for
 * the freeze - the accurate reason - rather than for a missing authorization nobody should
 * have been collecting in the first place.
 */
export const requestRecommendation = async (
  request: PlacementRequest,
): Promise<{ result: Outcome<PlacementResult>; trace: readonly StepTrace[] }> => {
  const { result: chainResult, trace } = await chain({
    actorId: request.actorId,
    tenantId: request.tenantId,
    action: 'draft_recommendation',
    clientId: request.clientId,
    eventType: 'placement.requested',
    eventPayload: { applicationRef: request.applicationRef },
    ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
  });

  if (chainResult.status !== 'ok') {
    // The chain writes its own refusal event at the step that blocked, so nothing is
    // recorded here - a second entry would double-count the same refusal.
    return { result: chainResult as Outcome<PlacementResult>, trace };
  }

  // Past this point the chain has already written `placement.requested`. Every exit below
  // must therefore write a terminal event: a request with no recorded outcome leaves the
  // Compliance Evidence Vault (7.1) unable to say what happened, which is the one thing a
  // regulator-ready file has to answer. Found by running the walking-skeleton demo, where
  // two requests sat in the Ledger with no resolution.
  const actor: EventActor = {
    id: chainResult.value.actor.id,
    kind: chainResult.value.actor.kind,
  };

  const recordOutcome = async (reason: string, principle: string): Promise<void> => {
    await append({
      tenantId: request.tenantId,
      type: 'placement.refused',
      actor,
      clientId: request.clientId,
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
      payload: { applicationRef: request.applicationRef, reason, principle },
    });
  };

  const consent = await checkConsent(
    request.tenantId,
    request.clientId,
    'application',
    request.applicationRef,
  );

  if (consent.status !== 'ok') {
    await recordOutcome(
      consent.status === 'refused' ? consent.reason : 'authorization check did not succeed',
      consent.status === 'refused' ? consent.principle : 'Blueprint 1.5',
    );
    return { result: consent as Outcome<PlacementResult>, trace };
  }

  // The profile used to be `not_built` on 1.2 Entity Graph. That module now exists, so the
  // profile is derived from the client's household when the caller does not supply one - and a
  // client with no primary entity designated is `no_data`, because the Console consulted a real
  // graph and found nobody had said which company is applying. The same transition 5.2 caused.
  let profile = request.profile;
  let derivedFrom: string | null = null;

  if (profile === undefined) {
    const graph = await loadGraph(request.tenantId, request.clientId);
    const derived = deriveProfile({
      graph,
      need: request.need ?? 'working_capital',
      requestedAmount: request.requestedAmount ?? 0,
      ...(request.today !== undefined ? { today: request.today } : {}),
    });

    if (derived.status !== 'ok') {
      await recordOutcome(
        derived.status === 'no_data' ? derived.reason : 'profile derivation did not succeed',
        'Principle 9 - honest empty state; the Entity Graph was consulted and holds no applicant',
      );
      return { result: derived as Outcome<PlacementResult>, trace };
    }

    profile = derived.value.profile;
    derivedFrom = derived.value.primaryEntityName;
  }

  const ranked = await rankCandidates({
    tenantId: request.tenantId,
    profile,
    ...(request.today !== undefined ? { today: request.today } : {}),
    ...(request.limit !== undefined ? { limit: request.limit } : {}),
  });

  if (ranked.status !== 'ok') {
    // An empty catalogue, or a catalogue in which nothing survived governance and
    // eligibility. Both are `no_data` and not `not_built`: the module exists and was
    // consulted, which is a materially different statement to make to a client.
    await recordOutcome(
      ranked.status === 'no_data' ? ranked.reason : 'recommendation ranking did not succeed',
      'Principle 9 - honest empty state; the catalogue was consulted and produced nothing',
    );
    return { result: ranked as Outcome<PlacementResult>, trace };
  }

  await append({
    tenantId: request.tenantId,
    type: 'placement.recommended',
    actor,
    clientId: request.clientId,
    ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
    payload: {
      applicationRef: request.applicationRef,
      // Offering ids, not client attributes. The Ledger must never carry the revenue or
      // score the recommendation was computed from.
      offeringIds: ranked.value.recommendations.map((entry) => entry.offeringId),
      // The entity name, not its attributes. Naming which company was underwritten is what
      // makes a placement explicable later; the revenue it was underwritten on is not.
      derivedFromEntity: derivedFrom,
      rejectedCount: ranked.value.rejected.length,
      containsUnverifiedInputs: ranked.value.recommendations.some(
        (entry) => entry.containsUnverifiedInputs,
      ),
    },
  });

  return { result: ok({ recommendations: ranked.value, trace }), trace };
};

/**
 * Assemble a recommendation from sourced inputs.
 *
 * Every input arrives as `Sourced<T>`, so a caller cannot pass a bare value - provenance is
 * structurally required rather than remembered. Decision D and principle 8.
 */
export const assembleRecommendation = (input: {
  provider: Sourced<string>;
  product: Sourced<string>;
  requestedCreditLimit: number;
  rationale: string;
  alternativesRejected: readonly string[];
}): Recommendation => {
  const provenances: Provenance[] = [input.provider.provenance, input.product.provenance];

  return {
    provider: input.provider,
    product: input.product,
    requestedCreditLimit: input.requestedCreditLimit,
    rationale: input.rationale,
    alternativesRejected: input.alternativesRejected,
    containsUnverifiedInputs: provenances.some(isUnverified),
  };
};

/**
 * Success fee basis. Computed from what the issuer actually granted, never from what was
 * requested - the Seek Capital lesson, blueprint 1.4 and 5.5.
 *
 * Takes only `approvedCreditLimit` as a parameter so a caller physically cannot pass the
 * requested figure by mistake: there is no second numeric argument to confuse it with.
 */
export const successFeeBasis = (approvedCreditLimit: number): number => {
  if (!Number.isFinite(approvedCreditLimit) || approvedCreditLimit < 0) {
    throw new Error('approvedCreditLimit must be a non-negative finite number.');
  }
  return approvedCreditLimit;
};
