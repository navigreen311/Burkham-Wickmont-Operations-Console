/**
 * @bwc/firewall - 6.2 Funding Ethics Firewall.
 *
 * Design principle 7: the Firewall and Do Not Fund Governance have precedence over all
 * placement-related modules. When either fires, downstream placement workflows freeze. Only
 * Compliance & Evidence with human approval can unfreeze.
 *
 * Decision E couples the Firewall to compliance state:
 *   - `fail`         auto-triggers the Firewall
 *   - `needs_review` freezes placement pending human resolution, without itself triggering
 *
 * `evaluate` therefore reads both and returns a single answer, because a caller that checked
 * only one of them would be checking half the gate.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import {
  autoTriggersFirewall,
  ok,
  permitsPlacement,
  refused,
  requiresHumanReview,
  type ComplianceState,
  type EventActor,
  type Outcome,
} from '@bwc/core';

export type FirewallState = 'clear' | 'triggered';

export interface FirewallStatus {
  readonly clientId: string;
  readonly state: FirewallState;
  readonly reason: string | null;
}

export const status = async (clientId: string): Promise<FirewallStatus> => {
  const row = await db().clientFirewallState.findUnique({ where: { clientId } });
  return row
    ? { clientId, state: row.state, reason: row.reason }
    : { clientId, state: 'clear', reason: null };
};

export const trigger = async (
  tenantId: string,
  clientId: string,
  reason: string,
  actor: EventActor,
): Promise<FirewallStatus> => {
  await db().clientFirewallState.upsert({
    where: { clientId },
    create: { clientId, tenantId, state: 'triggered', reason },
    update: { state: 'triggered', reason },
  });

  await append({
    tenantId,
    type: 'firewall.triggered',
    actor,
    clientId,
    payload: { reason },
  });

  return { clientId, state: 'triggered', reason };
};

/**
 * Clear the Firewall. Requires a human actor: principle 7 states that only Compliance &
 * Evidence with human approval can unfreeze, so an agent clearing its own block would
 * defeat the control entirely.
 */
export const clear = async (
  tenantId: string,
  clientId: string,
  justification: string,
  actor: EventActor,
): Promise<Outcome<FirewallStatus>> => {
  if (actor.kind !== 'human') {
    return refused(
      'Only a human actor may clear the Funding Ethics Firewall.',
      'Principle 7 - firewall precedence; unfreeze requires human approval',
    );
  }

  await db().clientFirewallState.upsert({
    where: { clientId },
    create: { clientId, tenantId, state: 'clear', reason: justification },
    update: { state: 'clear', reason: justification },
  });

  await append({
    tenantId,
    type: 'firewall.cleared',
    actor,
    clientId,
    payload: { justification },
  });

  return ok({ clientId, state: 'clear', reason: justification });
};

export interface PlacementGate {
  readonly complianceState: ComplianceState;
  readonly firewallState: FirewallState;
}

/**
 * The placement gate. Both halves must pass.
 *
 * Firewall is checked first because it has precedence: a triggered Firewall refuses even a
 * client sitting at `pass`, and reporting the compliance reason there would misdescribe why.
 */
export const evaluate = async (
  clientId: string,
  complianceState: ComplianceState,
): Promise<Outcome<PlacementGate>> => {
  const firewall = await status(clientId);

  if (firewall.state === 'triggered') {
    return refused(
      `Funding Ethics Firewall is triggered for this client${firewall.reason ? `: ${firewall.reason}` : ''}. Placement workflows are frozen until Compliance & Evidence clears it with human approval.`,
      'Principle 7 - firewall precedence over all placement modules',
    );
  }

  if (autoTriggersFirewall(complianceState)) {
    return refused(
      'Compliance state is Fail. Placement is blocked and the client routes to Do Not Fund Governance.',
      'Decision E - Fail auto-triggers the Firewall (blueprint 6.2, 6.4)',
    );
  }

  if (requiresHumanReview(complianceState)) {
    return refused(
      'Compliance state is Needs Review. Placement is frozen pending human resolution in the Human Approval Console.',
      'Decision E - Needs Review freezes placement (blueprint 2.4)',
    );
  }

  if (!permitsPlacement(complianceState)) {
    return refused(
      `Compliance state is ${complianceState}. Placement requires Pass or Pass with Findings.`,
      'Decision E - placement requires an assessed, passing compliance state',
    );
  }

  return ok({ complianceState, firewallState: firewall.state });
};
