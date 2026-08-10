/**
 * The client-side inputs eligibility is decided against, and the provenance conversion
 * shared by every stored record in this package.
 *
 * A separate file because both 5.2's eligibility logic and 5.3's recommendation take the
 * same profile, and a shape defined twice drifts.
 */

import type { Provenance } from '@bwc/core';

/** Sentinel for "serves every state". See the note on `Provider.statesServed`. */
export const NATIONWIDE = '*';

/**
 * What a lender's underwriting box is evaluated against.
 *
 * Every field is nullable because the honest state of a client file early in an engagement
 * is that most of it is unknown - and an unknown must not be silently treated as a zero
 * that fails every box, nor as a pass that fabricates eligibility. `eligibility.ts` treats
 * it as neither: it reports `unknown` as its own verdict.
 */
export interface ClientProfile {
  readonly clientId: string;
  /** Two-letter state code of the entity's principal place of business. */
  readonly state: string | null;
  readonly timeInBusinessMonths: number | null;
  readonly annualRevenue: number | null;
  readonly personalCreditScore: number | null;
  /** Free-text or NAICS-derived label, matched case-insensitively against exclusions. */
  readonly industry: string | null;
  /** What the client is trying to fund. Drives the suitability matrix, not eligibility. */
  readonly need: CapitalNeed;
  readonly requestedAmount: number;
}

/**
 * Why the client wants capital. Blueprint 5.2's "Funding Product Suitability Matrix" is a
 * mapping from this to product kinds, and the reason it exists is that the cheapest product
 * a client qualifies for is often the wrong one - a 5-year term loan for a 45-day receivables
 * gap costs less per dollar and leaves the client servicing debt long after the gap closed.
 */
export type CapitalNeed =
  | 'working_capital'
  | 'receivables_gap'
  | 'equipment_purchase'
  | 'expansion'
  | 'refinance_existing'
  | 'startup_launch';

export const CAPITAL_NEEDS = [
  'working_capital',
  'receivables_gap',
  'equipment_purchase',
  'expansion',
  'refinance_existing',
  'startup_launch',
] as const satisfies readonly CapitalNeed[];

/** The provenance columns as they are stored, shared by rules and offerings. */
export interface StoredProvenance {
  provenanceTag: 'issuer_rule' | 'unresearched_default' | 'vendor_feed';
  sourceUrl: string | null;
  lastVerified: Date | null;
  verifiedBy: string | null;
  rationale: string | null;
  vendor?: string | null;
  retrievedAt?: Date | null;
}

/**
 * Rebuild a `Provenance` from its stored columns.
 *
 * Throws on an inconsistent row rather than degrading to `unresearched_default`. Degrading
 * would be the more forgiving choice and the wrong one: it would silently relabel a
 * researched issuer rule as an assumption, or - far worse in the other direction - present
 * an assumption with a source URL nobody checked. A row that cannot be interpreted is a
 * defect in whatever wrote it.
 */
export const toProvenance = (stored: StoredProvenance): Provenance => {
  switch (stored.provenanceTag) {
    case 'issuer_rule':
      if (!stored.sourceUrl || !stored.lastVerified || !stored.verifiedBy) {
        throw new Error(
          'An issuer_rule row is missing sourceUrl, lastVerified or verifiedBy. Decision D requires all three; the write path should have rejected it.',
        );
      }
      return {
        tag: 'issuer_rule',
        sourceUrl: stored.sourceUrl,
        lastVerified: stored.lastVerified.toISOString(),
        verifiedBy: stored.verifiedBy,
      };
    case 'unresearched_default':
      if (!stored.rationale) {
        throw new Error(
          'An unresearched_default row is missing its rationale. An assumption nobody can explain cannot be argued with or revisited.',
        );
      }
      return { tag: 'unresearched_default', rationale: stored.rationale };
    case 'vendor_feed':
      if (!stored.vendor || !stored.retrievedAt) {
        throw new Error('A vendor_feed row is missing its vendor or retrievedAt.');
      }
      return {
        tag: 'vendor_feed',
        vendor: stored.vendor as 'plaid' | 'business_bureau' | 'personal_credit' | 'capitalforge',
        retrievedAt: stored.retrievedAt.toISOString(),
        consentReference: stored.sourceUrl ?? 'n/a',
      };
  }
};

/** Split a `Provenance` back into the columns it is stored as. */
export const fromProvenance = (provenance: Provenance): StoredProvenance => {
  switch (provenance.tag) {
    case 'issuer_rule':
      return {
        provenanceTag: 'issuer_rule',
        sourceUrl: provenance.sourceUrl,
        lastVerified: new Date(provenance.lastVerified),
        verifiedBy: provenance.verifiedBy,
        rationale: null,
        vendor: null,
        retrievedAt: null,
      };
    case 'unresearched_default':
      return {
        provenanceTag: 'unresearched_default',
        sourceUrl: null,
        lastVerified: null,
        verifiedBy: null,
        rationale: provenance.rationale,
        vendor: null,
        retrievedAt: null,
      };
    case 'vendor_feed':
      return {
        provenanceTag: 'vendor_feed',
        sourceUrl: provenance.consentReference,
        lastVerified: null,
        verifiedBy: null,
        rationale: null,
        vendor: provenance.vendor,
        retrievedAt: new Date(provenance.retrievedAt),
      };
    case 'client_stated':
      // A lender rule cannot be client-stated. The client is not the source of an issuer's
      // velocity policy, and coercing this into `unresearched_default` to make the write
      // succeed would relabel someone's statement as our assumption - the exact confusion
      // the tag was added to prevent. Throws rather than returning an Outcome: reaching this
      // is a programming error at the call site, not a runtime condition a caller can recover
      // from by asking the user.
      throw new Error(
        'A client_stated figure cannot be stored as a lender rule or product offering. Client statements belong to the Entity Graph (1.2); lender terms come from the issuer or from a vendor feed.',
      );
  }
};
