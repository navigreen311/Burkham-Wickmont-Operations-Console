/**
 * Event Ledger vocabulary - design principle 3, blueprint 11.3.
 *
 * Every state change is an event. Modules do not modify shared state; they emit events and
 * project their own read stores. The Ledger is append-only: corrections are compensating
 * events, never mutations, so the audit trail survives its own mistakes.
 *
 * Event types are versioned by name. Adding a field is a compatible change; changing the
 * meaning of one requires a new type, because events written under the old meaning are
 * still in the store and will still be read.
 */

import type { ComplianceState } from './compliance.js';

export const EVENT_TYPES = [
  // Client & Engagement
  'client.created',
  'client.compliance_state_changed',
  // Consent & Authorization Center (1.5)
  'consent.granted',
  'consent.revoked',
  // Funding Ethics Firewall (6.2)
  'firewall.triggered',
  'firewall.cleared',
  // Placement path (5.3)
  'placement.requested',
  'placement.refused',
  // Authority enforcement (2.1)
  'authority.action_blocked',
  /**
   * The counterpart, added when the Console grew buttons.
   *
   * The Ledger has always recorded what the chain REFUSED and never what it permitted, so an audit
   * could see the attempts that failed and not the ones that succeeded - and on a staff console
   * the second question is the more common one. Written by step 6 when a governance action is
   * authorised; the module that performs the action still writes its own outcome event, because
   * "this actor was allowed to try" and "this is what happened" are different facts.
   */
  'authority.action_authorised',
  // Tenant isolation (11.2)
  'tenancy.cross_tenant_access_blocked',
  // Workflow Engine (2.2) - Decision C. The Engine writes these and listens for others.
  /** The firm changed the rules by which it serves clients. Principle 3. */
  'workflow.playbook_published',
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'workflow.task_dispatched',
  'workflow.task_succeeded',
  'workflow.task_failed',
  'workflow.task_retry_scheduled',
  'workflow.task_dead_lettered',
  'workflow.task_lease_reclaimed',
  'workflow.decision_evaluated',
  'workflow.wait_started',
  /** A wait took long enough that the playbook asked somebody to chase it. */
  'workflow.reminder_raised',
  'workflow.wait_resolved',
  'workflow.sla_breached',
  'workflow.schedule_fired',
  'workflow.schedule_late',
  'workflow.trigger_fired',
  // Notification & Task Queue (11.4)
  'notification.raised',
  'notification.completed',
  // Document & Deliverable Management (3.1) and Deliverable Approval Workflow (3.4)
  'deliverable.drafted',
  'deliverable.qa_checked',
  'deliverable.scanned',
  'deliverable.blocked',
  'deliverable.approved',
  'deliverable.rejected',
  'deliverable.delivered',
  // Communication Compliance Scanner (4.2)
  'scanner.blocked_content',
  'scanner.novel_language',
  // Secure Document Vault (3.2)
  'vault.document_stored',
  'vault.document_accessed',
  'vault.access_refused',
  'vault.document_exported',
  'vault.legal_hold_set',
  'vault.legal_hold_released',
  'vault.document_deleted',
  'vault.scan_completed',
  // Document Intelligence Pipeline (3.3)
  'intelligence.ingestion_attempted',
  'intelligence.ingestion_completed',
  'intelligence.ingestion_unavailable',
  'intelligence.finding_raised',
  // Marketing Claim Library (7.4)
  'claim.published',
  'claim.deprecated',
  // Lender Intelligence Database (5.2). Rule and offering writes are events because the
  // specification requires every rule change logged with its source and verification method,
  // and the Ledger is where that log lives.
  'lender.provider.registered',
  'lender.rule.recorded',
  'lender.offering.recorded',
  'lender.appetite.observed',
  'lender.outcome.recorded',
  'lender.research.opened',
  'lender.research.advanced',
  'lender.research.promoted',
  // Capital Product Governance Board (5.4). Blueprint 5.4 requires an audit trail on every
  // decision; these are the tenant-chain half of it.
  'governance.provider.submitted',
  'governance.provider.approved',
  'governance.provider.reviewed',
  'governance.provider.flagged',
  'governance.provider.suspended',
  'governance.provider.blacklisted',
  'governance.provider.reinstated',
  'governance.complaint.recorded',
  // Funding Recommendation Engine (5.3), success path.
  'placement.recommended',
  // Client Household / Entity Graph (1.2). The reveal events exist because the question a
  // regulator asks about an encrypted field is not whether it was encrypted but who read it.
  'graph.entity.recorded',
  'graph.owner.recorded',
  'graph.edge.recorded',
  'graph.edge.ended',
  'graph.revenue.stated',
  'graph.primary_entity.set',
  'graph.ssn.revealed',
  'graph.ein.revealed',
  // State-by-State Regulatory Engine (7.2). Activation is the event a regulator asks about:
  // who brought this state online, against which module version, and on whose review.
  'regulatory.module.published',
  'regulatory.state.activated',
  'regulatory.state.withdrawn',
  'regulatory.seed.published',
  'regulatory.law_change.noticed',
  'regulatory.law_change.addressed',
  // Contract & Disclosure Builder (7.3). `contract.generated` carries the content hash, so the
  // Ledger can answer "what did they sign" without trusting the contracts schema.
  'contract.template.published',
  'contract.template.reviewed',
  'contract.clause.published',
  'contract.generated',
  // Pricing, Billing & Offer Management (1.4). The refund events carry the basis, so a declined
  // entitlement is visible to anyone reading the chain rather than only to whoever declined it.
  'billing.offer.published',
  'billing.engagement.started',
  'billing.engagement.cancelled',
  'billing.record.written',
  'billing.credit.applied',
  'billing.refund.paid',
  'billing.refund.declined',
  'billing.funding_outcome.recorded',
  'billing.funding_outcome.funded',
  // Legal Hold & Record Retention (7.5). A refused deletion request is an event because "we
  // received your request and did not act on it" is the fact a data-subject-rights regime asks you
  // to be able to show, and a request that was quietly dropped produces no record at all.
  // Neither the hold's reason nor the client's request text reaches a payload: both are free text
  // about a named person, and the Ledger is the one store here that cannot be corrected.
  'retention.hold.placed',
  'retention.hold.reviewed',
  'retention.hold.released',
  'retention.schedule.recorded',
  'retention.deletion.requested',
  'retention.deletion.approved',
  'retention.deletion.refused',
  'retention.deletion.completed',
  // Funding Outcome Ledger (5.5). `declined` and `withdrawn` are the types that did not exist
  // before this module, and they are the reason it does: a chain carrying only approvals cannot
  // answer what share of attempts were approved. The decline REASON is deliberately not in its
  // payload - it is free text a provider wrote about a named applicant, and the Ledger is the one
  // store here that cannot be corrected. It stays in the attempt row.
  'outcomes.attempt.submitted',
  'outcomes.attempt.approved',
  'outcomes.attempt.declined',
  'outcomes.attempt.withdrawn',
  'outcomes.attempt.funded',
  // Sales Motion & Engagement Tracking (1.3). The attribution events carry both sides of a
  // correction, because a payout dispute asks what changed and who changed it.
  'sales.lead.created',
  'sales.lead.qualified',
  'sales.blueprint.delivered',
  'sales.review_call.scheduled',
  'sales.lead.escalated',
  'sales.attribution.corrected',
  'sales.lead.converted',
  'sales.lead.closed',
  'sales.readiness.recorded',
  // Compliance Evidence Vault (7.1). An export is itself an audit artifact: who took a copy of
  // a client file, when, and why.
  'evidence.file.exported',
  // Communications Hub (4.1) with the Preference Center (4.4). Bodies never reach the
  // Ledger; these carry a hash, so a message can be identified without being quoted.
  'comms.preferences.updated',
  'comms.do_not_call.set',
  'comms.do_not_call.lifted',
  'comms.template.published',
  'comms.message.sent',
  'comms.message.blocked',
  'comms.message.received',
  // Do Not Fund Governance (6.4). Every one of these is a question somebody will be asked to
  // answer under oath: who listed this client, who let one through anyway, and on what basis.
  // `override_granted` and `override_consumed` are separate events because granting an exception
  // and using it are separate acts, and an exception granted and never used is worth seeing.
  'risk.do_not_fund.listed',
  'risk.do_not_fund.reviewed',
  'risk.do_not_fund.removed',
  'risk.do_not_fund.override_granted',
  'risk.do_not_fund.override_consumed',
  // Risk Event Timeline (6.5). Carries the fact and the severity; the summary stays in the
  // observation table, where a person wrote it and a person will read it.
  'risk.observation.recorded',
  // Client Conduct Monitoring (6.3). The summary is free text about a named client and stays in the
  // row; the payload carries the kind, the severity and the response, which is what an audit of
  // "why was this client's service paused" actually asks for. `resolved` carries `upheld` because
  // a dismissed detection is a different fact from one that never happened.
  'risk.conduct.detected',
  'risk.conduct.reviewed',
  'risk.conduct.resolved',
  // Partner & Referrer Portal (8.1) with Training & Certification (8.3). `client_status.viewed`
  // exists because a client who consented to a partner seeing their status is entitled to know
  // when the partner looked - the same reasoning as 1.2's reveal events.
  'partner.registered',
  'partner.qualification.recorded',
  'partner.onboarded',
  'partner.suspended',
  'partner.terminated',
  'partner.module.published',
  'partner.module.completed',
  'partner.claim.approved',
  'partner.claim.withdrawn',
  'partner.brand.approved',
  'partner.brand.revoked',
  'partner.client_status.viewed',
  // Partner Risk Score (8.4). The finding's summary is not in the payload - it is free text about
  // a named partner and often a named client. `resolved` carries `upheld`, because a dismissed
  // finding is a different fact from one that never happened, and a run of dismissed complaints
  // about one partner is itself a signal.
  'partner.finding.recorded',
  'partner.finding.resolved',
  // Partner Agreement & Payout Center (8.2). The payout payload carries the STATES a period drew
  // on and never the clients - a jurisdiction is not PII and a client list is. `computed` and
  // `approved` are separate because the computation is unattended and the approval is the only
  // point a person sees the figure; an audit asking "who authorised this money" needs the second
  // one to be its own row. `declined` exists for ADR-0041's reason: a payout somebody refused to
  // approve is a thing that happened, and inferring it from the absence of an approval loses who
  // decided and why.
  // Risk & Defense Alerts (6.1). The tier and whether it freezes funding travel; the summary does
  // not, because it is free text about a named client. `acknowledged` is its own type because
  // acknowledging is not resolving, and an audit asking "who looked at this and when" is a
  // different question from "who decided it was over".
  // Cost & Performance Governance (11.9). Source and provenance travel; the vendor reference does
  // not, because a model version is a procurement detail and this is a per-client ledger.
  'admin.cost.recorded',
  // Cross-Portfolio Opportunity Engine (10.2). No clientId on any of these: they travel to a
  // portfolio-level reader and principle 5 gives Gardner PII-stripped aggregates. `routed` carries
  // `consentVerifiedAt` because the whole control is that consent was read AT that moment, and
  // `routing_refused` is a row for the same reason a decline is (ADR-0041).
  'interventure.opportunity.detected',
  'interventure.opportunity.gardner_approved',
  'interventure.opportunity.gardner_declined',
  'interventure.opportunity.routed',
  'interventure.opportunity.routing_refused',
  'risk.alert.raised',
  'risk.alert.acknowledged',
  'risk.alert.resolved',
  'partner.agreement.drafted',
  'partner.agreement.activated',
  'partner.payout.computed',
  'partner.payout.approved',
  'partner.payout.declined',
  'partner.payout.clawback_recorded',
  // Call Recording & Promise Tracking (4.3). `recording.refused` is an event because "we wanted
  // to record this call and the client's state would not let us" is evidence, the same way a
  // blocked send is. No transcript text reaches the Ledger; excerpts stay in the obligation row.
  'calls.recording.started',
  'calls.recording.refused',
  'calls.transcript.attached',
  'calls.analysed',
  'calls.promise.detected',
  'calls.promise.corrected',
  'calls.promise.dismissed',
  // Marketing Ops (4.5). A claim proposal is the intake 7.4 never had; the approve event carries
  // the claim id it became, so the Library entry and the review that produced it are linked.
  'marketing.campaign.created',
  'marketing.campaign.activated',
  'marketing.asset.created',
  'marketing.asset.submitted',
  'marketing.asset.approved',
  'marketing.asset.rejected',
  'marketing.claim.proposed',
  'marketing.claim.approved',
  'marketing.claim.rejected',
  'marketing.experiment.created',
  'marketing.variant.registered',
  'marketing.experiment.started',
  'marketing.experiment.concluded',
  // Inter-Venture Commerce Hooks (10.1). Every one of these is a related-party fact an auditor
  // asks about: who tagged this sibling, who acknowledged the conflict, who approved a price that
  // was not the published one, and what personal information moved to Collingswood.
  'interventure.venture.tagged',
  'interventure.disclosure.generated',
  'interventure.disclosure.acknowledged',
  'interventure.disclosure.withdrawn',
  'interventure.pricing.deviation_approved',
  'interventure.handoff.proposed',
  'interventure.handoff.consented',
  'interventure.handoff.transferred',
  'interventure.handoff.declined',
  'interventure.invoice.raised',
  'interventure.invoice.routing_attempted',
  // Admin Configuration Center (11.7). Blueprint 11.7 asks for an audit trail on every change;
  // these are the tenant-chain half of it. A staged change is its own type, so a reader can tell
  // "somebody proposed this" from "this is in force".
  'admin.configuration.staged',
  'admin.configuration.changed',
  // Data Warehouse (11.6). A capture is an event because the series is only trustworthy if the
  // gaps in it are visible, and a missing snapshot is a missing event.
  'warehouse.snapshot.captured',
  // Client portal identity (11.1 for 11.10). Failures are events because a run of them against one
  // client file is the signal that matters, and it is invisible if only successes are recorded.
  'identity.client_user.invited',
  'identity.client_user.enrolled',
  'identity.client_user.signed_in',
  'identity.client_user.sign_in_failed',
  'identity.client_user.sign_in_blocked',
  'identity.client_user.disabled',
  // Password reset. Requested and issued are separate types because they are separate acts: one is
  // an anonymous person typing an address into a form, the other a named human deciding that the
  // caller on the phone is who they said. Reading them as one would hide which.
  'identity.client_user.password_reset_requested',
  'identity.client_user.password_reset_issued',
  'identity.client_user.password_reset_completed',
  // Changing a password you still know is a different act from recovering one you have
  // lost, and reading them as one would hide which happened.
  'identity.client_user.password_changed',
  // Moving the address is the strongest of the three: it changes where recovery GOES, so
  // the request and the move are separate events and both name the address.
  'identity.client_user.email_change_requested',
  'identity.client_user.email_changed',
  // Multi-factor. A failed challenge and a spent recovery code are both recorded because a run of
  // either against one account is the signal, and neither is visible from a successful sign-in.
  'identity.client_user.mfa_enrolled',
  'identity.client_user.mfa_removed',
  'identity.client_user.mfa_challenge_failed',
  'identity.client_user.mfa_recovery_code_used',
  // Switching password sign-in off is the strongest thing a client can do to protect their own
  // account, and switching it back on is the strongest thing anybody can do to weaken it. Two
  // types, because reading them as one would hide which happened.
  'identity.client_user.password_sign_in_disabled',
  'identity.client_user.password_sign_in_enabled',
  // Removing the password outright is a further step than switching it off, and restoring one is
  // the only route back. Separate types because the states they describe are different.
  'identity.client_user.password_removed',
  'identity.client_user.password_restored',
  'identity.client_session.revoked',

  // Staff credentials for the internal Console. An Actor with no credential row cannot sign in.
  'identity.staff.invited',
  'identity.staff.enrolment_started',
  'identity.staff.enrolled',
  'identity.staff.signed_in',
  'identity.staff.sign_in_failed',
  'identity.staff.sign_in_blocked',
  'identity.staff.disabled',
  'identity.staff_session.revoked',
  // Staff security keys. Registering one changes what an account can do; removing one changes what
  // it can still do afterwards, and on a passkey-only account that is the difference between
  // working tomorrow and a telephone call.
  'identity.staff.key_registered',
  'identity.staff.key_removed',
  // Turning password sign-in off is the strongest thing a staff member can do to protect an account
  // that opens every client file in the firm; restoring it is the strongest thing a colleague can do
  // to weaken one. Two types, because reading them as one would hide which happened - the same
  // reasoning the client pair above records.
  'identity.staff.password_sign_in_disabled',
  'identity.staff.password_sign_in_restored',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const isEventType = (value: unknown): value is EventType =>
  typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);

