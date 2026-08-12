/**
 * The Phase 0, 1 and 2 playbooks, as drafts.
 *
 * **These are a scaffold for the operators who run this firm, not a description of how it works.**
 * The regulatory seed says the same thing about counsel and states it best: something concrete to
 * correct rather than a blank page. Every node below is a proposal about how Burkham Wickmont
 * delivers its service, and several of them are proposals nobody has made yet — see `basis`.
 *
 * The Workflow Engine has been built, validated, scheduled and event-listening since 2.2 landed,
 * and `publishPlaybook` has been called only by tests. The blueprint's V1 goal is "execute Phases
 * 0-2 end-to-end", so with no Phase 0 playbook no client workflow can start at all. This file is
 * the content that gap needs; it is deliberately not the wiring, which belongs to whoever decides
 * when a firm starts running on it.
 *
 * ## What the blueprint does and does not say
 *
 * **It never defines Phase 0, 1 or 2.** It names "the 5-phase service delivery model" (2.2), assigns
 * "Phase 0 workflow" to Capital Readiness and "Phase 4"/"Phase 5" to CFO Advisory and Lifecycle &
 * Exit (Appendix B), and defers "Phases 3-5 playbooks" to V1.5 (section 6). The identities used here
 * are read off three converging sources and are an **inference**, recorded in `PHASE_IDENTITY`:
 *
 *   Phase 0  intake to Readiness Blueprint   flow 5.1, Appendix B, KPI "Funding Readiness Score
 *                                            improvement (Phase 0 clients)"
 *   Phase 1  placement                       flow 5.2, KPI "Placement approval rate by product
 *                                            type (Phase 1 clients)"
 *   Phase 2  stack management                flow 5.3, KPI "Client retention by offer tier
 *                                            (Phase 2 clients)"
 *
 * If that mapping is wrong, the node content is still mostly right and belongs to a differently
 * numbered phase. It is the first thing a reviewer should check.
 *
 * ## Every node says where it came from
 *
 * `basis` is `blueprint` with a citation, or `inferred` with the reasoning. **It is data rather
 * than a comment** so that the list a human has to review cannot drift away from the playbook it
 * describes — an invariant test asserts every node has exactly one entry and every entry names a
 * node. `inferredSteps()` is the review list, generated rather than written.
 *
 * An invented step that reads as confidently as a cited one is the failure the regulatory seed
 * warns about: it looks reviewed.
 *
 * ## Three rules these graphs obey
 *
 * **A human checkpoint raises an 11.4 task and nothing else.** The engine's `human_checkpoint`
 * handler parks the task and calls `raise` in `@bwc/notifications`; 2.4's console reads that queue.
 * There is no second approval store here and there must never be one.
 *
 * **A client-facing send is an `agent_task` naming 4.1**, never a node that sends. The Communications
 * Hub reports `not_built` at the provider seam today, and a playbook that routed around it would be
 * a workflow that appears to contact clients and does not.
 *
 * **Nothing here runs on import.** `seedV1Playbooks` is an exported function, and the integrator
 * decides when a deployment calls it.
 *
 * @see docs/adr/0067-a-playbook-is-a-proposal-about-how-a-firm-works.md
 */

import type { Outcome } from '@bwc/core';
import { publishPlaybook } from './engine.js';
import type { PlaybookDefinition } from './playbook.js';

/**
 * Where a node came from.
 *
 * `blueprint` carries the section it is read from. `inferred` carries the reasoning, and the
 * reasoning is the thing to argue with — a reviewer disagreeing with an inference should be able to
 * see what it rested on without opening the blueprint.
 */
export type NodeBasis =
  | { readonly basis: 'blueprint'; readonly source: string }
  | { readonly basis: 'inferred'; readonly reasoning: string };

export interface PlaybookSeed {
  readonly key: string;
  readonly version: number;
  readonly phase: number;
  readonly title: string;
  /** What this phase is for, in one sentence an operator would recognise. */
  readonly purpose: string;
  /** Why this phase number. The mapping is an inference; see the file header. */
  readonly identityBasis: string;
  readonly definition: PlaybookDefinition;
  /** One entry per node key. The invariant test asserts the two sets are equal. */
  readonly provenance: Readonly<Record<string, NodeBasis>>;
}

