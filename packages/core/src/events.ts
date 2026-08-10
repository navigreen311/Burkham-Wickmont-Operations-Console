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
