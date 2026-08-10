/**
 * @bwc/middleware - the fixed seven-step chain. Specification v2 section 5.5.
 *
 *   1. Authentication   - verify caller identity (Identity & Access)
 *   2. Tenant scope     - verify caller belongs to the tenant being operated on
 *   3. Authority Level  - verify the action is within the actor's level
 *   4. Firewall         - Firewall clear AND compliance state Pass / Pass with Findings
 *   5. Regulatory       - state-specific compliance requirements
 *   6. Event emission   - log the action to the Event Ledger
 *   7. Compliance scan  - Communication Compliance Scanner on client-facing content
 *
 * "Failure at any step blocks the action and logs the failure. Uniform across all modules."
 *
 * The order is not configurable and the steps are not exported individually. A route that
 * could reorder them could put the event emission before the authority check, and the first
 * thing anyone would notice is a ledger that disagrees with what actually happened.
 *
 * Steps 4-7 are skipped for actions that declare no client and no client-facing content -
 * skipped explicitly and reported in the trace, never silently.
 */

import { append } from '@bwc/ledger';
import { decideAuthority, findActor, type Actor } from '@bwc/identity';
import { assertSameTenant } from '@bwc/tenancy';
import { find as findClient } from '@bwc/clients';
import { evaluate as evaluateGate } from '@bwc/firewall';
import {
  failed,
  isProhibitedAction,
  notBuilt,
  ok,
  refused,
  type AuthorityActionBlockedPayload,
  type EventType,
  type Outcome,
} from '@bwc/core';

export const MIDDLEWARE_STEPS = [
  'authentication',
  'tenant_scope',
  'authority_level',
  'firewall',
  'regulatory',
  'event_emission',
  'compliance_scan',
] as const;

export type MiddlewareStep = (typeof MIDDLEWARE_STEPS)[number];

export type StepOutcome = 'passed' | 'skipped' | 'blocked';

export interface StepTrace {
  readonly step: MiddlewareStep;
  readonly outcome: StepOutcome;
  readonly detail?: string;
}

export interface ChainRequest {
  readonly actorId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly clientId?: string;
  /** The ledger event this action writes if it is permitted to proceed. */
  readonly eventType: EventType;
  readonly eventPayload?: Record<string, unknown>;
  /** Outbound client-facing text, if any. Triggers step 7. */
  readonly clientFacingContent?: string;
  readonly correlationId?: string;
}

export interface ChainResult {
  readonly actor: Actor;
  readonly trace: readonly StepTrace[];
}

/**
 * The trace is returned on the refusal path too, via `lastTrace`, because "which step
 * blocked this" is the first question anyone asks and reconstructing it from logs is
 * exactly the kind of adjacent-signal reading that goes wrong.
 */
export interface ChainRefusal {
  readonly outcome: Outcome<never>;
  readonly trace: readonly StepTrace[];
}

export class ChainBlocked extends Error {
  constructor(
    readonly refusal: ChainRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ChainBlocked';
  }
}

/**
 * Run the chain. Returns `ok` with the trace when every step passed or was explicitly
 * skipped; returns the blocking step's own refusal otherwise, unchanged - a refusal is
 * never reworded on the way up, because the reason is the useful part.
 */