/** How each phase was identified. Quoted in the ADR and in the PR, because it is the load-bearing guess. */
export const PHASE_IDENTITY: Readonly<Record<number, string>> = {
  0: 'Appendix B assigns "Phase 0 workflow" to Capital Readiness; flow 5.1 runs intake to Blueprint delivery; specification 9.1 measures "Funding Readiness Score improvement (Phase 0 clients)".',
  1: 'Flow 5.2 is the application submission flow; specification 9.1 measures "Placement approval rate by product type (Phase 1 clients)".',
  2: 'Flow 5.3 is the monthly Capital Command Brief for a Stack Management client; specification 9.1 measures "Client retention by offer tier (Phase 2 clients)".',
};

/**
 * Departments, as Appendix B names them.
 *
 * Held here as constants so a typo becomes a compile error rather than a task dispatched to a
 * department that does not exist — the queue would accept it and nobody would be looking.
 */
const CAPITAL_READINESS = 'capital_readiness';
const FUNDING_STRATEGY = 'funding_strategy';
const CAPITAL_OPERATIONS = 'capital_operations';
const RISK_AND_DEFENSE = 'risk_and_defense';
const COMPLIANCE_AND_EVIDENCE = 'compliance_and_evidence';
const CONCIERGE_DESK = 'concierge_desk';

/**
 * The queue a human checkpoint routes to.
 *
 * **These are 11.4 assignee names, not a new concept.** `dispatch` passes `node.queue` straight to
 * `raise` as `assignedTo`, and 2.4's console reads `openFor(tenantId, queue)`. Naming them after
 * departments is an inference: nothing in the blueprint says a queue is a department, and a firm
 * may well want "compliance_review_board" as its own queue.
 */
const QUEUE_COMPLIANCE = COMPLIANCE_AND_EVIDENCE;
const QUEUE_RISK = RISK_AND_DEFENSE;
const QUEUE_CAPITAL_OPS = CAPITAL_OPERATIONS;

/** Compliance states that permit client-facing work. Decision E, and the chain's step 4 agrees. */
const PERMITTING_STATES = ['pass', 'pass_with_findings'];

// --- Phase 0 --------------------------------------------------------------

