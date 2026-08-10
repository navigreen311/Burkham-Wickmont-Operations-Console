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

/**
 * Timestamps in provenance are **ISO 8601 strings, not `Date`**.
 *
 * Provenance crosses a serialization boundary constantly: it is embedded in deliverable content
 * stored as JSON, and in ledger payloads stored as JSONB. A `Date` survives none of those round
 * trips - it comes back as a string, and any code calling `.toISOString()` on it throws. That
 * defect is invisible in a unit test that never persists, and fatal the first time a stored
 * deliverable is re-rendered.
 *
 * A type that crosses a JSON boundary should be JSON-native. `IsoTimestamp` is the honest shape.
 */
export type IsoTimestamp = string;

export const toIso = (value: Date | string): IsoTimestamp =>
  typeof value === 'string' ? value : value.toISOString();

/** A rule read from a named source that someone verified on a date. */
export interface IssuerRuleProvenance {
  readonly tag: 'issuer_rule';
  readonly sourceUrl: string;
  readonly lastVerified: IsoTimestamp;
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
  readonly retrievedAt: IsoTimestamp;
  readonly consentReference: string;
}

/**
 * A figure the client told us.
 *
 * Its own tag because it is none of the others: nobody assumed it, no issuer published it, no
 * vendor returned it - the client said it. Storing a self-reported revenue under `vendor_feed`
 * would present it identically to a Plaid-derived one, and under `unresearched_default` would
 * describe the client's own statement as our assumption. Both are Decision D's failure in
 * different clothing.
 *
 * Legitimate to hold and to act on. A client's stated revenue is often the only figure available
 * early in an engagement, and it is frequently correct. It just has to be labelled.
 */
export interface ClientStatedProvenance {
  readonly tag: 'client_stated';
  readonly statedBy: string;
  readonly statedAt: IsoTimestamp;
  /** A document backing the statement, where one exists. */
  readonly documentReference?: string;
}

export type Provenance =
  | IssuerRuleProvenance
  | UnresearchedDefaultProvenance
  | VendorFeedProvenance
  | ClientStatedProvenance;

export type ProvenanceTag = Provenance['tag'];

export const PROVENANCE_TAGS = [
  'issuer_rule',
  'unresearched_default',
  'vendor_feed',
  'client_stated',
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
      return `Issuer rule, verified ${provenance.lastVerified.slice(0, 10)} by ${provenance.verifiedBy}`;
    case 'unresearched_default':
      return `Unresearched default - not verified against the issuer. ${provenance.rationale}`;
    case 'vendor_feed':
      return `${provenance.vendor} feed, retrieved ${provenance.retrievedAt.slice(0, 10)}`;
    case 'client_stated':
      return `As stated by ${provenance.statedBy} on ${provenance.statedAt.slice(0, 10)}${
        provenance.documentReference !== undefined
          ? `, supported by ${provenance.documentReference}`
          : ' - not independently verified'
      }`;
  }
};

/**
 * True when the figure rests on something a client should be told is not independently verified.
 *
 * Covers `unresearched_default` (we assumed it) and `client_stated` (they told us). Both are
 * legitimate to act on and both must be labelled where they surface, including in client-facing
 * deliverables - which is the whole of Decision D's portfolio-wide provenance discipline.
 */
export const isUnverified = (provenance: Provenance): boolean =>
  provenance.tag === 'unresearched_default' || provenance.tag === 'client_stated';
