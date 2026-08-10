/**
 * Which ledger events are risk-relevant, and how serious each one is - blueprint 6.5.
 *
 * A table, not a function body. The list of what counts as a risk event is a judgement the
 * Compliance Review Board should be able to read and argue with, and a chain of `if` statements
 * spread across a switch is not something anybody reviews.
 *
 * Pure and exported so the classification can be tested without a database, and so a reviewer can
 * see the whole vocabulary at once rather than discovering it one event at a time.
 *
 * Severity is CATEGORICAL, per Decision E's reasoning applied here. A numeric risk score would
 * invite arithmetic - averaging a fraud indicator with a late document into something "moderate" -
 * and the average of a serious event and a trivial one describes neither.
 */

import type { EventType } from '@bwc/core';

/**
 * How serious, ordered worst first.
 *
 *   `critical`  something the company acted on, or should have: fraud, a Do Not Fund listing
 *   `serious`   a refusal, a block, a failed compliance state
 *   `notable`   a change worth seeing in sequence: a state transition, a new debt, a freeze
 *   `context`   not itself a risk, but the timeline is unreadable without it
 */
export const SEVERITIES = ['critical', 'serious', 'notable', 'context'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

/** The worst of a set, or `null` for an empty one. Never an average - see the header. */
export const worstSeverity = (severities: readonly Severity[]): Severity | null =>
  severities.length === 0
    ? null
    : (severities.reduce((worst, next) =>
        severityRank(next) < severityRank(worst) ? next : worst,
      ) as Severity);

export interface RiskClassification {
  readonly severity: Severity;
  /** What this event means on a risk timeline, in a sentence a reviewer can read. */
  readonly meaning: string;
}

/**
 * The classification table.
 *
 * An event type absent from this map is not a risk event. That is a deliberate default: the
 * Ledger carries every state change in the system, and a timeline that included all of them would
 * bury the four events that matter under four hundred that do not.
 */
export const RISK_EVENT_CLASSIFICATION: Readonly<Partial<Record<EventType, RiskClassification>>> = {
  // Do Not Fund (6.4) - the most consequential determination the company makes about a client.
  'risk.do_not_fund.listed': {
    severity: 'critical',
    meaning: 'The client was placed on the Do Not Fund list.',
  },
  'risk.do_not_fund.override_granted': {
    severity: 'critical',
    meaning: 'A single-use exception to the Do Not Fund listing was approved by a Level 3 human.',
  },
  'risk.do_not_fund.override_consumed': {
    severity: 'critical',
    meaning: 'A Do Not Fund exception was used. The listing remained in force afterwards.',
  },
  'risk.do_not_fund.removed': {
    severity: 'serious',
    meaning: 'The Do Not Fund listing was removed by a Level 3 human.',
  },
  'risk.do_not_fund.reviewed': {
    severity: 'notable',
    meaning: 'The Do Not Fund listing was reviewed and left in force.',
  },
  'risk.observation.recorded': {
    severity: 'serious',
    meaning:
      'A risk observation was recorded by a person - see the observation for its own severity.',
  },

  // Funding Ethics Firewall (6.2).
  'firewall.triggered': {
    severity: 'critical',
    meaning: 'The Funding Ethics Firewall froze placement for this client.',
  },
  'firewall.cleared': {
    severity: 'serious',
    meaning: 'The Firewall was cleared with human approval.',
  },

  // Compliance (1.1, Decision E). The transition is where a Fail becomes visible.
  'client.compliance_state_changed': {
    severity: 'notable',
    meaning: 'The client moved between compliance states.',
  },

  // Placement (5.3). A refusal is a risk event; so is a recommendation, as the context that
  // explains what the refusals were about.
  'placement.refused': {
    severity: 'serious',
    meaning: 'A placement was refused at the gate before reaching a capital provider.',
  },
  'placement.recommended': {
    severity: 'context',
    meaning: 'A funding recommendation was produced.',
  },

  // Authority (2.1). An agent reaching past its level is a risk event about the system, recorded
  // on the client's timeline because that is where the consequence would have landed.
  'authority.action_blocked': {
    severity: 'serious',
    meaning: 'An actor attempted something above its authority level, or on the prohibited list.',
  },

  // Consent (1.5). A revocation is the one a regulator asks about.
  'consent.revoked': {
    severity: 'serious',
    meaning: 'The client revoked an authorization they had previously signed.',
  },
  'consent.granted': {
    severity: 'context',
    meaning: 'The client signed an authorization.',
  },

  // Compliance scanner (4.2) and the claim library (7.4).
  'scanner.blocked_content': {
    severity: 'serious',
    meaning: 'Content intended for this client was blocked for banned language.',
  },
  'comms.message.blocked': {
    severity: 'notable',
    meaning: 'An attempt to contact the client was blocked.',
  },
  'comms.do_not_call.set': {
    severity: 'notable',
    meaning: 'The client asked not to be called, and the instruction is in force.',
  },

  // Document intelligence (3.3). A finding raised against a client's own documents is the
  // earliest signal the company gets that something does not add up.
  'intelligence.finding_raised': {
    severity: 'serious',
    meaning: 'A finding was raised against a document the client provided.',
  },

  // Vault (3.2). A refused access attempt is a risk event about the file, not the client - it is
  // here because a reviewer asking "who tried to read this" should not need a second timeline.
  'vault.access_refused': {
    severity: 'notable',
    meaning: 'Someone was refused access to a document in this client file.',
  },
  'vault.legal_hold_set': {
    severity: 'notable',
    meaning: 'A legal hold was placed on this client file.',
  },

  // Billing (1.4). A declined refund entitlement is the one that produces complaints.
  'billing.refund.declined': {
    severity: 'serious',
    meaning: 'A refund entitlement was declined, with the basis recorded.',
  },
  'billing.refund.paid': {
    severity: 'notable',
    meaning: 'A refund was paid to the client against a recorded entitlement.',
  },
  'billing.funding_outcome.recorded': {
    severity: 'context',
    meaning: 'A funding outcome was recorded against an engagement.',
  },

  // Governance (5.4). A complaint against a provider this client was placed with.
  'governance.complaint.recorded': {
    severity: 'serious',
    meaning: 'A complaint was recorded against a capital provider.',
  },

  // Graph (1.2). Reading an encrypted identifier is the event a regulator asks about.
  'graph.ssn.revealed': {
    severity: 'notable',
    meaning: 'An encrypted Social Security Number was decrypted and read.',
  },
  'graph.ein.revealed': {
    severity: 'context',
    meaning: 'An encrypted EIN was decrypted and read.',
  },
};

export const isRiskEvent = (type: string): boolean =>
  Object.prototype.hasOwnProperty.call(RISK_EVENT_CLASSIFICATION, type);

export const classify = (type: string): RiskClassification | null =>
  RISK_EVENT_CLASSIFICATION[type as EventType] ?? null;

/**
 * Risk facts named in blueprint 6.5 that nothing in this system produces yet.
 *
 * Carried alongside the timeline rather than left out, for 7.1's reason: a risk profile that is
 * silent about missed payments reads as a client with no missed payments. The distinction between
 * "none happened" and "nothing watches for them" is the whole value of saying so.
 *
 * Each names the integration that would produce it, so the gap points somewhere.
 */
export const UNPRODUCED_RISK_SOURCES: readonly {
  readonly fact: string;
  readonly awaiting: string;
}[] = [
  {
    fact: 'Missed payments',
    awaiting: 'Plaid transaction monitoring (11.5), pending security review',
  },
  { fact: 'NSF events', awaiting: 'Plaid transaction monitoring (11.5), pending security review' },
  { fact: 'Utilization changes', awaiting: 'Issuer / bureau monitoring (5.1, 11.5)' },
  { fact: 'Credit line decreases', awaiting: 'Issuer / bureau monitoring (5.1, 11.5)' },
  { fact: 'Adverse action notices', awaiting: 'Capital provider integrations (11.5)' },
  {
    fact: 'Disputes and fraud alerts',
    awaiting: 'Bureau integrations (11.5); record manually meanwhile',
  },
  { fact: 'Client complaints', awaiting: '6.3 Client Conduct Monitoring (V1.5)' },
];
