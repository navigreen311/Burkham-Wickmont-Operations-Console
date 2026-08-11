/**
 * What a state permits by way of paying somebody for an introduction - blueprint 8.2's
 * "state restrictions on referral fees", owned HERE.
 *
 * **8.2 needs this answer and must not hold it.** Blueprint 8.2 lists the restrictions among the
 * things it owns, and that reading is the dangerous one: a copy of the state rules living beside
 * the payout calculator is a second set of state rules, and the drift between them would be
 * silent and would surface as money that had already been paid. 7.2 owns state rules. 8.2 asks.
 *
 * The important half of this file is what it REFUSES. `@bwc/partners` cannot compute a figure
 * without an answer here, so every gap below becomes a payout that does not happen rather than a
 * payout nobody checked:
 *
 *   the state is not activated        - counsel has not reviewed anything for it
 *   the module was republished        - what counsel reviewed is not what we would now apply
 *   the module carries no rule        - nobody has said what this state permits
 *   the jurisdiction is undeterminable - `checkJurisdiction`'s rule, applied to money
 *
 * **Staleness moves toward refusing to pay** (ADR-0013, and ADR-0053 for why the direction is
 * this one here). A payout delayed by a day is recoverable by paying it tomorrow. A referral fee
 * paid into a state that prohibits it is not recoverable by any act available to us - it is an
 * unlawful payment that has already happened, and the partner has spent it. The asymmetry is
 * total, so the safe direction is `refuse`.
 */

import { db } from '@bwc/db';
import { noData, ok, refused, type Outcome } from '@bwc/core';
import { currentModule } from './states.js';
import { standingFor } from './activation.js';

export type ReferralFeePosture = 'permitted' | 'permitted_with_conditions' | 'prohibited';

export interface ReferralFeeRule {
  readonly state: string;
  readonly posture: ReferralFeePosture;
  /** What must hold before a fee may be paid. Travels to the payout line as evidence. */
  readonly conditions: readonly string[];
  /**
   * Cap on the partner's share, in basis points of the fee we earned.
   *
   * `null` means the state states no cap, which is NOT "no cap applies" - the agreement's own
   * share still governs, and a caller that read null as unlimited would pay whatever the
   * agreement said in a state that simply had not been asked.
   */
  readonly maxShareBasisPoints: number | null;
  readonly citation: string;
  /** The module version this rule belongs to. Copied onto a payout line so evidence is frozen. */
  readonly moduleVersion: number;
}

export interface RecordRuleInput {
  readonly tenantId: string;
  readonly state: string;
  readonly posture: ReferralFeePosture;
  readonly conditions?: readonly string[];
  readonly maxShareBasisPoints?: number | null;
  readonly citation: string;
  readonly recordedBy: string;
}

/**
 * Attach a referral-fee rule to the state's CURRENT module version.
 *
 * Deliberately not "set the rule for Nevada". The rule belongs to a version, so republishing
 * Nevada materially leaves the new version without one and `referralFeeRuleFor` starts refusing -
 * which is the behaviour we want, because a rule written against superseded text is a rule
 * nobody has checked against the current text.
 */
