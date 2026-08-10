/**
 * @bwc/placement - 5.3 Funding Recommendation Engine, refusal path only.
 *
 * The walking skeleton builds the refusal, not the recommendation. That is the deliberate
 * choice: the Engine's blueprint entry says it "refuses to generate when Funding Ethics
 * Firewall or Do Not Fund Governance triggers, or when compliance categorical state is
 * Needs Review or Fail", and that refusal is the behaviour the whole spine exists to make
 * reliable. A recommendation built before the refusal works would be a recommendation that
 * can escape the gate.
 *
 * What is here: the request path, the gate, per-application consent, and provenance on the
 * output shape. What is not: the multi-factor recommendation logic, which depends on the
 * Lender Intelligence Database (5.2, deferred to V1.5).
 */

import { check as checkConsent } from '@bwc/consent';
import { append } from '@bwc/ledger';
import { chain, type StepTrace } from '@bwc/middleware';
import {
  isUnverified,
  notBuilt,
  type EventActor,
  type Outcome,
  type Provenance,
  type Sourced,
} from '@bwc/core';

export interface PlacementRequest {
  readonly actorId: string;
  readonly tenantId: string;
  readonly clientId: string;
  /** The specific application this placement is for. Consent is scoped to it. */
  readonly applicationRef: string;
  readonly correlationId?: string;
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
  readonly recommendation: Recommendation;
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

  // 5.2 Lender Intelligence Database is deferred to V1.5. Without it there is no lender
  // catalogue and no rule to tag, so there is no honest recommendation to make. Reporting
  // not_built rather than returning a plausible default: an untagged recommendation would
  // violate principle 8, and a fabricated one would violate principle 1.
  const unbuilt = notBuilt(
    '5.2 Lender Intelligence Database',
    'The gate and authorization passed, but no lender catalogue exists to recommend from. Deferred to V1.5 (blueprint category 5).',
  );

  await recordOutcome(unbuilt.reason, `Principle 9 - honest refusal; ${unbuilt.module} not built`);

  return { result: unbuilt, trace };
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
