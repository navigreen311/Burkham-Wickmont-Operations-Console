/**
 * @bwc/http - the Outcome-to-HTTP contract.
 *
 * Deliberately tiny, and deliberately a package rather than a file in one app. `apps/api` and
 * `apps/portal-api` are separate processes on separate trust boundaries; the one thing they must
 * agree on is what a refusal looks like on the wire.
 */

export * from './serialize.js';
