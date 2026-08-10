/**
 * @bwc/consent - 1.5 Consent & Authorization Center.
 *
 * The legal permission layer. Per-event, never blanket:
 *   - per-application authorization before any Level 3 submission (18 USC 1014/1344)
 *   - per-pull bureau authorization, business and personal separately (Decision B, FCRA-adjacent)
 *   - per-connection Plaid authorization naming the institution (Decision A, GLBA-adjacent)
 *
 * Every consent carries a `scope`. A consent without one is a blanket consent by accident,
 * which is the exact shape the per-event requirement exists to prevent, so `grant` refuses
 * an empty scope rather than storing it.
 *
 * Revocation propagates: `check` treats a revoked or expired consent as absent, so a
 * dependent workflow freezes the moment the client withdraws permission.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';

export const CONSENT_KINDS = [
  'application',
  'business_bureau_pull',
  'personal_credit_pull',
  'plaid_connection',
  'disclosure',
  'cross_portfolio_handoff',
  // 8.1 Partner & Referrer Portal. A client consents to work with US; that is not consent to be
  // reported on to the accountant who introduced them. This kind is what makes the difference.
  'partner_status_visibility',
  // 4.3 Call Recording. Required in all-party-consent states, where recording a client without
  // their consent is a crime in the state where the CLIENT is sitting - not where we are.
  'call_recording',
] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface Consent {
  readonly id: string;
  readonly clientId: string;
  readonly kind: ConsentKind;
  readonly scope: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface GrantInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: ConsentKind;
  readonly scope: string;
  readonly expiresAt?: Date;
  readonly actor: EventActor;
}

export const grant = async (input: GrantInput): Promise<Outcome<Consent>> => {
  if (input.scope.trim() === '') {
    return refused(
      `A ${input.kind} consent requires an explicit scope. An unscoped consent is a blanket consent.`,
      'Blueprint 1.5 - authorization is per-event, never blanket',
    );
  }

  const row = await db().consent.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind,
      scope: input.scope,
      expiresAt: input.expiresAt ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'consent.granted',
    actor: input.actor,
    clientId: input.clientId,
    payload: { kind: input.kind, scope: input.scope },
  });

  return ok(row);
};

export const revoke = async (
  tenantId: string,
  consentId: string,
  actor: EventActor,
): Promise<Outcome<Consent>> => {
  const existing = await db().consent.findFirst({ where: { id: consentId, tenantId } });
  if (!existing)
    return refused('No such consent in this tenant.', 'Principle 5 - tenant isolation');

  const row = await db().consent.update({
    where: { id: consentId },
    data: { revokedAt: new Date() },
  });

  await append({
    tenantId,
    type: 'consent.revoked',
    actor,
    clientId: row.clientId,
    payload: { kind: row.kind, scope: row.scope },
  });

  return ok(row);
};

/**
 * Is there a live consent of this kind covering this scope?
 *
 * Refuses rather than returning false, so the caller propagates the reason upward instead of
 * translating a boolean back into an explanation it has to invent.
 */
export const check = async (
  tenantId: string,
  clientId: string,
  kind: ConsentKind,
  scope: string,
  now: Date = new Date(),
): Promise<Outcome<Consent>> => {
  const row = await db().consent.findFirst({
    where: {
      tenantId,
      clientId,
      kind,
      scope,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { grantedAt: 'desc' },
  });

  if (!row) {
    return refused(
      `No live ${kind} authorization covering '${scope}'. The client must authorize this specific action before it can proceed.`,
      'Blueprint 1.5 - per-event client authorization required',
    );
  }

  return ok(row);
};

/**
 * Every authorization on file for a client, granted or revoked.
 *
 * Added for the Compliance Evidence Vault (7.1), which needs the full history rather than a
 * yes/no on one scope. Revoked records are included: "this client authorized a bureau pull in
 * March and revoked it in June" is the evidence, and filtering revoked ones out would present the
 * revocation as though it had never been granted.
 */
export const forClient = async (tenantId: string, clientId: string): Promise<Consent[]> => {
  const rows = await db().consent.findMany({
    where: { tenantId, clientId },
    orderBy: { grantedAt: 'asc' },
  });
  return rows;
};
