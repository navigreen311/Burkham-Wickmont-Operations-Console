/**
 * @bwc/observability - 11.8 System Health & Observability.
 *
 * THE DECISION THIS PACKAGE TURNS ON: `unmonitored` is a state, and it is not green.
 *
 * 9.1 established that `null` is not zero. The argument lands harder here, because the default
 * rendering of "no data" on a health dashboard is a green tick and the person reading it is
 * deciding whether to go home. A component with no probe says so, in the same shape as one that is
 * failing - rather than being absent from the list, which reads as nothing to report.
 *
 * The `healthy` constructor takes a MEASUREMENT as a required argument, so there is no way to
 * report a component as working without saying what was measured.
 *
 * Blueprint 11.8 names twelve things to monitor. Four are genuinely measurable from 11.3 and 11.4;
 * the rest are `unmonitored` with what would measure them. That ratio is the honest state of a
 * system with no metrics backend.
 */

export * from './probes.js';
export * from './vendors.js';
export * from './health.js';
