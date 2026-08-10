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
 * One dependency is still missing and is reported rather than papered over. The Console's
 * client record holds a legal name and a compliance state; it does not hold time in
 * business, revenue, industry or an authorized credit score, because the Client Household /
 * Entity Graph (1.2) is not built. So the underwriting profile arrives with the request, and
 * a request without one gets `not_built` naming 1.2 - not a recommendation computed from
 * blanks.
 */

import { check as checkConsent } from '@bwc/consent';
import { append } from '@bwc/ledger';
import { chain, type StepTrace } from '@bwc/middleware';
import type { ClientProfile } from '@bwc/lenders';
import {
  isUnverified,
  notBuilt,
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
   * The underwriting profile. Supplied by the caller because 1.2 Entity Graph does not
   * exist to hold it; absent, the engine refuses rather than evaluating against blanks.
   */
  readonly profile?: ClientProfile;
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

  // The one dependency still missing. The Console holds no underwriting attributes for a
  // client - 1.2 Entity Graph owns those and is not built - so a request that does not carry
  // a profile has nothing to evaluate against. Reporting not_built rather than treating the
  // blanks as zeroes, which would disqualify every provider, or as unknowns that pass, which
  // would fabricate a recommendation the client cannot act on.
  if (request.profile === undefined) {
    const unbuilt = notBuilt(
      '1.2 Client Household / Entity Graph',
      'The gate and authorization passed, but no underwriting profile was supplied and the Console does not yet hold one. Pass a profile with the request, or build 1.2.',
    );
    await recordOutcome(
      unbuilt.reason,
      `Principle 9 - honest refusal; ${unbuilt.module} not built`,
    );
    return { result: unbuilt, trace };
  }

  const ranked = await rankCandidates({
    tenantId: request.tenantId,
    profile: request.profile,
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
