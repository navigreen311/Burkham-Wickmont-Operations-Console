/**
 * @bwc/lenders - 5.2 Lender Intelligence Database.
 *
 * Blueprint 5.2 calls this a "defensible long-term asset". What makes it defensible is not
 * the list of lenders, which anyone can compile, but the provenance on every rule: an
 * `issuer_rule` read off the published terms and an `unresearched_default` somebody assumed
 * are stored differently and render differently, so they cannot be presented alike.
 *
 * Note what is *not* here. Nothing in this package can mark a provider recommendable -
 * there is no such field. Approval lives in @bwc/governance (5.4), in a different schema,
 * so a provider the board has never seen has no governance record at all and absence
 * resolves to "not approved".
 */

export * from './profile.js';
export * from './eligibility.js';
export * from './suitability.js';
export * from './catalogue.js';
export * from './performance.js';
export * from './research.js';
