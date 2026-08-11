/**
 * @bwc/retention - 7.5 Legal Hold & Record Retention.
 *
 * The vault (3.2) has been refusing to destroy documents since it was built, honestly and for two
 * different reasons: one under legal hold, and one with no resolved retention schedule - the second
 * saying plainly that 7.2 and 7.5 did not exist. This module is what those refusals were waiting
 * for.
 *
 * The design is one asymmetry, stated twice because both halves are easy to get backwards:
 *
 *   **A hold is a matter, not a flag on a document.** It is evaluated at the moment of the
 *   decision, never propagated onto rows - so a statement uploaded the morning after a litigation
 *   hold is covered by it without anybody re-running anything. The propagating version is the
 *   classic way an organisation destroys evidence while believing it preserved it.
 *
 *   **A schedule is an authorisation, so its absence blocks.** Absence of a hold means not held;
 *   absence of a schedule means not permitted to delete. Both are ADR-0007's "absence is not
 *   permission" - a hold restricts and a schedule permits, so silence reads opposite for each.
 *
 * Nothing here destroys anything. The vault owns the bytes and owns the destruction; a second
 * deletion path in this module would be exactly the second door ADR-0034 is about, on the one
 * operation in this system that cannot be undone.
 */

export * from './holds.js';
export * from './schedules.js';
export * from './deletion.js';