const PHASE_0_DEFINITION: PlaybookDefinition = {
  startNode: 'open_file',
  nodes: {
    open_file: {
      kind: 'agent_task',
      department: CAPITAL_READINESS,
      action:
        'Open the client file and set the compliance state to pending_assessment (1.1). Record the offer tier the engagement was sold on.',
      slaMinutes: 60 * 8,
      next: 'record_initial_consents',
    },
    record_initial_consents: {
      kind: 'agent_task',
      department: COMPLIANCE_AND_EVIDENCE,
      action:
        'Record the initial authorizations in the Consent & Authorization Center (1.5): data processing, and the per-pull bureau authorizations Decision B requires. Blanket consent is not a thing this firm takes.',
      slaMinutes: 60 * 8,
      next: 'invite_bank_connection',
    },
    invite_bank_connection: {
      kind: 'agent_task',
      department: CONCIERGE_DESK,
      action:
        'Ask the client to connect their bank through Plaid Link in the Client Portal (11.10, Decision A). Send through the Communications Hub (4.1) - it reports not_built at the provider seam until an email provider is gated in, and that refusal is the honest state of the world rather than a reason to send another way.',
      slaMinutes: 60 * 24,
      next: 'await_bank_authorization',
    },
    await_bank_authorization: {
      kind: 'wait',
      // Decision A routes the Plaid connection authorization through 1.5, so the client's act
      // surfaces as `consent.granted` for this client. The listener matches on the client, so one
      // client's consent cannot wake another's workflow.
      until: { event: 'consent.granted' },
      next: 'request_documents',
    },
    request_documents: {
      kind: 'agent_task',
      department: CONCIERGE_DESK,
      action:
        'Request the documents Phase 0 needs that Plaid does not supply - entity documents, tax returns, debt schedule. Through 4.1, which owns document chase workflows.',
      slaMinutes: 60 * 24,
      next: 'await_documents',
    },
    await_documents: {
      kind: 'wait',
      until: { event: 'vault.document_stored' },
      next: 'enrich_intake',
    },
    enrich_intake: {
      kind: 'agent_task',
      department: CAPITAL_READINESS,
      action:
        'Run the Document Intelligence Pipeline (3.3) over the Plaid feed and the uploaded documents: categorisation, revenue reconciliation, anomaly detection. Every enriched fact carries its provenance.',
      slaMinutes: 60 * 24,
      next: 'build_entity_graph',
    },
    build_entity_graph: {
      kind: 'agent_task',
      department: CAPITAL_READINESS,
      action:
        'Record the entity graph (1.2): operating and holding companies, owners, guarantors, existing debt edges. Designate the primary applicant entity - 5.3 refuses a placement without one.',
      slaMinutes: 60 * 24,
      next: 'score_readiness',
    },
    score_readiness: {
      kind: 'agent_task',
      department: CAPITAL_READINESS,
      action:
        'Produce the Funding Readiness Score with provenance on each component. A component with no source is reported as unmeasured rather than defaulted.',
      slaMinutes: 60 * 24,
      next: 'assess_compliance_state',
    },
    assess_compliance_state: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'Assess the compliance categorical state for this client (Decision E): pass, pass with findings, needs review, or fail. This is the gate every downstream module reads.',
      slaMinutes: 60 * 24 * 2,
      next: 'compliance_gate',
    },
    compliance_gate: {
      kind: 'decision',
      branches: [
        {
          when: { field: 'client.complianceState', op: 'in', value: PERMITTING_STATES },
          next: 'draft_readiness_blueprint',
        },
        {
          when: { field: 'client.complianceState', op: 'eq', value: 'fail' },
          next: 'do_not_fund_routing',
        },
      ],
      // `needs_review` and `pending_assessment` both land here. Decision E freezes placement for
      // the first, and the second means the checkpoint above was completed without a determination
      // being recorded - which is a thing to put in front of a person, not to guess at.
      otherwise: 'hold_for_findings',
    },
    hold_for_findings: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'This client is not in a state that permits client-facing work. Resolve the open findings and record a new compliance state, or move them to fail.',
      slaMinutes: 60 * 24 * 5,
      // Back to the gate. The loop is bounded by a human each time round - the checkpoint parks
      // until somebody completes it - so it cannot spin, and a client whose findings take three
      // attempts to resolve is an ordinary client rather than a stuck workflow.
      next: 'compliance_gate',
    },
    do_not_fund_routing: {
      kind: 'human_checkpoint',
      queue: QUEUE_RISK,
      summary:
        'Compliance state is fail. Decision E routes this client to Do Not Fund Governance and the Funding Ethics Firewall. Record the listing, then close the Phase 0 engagement.',
      slaMinutes: 60 * 24,
      next: 'ended_without_blueprint',
    },
    draft_readiness_blueprint: {
      kind: 'agent_task',
      department: CAPITAL_READINESS,
      action:
        'Draft the Readiness Blueprint from the readiness-blueprint template (3.1). Every figure carries provenance; an unresearched input is labelled rather than smoothed over.',
      slaMinutes: 60 * 24 * 2,
      next: 'blueprint_review',
    },
    blueprint_review: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'Review the Readiness Blueprint before it reaches the client (3.4). It carries a compliance state and readiness figures, so it needs a human.',
      slaMinutes: 60 * 24 * 2,
      next: 'deliver_blueprint',
    },
    deliver_blueprint: {
      kind: 'agent_task',
      department: CONCIERGE_DESK,
      action:
        'Deliver the approved Blueprint to the Client Portal and notify the client through 4.1.',
      slaMinutes: 60 * 24,
      next: 'book_review_call',
    },
    book_review_call: {
      kind: 'agent_task',
      department: CONCIERGE_DESK,
      action:
        'Schedule the Blueprint Review Call and record it against the lead in Sales Motion (1.3).',
      slaMinutes: 60 * 24 * 3,
      next: 'phase_0_complete',
    },
    phase_0_complete: { kind: 'terminal', outcome: 'completed' },
    ended_without_blueprint: { kind: 'terminal', outcome: 'cancelled' },
  },
};

