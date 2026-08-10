/**
 * @bwc/graph - 1.2 Client Household / Entity Graph.
 *
 * The question this module exists to answer is the one clients cannot answer themselves: what am
 * I personally on the hook for, in total? Each guarantee was reasonable when it was signed, and
 * nobody holds the sum - so the first lender to ask gets an answer that is wrong.
 *
 * Two things are worth knowing before reading further.
 *
 * Detection produces QUESTIONS, not conclusions. Every signal available here has an innocent
 * explanation that is usually the true one, so a finding carries the question to put to the
 * client and has no field in which a verdict could be recorded.
 *
 * SSN and EIN never enter a Graph value. The store holds ciphertext and hands out a display
 * last-4, so no traversal, finding or ledger payload can include one - not because each of them
 * strips it, but because they were never given it.
 */

export * from './model.js';
export * from './traverse.js';
export * from './exposure.js';
export * from './detect.js';
export * from './risk.js';
export * from './profile.js';
export * from './store.js';
