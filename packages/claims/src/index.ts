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
    orderBy: { phrase: 'asc' },
  });
  return rows.map(toClaim);
};

/**
 * The starting library, drawn from language the blueprint and specification name explicitly.
 *
 * Seeded rather than hardcoded into the Scanner: blueprint 7.4 puts these under weekly Compliance
 * Review Board control, and a list compiled into code cannot be reviewed weekly by anyone but an
 * engineer.
 */
export const FOUNDING_CLAIMS: readonly Omit<
  PublishClaimInput,
  'tenantId' | 'actor' | 'approvedBy'
>[] = [
  {
    phrase: 'guaranteed approval',
    disposition: 'banned',
    rationale:
      'Burkham Wickmont is not the decision-maker on any application. Promising approval both misstates the relationship and is the claim regulators treat as the clearest deceptive-practice marker (FTC Act).',
  },
  {
    phrase: 'guarantee approval',
    disposition: 'banned',
    rationale: 'Verb form of "guaranteed approval"; same reasoning.',
  },
  {
    phrase: 'no risk',
    disposition: 'banned',
    rationale:
      'Every capital placement carries risk, and personal guarantees make some of it personal. The phrase is false on its face for this product set.',
  },
  {
    phrase: 'risk free',
    disposition: 'banned',
    rationale: 'Variant of "no risk"; same reasoning.',
  },
  {
    phrase: 'we can remove negative items',
    disposition: 'banned',
    rationale:
      'Credit repair language. Saying it would recharacterize Burkham Wickmont as a Credit Repair Organization under CROA - principle 1, and the single fastest way to change what the company legally is.',
  },
  {
    phrase: 'remove negative items',
    disposition: 'banned',
    rationale: 'Shorter form of the credit repair claim; same reasoning.',
  },
  {
    phrase: 'fix your credit',
    disposition: 'banned',
    rationale: 'Credit repair framing; same CROA exposure.',
  },
  {
    phrase: 'we are a lender',
    disposition: 'banned',
    rationale:
      'Burkham Wickmont facilitates placement and is not a lender. Principle 1 - no communication may recharacterize the company.',
  },
  {
    phrase: 'pre-approved',
    disposition: 'banned',
    rationale:
      'A term of art with a specific meaning under FCRA firm-offer rules that this service does not satisfy.',
  },
  {
    phrase: 'investment advice',
    disposition: 'banned',
    rationale: 'Would recharacterize the company as an investment adviser. Principle 1.',
  },
  {
    phrase: 'estimated',
    disposition: 'requires_disclaimer',
    rationale:
      'An estimate presented without its basis reads as a commitment. Blueprint 3.1 requires derived figures to ship how they were derived.',
    requiredDisclosure:
      'Estimates are based on the information available at the time of preparation and are not an offer or commitment of credit.',
  },
  {
    phrase: 'up to',
    disposition: 'requires_disclaimer',
    rationale:
      'Ceiling language implies attainability. Requires the qualifying disclosure so the figure is not read as an expectation.',
    requiredDisclosure:
      'Amounts shown are maximums for the product described and are not an indication of the amount any particular applicant will be approved for.',
  },
];

/** Seed the founding library for a tenant. Idempotent - publishing upserts by phrase. */
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
