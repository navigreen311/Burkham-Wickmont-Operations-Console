/**
 * @bwc/admin - 11.7 Admin Configuration Center.
 *
 * THE DECISION THIS PACKAGE TURNS ON: a configuration surface must not be able to turn a control
 * off. Blueprint 11.7 lists "authority levels" and "state rules" among the configurable things,
 * which taken literally is a screen where somebody sets the TCPA quiet-hours window to 24 hours or
 * adds `guarantee_approval` to the permitted-action list.
 *
 * So every tunable constant is a PARAMETER (a policy choice, bounded and audited) or an INVARIANT
 * (law, or something the architecture depends on). Invariants are not permission-gated - they are
 * ABSENT. A "Level 4 required" flag would be a permission somebody eventually holds, and the
 * person most likely to hold it is the one under pressure to make a number move.
 *
 * There is no table of current values. The effective value is the latest applied change or the
 * compiled default, so the audit trail IS the store and nothing has to keep two copies in step.
 */

export * from './registry.js';
export * from './settings.js';
