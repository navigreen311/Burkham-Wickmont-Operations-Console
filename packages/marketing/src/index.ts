/**
 * @bwc/marketing - 4.5 Marketing Ops.
 *
 * A governance layer, not a marketing tool. Blueprint 4.5 describes it as governance "over content
 * produced via SelfPublisherForge / AnimaForge / VideoEditForge cascades" - content nobody read
 * before it arrived - so the scan happens at the boundary rather than being left to a reviewer to
 * remember.
 *
 * Two decisions worth knowing before reading further:
 *
 *   AN A/B TEST WHOSE ARMS DIFFER IN COMPLIANCE IS AN EXPERIMENT ON WHETHER NON-COMPLIANT LANGUAGE
 *   CONVERTS BETTER. It does. So every variant must scan clean BEFORE the test runs, and a variant
 *   that does not is refused rather than registered as the arm we expect to lose - while the test
 *   runs, real clients read it.
 *
 *   THIS MODULE DOES NOT WRITE ATTRIBUTION. A campaign owns a channel VALUE and hands it out;
 *   1.3 writes it once, because a referral fee is owed on it.
 */

export * from './campaigns.js';
export * from './proposals.js';
export * from './experiments.js';