export const recordReferralFeeRule = async (
  input: RecordRuleInput,
): Promise<Outcome<ReferralFeeRule>> => {
  const state = input.state.trim().toUpperCase();

  if (input.citation.trim().length < 8) {
    return refused(
      'A referral-fee restriction needs a citation. A restriction with no cited basis cannot be reviewed by counsel or defended later, and this one decides whether money may lawfully move.',
      'Blueprint 7.2 - state modules cite their statutes',
    );
  }

  const cap = input.maxShareBasisPoints ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 10_000)) {
    return refused(
      `A share cap is basis points between 0 and 10000; received ${cap}. Basis points, not a percentage - ADR-0011.`,
      'ADR-0011 - money is cents and rates are basis points',
    );
  }

  const module = await currentModule(input.tenantId, state);
  if (module.status !== 'ok') {
    return noData(
      `${state} has no current regulatory module, so there is nothing to attach a referral-fee rule to. Publish the state module first.`,
    );
  }

  const row = await db().stateReferralFeeRule.upsert({
    where: { moduleId: module.value.id },
    create: {
      tenantId: input.tenantId,
      moduleId: module.value.id,
      posture: input.posture,
      conditions: [...(input.conditions ?? [])],
      maxShareBasisPoints: cap,
      citation: input.citation,
      createdBy: input.recordedBy,
    },
    update: {
      posture: input.posture,
      conditions: [...(input.conditions ?? [])],
      maxShareBasisPoints: cap,
      citation: input.citation,
      createdBy: input.recordedBy,
    },
  });

  return ok({
    state,
    posture: row.posture,
    conditions: row.conditions,
    maxShareBasisPoints: row.maxShareBasisPoints,
    citation: row.citation,
    moduleVersion: module.value.version,
  });
};

/**
 * What may we pay for an introduction in this state?
 *
 * Four distinguishable answers, and the distinctions are the point:
 *
 *   `refused`  the state is not in a position to be relied on - not activated, or republished
 *              since counsel read it. Naming which.
 *   `no_data`  the state is activated and nobody has recorded what it permits. A gap in our
 *              research, not a permission.
 *   `ok` with posture `prohibited`  we asked, and the answer is no.
 *   `ok` otherwise                  we asked, and here are the terms.
 *
 * The second is the one that would be tempting to collapse into "no restriction found, proceed".
 * That reading turns every state nobody has researched into a state that permits everything.
 */
export const referralFeeRuleFor = async (
  tenantId: string,
  state: string,
): Promise<Outcome<ReferralFeeRule>> => {
  const code = state.trim().toUpperCase();

  if (code === '') {
    return refused(
      'No state was supplied, so no referral-fee rule can be found. An undeterminable jurisdiction is a refusal and not a pass - the same rule `checkJurisdiction` applies to client-facing action, applied here to money.',
      'Blueprint 7.2 with 8.2 - state-aware referral fee compliance',
    );
  }

  const standing = await standingFor(tenantId, code);
  if (!standing.permitsClientFacingAction) {
    return refused(
      `${code} is '${standing.status}', so its rules cannot be relied on to authorise a payment. ${standing.explanation}`,
      'Blueprint 7.2 - no state comes online without documented counsel review',
    );
  }

  const module = await currentModule(tenantId, code);
  if (module.status !== 'ok') {
    // Unreachable in practice - `standingFor` derives from the same module - but a standing that
    // permits action with no module behind it is a contradiction worth refusing rather than
    // resolving to a default.
    return refused(
      `${code} reports as active but has no current module. Nothing may be paid against a rule that cannot be read.`,
      'Blueprint 7.2 - state modules are the record',
    );
  }

  const row = await db().stateReferralFeeRule.findUnique({
    where: { moduleId: module.value.id },
  });

  if (!row) {
    return noData(
      `${code} is active, and nobody has recorded what it permits by way of referral fees for module version ${module.value.version}. That is a gap in our research and not a permission: a state nobody has asked about is not a state that allows everything. Record a rule with 'recordReferralFeeRule' before a payout can include this jurisdiction.`,
    );
  }

  return ok({
    state: code,
    posture: row.posture,
    conditions: row.conditions,
    maxShareBasisPoints: row.maxShareBasisPoints,
    citation: row.citation,
    moduleVersion: module.value.version,
  });
};

/** Every state that has an answer on record, for a coverage view. */
export const statesWithReferralFeeRules = async (
  tenantId: string,
): Promise<readonly { state: string; posture: ReferralFeePosture }[]> => {
  const rows = await db().stateReferralFeeRule.findMany({
    where: { tenantId, module: { supersededAt: null } },
    select: { posture: true, module: { select: { state: true } } },
    orderBy: { module: { state: 'asc' } },
  });

  return rows.map((row) => ({ state: row.module.state, posture: row.posture }));
};
