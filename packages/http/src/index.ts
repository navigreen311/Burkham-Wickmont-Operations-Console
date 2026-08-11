/**
 * @bwc/http - the Outcome-to-HTTP contract.
 *
 * Deliberately small, and deliberately a package rather than a file in one app. `apps/api` and
 * `apps/portal-api` are separate processes on separate trust boundaries; what they must agree on is
 * what a refusal looks like on the wire - and, since the Console grew a sign-in of its own, how an
 * unauthenticated path is rate limited. A limiter copied into a second app is a second control.
 */

export * from './limiter.js';
export * from './serialize.js';
