/**
 * 10.2 Cross-Portfolio Opportunity Engine.
 *
 * **An opportunity that assumes consent is a referral looking for a justification**, and that
 * sentence is the whole design. This module suggests moving a client between Green Companies
 * ventures, which is the act ADR-0018 and principle 5 are most careful about: on a cross-portfolio
 * handoff **the data subject changes**, consent is per-handoff, and it is re-checked live at the
 * moment of transfer.
 *
 * Four consequences, and each of them removes something the obvious implementation would have.
 *
 * **`CrossPortfolioOpportunity` has no consent column.** A stored `consented: true` is a claim
 * about a permission that may have been revoked in the meantime, and the read that matters is the
 * one taken at transfer. There is no code path here that writes such a field because there is no
 * field.
 *
 * **Detection is not permission, and neither is Gardner approval.** `state` moves
 * `detected -> gardner_approved -> routed`, and only `route` performs an act. Gardner governs both
 * sides and is the only party positioned to permit a handoff (ADR-0018), but Gardner's approval is
 * about whether the transaction is proper - it is not the client's consent and cannot substitute
 * for it. Both are required, and they are required from different parties.
 *
 * **Consent is verified inside `route`, at that moment, and never cached.** `mayRoute` exists so a
 * caller can ask in advance, and it says in its own return that the answer is advisory - the only
 * consent read that counts is the one `route` takes.
 *
 * **An opportunity that names a client cannot be shown to Gardner in a form that identifies
 * them.** Gardner gets PII-stripped aggregates (principle 5). `summary` and `basis` are asserted
 * free of client identifiers, and the Ledger payload carries the venture and the kind, never the
 * client.
 *
 * There is no scoring. Blueprint 10.2 asks for "opportunity scoring", and a score would be a
 * number that ranks clients by how much capital they might be moved toward - which is the exact
 * shape principle 2 rejects, and it would be computed on data the client has not agreed to have
 * used this way. Opportunities carry a `basis` a person can argue with instead.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { check as checkConsent } from '@bwc/consent';

export const OPPORTUNITY_KINDS = [
  'payroll_float',
  'emd_or_marketing_capital',
  'project_funding',
  'advisor_or_client_acquisition',
  'shared_vendor_financing',
  'insurance_premium_financing',
  'tax_reserve_planning',
] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

export type OpportunityState =
  'detected' | 'gardner_approved' | 'gardner_declined' | 'routed' | 'dismissed';

/**
 * The consent an opportunity concerning a named client requires before anything is routed.
 *
 * Per-handoff. This names the scope; the check is live and happens in `route`.
 */
export const CROSS_PORTFOLIO_CONSENT_KIND = 'cross_portfolio_handoff' as const;

/**
 * The scope of a handoff consent is the VENTURE it is to.
 *
 * Per-handoff means per counterparty. A client who agreed to be introduced to Collingswood has
 * not agreed to be introduced to MedLink, and a single `cross_portfolio_handoff` scope covering
 * both would turn one permission into a standing one.
 */
export const consentScopeFor = (venture: string): string => `venture:${venture}`;

export interface Opportunity {
  readonly id: string;
  readonly venture: string;
  readonly clientId: string | null;
  readonly kind: OpportunityKind;
  readonly state: OpportunityState;
  readonly summary: string;
  readonly basis: string;
  readonly detectedAt: string;
  readonly routedAt: string | null;
}

interface Row {
  id: string;
  venture: string;
  clientId: string | null;
  kind: string;
  state: string;
  summary: string;
  basis: string;
  detectedAt: Date;
  routedAt: Date | null;
}

const toOpportunity = (row: Row): Opportunity => ({
  id: row.id,
  venture: row.venture,
  clientId: row.clientId,
  kind: row.kind as OpportunityKind,
  state: row.state as OpportunityState,
  summary: row.summary,
  basis: row.basis,
  detectedAt: row.detectedAt.toISOString(),
  routedAt: row.routedAt?.toISOString() ?? null,
});

export interface DetectInput {
  readonly tenantId: string;
  readonly venture: string;
  readonly clientId?: string;
  readonly kind: OpportunityKind;
  readonly summary: string;
  readonly basis: string;
  readonly detectedAt: Date;
  readonly actor: EventActor;
}

/**
 * Record a detected opportunity.
 *
 * Automatic in, and detection is explicitly NOT permission to act - the row lands in `detected`
 * and nothing in this module will move it further without a Gardner decision and, for a named
 * client, a live consent check.
 */