const PHASE_0_PROVENANCE: Readonly<Record<string, NodeBasis>> = {
  open_file: {
    basis: 'blueprint',
    source:
      'Flow 5.1: "Client Lifecycle & CRM (client record created, compliance state = Pending Assessment)"',
  },
  record_initial_consents: {
    basis: 'blueprint',
    source:
      'Flow 5.1: "Consent & Authorization Center (initial authorizations)"; Decision B per-pull authorization',
  },
  invite_bank_connection: {
    basis: 'blueprint',
    source:
      'Flow 5.1: "Client Portal (Plaid Link connection prompt)"; 11.10 hosts the Link experience per Decision A',
  },
  await_bank_authorization: {
    basis: 'inferred',
    reasoning:
      'Flow 5.1 shows the connection being established but names no wait. A workflow that walked straight from "ask" to "enrich" would enrich nothing. The event chosen is `consent.granted` because Decision A routes the Plaid connection authorization through 1.5 - if a deployment records it some other way, this wait never resolves and this is the node to change.',
  },
  request_documents: {
    basis: 'inferred',
    reasoning:
      'Flow 5.1 goes from Plaid to enrichment with no document request, but 3.2 stores tax returns, entity documents and debt schedules that Plaid cannot supply, and 4.1 owns "document chase workflows". Some step has to ask.',
  },
  await_documents: {
    basis: 'inferred',
    reasoning:
      'Same basis as the request. `vault.document_stored` fires on the first upload, so this resumes on one document rather than on a complete set - completeness is 3.3\'s "missing document detection" and belongs to the enrichment step, not to a wait that cannot count.',
  },
  enrich_intake: {
    basis: 'blueprint',
    source: 'Flow 5.1: "Document Intelligence Pipeline (enrichment)"; 3.3 pipeline steps 2-6',
  },
  build_entity_graph: {
    basis: 'blueprint',
    source: 'Flow 5.1: "Client Household / Entity Graph (initial entity discovery)"',
  },
  score_readiness: {
    basis: 'blueprint',
    source: 'Flow 5.1: "Funding Readiness Score generated (provenance on each component)"',
  },
  assess_compliance_state: {
    basis: 'blueprint',
    source: 'Flow 5.1: "Compliance categorical state assessed"; Decision E makes it categorical',
  },
  compliance_gate: {
    basis: 'blueprint',
    source:
      'Decision E: pass allows autonomous action, needs review freezes placement and routes to 2.4, fail integrates with Do Not Fund Governance',
  },
  hold_for_findings: {
    basis: 'inferred',
    reasoning:
      'Decision E says needs_review "routes to Human Approval Console with placement frozen" but does not say what happens next. A checkpoint that returns to the gate lets a resolved finding move the client on; the alternative - ending the workflow - would make every findings resolution a new engagement.',
  },
  do_not_fund_routing: {
    basis: 'blueprint',
    source:
      'Decision E: "Fail integrates with Do Not Fund Governance"; principle 7 firewall precedence',
  },
  draft_readiness_blueprint: {
    basis: 'blueprint',
    source:
      'Flow 5.1: "Deliverable Approval Workflow (Blueprint report reviewed)" implies the report is drafted; 1.3 tracks "Readiness Blueprint status"',
  },
  blueprint_review: {
    basis: 'blueprint',
    source:
      'Flow 5.1: "Deliverable Approval Workflow (Blueprint report reviewed)"; 3.4 requires human review by content type',
  },
  deliver_blueprint: {
    basis: 'blueprint',
    source: 'Flow 5.1: "Client Portal (Blueprint delivered)"',
  },
  book_review_call: {
    basis: 'blueprint',
    source:
      'Flow 5.1: "Sales Motion (Blueprint Review Call scheduled)"; 1.3 owns Blueprint Review Calls',
  },
  phase_0_complete: {
    basis: 'inferred',
    reasoning:
      "Every graph needs a terminal; `validate` refuses one without. Where Phase 0 ends is not stated - this ends it at the review call being booked rather than at the call happening, because the call belongs to 1.3 and to a person's calendar.",
  },
  ended_without_blueprint: {
    basis: 'inferred',
    reasoning:
      'A failed compliance state has to end the workflow somewhere. Cancelled rather than completed: nothing was delivered, and a completed Phase 0 with no Blueprint would read as a served client.',
  },
};

