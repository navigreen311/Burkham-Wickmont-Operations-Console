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
  // Tenant isolation (11.2)
  'tenancy.cross_tenant_access_blocked',
  // Workflow Engine (2.2) - Decision C. The Engine writes these and listens for others.
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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const isEventType = (value: unknown): value is EventType =>
  typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);

/** Who acted. Every event has an actor; there are no anonymous state changes. */
export interface EventActor {
  readonly id: string;
  readonly kind: 'village_agent' | 'human';
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
