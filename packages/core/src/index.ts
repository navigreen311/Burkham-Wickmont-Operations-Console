/**
 * @bwc/core - shared types and invariants for the Burkham Wickmont Operations Console.
 *
 * No I/O and no dependencies. Everything else in the monorepo builds on this, so a
 * dependency added here is a dependency added everywhere.
 *
 * The design principles this package makes structural rather than aspirational:
 *   3. Every state change is an event      -> events.ts
 *   4. Authority Levels via middleware     -> authority.ts
 *   8. Provenance on output                -> provenance.ts
 *   9. Honest empty states and refusals    -> outcome.ts
 *   Decision E: categorical compliance     -> compliance.ts
 *   PII never reaches logs or the Ledger   -> pii.ts
 */

export * from './outcome.js';
export * from './compliance.js';
export * from './jurisdiction.js';
export * from './authority.js';
export * from './provenance.js';
export * from './events.js';
export * from './pii.js';