// --- Phase 1 --------------------------------------------------------------

const PHASE_1_DEFINITION: PlaybookDefinition = {
  startNode: 'confirm_placement_scope',
  nodes: {
    confirm_placement_scope: {
      kind: 'agent_task',
      department: FUNDING_STRATEGY,
      action:
        'Confirm what this client is borrowing for and how much, and record the application reference. 5.2 assesses suitability against the stated need, so a default here produces a confident recommendation for a purpose nobody stated (ADR-0035).',
      slaMinutes: 60 * 24,
      next: 'placement_gate',
    },
    placement_gate: {
      kind: 'decision',
      branches: [
        {
          when: { field: 'client.complianceState', op: 'in', value: PERMITTING_STATES },
          next: 'request_recommendation',
        },
      ],
      otherwise: 'placement_frozen',
    },
    placement_frozen: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'Placement is frozen: this client is not in a passing compliance state. Resolve it in Phase 0 terms, or close this placement.',
      slaMinutes: 60 * 24 * 5,
      next: 'ended_not_placed',
    },
    request_recommendation: {
      kind: 'agent_task',
      department: FUNDING_STRATEGY,
      action:
        'Ask 5.3 for a recommendation for this application reference. Rejections travel with it and are never truncated - a short list without them is not reviewable.',
      slaMinutes: 60 * 24,
      next: 'draft_suitability_memo',
    },
    draft_suitability_memo: {
      kind: 'agent_task',
      department: FUNDING_STRATEGY,
      action:
        'Draft the Funding Suitability Memo (3.1) from the recommendation, with the cost of capital computed by 5.6 and every lender rule carrying its provenance tag.',
      slaMinutes: 60 * 24 * 2,
      next: 'memo_review',
    },
    memo_review: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'Review the Funding Suitability Memo before the client sees it. It carries a recommendation and cost figures, which is exactly the content 3.4 requires a human for.',
      slaMinutes: 60 * 24 * 2,
      next: 'request_client_authorization',
    },
    request_client_authorization: {
      kind: 'agent_task',
      department: CONCIERGE_DESK,
      action:
        'Send the memo and the per-application authorization to the Client Portal through 4.1. Authorization is scoped to this application reference, never blanket (1.5).',
      slaMinutes: 60 * 24,
      next: 'await_client_authorization',
    },
    await_client_authorization: {
      kind: 'wait',
      until: { event: 'consent.granted' },
      next: 'compliance_officer_approval',
    },
    compliance_officer_approval: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'Approve this submission. Level 3 with the client authorization on file; the middleware chain refuses the submit action without both.',
      slaMinutes: 60 * 24,
      next: 'submit_application',
    },
    submit_application: {
      kind: 'agent_task',
      department: FUNDING_STRATEGY,
      action:
        'Submit the application through the Integration Layer to CapitalForge. No module calls a provider directly (11.5).',
      slaMinutes: 60 * 24,
      next: 'await_provider_decision',
    },
    await_provider_decision: {
      kind: 'wait',
      // A provider takes days and the Funding Outcome Ledger records the answer when it arrives.
      // A duration wait here would make a fast approval sit until the timer expired.
      until: { event: 'billing.funding_outcome.recorded' },
      next: 'record_outcome',
    },
    record_outcome: {
      kind: 'agent_task',
      department: CAPITAL_OPERATIONS,
      action:
        'Record the outcome and file the artifact set in the Compliance Evidence Vault (7.1). A success fee computes against approvedCreditLimit and never against the requested limit.',
      slaMinutes: 60 * 24,
      next: 'phase_1_complete',
    },
    phase_1_complete: { kind: 'terminal', outcome: 'completed' },
    ended_not_placed: { kind: 'terminal', outcome: 'cancelled' },
  },
};

