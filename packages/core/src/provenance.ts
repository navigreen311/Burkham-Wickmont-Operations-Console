/**
 * Provenance on output - design principle 8, Decision D applied portfolio-wide.
 *
 * Every derived figure ships how it was derived. The specific failure this prevents:
 * a lender velocity rule that nobody researched, presented to a client with the same
 * confidence as one read off the issuer's published terms. The client cannot tell the
 * difference, and neither can the agent, unless the difference is carried in the data.
 *
 * Provenance is a required field, not an optional annotation. A rule written without one
 * is a rejected write - see `requireProvenance`.
 */

/** A rule read from a named source that someone verified on a date. */
export interface IssuerRuleProvenance {
  readonly tag: 'issuer_rule';
  readonly sourceUrl: string;
  readonly lastVerified: Date;
  readonly verifiedBy: string;
}

/**
 * A working assumption nobody has researched. Legitimate to hold and legitimate to act on,
 * so long as it is labelled as such wherever it surfaces - including in client-facing
 * deliverables (blueprint 3.1).
 */
export interface UnresearchedDefaultProvenance {
  readonly tag: 'unresearched_default';
  readonly rationale: string;
}

/** A figure taken from a vendor feed, carrying the pull time so staleness is visible. */
export interface VendorFeedProvenance {
  readonly tag: 'vendor_feed';
  readonly vendor: 'plaid' | 'business_bureau' | 'personal_credit' | 'capitalforge';
  readonly retrievedAt: Date;
  readonly consentReference: string;
}

export type Provenance =
  IssuerRuleProvenance | UnresearchedDefaultProvenance | VendorFeedProvenance;

export type ProvenanceTag = Provenance['tag'];

export const PROVENANCE_TAGS = [
  'issuer_rule',
  'unresearched_default',
  'vendor_feed',
] as const satisfies readonly ProvenanceTag[];

/** A value that cannot exist without knowing where it came from. */
export interface Sourced<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

export const sourced = <T>(value: T, provenance: Provenance): Sourced<T> => ({
  value,
  provenance,
});

export const hasProvenance = (candidate: unknown): candidate is { provenance: Provenance } => {
  if (typeof candidate !== 'object' || candidate === null || !('provenance' in candidate)) {
    return false;
  }
  const { provenance } = candidate as { provenance: unknown };
  return (
    typeof provenance === 'object' &&
    provenance !== null &&
    'tag' in provenance &&
    (PROVENANCE_TAGS as readonly unknown[]).includes((provenance as { tag: unknown }).tag)
  );
};

/**
 * Guard for write paths. Throws rather than returning an Outcome because an untagged rule
 * is a programming error at the call site, not a runtime condition to be handled - the
 * caller cannot recover by asking the user.
 */
export function requireProvenance<T extends object>(
  candidate: T,
  context: string,
): asserts candidate is T & { provenance: Provenance } {
  if (!hasProvenance(candidate)) {
    throw new Error(
      `Provenance required but absent (${context}). Design principle 8: every derived figure ships how it was derived.`,
    );
  }
}

/**
 * How a provenance renders where a human will read it, including in client-facing
 * deliverables. `unresearched_default` is labelled plainly and on purpose.
 */
export const describeProvenance = (provenance: Provenance): string => {
  switch (provenance.tag) {
    case 'issuer_rule':
      return `Issuer rule, verified ${provenance.lastVerified.toISOString().slice(0, 10)} by ${provenance.verifiedBy}`;
    case 'unresearched_default':
      return `Unresearched default - not verified against the issuer. ${provenance.rationale}`;
    case 'vendor_feed':
      return `${provenance.vendor} feed, retrieved ${provenance.retrievedAt.toISOString().slice(0, 10)}`;
  }
};

/** True when the figure rests on an assumption a client should be told is an assumption. */
export const isUnverified = (provenance: Provenance): boolean =>
  provenance.tag === 'unresearched_default';
