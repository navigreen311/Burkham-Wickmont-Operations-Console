/**
 * Evidence sources - blueprint 7.1.
 *
 * The heart of the module, and the reason it works differently from every other package here:
 * **7.1 owns almost nothing.** Every line of its data model names something another module already
 * holds, so this file is a registry of where to look rather than a store of what was found.
 *
 * Each source reports a **coverage verdict** alongside its items, and that is the design:
 *
 *   `complete`   consulted; returned everything it holds
 *   `empty`      consulted; holds nothing for this client
 *   `not_built`  the module does not exist yet
 *   `failed`     consulted and errored
 *
 * `empty` and `not_built` are different claims and the file says which. "This client has no
 * complaints" and "we have no complaints module" both produce zero rows, and a regulator reading
 * the first when the second is true has been misled by an omission nobody intended.
 *
 * Design principle 9, applied at the level of a whole document rather than a single function.
 */

export type Coverage = 'complete' | 'empty' | 'not_built' | 'failed';

export interface SourceResult {
  /** The evidence itself. Shapes differ per source; the file carries them as recorded. */
  readonly items: readonly unknown[];
  readonly coverage: Coverage;
  /** Why the coverage is what it is. Always present, including on `complete`. */
  readonly note: string;
}

export interface EvidenceSource {
  /** Stable key, so a coverage map can be compared across exports. */
  readonly key: string;
  /** The blueprint module this evidence comes from, for a reader tracing a gap. */
  readonly module: string;
  readonly description: string;
  readonly fetch: (context: SourceContext) => Promise<SourceResult>;
}

export interface SourceContext {
  readonly tenantId: string;
  readonly clientId: string;
  /** Present for an engagement-scoped file. Sources that cannot narrow say so in their note. */
  readonly engagementId?: string;
}

/** Convenience for the common shape: some rows, or none. */
export const fromRows = (rows: readonly unknown[], whenEmpty: string): SourceResult =>
  rows.length > 0
    ? { items: rows, coverage: 'complete', note: `${rows.length} record(s).` }
    : { items: [], coverage: 'empty', note: whenEmpty };

/**
 * A source for a module that does not exist yet.
 *
 * Carried into the file rather than omitted from the registry, which is the whole point: a
 * regulator-ready file that silently lacks a section asserts a completeness it does not have.
 */
export const notBuiltSource = (
  key: string,
  module: string,
  description: string,
  reason: string,
): EvidenceSource => ({
  key,
  module,
  description,
  fetch: async () => ({ items: [], coverage: 'not_built', note: reason }),
});

/**
 * Run a source, converting a throw into a `failed` coverage entry.
 *
 * Sources are independent on purpose. Abandoning the whole assembly because one source errored
 * would make the file unavailable exactly when something is already wrong - which is when it is
 * most likely to be wanted.
 */
export const runSource = async (
  source: EvidenceSource,
  context: SourceContext,
): Promise<SourceResult> => {
  try {
    return await source.fetch(context);
  } catch (error) {
    return {
      items: [],
      coverage: 'failed',
      note: `The source errored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
