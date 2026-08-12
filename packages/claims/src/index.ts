/**
 * @bwc/claims - 7.4 Marketing Claim Library.
 *
 * Version-controlled repository of approved and banned communication language. The Communication
 * Compliance Scanner (4.2) reads from here; Partner Training (8.3) and the Deliverable Approval
 * Workflow (3.4) do too.
 *
 * Every entry carries a **rationale**. Blueprint 7.4 requires "public documentation of ban
 * rationale for internal training", and the practical reason is sharper than the compliance one:
 * a banned phrase without a stated reason cannot be taught to a partner, cannot be argued with
 * when an agent thinks it is wrong, and cannot be safely revisited when the law changes. It
 * calcifies into folklore.
 *
 * Deprecation, not deletion. A phrase banned in March and permitted in June must still explain a
 * March deliverable, so entries are deactivated with a timestamp rather than removed.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { FOUNDING_CLAIMS } from './seed.js';

export type ClaimDisposition = 'approved' | 'banned' | 'requires_disclaimer';

/**
 * Sentinel for "applies in every jurisdiction".
 *
 * A sentinel rather than NULL because Postgres treats NULL as distinct from NULL, so a unique
 * constraint containing a nullable column would happily accept two global entries for the same
 * phrase - the duplicate the constraint exists to prevent.
 */
export const ALL_JURISDICTIONS = '*';

export interface MarketingClaim {
  readonly id: string;
  readonly tenantId: string;
  readonly phrase: string;
  readonly disposition: ClaimDisposition;
  readonly rationale: string;
  readonly jurisdiction: string;
  readonly requiredDisclosure: string | null;
  readonly approvedBy: string;
  readonly version: number;
  readonly active: boolean;
}

export interface PublishClaimInput {
  readonly tenantId: string;
  readonly phrase: string;
  readonly disposition: ClaimDisposition;
  readonly rationale: string;
  readonly approvedBy: string;
  readonly actor: EventActor;
  readonly jurisdiction?: string;
  readonly requiredDisclosure?: string;
}

interface ClaimRow {
  id: string;
  tenantId: string;
  phrase: string;
  disposition: string;
  rationale: string;
  jurisdiction: string;
  requiredDisclosure: string | null;
  approvedBy: string;
  version: number;
  active: boolean;
}

const toClaim = (row: ClaimRow): MarketingClaim => ({
  id: row.id,
  tenantId: row.tenantId,
  phrase: row.phrase,
  disposition: row.disposition as ClaimDisposition,
  rationale: row.rationale,
  jurisdiction: row.jurisdiction,
  requiredDisclosure: row.requiredDisclosure,
  approvedBy: row.approvedBy,
  version: row.version,
  active: row.active,
});

export const publish = async (input: PublishClaimInput): Promise<Outcome<MarketingClaim>> => {
  if (input.rationale.trim() === '') {
    return refused(
      `Claim '${input.phrase}' needs a rationale. A rule nobody can explain cannot be taught to a partner or revisited when the law changes.`,
      'Blueprint 7.4 - ban rationale is documented, not folklore',
    );
  }
  if (input.disposition === 'requires_disclaimer' && !input.requiredDisclosure) {
    return refused(
      `Claim '${input.phrase}' requires a disclaimer but none was supplied.`,
      'Blueprint 7.4 - a requires_disclaimer entry must name the disclosure it obliges',
    );
  }

  const existing = await db().marketingClaim.findFirst({
    where: {
      tenantId: input.tenantId,
      phrase: input.phrase,
      jurisdiction: input.jurisdiction ?? ALL_JURISDICTIONS,
    },
  });

  const row = await db().marketingClaim.upsert({
    where: {
      tenantId_phrase_jurisdiction: {
        tenantId: input.tenantId,
        phrase: input.phrase,
        jurisdiction: input.jurisdiction ?? ALL_JURISDICTIONS,
      },
    },
    create: {
      tenantId: input.tenantId,
      phrase: input.phrase,
      disposition: input.disposition,
      rationale: input.rationale,
      jurisdiction: input.jurisdiction ?? ALL_JURISDICTIONS,
      requiredDisclosure: input.requiredDisclosure ?? null,
      approvedBy: input.approvedBy,
    },
    update: {
      disposition: input.disposition,
      rationale: input.rationale,
      requiredDisclosure: input.requiredDisclosure ?? null,
      approvedBy: input.approvedBy,
      active: true,
      deprecatedAt: null,
      version: (existing?.version ?? 0) + 1,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'claim.published',
    actor: input.actor,
    payload: {
      phrase: input.phrase,
      disposition: input.disposition,
      jurisdiction: input.jurisdiction ?? ALL_JURISDICTIONS,
      version: row.version,
      approvedBy: input.approvedBy,
    },
  });

  return ok(toClaim(row));
};

/**
 * Deactivate rather than delete. A phrase banned in March and permitted in June must still
 * explain a March deliverable, and the Compliance Evidence Vault reads that history.
 */
export const deprecate = async (
  tenantId: string,
  claimId: string,
  actor: EventActor,
  now: Date = new Date(),
): Promise<Outcome<MarketingClaim>> => {
  const existing = await db().marketingClaim.findFirst({ where: { id: claimId, tenantId } });
  if (!existing) return noData('No such claim in this tenant.');

  const row = await db().marketingClaim.update({
    where: { id: claimId },
    data: { active: false, deprecatedAt: now },
  });

  await append({
    tenantId,
    type: 'claim.deprecated',
    actor,
    payload: { phrase: row.phrase, disposition: row.disposition },
  });

  return ok(toClaim(row));
};

export interface LibraryQuery {
  readonly tenantId: string;
  /** Restricts to entries that are global or scoped to this jurisdiction. */
  readonly jurisdiction?: string;
}

/**
 * The active library the Scanner reads.
 *
 * Includes global entries plus any scoped to the given jurisdiction, because a state-specific ban
 * adds to the national list rather than replacing it.
 */
export const activeLibrary = async (query: LibraryQuery): Promise<MarketingClaim[]> => {
  const rows = await db().marketingClaim.findMany({
    where: {
      tenantId: query.tenantId,
      active: true,
      // Global entries plus any scoped to this jurisdiction: a state ban ADDS to the national
      // list rather than replacing it.
      ...(query.jurisdiction !== undefined
        ? { OR: [{ jurisdiction: ALL_JURISDICTIONS }, { jurisdiction: query.jurisdiction }] }
        : {}),
    },
    orderBy: [{ phrase: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toClaim);
};

/**
 * Seed the founding library for a tenant.
 *
 * The library itself moved to `seed.ts` when it grew from fourteen entries to a hundred, and grew
 * a header explaining what may and may not be seeded. The function stays here, with `publish`, so
 * that `seed.ts` needs only a type from this module and no runtime cycle exists between the two.
 *
 * Idempotent - publishing upserts on (tenant, phrase, jurisdiction). Never runs on import.
 */
export const seedFoundingClaims = async (
  tenantId: string,
  approvedBy: string,
  actor: EventActor,
): Promise<number> => {
  let published = 0;
  for (const claim of FOUNDING_CLAIMS) {
    const result = await publish({ ...claim, tenantId, approvedBy, actor });
    if (result.status === 'ok') published += 1;
  }
  return published;
};

export * from './seed.js';
export * from './proposed.js';
