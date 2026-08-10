/**
 * Pseudonymous subject keys - blueprint 11.6's "historical retention independent of operational
 * data retention".
 *
 * Pure, so what the key is derived from is readable in one place.
 *
 * The warehouse keeps rows after the operational client record is gone. Those rows must still be
 * followable through time - a retention curve is worthless if the same client is a different row
 * each month - so each carries a stable key rather than a client id.
 *
 * **This is pseudonymisation, not anonymisation, and the difference matters.** The key is a
 * keyed hash of the tenant and client id. Somebody holding the operational client list can compute
 * every key and re-identify every row. What it prevents is the casual join: an analyst querying
 * the warehouse does not have client identifiers in front of them, and a warehouse extract shared
 * for analysis does not carry them.
 *
 * Claiming more than that would be worse than not doing it, because the claim is what somebody
 * would rely on when deciding where an extract may go.
 *
 * The key is derived with the Ledger's signing key rather than a plain hash, so re-identification
 * needs both the client list AND the key. That is a real improvement over a bare sha256 of a UUID,
 * and still not anonymity.
 */

import { createHmac } from 'node:crypto';

/**
 * A stable pseudonym for one client within one tenant.
 *
 * Keyed, so the mapping cannot be recomputed from the client id alone. Tenant-scoped, so the same
 * client id in two tenants - which cannot happen today, and might if ids are ever reused - would
 * not collide across them.
 */
export const subjectKeyFor = (tenantId: string, clientId: string, secret: string): string =>
  createHmac('sha256', secret).update(`${tenantId}:${clientId}`).digest('hex').slice(0, 32);

/**
 * The cohort a client belongs to: the month they were created.
 *
 * Month rather than week or quarter because a cohort needs enough members to mean something and
 * few enough periods to read. Fixed at capture and never recomputed - a client does not move
 * between cohorts, which is what makes a retention curve a curve.
 */
export const cohortFor = (createdAt: Date): string =>
  `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * What the subject key does and does not protect, in one place a reader can quote.
 *
 * Exported so it can travel with an extract rather than living only in a comment somebody has to
 * find. A limitation nobody can quote is a limitation that gets forgotten at the moment it
 * matters - which is when somebody is deciding whether an extract may leave the building.
 */
export const PSEUDONYMISATION_NOTE =
  'Subject keys are a keyed hash of tenant and client id. They are a PSEUDONYM, not anonymisation: anybody holding both the operational client list and the derivation key can re-identify every row. They prevent casual joining and make an analytical extract free of client identifiers; they do not make this data anonymous, and it should be handled as personal data.';