export const chain = async (
  request: ChainRequest,
): Promise<{ result: Outcome<ChainResult>; trace: readonly StepTrace[] }> => {
  const trace: StepTrace[] = [];
  const blockAt = (
    step: MiddlewareStep,
    outcome: Outcome<never>,
    detail: string,
  ): { result: Outcome<ChainResult>; trace: readonly StepTrace[] } => {
    trace.push({ step, outcome: 'blocked', detail });
    return { result: outcome, trace };
  };

  // --- 1. Authentication --------------------------------------------------
  const actor = await findActor(request.actorId);
  if (!actor) {
    return blockAt(
      'authentication',
      refused('Unknown actor.', 'Specification v2 section 5.5 step 1 - authentication'),
      'actor not found',
    );
  }
  trace.push({ step: 'authentication', outcome: 'passed', detail: actor.label });

  // --- 2. Tenant scope ----------------------------------------------------
  const tenantScope = assertSameTenant(actor.tenantId, request.tenantId);
  if (tenantScope.status !== 'ok') {
    // Logged to the actor's own tenant: the target tenant must not gain a record of
    // an outsider's attempt, and the actor's tenant is where the accountability sits.
    await append({
      tenantId: actor.tenantId,
      type: 'tenancy.cross_tenant_access_blocked',
      actor: { id: actor.id, kind: actor.kind },
      payload: { action: request.action, attemptedTenantId: request.tenantId },
    });
    return blockAt('tenant_scope', tenantScope, 'cross-tenant access blocked');
  }
  trace.push({ step: 'tenant_scope', outcome: 'passed' });

  // --- 3. Authority Level -------------------------------------------------
  const authority = decideAuthority(actor, request.action);
  if (authority.status !== 'ok') {
    const payload: AuthorityActionBlockedPayload = {
      action: request.action,
      actorLevel: actor.authorityLevel,
      requiredLevel: null,
      prohibited: isProhibitedAction(request.action),
    };
    await append({
      tenantId: request.tenantId,
      type: 'authority.action_blocked',
      actor: { id: actor.id, kind: actor.kind },
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
      payload,
    });
    return blockAt('authority_level', authority, request.action);
  }
  trace.push({
    step: 'authority_level',
    outcome: 'passed',
    detail: `level ${actor.authorityLevel} >= ${authority.value.requiredLevel}`,
  });

  // --- 4. Firewall + compliance state -------------------------------------
  if (request.clientId === undefined) {
    trace.push({ step: 'firewall', outcome: 'skipped', detail: 'no client in scope' });
  } else {
    const client = await findClient(request.tenantId, request.clientId);
    if (client.status !== 'ok') {
      return blockAt('firewall', client as Outcome<never>, 'client not resolvable');
    }

    const gate = await evaluateGate(request.clientId, client.value.complianceState);
    if (gate.status !== 'ok') {
      await append({
        tenantId: request.tenantId,
        type: 'placement.refused',
        actor: { id: actor.id, kind: actor.kind },
        clientId: request.clientId,
        payload: {
          action: request.action,
          reason: gate.status === 'refused' ? gate.reason : 'gate evaluation failed',
          principle: gate.status === 'refused' ? gate.principle : 'unknown',
          complianceState: client.value.complianceState,
        },
      });
      return blockAt('firewall', gate as Outcome<never>, 'placement gate refused');
    }
    trace.push({
      step: 'firewall',
      outcome: 'passed',
      detail: `${gate.value.firewallState} / ${gate.value.complianceState}`,
    });
  }

  // --- 5. Regulatory ------------------------------------------------------
  // 7.2 State-by-State Regulatory Engine is not built. Reporting `not_built` here rather
  // than passing silently: a pass would assert that state compliance was checked, and no
  // client-facing action may fire without that check (principle 6). The step is wired and
  // honest about being empty, which is the distinction principle 9 exists to preserve.
  if (request.clientFacingContent === undefined) {
    trace.push({
      step: 'regulatory',
      outcome: 'skipped',
      detail: 'no client-facing action in scope',
    });
  } else {
    return blockAt(
      'regulatory',
      notBuilt(
        '7.2 State-by-State Regulatory Engine',
        'State compliance cannot be verified because the Regulatory Engine is not built. Principle 6 gates client-facing actions on this check, so the action is refused rather than allowed through unchecked.',
      ) as Outcome<never>,
      'regulatory engine not built',
    );
  }

  // --- 6. Event emission --------------------------------------------------
  try {
    await append({
      tenantId: request.tenantId,
      type: request.eventType,
      actor: { id: actor.id, kind: actor.kind },
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
      payload: request.eventPayload ?? { action: request.action },
    });
    trace.push({ step: 'event_emission', outcome: 'passed', detail: request.eventType });
  } catch (error) {
    return blockAt(
      'event_emission',
      failed(
        'Could not write to the Event Ledger; the action is blocked.',
        error instanceof Error ? error.message : String(error),
      ) as Outcome<never>,
      'ledger append failed',
    );
  }

  // --- 7. Compliance scan -------------------------------------------------
  // 4.2 Communication Compliance Scanner is not built. Unreachable while step 5 refuses
  // every client-facing action, and retained so the order stays visible and the step has
  // somewhere to land when the Scanner is built.
  trace.push({
    step: 'compliance_scan',
    outcome: 'skipped',
    detail: 'no client-facing content in scope',
  });

  return { result: ok({ actor, trace }), trace };
};