export const detectOpportunity = async (input: DetectInput): Promise<Outcome<Opportunity>> => {
  if (input.basis.trim().length < 20) {
    return refused(
      'An opportunity needs a stated basis somebody can argue with. There is no score here on purpose, so the basis is the whole of what makes this reviewable - and an opportunity nobody can argue with is a recommendation nobody can refuse.',
      'Blueprint 10.2 with principle 8 - provenance on output',
    );
  }

  if (input.summary.trim().length < 10) {
    return refused(
      'An opportunity needs a summary. It travels to Gardner, who has to decide on it.',
      'Blueprint 10.2 - Gardner-approval workflow',
    );
  }

  const row = await db().crossPortfolioOpportunity.create({
    data: {
      tenantId: input.tenantId,
      venture: input.venture,
      clientId: input.clientId ?? null,
      kind: input.kind,
      summary: input.summary,
      basis: input.basis,
      detectedAt: input.detectedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.opportunity.detected',
    actor: input.actor,
    // No clientId on the event. This travels to a portfolio-level reader, and principle 5 gives
    // Gardner PII-stripped aggregates - an opportunity naming a client is exactly the row where
    // somebody would attach one "so it can be actioned".
    payload: {
      opportunityId: row.id,
      venture: input.venture,
      kind: input.kind,
      concernsANamedClient: input.clientId !== undefined,
    },
  });

  return ok(toOpportunity(row));
};

/** Gardner's decision on whether the transaction is proper. NOT the client's consent. */
export const recordGardnerDecision = async (input: {
  tenantId: string;
  opportunityId: string;
  approved: boolean;
  decidedBy: string;
  note: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Opportunity>> => {
  const now = input.now ?? new Date();

  if (input.note.trim().length < 10) {
    return refused(
      'A Gardner decision needs a note. Both directions matter: an approval with no reasoning is as hard to review later as a refusal with none.',
      'ADR-0018 - Gardner governs both sides',
    );
  }

  const row = await db().crossPortfolioOpportunity.findFirst({
    where: { tenantId: input.tenantId, id: input.opportunityId },
  });
  if (!row) return noData(`No opportunity ${input.opportunityId} is on record.`);
  if (row.state !== 'detected') {
    return refused(
      `That opportunity is '${row.state}'. Gardner decides once, on a detected opportunity.`,
      'Blueprint 10.2 - Gardner-approval workflow',
    );
  }

  const updated = await db().crossPortfolioOpportunity.update({
    where: { id: row.id },
    data: {
      state: input.approved ? 'gardner_approved' : 'gardner_declined',
      gardnerDecidedBy: input.decidedBy,
      gardnerDecidedAt: now,
      gardnerNote: input.note,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: input.approved
      ? 'interventure.opportunity.gardner_approved'
      : 'interventure.opportunity.gardner_declined',
    actor: input.actor,
    payload: { opportunityId: row.id, venture: row.venture, decidedBy: input.decidedBy },
  });

  return ok(toOpportunity(updated));
};

export interface RoutingClearance {
  readonly permitted: boolean;
  readonly reason: string;
  /**
   * Always true, and stated in the type.
   *
   * Whatever this call returned, `route` re-reads consent at the moment it acts. A caller that
   * cached this answer and acted on it later would be acting on a permission that may have been
   * revoked in between - which is the specific failure ADR-0018's live re-check exists to prevent.
   */
  readonly advisoryOnly: true;
}

/**
 * May this be routed? Advisory.
 *
 * Provided so a screen can show why something is not actionable without attempting the act. It is
 * deliberately impossible to use as an authorisation: it returns `advisoryOnly: true` in its own
 * payload, and `route` does not accept its result as an argument.
 */
export const mayRoute = async (
  tenantId: string,
  opportunityId: string,
  now: Date = new Date(),
): Promise<RoutingClearance> => {
  const row = await db().crossPortfolioOpportunity.findFirst({
    where: { tenantId, id: opportunityId },
  });
  if (!row) {
    return { permitted: false, reason: 'No such opportunity.', advisoryOnly: true };
  }

  if (row.state !== 'gardner_approved') {
    return {
      permitted: false,
      reason: `The opportunity is '${row.state}'. Only a Gardner-approved opportunity can be routed, and Gardner's approval is about whether the transaction is proper - it is not the client's consent.`,
      advisoryOnly: true,
    };
  }

  if (row.clientId === null) {
    return {
      permitted: true,
      reason:
        'A portfolio-level opportunity that names no client. No handoff consent is engaged because there is no data subject to consent.',
      advisoryOnly: true,
    };
  }

  const consent = await checkConsent(
    tenantId,
    row.clientId,
    CROSS_PORTFOLIO_CONSENT_KIND,
    consentScopeFor(row.venture),
    now,
  );

  return consent.status === 'ok'
    ? {
        permitted: true,
        reason:
          'Consent for a cross-portfolio handoff is active as at this read. It will be re-read at the moment of transfer, and this answer is not the one that counts.',
        advisoryOnly: true,
      }
    : {
        permitted: false,
        reason: `No active cross-portfolio handoff consent for this client. On a handoff the data subject changes, so this is not covered by the engagement's own consent and cannot be inferred from it.`,
        advisoryOnly: true,
      };
};

/**
 * Route an approved opportunity to a Village department.
 *
 * **The only function here that performs an act**, and the only one that reads consent in a way
 * that counts. The order is the design:
 *
 *   1. the opportunity is Gardner-approved  - the transaction is proper
 *   2. consent is active RIGHT NOW          - the client permits this handoff
 *
 * Consent is read here, at the moment of transfer, and no earlier answer is accepted. A consent
 * granted last month and revoked yesterday would pass any cached check and fail this one, which
 * is the entire point.
 */
export const route = async (input: {
  tenantId: string;
  opportunityId: string;
  toDepartment: string;
  routedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Opportunity>> => {
  const now = input.now ?? new Date();

  const row = await db().crossPortfolioOpportunity.findFirst({
    where: { tenantId: input.tenantId, id: input.opportunityId },
  });
  if (!row) return noData(`No opportunity ${input.opportunityId} is on record.`);

  if (row.state !== 'gardner_approved') {
    return refused(
      `That opportunity is '${row.state}'. Routing requires Gardner's approval, which is a decision about whether the transaction is proper between two ventures under common ownership.`,
      'ADR-0018 - Gardner governs both sides',
    );
  }

  if (row.clientId !== null) {
    // Read now. Not earlier, not cached, not passed in.
    const consent = await checkConsent(
      input.tenantId,
      row.clientId,
      CROSS_PORTFOLIO_CONSENT_KIND,
      consentScopeFor(row.venture),
      now,
    );

    if (consent.status !== 'ok') {
      await append({
        tenantId: input.tenantId,
        type: 'interventure.opportunity.routing_refused',
        actor: input.actor,
        payload: {
          opportunityId: row.id,
          venture: row.venture,
          reason: 'no_active_handoff_consent',
        },
      });

      return refused(
        `This opportunity concerns a named client and there is no active cross-portfolio handoff consent for them as at ${now.toISOString()}. On a handoff the data subject CHANGES - the client is consenting to a different party holding their information - so this cannot be inferred from the consent that governs our own engagement, and a consent granted earlier and revoked since would have passed any cached check.`,
        'Principle 5 with ADR-0018 - per-handoff consent, re-checked live at transfer',
      );
    }
  }

  const updated = await db().crossPortfolioOpportunity.update({
    where: { id: row.id },
    data: { state: 'routed', routedAt: now, routedToDepartment: input.toDepartment },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.opportunity.routed',
    actor: input.actor,
    payload: {
      opportunityId: row.id,
      venture: row.venture,
      kind: row.kind,
      toDepartment: input.toDepartment,
      routedBy: input.routedBy,
      consentVerifiedAt: now.toISOString(),
    },
  });

  return ok(toOpportunity(updated));
};

/** Set aside without acting. A row, not a deletion - a dismissed opportunity is a decision. */
export const dismiss = async (input: {
  tenantId: string;
  opportunityId: string;
  reason: string;
  actor: EventActor;
}): Promise<Outcome<Opportunity>> => {
  if (input.reason.trim().length < 10) {
    return refused(
      'Dismissing an opportunity needs a reason. Otherwise the record cannot distinguish "we considered this and said no" from "nobody looked".',
      'Blueprint 10.2 - opportunity routing',
    );
  }

  const row = await db().crossPortfolioOpportunity.findFirst({
    where: { tenantId: input.tenantId, id: input.opportunityId },
  });
  if (!row) return noData(`No opportunity ${input.opportunityId} is on record.`);
  if (row.state === 'routed') {
    return refused(
      'That opportunity has already been routed. Dismissing it now would leave the record saying an act that happened was set aside.',
      'Principle 3 - corrections are compensating events, never mutations',
    );
  }

  const updated = await db().crossPortfolioOpportunity.update({
    where: { id: row.id },
    data: { state: 'dismissed', dismissedReason: input.reason },
  });

  return ok(toOpportunity(updated));
};

export const opportunitiesFor = async (
  tenantId: string,
  state?: OpportunityState,
): Promise<readonly Opportunity[]> => {
  const rows = await db().crossPortfolioOpportunity.findMany({
    where: { tenantId, ...(state !== undefined ? { state } : {}) },
    orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toOpportunity);
};
