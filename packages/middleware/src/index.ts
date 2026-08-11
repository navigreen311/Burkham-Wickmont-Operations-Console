/**
 * @bwc/middleware - the fixed seven-step chain. Specification v2 section 5.5.
 *
 *   1. Authentication   - verify caller identity (Identity & Access)
 *   2. Tenant scope     - verify caller belongs to the tenant being operated on
 *   3. Authority Level  - verify the action is within the actor's level
 *   4. Firewall         - Do Not Fund clear, Firewall clear, AND compliance state Pass /
 *                         Pass with Findings
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
 *
 * Every step now performs a real check. Step 5 was the last to report `not_built`, and with the
 * Regulatory Engine (7.2) built there is no step in this chain that reports a capability as
 * missing - which is why `notBuilt` is no longer imported here. Ungated vendors still report it,
 * from `@bwc/integration`, and that is the remaining honest use of the status.
 */

import { append } from '@bwc/ledger';
import { decideAuthority, findActor, type Actor } from '@bwc/identity';
import { assertSameTenant } from '@bwc/tenancy';
import { find as findClient } from '@bwc/clients';
import { evaluate as evaluateGate } from '@bwc/firewall';
import { checkConduct, checkDoNotFund } from '@bwc/risk';
import { checkJurisdiction, type RegulatoryClearance } from '@bwc/regulatory';
import { scanForTenant } from '@bwc/scanner';
import {
  failed,
  isGovernanceAction,
  isProhibitedAction,
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
  /** Outbound client-facing text, if any. Triggers steps 5 and 7. */
  readonly clientFacingContent?: string;
  /**
   * Two-letter state code governing this action. Required alongside client-facing content:
   * step 5 refuses without it, because "we could not tell which state" and "no state rule
   * applies" are different statements and only one of them is a check.
   */
  readonly jurisdiction?: string;
  /** Narrows the required disclosures to one product. */
  readonly productKind?: string;
  /** When present, step 5 also confirms the Governance Board permits it in this state. */
  readonly providerId?: string;
  readonly correlationId?: string;
}

