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

  // --- Batch A: the writes that are irreversible, firm-wide, or move money ---
  //
  // Seventeen Console capabilities had a working module function and no declared action, so the
  // surface could read them and not offer them. These are the eight the firm cannot undo.
  //
  // **Every one is Level 3, and that was close to decided already.** Nineteen modules had each
  // picked a level for their own most consequential act - CHANGE_AUTHORITY_LEVEL,
  // HOLD_AUTHORITY_LEVEL, DELETION_AUTHORITY_LEVEL, TERMINATION_AUTHORITY_LEVEL,
  // PAYOUT_AUTHORITY_LEVEL and the rest - and every single one chose 3 independently. Declaring
  // these makes the authority model agree with a judgement the modules had already made and the
  // chain had no way to enforce.

  /**
   * Level 3. A parameter is not one client's setting: it is the number every client's file is
   * computed against, so a wrong one is wrong retroactively and everywhere at once. The module
   * already says so with `CHANGE_AUTHORITY_LEVEL = 3`.
   */
  change_system_parameter: 3,

  /**
   * Level 3. Publishing an offer supersedes the live one and fixes what the firm charges. It is a
   * price list, not a quote, and the previous version stops being what a new engagement starts on.
   */
  publish_offer: 3,

  /**
   * Level 3. Starting an engagement commits a client to a fee; cancelling one ends the commercial
   * relationship; applying a credit moves money. Grouped because they are the same act from three
   * directions - a change to what this client owes.
   */
  manage_engagement: 3,

  /**
   * Level 3. A clause is wording that lands in every contract generated after it, including ones
   * nobody re-reads. Contract language is the firm's legal position stated once and relied on many
   * times.
   */
  publish_contract_clause: 3,

  /**
   * Level 3. A generated contract is a document a client signs. It sits with `submit_application`:
   * the act of putting something in front of a counterparty under the firm's name.
   */
  generate_client_contract: 3,

  /**
   * Level 3, and the one that is not a write at all.
   *
   * Revealing an SSN or EIN produces the most sensitive field the system holds - field-level
   * encrypted, kept out of logs, events and error messages. It is declared as an action precisely
   * because the authority model is the only place that can gate a READ, and a read nobody had to
   * hold a level for was reachable by anyone the session let in.
   */
  reveal_protected_identifier: 3,

  /**
   * Level 3. A hold is a matter, and placing one asserts that litigation is anticipated - it stops
   * a retention schedule the firm otherwise runs automatically.
   */
  place_legal_hold: 3,

  /**
   * Level 3, and separate from placing one **because releasing is the dangerous half.** A hold in
   * force costs storage; a hold released early is the thing that lets records be destroyed while
   * they were still wanted. Two actions rather than one so the Ledger can tell them apart and so a
   * later policy can lower placing without lowering this.
   */
  release_legal_hold: 3,

  /**
   * Level 3. Deleting a client's records is the most consequential act in this Console and the
   * only one with no recovery. The module already requires `DELETION_AUTHORITY_LEVEL`.
   */
  decide_deletion_request: 3,

  /**
   * Level 3. Removing a document is irreversible and removes evidence - the artifact set in the
   * Compliance Evidence Vault is what the firm would produce if asked to show its work.
   */
  remove_vault_document: 3,

  /**
   * Level 3. A retention schedule decides when documents are destroyed without anybody deciding
   * again, which makes setting one a decision taken once and executed for years.
   */
  set_document_retention: 3,

  /**
   * Level 3. A material republish decertifies every partner who completed the previous version
   * (ADR-0074), so publishing a module is an act against the whole network rather than a document
   * edit.
   */
  publish_curriculum_module: 3,

  // --- Batch B: the determinations ---
  //
  // Three capability lines that were scoped as "the Level 2 ones". Two of them turned out not to
  // be, for the same reason Batch A produced twelve actions from eight lines: a line is a surface
  // and the acts behind it differ.

  /**
   * Level 1. A conflict disclosure is generated MECHANICALLY and that is the point of it - a
   * hand-written one varies with how the writer feels about the conflict, and the version written
   * by somebody keen to proceed is the one that understates it (ADR-0063).
   *
   * So producing the artifact is preparation, not a determination. **Generating is not
   * disclosing**: the disclosure is complete only when acknowledged, and acknowledgement is not
   * offered on this surface at any level, because a control for it here would manufacture the
   * evidence the disclosure exists to require.
   */
  generate_conflict_disclosure: 1,

  /**
   * Level 2. Tagging a client as an inter-venture relationship is a determination about who this
   * client is to the firm, and it is what turns the conflict machinery on. It sits with
   * `record_client_consent`: asserting a fact that authorises - or constrains - acts downstream.
   */
  tag_venture: 2,

  /**
   * Level 3. An intercompany invoice moves money between related parties, which is the precise
   * point where an inter-venture conflict stops being a disclosure question and becomes a
   * transaction somebody could be asked to justify.
   */
  raise_intercompany_invoice: 3,

  /**
   * Level 2. Recording what a PROVIDER decided - submitted, approved, declined, withdrawn, and the
   * client's satisfaction with it. The firm is not deciding here; it is writing down somebody
   * else's decision, which is why it does not sit with `submit_application` at 3.
   *
   * It is not clerical either. This is the denominator 9.1 refused to fake and 5.5 exists to make
   * honest: a decline that nobody records is an approval rate that reads better than the firm
   * performed.
   */
  record_funding_outcome: 2,

  /**
   * Level 3, and separate from recording any other outcome.
   *
   * **Marking an attempt funded stops a refund clock.** Blueprint 1.4 drives refunds from objective
   * triggers, and the first of them is sixty days approved-but-unfunded. An attempt wrongly marked
   * funded silently takes a client out of the window that would have refunded them - a financial
   * consequence to somebody who is not in the room, arriving later and invisibly.
   */
  mark_attempt_funded: 3,

  /**
   * Level 2. Entities, owners, relationships and stated revenue - the structural facts the risk and
   * readiness engines read as given.
   *
   * **Recording what a client stated is Level 2; altering it is Level 4 and never permitted.**
   * `fabricate_revenue` is on the prohibited list below, and the distinction is the whole of the
   * rule: this action writes down what somebody said, and no level of authority permits changing it
   * into what somebody wishes they had said.
   */
  record_entity_graph: 2,

  // --- Batch C: the casework, and the one act inside it that is not ---

  /**
   * Level 1. Creating, qualifying and closing a lead is the sales team's own work on a prospect
   * who is not yet a client of the firm. Qualification decides whether this is somebody the firm
   * should take on, which sounds weightier than 1 - but the act it gates is `convert_lead`, and
   * that is where the level belongs. Putting ordinary prospecting behind Level 3 would mean the
   * firm's most senior person logging every enquiry.
   */
  manage_lead: 1,

  /**
   * **Level 3, and this is the whole of Batch C's finding.**
   *
   * `convertLead` creates a client through 1.1 and may start an engagement through 1.4. Those are
   * `create_client_record` at Level 2 and `manage_engagement` at Level 3 - so a lead conversion
   * declared at Level 1 would be a lower-level path to both of them.
   *
   * ADR-0034's rule, in a new shape: a control somebody can reach another way is not a control. The
   * level of an action is the level of the most consequential thing it can do, not the level of
   * what it is usually used for.
   */
  convert_lead: 3,

  /**
   * Level 1. Market and competitor intelligence: ingesting a feed, normalising it, recording what
   * it found. It writes rather than only observes, which is why it is not 0 alongside
   * `generate_internal_report` - but nothing here reaches a client or commits the firm.
   */
  record_market_intelligence: 1,
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

  // Legal holds and deletion decisions, for the same reason and a sharper one.
  //
  // **A hold is placed on exactly the client step 4 refuses.** Litigation is anticipated because
  // something went wrong, so the client is very often in `fail`, on the Do Not Fund list, or behind
  // a triggered Firewall - and a gate that blocked the hold would mean the firm could not preserve
  // records precisely when it most needs to, and would keep destroying them on schedule while
  // somebody worked out why the button did nothing.
  //
  // Releasing is here too, and that is the uncomfortable half: the same skip that lets a hold be
  // placed on a failing client lets one be lifted from them. The alternative is worse - a hold
  // nobody can release is a retention schedule permanently suspended by whoever placed it - and
  // the act still needs Level 3, still writes to the Ledger, and still names a matter.
  'place_legal_hold',
  'release_legal_hold',

  // A deletion request is a determination ABOUT a client, and a client asking to be forgotten is
  // not made ineligible to ask by failing an assessment. Their eligibility is decided by
  // `assessEligibility`, which reads the holds in force - not by the compliance gate.
  'decide_deletion_request',

  // --- Batch B ---
  //
  // **`record_entity_graph` is here because leaving it out would rebuild the original trap.**
  // Step 4 refuses anything that is not Pass or Pass with Findings, so a client in
  // `pending_assessment` - which is every client on the day their file opens - could not have an
  // entity, an owner or a stated revenue recorded. And the entity graph is an INPUT to the
  // assessment that would move them out of `pending_assessment`. A new client could never be
  // assessed, which is word for word the failure this list was created to prevent, one layer out.
  'record_entity_graph',

  // Recording what a provider decided is the clearest case of a determination ABOUT a client
  // rather than an act FOR one. A client can be firewalled or moved to `fail` between submission
  // and answer - that is a common sequence, not an exotic one - and a gate that blocked the record
  // would leave the decline unrecorded. 9.1's denominator would then improve because a client's
  // file went wrong, which is precisely backwards.
  'record_funding_outcome',
  'mark_attempt_funded',

  // Tagging a venture is how a conflict gets discovered, and a client whose file has gone wrong is
  // not less likely to be the one with the undisclosed relationship.
  'tag_venture',
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
