/**
 * The shared attempt counter behind per-source rate limiting - 11.1 Identity & Access.
 *
 * **In 11.1 because 11.1 already owns the other half of this control.** Per-account lockout counts
 * the victim; per-source rate limiting counts the attacker (ADR-0022). They are two halves of one
 * answer, and keeping the two counters in one module is what stops somebody changing one without
 * seeing the other.
 *
 * ## Why Postgres rather than Redis
 *
 * The instinct is that a limiter must not touch the database, because the point of running it first
 * is to spend as little as possible on an attacker. That is right for a limiter protecting a static
 * asset and wrong here: **this one protects a scrypt verification** - N=2^15, 64 MiB, about a
 * hundred milliseconds - and an indexed upsert is about one. A limiter two orders of magnitude
 * cheaper than what it prevents is doing its job.
 *
 * The decisive reason is not speed, though. **Every shared limiter has to answer whether it fails
 * open or closed when its store is unavailable**, and with Redis both answers are bad: Redis can be
 * down while Postgres is healthy, so failing open removes the control and failing closed locks out
 * clients who could otherwise have signed in. With Postgres the question dissolves - sign-in needs
 * this same database to read the user, verify the password and issue a session, so if the store is
 * unreachable the thing being protected is already unavailable. **The dilemma is removed by the
 * choice of store rather than papered over by a policy.**
 *
 * @see docs/adr/0025-a-shared-counter-is-one-statement.md
 */

import { db } from '@bwc/db';

export interface RateLimitOutcome {
  readonly attempts: number;
  /** When the window this attempt was counted in opened. */
  readonly windowStartedAt: Date;
}

/**
 * Count one attempt and return the running total.
 *
 * **One statement.** A counter is a read-modify-write, and two instances that both read 4 and both
 * write 5 have let six requests through on a limit of five - the whole class of bug a shared store
 * exists to prevent, and one a sequential test cannot see. `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING` is atomic in Postgres: no transaction, no advisory lock, no window in which two
 * sessions hold the same value.
 *
 * The window rolls inside the same statement. `CASE WHEN` compares the stored start against the
 * cutoff and either increments or resets, so a rolled window is not a second row and not a second
 * round trip.
 */
export const consumeRateLimit = async (input: {
  scope: string;
  key: string;
  windowSeconds: number;
  now: Date;
}): Promise<RateLimitOutcome> => {
  const id = `${input.scope}:${input.key}`;
  // Bound to timestamps as ISO strings cast to `timestamp`, never as JS Dates: Prisma sends a Date
  // as `timestamptz` against a naive `timestamp(3)` column, and Postgres then shifts the comparison
  // by the session timezone - wrong rows, no error, invisible on a UTC machine.
  const nowIso = input.now.toISOString();
  const cutoffIso = new Date(input.now.getTime() - input.windowSeconds * 1000).toISOString();

  const rows = await db().$queryRaw<{ attempts: number; windowStartedAt: Date }[]>`
    INSERT INTO identity.rate_limit_counters ("id", "attempts", "windowStartedAt", "updatedAt")
    VALUES (${id}, 1, ${nowIso}::timestamp, ${nowIso}::timestamp)
    ON CONFLICT ("id") DO UPDATE SET
      "attempts" = CASE
        WHEN identity.rate_limit_counters."windowStartedAt" <= ${cutoffIso}::timestamp THEN 1
        ELSE identity.rate_limit_counters."attempts" + 1
      END,
      "windowStartedAt" = CASE
        WHEN identity.rate_limit_counters."windowStartedAt" <= ${cutoffIso}::timestamp
          THEN ${nowIso}::timestamp
        ELSE identity.rate_limit_counters."windowStartedAt"
      END,
      "updatedAt" = ${nowIso}::timestamp
    RETURNING "attempts", "windowStartedAt"
  `;

  const row = rows[0];
  if (!row) {
    // Unreachable: the statement always returns the row it wrote. Stated rather than cast away,
    // because a limiter that silently returned "nothing" would read as "not over the limit".
    throw new Error('The rate-limit counter did not return a row.');
  }

  return { attempts: Number(row.attempts), windowStartedAt: row.windowStartedAt };
};

/**
 * Delete counters nobody has touched for a while.
 *
 * Rows are keyed by source, so the table grows with distinct sources seen rather than with traffic -
 * unbounded over a long enough time, which is why this exists.
 *
 * **If the sweep stops, the cost is disk rather than a broken limit** - ADR-0013's rule, that
 * staleness must move toward the safe answer. An unswept row keeps counting correctly; it simply
 * outlives its usefulness.
 *
 * Bounded per call so it cannot become a long-running delete on a table an unauthenticated path is
 * writing to.
 */
export const sweepRateLimits = async (input: {
  olderThanSeconds: number;
  now: Date;
  limit?: number;
}): Promise<number> => {
  const cutoffIso = new Date(input.now.getTime() - input.olderThanSeconds * 1000).toISOString();
  const limit = input.limit ?? 1000;

  const deleted = await db().$executeRaw`
    DELETE FROM identity.rate_limit_counters
    WHERE "id" IN (
      SELECT "id" FROM identity.rate_limit_counters
      WHERE "updatedAt" <= ${cutoffIso}::timestamp
      LIMIT ${limit}
    )
  `;

  return deleted;
};

/** What an access review or a test reads. Never a route. */
export const rateLimitCount = async (scope: string, key: string): Promise<number> => {
  const row = await db().rateLimitCounter.findFirst({ where: { id: `${scope}:${key}` } });
  return row?.attempts ?? 0;
};

/** Clear a scope. An operational escape hatch and a test seam; not reachable from a route. */
export const clearRateLimits = async (scope: string): Promise<number> =>
  db()
    .rateLimitCounter.deleteMany({ where: { id: { startsWith: `${scope}:` } } })
    .then((r) => r.count);
