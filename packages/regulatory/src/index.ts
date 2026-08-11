/**
 * @bwc/regulatory - 7.2 State-by-State Regulatory Engine.
 *
 * Specification: "The Regulatory Engine is not a post-hoc check. No client-facing action fires
 * without state compliance checks having passed. State activation itself is gated."
 *
 * The activation gate is the module. Everything else here is a lookup table, and the gate is what
 * makes the table worth reading: a state with no activation row is not active, only a Level 3
 * human can change that, and the change requires a counsel review naming a document.
 *
 * Note what has no code path: nothing in this package lets an agent bring a state online, and
 * nothing lets a material rule change stay live without a fresh review.
 */

export * from './states.js';
export * from './activation.js';
export * from './disclosures.js';
export * from './check.js';
export * from './seed.js';
export * from './referralFees.js';
