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
} as const satisfies Record<string, AuthorityLevel>;

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