/**
 * Who acted. Every event has an actor; there are no anonymous state changes.
 *
 * `client` was added with the Client Portal's authentication. A client uploading a statement and a
 * staff member uploading one on their behalf are DIFFERENT ACTS, and recording both as `human`
 * would blur exactly the line `sign_for_client` - a Level 4 prohibited action - is drawn along.
 *
 * A `client` actor is never an `Actor` row and holds no authority level. See ADR-0021.
 */
export interface EventActor {
  readonly id: string;
  readonly kind: 'village_agent' | 'human' | 'client';
}

/**
 * An event as submitted for append. The Ledger assigns `seq`, `createdAt`, `prevHash`
 * and `signature` - a caller cannot set them, which is what makes the chain meaningful.
 */
export interface LedgerEventInput {
  readonly tenantId: string;
  readonly type: EventType;
  readonly actor: EventActor;
  readonly clientId?: string;
  readonly correlationId?: string;
  /** Must be PII-free. The Ledger redacts defensively and asserts before writing. */
  readonly payload: Record<string, unknown>;
}

/** An event as stored. Immutable. */
export interface LedgerEvent extends LedgerEventInput {
  readonly id: string;
  readonly seq: number;
  readonly createdAt: Date;
  readonly prevHash: string;
  readonly signature: string;
}

/** Typed payload shapes for the events this slice writes. */
export interface ComplianceStateChangedPayload extends Record<string, unknown> {
  readonly from: ComplianceState;
  readonly to: ComplianceState;
  readonly reason: string;
  readonly findingCodes: readonly string[];
}

export interface PlacementRefusedPayload extends Record<string, unknown> {
  readonly reason: string;
  readonly principle: string;
  readonly complianceState: ComplianceState;
  readonly firewallState: 'clear' | 'triggered';
}

export interface AuthorityActionBlockedPayload extends Record<string, unknown> {
  readonly action: string;
  readonly actorLevel: number | null;
  readonly requiredLevel: number | null;
  readonly prohibited: boolean;
}