const PHASE_1_PROVENANCE: Readonly<Record<string, NodeBasis>> = {
  confirm_placement_scope: {
    basis: 'inferred',
    reasoning:
      'Flow 5.2 begins at "Funding Recommendation Engine generates recommendation", which needs a need and an amount to generate against. ADR-0035 established that both are required and must not be defaulted, so something upstream has to establish them. The blueprint names no such step.',
  },
  placement_gate: {
    basis: 'blueprint',
    source:
      'Flow 5.2: "Compliance state check (must be Pass or Pass with Findings per Decision E)"',
  },
  placement_frozen: {
    basis: 'inferred',
    reasoning:
      'Flow 5.2 shows the check but not the failure path. Ending at a checkpoint rather than silently stopping means somebody is told; a placement that simply stops is one a client asks about later.',
  },
  request_recommendation: {
    basis: 'blueprint',
    source: 'Flow 5.2: "Funding Recommendation Engine (generates recommendation with provenance)"',
  },
  draft_suitability_memo: {
    basis: 'inferred',
    reasoning:
      'Flow 5.2 does not name a memo. 5.6 says the Cost of Capital Calculator is "embedded in Funding Suitability Memos", and 3.1 owns the template, so the artifact exists - what is inferred is that Phase 1 is where it is produced.',
  },
  memo_review: {
    basis: 'inferred',
    reasoning:
      '3.4 requires human review "if required by risk or content type" without saying which types. A document carrying a funding recommendation is the clearest candidate, and the template is registered requiresHumanReview.',
  },
  request_client_authorization: {
    basis: 'blueprint',
    source:
      'Flow 5.2: "Consent & Authorization Center (per-application authorization)" then "Client Portal (client signs authorization)"',
  },
  await_client_authorization: {
    basis: 'blueprint',
    source:
      "Flow 5.2: the client signs before the compliance officer approves; the ordering is the blueprint's",
  },
  compliance_officer_approval: {
    basis: 'blueprint',
    source: 'Flow 5.2: "Human Approval Console (compliance officer approves)"',
  },
  submit_application: {
    basis: 'blueprint',
    source: 'Flow 5.2: "CapitalForge (submission execution)"; 11.5 requires the Integration Layer',
  },
  await_provider_decision: {
    basis: 'inferred',
    reasoning:
      'Flow 5.2 goes straight from submission to "Funding Outcome Ledger (outcome captured)" with no wait. A provider takes days, so a wait is needed; `billing.funding_outcome.recorded` was chosen over a duration so a fast decision is not held behind a timer.',
  },
  record_outcome: {
    basis: 'blueprint',
    source:
      'Flow 5.2: "Funding Outcome Ledger", "Pricing / Billing (success fee ... from approvedCreditLimit)", "Compliance Evidence Vault (full artifact set stored)"',
  },
  phase_1_complete: {
    basis: 'inferred',
    reasoning:
      'A terminal is structurally required. Phase 1 ends at the outcome being recorded rather than at funding arriving, because the 60-day approved-not-funded trigger in 1.4 is a billing concern that outlives this workflow.',
  },
  ended_not_placed: {
    basis: 'inferred',
    reasoning: 'Cancelled rather than completed, for the reason Phase 0 gives: nothing was placed.',
  },
};

// --- Phase 2 --------------------------------------------------------------

