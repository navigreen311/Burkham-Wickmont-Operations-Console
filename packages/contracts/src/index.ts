/**
 * @bwc/contracts - 7.3 Contract & Disclosure Builder.
 *
 * Generates the documents a client signs, from templates counsel reviewed, with clauses scoped to
 * the jurisdiction and disclosures inserted from the Regulatory Engine rather than retyped.
 *
 * Two properties are worth knowing before reading further.
 *
 * A GENERATED CONTRACT IS FROZEN. Blueprint 7.3's "auto-updates when Regulatory Engine flags rule
 * changes" is implemented as a derived staleness report plus different content in the NEXT
 * document. Nothing in this package updates an issued one: it is the only evidence of what was
 * agreed.
 *
 * DISCLOSURE WORDING HAS ONE HOME. `not_a_lender` and `no_guarantee` are clauses in 7.2's federal
 * baseline, inserted here by key. A second copy of those words maintained separately would not
 * become wrong so much as become ambiguous, and nobody could say which governed.
 */

export * from './templates.js';
export * from './clauses.js';
export * from './fee.js';
export * from './generate.js';
export * from './staleness.js';