export interface ChainResult {
  readonly actor: Actor;
  readonly trace: readonly StepTrace[];
  /**
   * What step 5 cleared, when a client-facing action was in scope. Carries the disclosures the
   * jurisdiction obliges, so the caller attaches them from the same check that permitted the
   * action rather than from a second lookup that could disagree with it.
   */
  readonly clearance?: RegulatoryClearance;
  /**
   * Set when the client is on the Do Not Fund list and an unspent single-use override permitted
   * this action. The caller MUST call `consumeOverride` if it proceeds - the chain deliberately
   * does not spend it, because a caller that checks and then abandons the action for an unrelated
   * reason would otherwise have burned an exception a Level 3 human granted.
   */
  readonly doNotFundOverrideId?: string;
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
  // Declared here rather than at step 4 because the result carries it out of the chain.
  let doNotFundOverrideId: string | undefined;
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
  } else if (isGovernanceAction(request.action)) {
    // **The gate must not block the act of clearing the gate.** This step refuses a client in
    // `fail`, in `needs_review`, on the Do Not Fund list, or behind a triggered Firewall - which
    // is right for acting FOR a client and a one-way door for recording a determination ABOUT
    // one. A client in `fail` could never be moved back to `pass`; a new client could never be
    // assessed at all.
    //
    // Skipped rather than passed, and the reason travels in the trace, because a step that says
    // `passed` here would be claiming a check ran.
    trace.push({
      step: 'firewall',
      outcome: 'skipped',
      detail:
        'governance action: this records a determination about the client, so the gate it would clear does not gate it',
    });
  } else {
    const client = await findClient(request.tenantId, request.clientId);
    if (client.status !== 'ok') {
      return blockAt('firewall', client as Outcome<never>, 'client not resolvable');
    }

    // Do Not Fund is checked first, and the precedence is about which true statement to lead
    // with. A triggered Firewall is a condition somebody expects to clear; a Do Not Fund listing
    // is a standing determination that this client should not receive further capital. Reporting
    // the Firewall when the real answer is "we decided in March not to fund this client" sends
    // the operator to resolve the wrong thing.
    const doNotFund = await checkDoNotFund(request.tenantId, request.clientId, request.action);
    if (doNotFund.status !== 'ok') {
      await append({
        tenantId: request.tenantId,
        type: 'placement.refused',
        actor: { id: actor.id, kind: actor.kind },
        clientId: request.clientId,
        payload: {
          action: request.action,
          reason: doNotFund.status === 'refused' ? doNotFund.reason : 'do not fund check failed',
          principle: doNotFund.status === 'refused' ? doNotFund.principle : 'unknown',
          complianceState: client.value.complianceState,
        },
      });
      return blockAt('firewall', doNotFund as Outcome<never>, 'do not fund listing');
    }
    if (doNotFund.value.overrideId !== null) {
      doNotFundOverrideId = doNotFund.value.overrideId;
    }

    // 6.3's conduct pause, checked after Do Not Fund and before the Firewall, on the same
    // "which true statement to lead with" reasoning. A Do Not Fund listing is a standing
    // determination not to fund this client; a conduct pause is "we are looking into something
    // and service is stopped meanwhile". Reporting the pause when the listing is what is really in
    // force would send the operator to resolve the smaller thing.
    //
    // The check is here rather than beside here because an assessment nothing consults is a report
    // rather than a control - 6.3 would compute `service_pause` for a client who applied for
    // capital behind our back while frozen, and that client would go on being placed. Third
    // instance of ADR-0034's defect closed in this batch.
    const conduct = await checkConduct(request.tenantId, request.clientId, request.action);
    if (conduct.status !== 'ok') {
      await append({
        tenantId: request.tenantId,
        type: 'placement.refused',
        actor: { id: actor.id, kind: actor.kind },
        clientId: request.clientId,
        payload: {
          action: request.action,
          reason: conduct.status === 'refused' ? conduct.reason : 'conduct check failed',
          principle: conduct.status === 'refused' ? conduct.principle : 'unknown',
          complianceState: client.value.complianceState,
        },
      });
      return blockAt('firewall', conduct as Outcome<never>, 'conduct service pause');
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
      detail: `${gate.value.firewallState} / ${gate.value.complianceState}${doNotFund.value.listed ? `; do not fund listing in force (${doNotFundOverrideId !== undefined ? 'single-use override approved' : 'action permitted while listed'})` : ''}${conduct.value.paused ? `; conduct service pause in force (${conduct.value.response}), action permitted while paused` : ''}`,
    });
  }

  // --- 5. Regulatory ------------------------------------------------------
  // 7.2 State-by-State Regulatory Engine. This step used to report `not_built`; the engine now
  // exists, so it performs the check the specification demands: "no client-facing action fires
  // without state compliance checks having passed."
  //
  // The jurisdiction arrives as a value rather than being resolved here. The chain could reach
  // into the Entity Graph for it, and that would put this gate downstream of the lender
  // catalogue - `@bwc/graph` depends on `@bwc/lenders` - which is the wrong direction for the
  // module that decides whether anything may happen at all. Forgetting to pass one is safe: it
  // produces a refusal naming what to pass, not a silent pass.
  let clearance: RegulatoryClearance | undefined;

  if (request.clientFacingContent === undefined) {
    trace.push({
      step: 'regulatory',
      outcome: 'skipped',
      detail: 'no client-facing action in scope',
    });
  } else {
    const checked = await checkJurisdiction({
      tenantId: request.tenantId,
      state: request.jurisdiction ?? null,
      ...(request.productKind !== undefined ? { productKind: request.productKind } : {}),
      ...(request.providerId !== undefined ? { providerId: request.providerId } : {}),
    });

    if (checked.status !== 'ok') {
      return blockAt(
        'regulatory',
        checked as Outcome<never>,
        checked.status === 'refused' ? checked.reason : 'state compliance check did not succeed',
      );
    }

    clearance = checked.value;
    trace.push({
      step: 'regulatory',
      outcome: 'passed',
      detail: `${clearance.state} active at module version ${clearance.standing.currentVersion ?? 0}; ${clearance.requiredDisclosures.length} disclosure(s) required`,
    });
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
  //
  // This step was a no-op for longer than it should have been. Its comment said the Scanner was
  // not built and the step "unreachable while step 5 refuses every client-facing action" - true
  // when written, and false from the moment 7.2 made step 5 pass for an activated state. Nothing
  // failed: the step reported `skipped` with the detail "no client-facing content in scope" even
  // when there was content, which is precisely the shape of a guard that looks fine.
  //
  // Found by a Communications Hub test that sent a banned phrase to a client and watched it go.
  if (request.clientFacingContent === undefined) {
    trace.push({
      step: 'compliance_scan',
      outcome: 'skipped',
      detail: 'no client-facing content in scope',
    });
  } else {
    const scan = await scanForTenant({
      tenantId: request.tenantId,
      text: request.clientFacingContent,
      actor: { id: actor.id, kind: actor.kind },
      ...(request.clientId !== undefined ? { clientId: request.clientId } : {}),
      ...(request.jurisdiction !== undefined ? { jurisdiction: request.jurisdiction } : {}),
      context: request.action,
    });

    if (scan.status !== 'ok') {
      return blockAt('compliance_scan', scan as Outcome<never>, 'scan did not complete');
    }

    if (scan.value.verdict === 'blocked') {
      return blockAt(
        'compliance_scan',
        refused(
          `Client-facing content contains language the Marketing Claim Library bans: ${scan.value.findings
            .filter((finding) => finding.disposition === 'banned')
            .map((finding) => finding.phrase)
            .join(', ')}.`,
          'Blueprint 7.4 with specification 5.5 step 7 - the Communication Compliance Scanner',
        ),
        'banned language',
      );
    }

    // A `requires_disclosure` phrase is fine PROVIDED the disclosure it obliges travels with the
    // content. The library's disclosure text is exact, so the check is exact - matching loosely
    // would let a paraphrase satisfy an obligation the specific wording exists to discharge.
    const missing = scan.value.requiredDisclosures.filter(
      (disclosure) => !request.clientFacingContent?.includes(disclosure),
    );

    if (missing.length > 0) {
      return blockAt(
        'compliance_scan',
        refused(
          `Client-facing content uses language requiring ${missing.length} disclosure(s) that it does not carry: ${missing.join(' | ')}`,
          'Blueprint 7.4 - a requires_disclaimer phrase must travel with the disclosure it obliges',
        ),
        'missing required disclosure',
      );
    }

    trace.push({
      step: 'compliance_scan',
      outcome: 'passed',
      detail: `${scan.value.libraryEntriesChecked} library entries checked; verdict ${scan.value.verdict}`,
    });
  }

  return {
    result: ok({
      actor,
      trace,
      ...(clearance !== undefined ? { clearance } : {}),
      ...(doNotFundOverrideId !== undefined ? { doNotFundOverrideId } : {}),
    }),
    trace,
  };
};