const PHASE_2_DEFINITION: PlaybookDefinition = {
  startNode: 'refresh_bank_feed',
  nodes: {
    refresh_bank_feed: {
      kind: 'agent_task',
      department: CAPITAL_OPERATIONS,
      action:
        'Pull fresh transaction data through the Integration Layer (Plaid, Decision A) and record the feed timestamp as provenance for everything computed from it.',
      slaMinutes: 60 * 24,
      next: 'compute_stack_position',
    },
    compute_stack_position: {
      kind: 'agent_task',
      department: CAPITAL_OPERATIONS,
      action:
        'Compute the current capital stack and the Capital Stack Health Score (5.1). Write the health band into the workflow context as `stackHealth` so the branch below can read it.',
      slaMinutes: 60 * 24,
      next: 'update_cost_of_capital',
    },
    update_cost_of_capital: {
      kind: 'agent_task',
      department: CAPITAL_OPERATIONS,
      action: 'Update the blended cost of capital across the stack (5.6).',
      slaMinutes: 60 * 24,
      next: 'health_gate',
    },
    health_gate: {
      kind: 'decision',
      branches: [
        {
          when: { field: 'context.stackHealth', op: 'eq', value: 'deteriorating' },
          next: 'escalate_to_advisory',
        },
      ],
      otherwise: 'draft_capital_command_brief',
    },
    escalate_to_advisory: {
      kind: 'human_checkpoint',
      queue: QUEUE_CAPITAL_OPS,
      summary:
        'The capital stack health has deteriorated. Decide what the Brief should say about it before it is drafted, and whether this client needs a conversation rather than a document.',
      slaMinutes: 60 * 24 * 2,
      next: 'draft_capital_command_brief',
    },
    draft_capital_command_brief: {
      kind: 'agent_task',
      department: CAPITAL_OPERATIONS,
      action:
        'Draft the Capital Command Brief (3.1) with provenance on every figure. A figure with no measurement is reported as unmeasured, never as zero.',
      slaMinutes: 60 * 24 * 2,
      next: 'brief_review',
    },
    brief_review: {
      kind: 'human_checkpoint',
      queue: QUEUE_COMPLIANCE,
      summary:
        'Review the Capital Command Brief before delivery (3.4). The Communication Compliance Scanner runs on its client-facing text as part of the approval, not as a separate step here.',
      slaMinutes: 60 * 24 * 2,
      next: 'deliver_brief',
    },
    deliver_brief: {
      kind: 'agent_task',
      department: CONCIERGE_DESK,
      action: 'Deliver the approved Brief to the Client Portal and notify the client through 4.1.',
      slaMinutes: 60 * 24,
      next: 'phase_2_complete',
    },
    phase_2_complete: { kind: 'terminal', outcome: 'completed' },
  },
};

const PHASE_2_PROVENANCE: Readonly<Record<string, NodeBasis>> = {
  refresh_bank_feed: {
    basis: 'blueprint',
    source: 'Flow 5.3: "Plaid (fresh transaction data pulled)"',
  },
  compute_stack_position: {
    basis: 'blueprint',
    source:
      'Flow 5.3: "Capital Stack & Monitoring (current state computed)" then "Capital Stack Health Score computed"',
  },
  update_cost_of_capital: {
    basis: 'blueprint',
    source: 'Flow 5.3: "Cost of Capital Calculator (blended cost updated)"',
  },
  health_gate: {
    basis: 'inferred',
    reasoning:
      'Flow 5.3 is a straight line with no branch. A monthly brief that reported a deteriorating stack with nobody looking would be a report nobody acts on, and 6.1 exists because deterioration is supposed to reach a person. The field read here is written by the step above; if a deployment names the band differently, this branch silently never fires - which is the weakest point in this playbook.',
  },
  escalate_to_advisory: {
    basis: 'inferred',
    reasoning:
      'Same basis as the gate. Routed to Capital Operations rather than to the founder: 11.11 takes items that need a Level 3 human and are blocking, and a brief that needs a conversation is neither yet.',
  },
  draft_capital_command_brief: {
    basis: 'blueprint',
    source:
      'Flow 5.3: "Document & Deliverable Management (Brief template populated with provenance)"',
  },
  brief_review: {
    basis: 'blueprint',
    source:
      'Flow 5.3: "Communication Compliance Scanner (final check)" then "Deliverable Approval Workflow"',
  },
  deliver_brief: {
    basis: 'blueprint',
    source: 'Flow 5.3: "Client Portal (Brief delivered)"',
  },
  phase_2_complete: {
    basis: 'inferred',
    reasoning:
      'The graph ends after delivery rather than waiting a month and looping. 2.2 gives the Scheduler "cron-like capability for recurring workflows (monthly Capital Command Briefs)", so the recurrence belongs to a schedule that starts a fresh instance - a workflow that slept for thirty days would hold an instance open for a year and hide a failure inside it.',
  },
};

// --- The seeds ------------------------------------------------------------

export const PHASE_0_PLAYBOOK: PlaybookSeed = {
  key: 'phase-0-capital-readiness',
  version: 1,
  phase: 0,
  title: 'Phase 0 - Capital Readiness',
  purpose:
    'From a purchased engagement to a delivered Readiness Blueprint and a booked review call.',
  identityBasis: PHASE_IDENTITY[0] as string,
  definition: PHASE_0_DEFINITION,
  provenance: PHASE_0_PROVENANCE,
};

