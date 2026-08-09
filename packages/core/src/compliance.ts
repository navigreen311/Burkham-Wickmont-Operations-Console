/**
 * Compliance categorical state - Decision E.
 *
 * v1 modelled compliance as a numeric score. v2 replaced it with four distinguishable
 * states because a number hides exactly the difference that drives workflow: a client at
 * "0.72" tells you nothing about whether placement may proceed, while `needs_review` does.
 *
 * This module deliberately exports NO ordering, NO comparison, and NO numeric mapping.
 * If you find yourself wanting to ask "how close is this client to Pass", the question is
 * malformed - ask instead which findings are open. An ordinal helper added here would
 * reintroduce the score through the back door, so `tests/invariants` asserts none exists.
 */

/**
 * The four states, plus the pre-assessment state a client occupies between record creation
 * and first assessment. Order in this array is declaration order for exhaustiveness checks
 * and UI grouping only - it is not a ranking.
 */
export const COMPLIANCE_STATES = [
  'pending_assessment',
  'pass',
  'pass_with_findings',
  'needs_review',
  'fail',
] as const;

export type ComplianceState = (typeof COMPLIANCE_STATES)[number];

export const isComplianceState = (value: unknown): value is ComplianceState =>
  typeof value === 'string' && (COMPLIANCE_STATES as readonly string[]).includes(value);

/**
 * Placement may proceed only from `pass` or `pass_with_findings` - Specification v2 §5.5 step 4
 * and Decision E. Every other state, including `pending_assessment`, blocks.
 *
 * This is a membership test, not a threshold. Adding a sixth state defaults it to blocking,
 * which is the safe direction.
 */
export const PLACEMENT_ELIGIBLE_STATES = ['pass', 'pass_with_findings'] as const;

export type PlacementEligibleState = (typeof PLACEMENT_ELIGIBLE_STATES)[number];

export const permitsPlacement = (state: ComplianceState): state is PlacementEligibleState =>
  (PLACEMENT_ELIGIBLE_STATES as readonly ComplianceState[]).includes(state);

/**
 * `fail` auto-triggers the Funding Ethics Firewall and populates Do Not Fund Governance
 * (Decision E, blueprint 6.2 and 6.4). `needs_review` freezes placement pending human
 * resolution in the Human Approval Console (blueprint 2.4).
 */
export const autoTriggersFirewall = (state: ComplianceState): boolean => state === 'fail';

export const requiresHumanReview = (state: ComplianceState): boolean => state === 'needs_review';

/** A specific finding contributing to a client's categorical state. */
export interface ComplianceFinding {
  readonly code: string;
  readonly summary: string;
  readonly openedAt: Date;
  readonly resolvedAt?: Date;
}

export const isOpen = (finding: ComplianceFinding): boolean => finding.resolvedAt === undefined;

/**
 * A state transition, which is a ledger event. Transitions carry the findings that produced
 * them - Compliance Evidence Vault (7.1) generates regulator-ready files from exactly this,
 * which is why the finding list travels with the transition rather than being looked up later.
 */
export interface ComplianceTransition {
  readonly from: ComplianceState;
  readonly to: ComplianceState;
  readonly findings: readonly ComplianceFinding[];
  readonly reason: string;
}
