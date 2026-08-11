/**
 * State-restriction propagation to the Regulatory Engine - blueprint 5.4.
 *
 * The blueprint says restrictions "propagate to Regulatory Engine". The Regulatory Engine is
 * category 7 and does not exist yet, which leaves two options: build a propagation mechanism
 * against an interface nobody has agreed, or build the payload and let the engine pull it.
 *
 * Pull, for a reason beyond convenience. A push would need a queue, a retry and a
 * reconciliation job to answer "did the engine get it?", and each of those can lag - which
 * means a provider restricted in Texas on Monday might still be recommendable there on
 * Tuesday. A derived view has no lag: whoever asks gets the current restrictions, computed
 * from the governance rows at the moment of asking. Same reasoning as `standing()`.
 */

import { db } from '@bwc/db';
import type { GovernanceStatus } from './standing.js';

export interface StateRestriction {
  readonly providerId: string;
  readonly status: GovernanceStatus;
  /** States the board has explicitly restricted. */
  readonly restrictedStates: readonly string[];
  /**
   * States the approval is limited to. Empty means not limited - which is different from
   * limited to nothing, and the distinction decides whether a provider may be recommended
   * anywhere at all.
   */
  readonly approvedStates: readonly string[];
  readonly requiredDisclosures: readonly string[];
}

/**
 * The current restriction picture for the tenant.
 *
 * Includes suspended and blacklisted providers rather than only approved ones: the
 * Regulatory Engine's question is "what may not happen where", and a provider that may not
 * be used anywhere is the strongest possible answer to it.
 */
export const stateRestrictions = async (tenantId: string): Promise<readonly StateRestriction[]> => {
  const rows = await db().providerGovernance.findMany({
    where: { tenantId },
    orderBy: [{ providerId: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => ({
    providerId: row.providerId,
    status: row.status as GovernanceStatus,
    restrictedStates: row.restrictedStates,
    approvedStates: row.approvedStates,
    requiredDisclosures: row.requiredDisclosures,
  }));
};

/**
 * Providers usable in a given state.
 *
 * Deliberately does *not* apply the review-cadence check - that belongs to `standing()`, and
 * duplicating it here would create two definitions of recommendable that drift apart. This
 * answers the narrower question the Regulatory Engine asks: which providers has the board
 * permitted in this state.
 */
export const providersPermittedIn = async (
  tenantId: string,
  state: string,
): Promise<readonly string[]> => {
  const restrictions = await stateRestrictions(tenantId);
  return restrictions
    .filter(
      (entry) =>
        entry.status === 'approved' &&
        !entry.restrictedStates.includes(state) &&
        (entry.approvedStates.length === 0 || entry.approvedStates.includes(state)),
    )
    .map((entry) => entry.providerId);
};

/**
 * Every disclosure obliged by the providers named in a communication.
 *
 * The Communication Compliance Scanner (4.2) and deliverable templates (3.1) both need this:
 * naming a provider in client-facing material can oblige that provider's disclosure, and a
 * missing one is a compliance finding rather than a formatting issue.
 */
export const disclosuresRequiredFor = async (
  tenantId: string,
  providerIds: readonly string[],
): Promise<readonly string[]> => {
  const rows = await db().providerGovernance.findMany({
    where: { tenantId, providerId: { in: [...providerIds] } },
    select: { requiredDisclosures: true },
  });

  return [...new Set(rows.flatMap((row) => row.requiredDisclosures))].sort();
};
