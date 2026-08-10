/**
 * @bwc/evidence - 7.1 Compliance Evidence Vault.
 *
 * This module owns almost nothing, and that is the design. Blueprint 7.1's data model names
 * authorizations, documents, approval logs, complaints, refunds and state transitions - every one
 * of which another module already holds. A version that copied them here would produce a second
 * version of each fact, drifting from the first, and the copy is the one a regulator would be
 * shown.
 *
 * What it does own is the record that an export happened: who took a copy of a client's file, when
 * and why. That fact exists nowhere else, and it is the one asked about when a file turns up
 * somewhere it should not have.
 *
 * The property that makes a generated file trustworthy is that IT NAMES WHAT IT COULD NOT INCLUDE.
 * Every source reports coverage, and `empty` is distinguished from `not_built`: "this client has no
 * complaints" and "we have no complaints module" both produce zero rows, and a reader shown the
 * first when the second is true has been misled by an omission nobody intended.
 *
 * Nothing imports this package, so its wide dependency list cannot create a cycle. Evidence flows
 * in; nothing flows out.
 */

export * from './sources.js';
export * from './assemble.js';
export * from './export.js';
