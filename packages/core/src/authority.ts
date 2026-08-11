/**
 * Authority Levels 0-4 - Specification v2 §7.1, design principle 4.
 *
 * Enforced by one middleware layer that every agent action passes through. Never
 * reimplemented per module: a local check is a second implementation that will drift
 * from this one, and the drift will be silent.
 *
 * Level 4 is not a level an agent can hold. It is the list of actions no actor may ever
 * take - the non-negotiable perimeter. Success criterion, Specification v2 §10.5:
 * *zero Level 4 actions succeed*. Blocked-and-logged is the only permitted outcome.
 */

export const AUTHORITY_LEVELS = [0, 1, 2, 3] as const;

/** The level an actor may hold. There is no holder of level 4 - see PROHIBITED_ACTIONS. */
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

export const isAuthorityLevel = (value: unknown): value is AuthorityLevel =>
  typeof value === 'number' && (AUTHORITY_LEVELS as readonly number[]).includes(value);

export const AUTHORITY_LEVEL_NAMES: Record<AuthorityLevel, string> = {
  0: 'Observe',
  1: 'Prepare',
  2: 'Communicate with approval',
  3: 'Submit with human approval',
};

/**
 * Actions an agent may attempt, each requiring a minimum level. Unlike compliance state,
 * authority levels ARE ordinal - level 3 subsumes level 0 - so a numeric comparison is
 * correct here and only here.
 */
export const ACTION_MINIMUM_LEVEL = {
  read_document: 0,
  analyze_file: 0,
  generate_internal_report: 0,
  draft_application: 1,
  draft_communication: 1,
  draft_recommendation: 1,
  send_client_communication: 2,
  send_document_request: 2,
  send_partner_followup: 2,
  submit_application: 3,
  submit_lender_packet: 3,

  // --- Governance actions. See GOVERNANCE_ACTIONS below. ---
  //
  // Added when the Console grew buttons. Until then these acts were reachable only through the
  // API, and - this is the defect, not a design - they went through NO authority check at all:
  // `transitionComplianceState`, `trigger` and `grant` are called directly by their routes rather
  // than through the chain, so a Level 0 observer could move a client to `pass`.
  //
  // **The levels below are a judgement, and one a person should confirm.** The blueprint states
  // levels for agent actions on a client's behalf; it does not state one for recording a
  // determination ABOUT a client. The reasoning for each is written out rather than left implicit,
  // so the argument is with the reasoning rather than with the number.

  /**
   * Level 3. Compliance state is the gate every downstream module reads (Decision E), and moving
   * it to `pass` is what unblocks placement. It is the most consequential single field in a
   * client's file, so it sits with `submit_application`.
   */
  transition_compliance_state: 3,

  /**
   * Level 1, and deliberately the lowest of the four.
   *
   * The Firewall STOPS things. The direction of harm is asymmetric: a Firewall nobody triggered is
   * a placement that should have been frozen and was not, while a Firewall triggered in error is
   * visible immediately, blocks nothing irreversible, and takes a human to clear. The same
   * reasoning 6.4's fail-closed allow-list uses - over-blocking produces a complaint, under-blocking
   * produces a funded client nobody notices.
   *
   * Clearing one is not this action and is not offered here.
   */
  trigger_firewall: 1,

  /**
   * Level 2. Recording a consent is asserting something the CLIENT said, and it is what authorises
   * acts downstream - so it belongs with the actions that reach the client rather than with the
   * ones that only prepare.
   */
  record_client_consent: 2,

  /** Level 2. Opening a file is the start of a commercial relationship, not a draft. */
  create_client_record: 2,
} as const satisfies Record<string, AuthorityLevel>;

/**
 * Actions that RECORD A DETERMINATION about a client, rather than acting for or upon one.
 *
 * **Why this distinction has to exist, concretely.** Middleware step 4 refuses when the client is
 * Do Not Fund listed, when the Firewall is triggered, or when the compliance state is anything but
 * `pass`/`pass_with_findings`. Route a compliance transition through that unchanged and the result
 * is a **one-way door**:
 *
 *   a client in `fail`             can never be moved back to `pass` - the gate blocks the move
 *   a client in `needs_review`     can never be resolved - same
 *   a NEW client (`pending_assessment`) can never be assessed at all
 *
 * A gate that blocks the act of clearing the gate is a trap, and it is the kind of trap that is
 * only discovered by the person it traps.
 *
 * So step 4 is SKIPPED for these actions - and steps 1, 2, 3 and 6 are not. Authentication, tenant
 * scope, the Authority Level and the Ledger event all still apply, which is the whole of what was
 * missing before.
 *
 * **A table rather than an option on the call.** An option is a thing a caller can pass wrongly,
 * and the first caller to want step 4 skipped for a reason of its own would pass it. The
 * classification is a property of the ACTION, it lives in one place, and a reviewer can argue with
 * it - the same shape as `RISK_EVENT_CLASSIFICATION` and `DO_NOT_FUND_PERMITTED_ACTIONS`.
 *
 * Membership is not a licence: `trigger_firewall` is here because you must be able to raise a
 * Firewall on a client who is already listed, not because the Firewall does not apply to it.
 */
export const GOVERNANCE_ACTIONS: readonly string[] = [
  'transition_compliance_state',
  'trigger_firewall',
  'record_client_consent',
  'create_client_record',
];

export const isGovernanceAction = (action: string): boolean => GOVERNANCE_ACTIONS.includes(action);

export type PermittedAction = keyof typeof ACTION_MINIMUM_LEVEL;

/**
 * Level 4 - never allowed, by any actor, at any level, with any approval.
 * Specification v2 §7.1. Middleware hard-blocks each of these and writes a ledger event.
 */
export const PROHIBITED_ACTIONS = [
  'sign_for_client',
  'fabricate_revenue',
  'alter_client_document',
  'submit_without_consent',
  'guarantee_approval',
  'promise_credit_repair',
  'mislabel_card_as_loan',
  'hide_fees',
  'give_legal_or_tax_advice_without_professional_review',
] as const;

export type ProhibitedAction = (typeof PROHIBITED_ACTIONS)[number];

export const isProhibitedAction = (action: string): action is ProhibitedAction =>
  (PROHIBITED_ACTIONS as readonly string[]).includes(action);

export const isPermittedAction = (action: string): action is PermittedAction =>
  Object.prototype.hasOwnProperty.call(ACTION_MINIMUM_LEVEL, action);

/**
 * Actions 2 and 3 require human approval before dispatch in addition to the level check.
 * The level grants the ability to prepare the action, not to complete it unattended.
 */
export const requiresHumanApproval = (action: PermittedAction): boolean =>
  ACTION_MINIMUM_LEVEL[action] >= 2;

/** Level 3 additionally requires a signed client authorization for the specific application. */
export const requiresClientAuthorization = (action: PermittedAction): boolean =>
  ACTION_MINIMUM_LEVEL[action] >= 3;
