/**
 * @bwc/warehouse - 11.6 Data Warehouse & Analytics Layer.
 *
 * THE DECISION: a warehouse answers questions about the PAST, not faster questions about the
 * present. ADR-0017 decided the dashboards read live and store nothing, and this does not overturn
 * it - it answers a different question. A live read tells you where clients stand today; it cannot
 * tell you where they stood in March, because those clients have moved and the operational store
 * keeps only the current value.
 *
 * So every read REQUIRES a historical period. There is no `current()`, which is what stops
 * anything quietly using this as a faster read of what 9.1 already answers live. Snapshots are
 * immutable: re-capturing a date is refused, because an overwritten snapshot is a rewritten
 * history.
 *
 * Retention outlives the operational record, so subject rows carry a PSEUDONYM rather than a
 * client id - and `PSEUDONYMISATION_NOTE` states the limits of that rather than overclaiming.
 */

export * from './subjects.js';
export * from './snapshot.js';
export * from './trends.js';
