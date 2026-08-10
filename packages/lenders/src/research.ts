/**
 * The V1.5 credit-union research workstream - Decision D.
 *
 * Decision D reads: "V1 CU placement restricted to Navy Federal only. Portfolio-wide
 * provenance discipline applies to all lender recommendations." Blueprint 5.2 adds that the
 * five deferred credit unions each get "a research status, assigned researcher, target
 * completion date."
 *
 * The two halves are one decision and live in one file, because the restriction is only
 * meaningful next to the list of what is restricted. Separating them is how a constant ends
 * up updated on one side and not the other.
 *
 * A research row is not a Provider. It has no product offerings and no governance record, so
 * nothing in the recommendation path can reach it - the restriction survives an eager agent
 * because there is no query that would return the row, not because a check remembered to
 * exclude it.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

/**
 * The only credit union approvable in V1. Decision D.
 *
 * A list rather than a single string so the V1.5 activation is an append here plus a
 * governance approval, rather than a change of shape that touches call sites.
 */
export const V1_APPROVED_CREDIT_UNIONS: readonly string[] = ['Navy Federal Credit Union'];

/** The five deferred to V1.5 by Decision D, named in blueprint 5.2. */
export const V1_5_DEFERRED_CREDIT_UNIONS: readonly string[] = [
  'Alliant Credit Union',
  'PenFed Credit Union',
  'BECU',
  'First Tech Federal Credit Union',
  'Lake Michigan Credit Union',
];

/**
 * Is this provider inside V1's credit-union scope?
 *
 * Answers `true` for everything that is not a credit union: Decision D restricts credit
 * unions specifically, and card issuers, national banks and fintech LOCs are in V1 scope by
 * the blueprint's own "V1 lender scope" line.
 */
export const isWithinV1CreditUnionScope = (kind: string, providerName: string): boolean =>
  kind !== 'credit_union' || V1_APPROVED_CREDIT_UNIONS.includes(providerName);

export type ResearchStatus = 'not_started' | 'in_progress' | 'blocked' | 'complete';

export interface ResearchRecord {
  readonly id: string;
  readonly providerName: string;
  readonly kind: string;
  readonly status: ResearchStatus;
  readonly assignedTo: string | null;
  readonly targetCompletionDate: string | null;
  readonly notes: string | null;
  readonly promotedProviderId: string | null;
}

interface ResearchRow {
  id: string;
  providerName: string;
  kind: string;
  status: string;
  assignedTo: string | null;
  targetCompletionDate: Date | null;
  notes: string | null;
  promotedProviderId: string | null;
}

const toRecord = (row: ResearchRow): ResearchRecord => ({
  id: row.id,
  providerName: row.providerName,
  kind: row.kind,
  status: row.status as ResearchStatus,
  assignedTo: row.assignedTo,
  targetCompletionDate: row.targetCompletionDate?.toISOString() ?? null,
  notes: row.notes,
  promotedProviderId: row.promotedProviderId,
});

export interface OpenResearchInput {
  readonly tenantId: string;
  readonly providerName: string;
  readonly kind: string;
  readonly assignedTo?: string;
  readonly targetCompletionDate?: Date;
  readonly notes?: string;
  readonly actor: EventActor;
}

export const openResearch = async (input: OpenResearchInput): Promise<Outcome<ResearchRecord>> => {
  const row = await db().researchWorkstream.upsert({
    where: {
      tenantId_providerName: { tenantId: input.tenantId, providerName: input.providerName },
    },
    create: {
      tenantId: input.tenantId,
      providerName: input.providerName,
      kind: input.kind as never,
      assignedTo: input.assignedTo ?? null,
      targetCompletionDate: input.targetCompletionDate ?? null,
      notes: input.notes ?? null,
    },
    update: {
      assignedTo: input.assignedTo ?? null,
      targetCompletionDate: input.targetCompletionDate ?? null,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.research.opened',
    actor: input.actor,
    payload: { providerName: input.providerName, kind: input.kind },
  });

  return ok(toRecord(row));
};

export interface AdvanceResearchInput {
  readonly tenantId: string;
  readonly providerName: string;
  readonly status: ResearchStatus;
  readonly notes?: string;
  readonly actor: EventActor;
}

/**
 * Move a workstream along. Explicitly does *not* create a Provider when status reaches
 * `complete`.
 *
 * Completing the research means we now know PenFed's rules. It does not mean anyone decided
 * to place clients there - that is a governance decision, made by a named human on a
 * separate record. Auto-promoting on completion would let a researcher finishing their notes
 * silently widen V1's lender scope, which is precisely the outcome Decision D exists to
 * prevent.
 */
export const advanceResearch = async (
  input: AdvanceResearchInput,
): Promise<Outcome<ResearchRecord>> => {
  const existing = await db().researchWorkstream.findFirst({
    where: { tenantId: input.tenantId, providerName: input.providerName },
  });
  if (!existing) return noData(`No research workstream for '${input.providerName}'.`);

  const row = await db().researchWorkstream.update({
    where: { id: existing.id },
    data: {
      status: input.status as never,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.research.advanced',
    actor: input.actor,
    payload: {
      providerName: input.providerName,
      fromStatus: existing.status,
      toStatus: input.status,
    },
  });

  return ok(toRecord(row));
};

/**
 * Link a completed workstream to the Provider record created from it.
 *
 * Refuses while research is incomplete: a provider promoted from half-finished research
 * carries rules nobody verified, and Decision D's whole subject is the difference between a
 * researched rule and an assumed one.
 */
export const linkPromotedProvider = async (input: {
  tenantId: string;
  providerName: string;
  providerId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ResearchRecord>> => {
  const existing = await db().researchWorkstream.findFirst({
    where: { tenantId: input.tenantId, providerName: input.providerName },
  });
  if (!existing) return noData(`No research workstream for '${input.providerName}'.`);

  if (existing.status !== 'complete') {
    return refused(
      `Research on '${input.providerName}' is ${existing.status}, so it cannot be linked to a provider record yet.`,
      'Decision D - a provider promoted from unfinished research carries rules nobody verified',
    );
  }

  const row = await db().researchWorkstream.update({
    where: { id: existing.id },
    data: { promotedProviderId: input.providerId, promotedAt: input.now ?? new Date() },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.research.promoted',
    actor: input.actor,
    payload: { providerName: input.providerName, providerId: input.providerId },
  });

  return ok(toRecord(row));
};

export const researchWorkstreams = async (
  tenantId: string,
  status?: ResearchStatus,
): Promise<readonly ResearchRecord[]> => {
  const rows = await db().researchWorkstream.findMany({
    where: { tenantId, ...(status !== undefined ? { status } : {}) },
    orderBy: { providerName: 'asc' },
  });
  return rows.map(toRecord);
};

/**
 * Seed the five deferred credit unions. Idempotent.
 *
 * Seeded rather than left to be created ad hoc, because blueprint 5.2 requires the V1.5
 * progress to be *trackable* - and a workstream nobody created cannot be behind schedule.
 */
export const seedDeferredCreditUnionResearch = async (
  tenantId: string,
  actor: EventActor,
  assignedTo?: string,
): Promise<number> => {
  let opened = 0;
  for (const providerName of V1_5_DEFERRED_CREDIT_UNIONS) {
    const result = await openResearch({
      tenantId,
      providerName,
      kind: 'credit_union',
      ...(assignedTo !== undefined ? { assignedTo } : {}),
      notes:
        'Deferred to V1.5 by Decision D. Velocity rules, membership eligibility and business-product terms all require research before any placement.',
      actor,
    });
    if (result.status === 'ok') opened += 1;
  }
  return opened;
};