export const PHASE_1_PLAYBOOK: PlaybookSeed = {
  key: 'phase-1-placement',
  version: 1,
  phase: 1,
  title: 'Phase 1 - Placement',
  purpose: 'From a stated capital need to a submitted application and a recorded outcome.',
  identityBasis: PHASE_IDENTITY[1] as string,
  definition: PHASE_1_DEFINITION,
  provenance: PHASE_1_PROVENANCE,
};

export const PHASE_2_PLAYBOOK: PlaybookSeed = {
  key: 'phase-2-stack-management',
  version: 1,
  phase: 2,
  title: 'Phase 2 - Stack Management',
  purpose: 'One month of the Capital Command Brief cycle, from fresh data to a delivered Brief.',
  identityBasis: PHASE_IDENTITY[2] as string,
  definition: PHASE_2_DEFINITION,
  provenance: PHASE_2_PROVENANCE,
};

export const V1_PLAYBOOK_SEEDS: readonly PlaybookSeed[] = [
  PHASE_0_PLAYBOOK,
  PHASE_1_PLAYBOOK,
  PHASE_2_PLAYBOOK,
];

/**
 * Every node whose content this file inferred rather than read.
 *
 * **This is the review list, and it is generated.** Written out by hand it would drift from the
 * playbooks the first time somebody retargeted a `next`; derived from the same data the graphs
 * carry, it cannot.
 */
export const inferredSteps = (): readonly {
  playbookKey: string;
  nodeKey: string;
  reasoning: string;
}[] =>
  V1_PLAYBOOK_SEEDS.flatMap((seed) =>
    Object.entries(seed.provenance)
      .filter(([, entry]) => entry.basis === 'inferred')
      .map(([nodeKey, entry]) => ({
        playbookKey: seed.key,
        nodeKey,
        reasoning: (entry as { basis: 'inferred'; reasoning: string }).reasoning,
      })),
  );

export interface SeedResult {
  readonly published: readonly string[];
  readonly refused: readonly { key: string; reason: string }[];
}

/**
 * Publish the three V1 playbooks.
 *
 * **Idempotent, and more simply than the regulatory seed is.** `publishPlaybook` upserts on
 * (key, version), so running this twice republishes the same definition at the same version and
 * leaves the row where it was. The regulatory seed deliberately bumps a version on every run
 * because a state module is a claim about the law that has to go back to counsel when it changes;
 * a playbook re-seeded from unchanged source is the same playbook, and an instance already running
 * v1 stays pinned to it regardless.
 *
 * **Nothing calls this on import.** A deployment that wanted these playbooks live would call it
 * once, deliberately, and that call belongs to whoever is integrating rather than here.
 *
 * A refusal is collected rather than thrown: `publishPlaybook` validates, and if a definition in
 * this file is ever invalid the useful output is which one and why, not a stack trace from the
 * first failure.
 *
 * ## Nothing here is written to the Event Ledger, and that is a reported gap rather than a choice
 *
 * The regulatory seed appends `regulatory.seed.published`. There is no `workflow.seed.published`
 * in `packages/core/src/events.ts`, this slice does not own that file, and borrowing a neighbouring
 * type would put a false entry in an append-only store - so this function records nothing and says
 * so instead.
 *
 * **The larger half of that finding is not about seeding.** `publishPlaybook` itself writes no
 * Ledger event either, so publishing a playbook - the rules by which the firm serves clients - is
 * currently unrecorded however it is done. Principle 3 says every state change is an event. Both are
 * in the PR.
 */
export const seedV1Playbooks = async (): Promise<SeedResult> => {
  const published: string[] = [];
  const refused: { key: string; reason: string }[] = [];

  for (const seed of V1_PLAYBOOK_SEEDS) {
    const result: Outcome<{ id: string }> = await publishPlaybook({
      key: seed.key,
      version: seed.version,
      phase: seed.phase,
      definition: seed.definition,
    });

    if (result.status === 'ok') {
      published.push(seed.key);
    } else {
      refused.push({ key: seed.key, reason: result.reason });
    }
  }

  return { published, refused };
};
