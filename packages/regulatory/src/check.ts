/**
 * The check - blueprint 7.2, "every application submission checked against client state(s)".
 *
 * This is what the middleware chain's step 5 calls, and what an application submission calls before
 * it goes out. It composes three things that already exist separately:
 *
 *   1. is the state activated (the gate, `activation.ts`)
 *   2. what must be disclosed here (`disclosures.ts`)
 *   3. is this provider permitted in this state (5.4's `providersPermittedIn`)
 *
 * The third is the pull side of what blueprint 5.4 calls "state-restriction propagation to
 * Regulatory Engine". ADR-0007 chose a pull over a push because a push needs a retry and a
 * reconciliation job, each of which can lag - so a provider restricted on Monday might still be
 * recommendable on Tuesday. This function is the reader that choice was made for.
 */

import { providersPermittedIn } from '@bwc/governance';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import { standingFor, type StateStanding } from './activation.js';
import { requiredDisclosures, type RequiredDisclosure } from './disclosures.js';

export interface RegulatoryCheckInput {
  readonly tenantId: string;
  /** Two-letter state code. `null` when it could not be determined - see below. */
  readonly state: string | null;
  readonly productKind?: string;
  /** When present, the check also confirms the provider is permitted in this state. */
  readonly providerId?: string;
}

export interface RegulatoryClearance {
  readonly state: string;
  readonly standing: StateStanding;
  /** Attach these to whatever goes out. Federal baseline first, then the state layer. */
  readonly requiredDisclosures: readonly RequiredDisclosure[];
  readonly providerPermitted: boolean | null;
}

/**
 * Check whether a client-facing action may proceed.
 *
 * **An undeterminable jurisdiction is a refusal, not a pass.** "We could not tell which state this
 * client is in" and "no state rule applies" are different statements, and collapsing them is the
 * failure principle 6 exists to prevent: the whole value of a pre-action check is that a pass means
 * something was actually checked.
 */
export const checkJurisdiction = async (
  input: RegulatoryCheckInput,
): Promise<Outcome<RegulatoryClearance>> => {
  if (input.state === null || input.state.trim() === '') {
    return refused(
      'The client state could not be determined, so state compliance cannot be checked. Record the entity state on the client household (1.2), or pass a jurisdiction explicitly.',
      'Design principle 6 - no client-facing action fires without a state compliance check',
    );
  }

  const state = input.state.trim().toUpperCase();
  const standing = await standingFor(input.tenantId, state);

  if (!standing.permitsClientFacingAction) {
    return refused(
      standing.explanation,
      standing.status === 'needs_counsel_review'
        ? 'Specification versioning - counsel review required for material changes'
        : 'Specification 11.2 - state activation gate',
    );
  }

  const disclosures = await requiredDisclosures({
    tenantId: input.tenantId,
    state,
    ...(input.productKind !== undefined ? { productKind: input.productKind } : {}),
  });

  let providerPermitted: boolean | null = null;
  if (input.providerId !== undefined) {
    const permitted = await providersPermittedIn(input.tenantId, state);
    providerPermitted = permitted.includes(input.providerId);

    if (!providerPermitted) {
      return refused(
        `The Capital Product Governance Board has not approved this provider for use in ${state}.`,
        'Blueprint 5.4 - state restrictions propagate to the Regulatory Engine',
      );
    }
  }

  return ok({ state, standing, requiredDisclosures: disclosures, providerPermitted });
};

/**
 * The jurisdiction a client's actions are governed by.
 *
 * Returns `no_data` rather than a default when the household holds no state. There is no sensible
 * default here - guessing the company's home state for a client operating elsewhere would produce
 * a check that passes against the wrong law, which is worse than no check at all because it looks
 * like one.
 *
 * Takes the state as a value rather than reaching into `@bwc/graph`: the Entity Graph depends on
 * `@bwc/lenders`, and a dependency from here into that tree would put the compliance gate
 * downstream of the lender catalogue. The caller (the middleware chain) resolves it.
 */
export const jurisdictionOf = (entityState: string | null): Outcome<string> =>
  entityState === null || entityState.trim() === ''
    ? noData(
        'No state of formation is recorded for the client’s primary entity, so no jurisdiction can be determined.',
      )
    : ok(entityState.trim().toUpperCase());
