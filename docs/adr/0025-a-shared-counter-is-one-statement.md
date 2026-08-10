# ADR-0025 — A shared counter is one statement, and the store that removes the fail-open question is the one already there

**Status:** Accepted · **Date:** 2026-08-14 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

ADR-0022 shipped per-IP rate limiting with its limitation written into its own header: the window is
held in process memory, **so two instances means twice the limit and a restart clears every
counter.**

Three replicas behind a load balancer give an attacker three times the sign-in budget, and a rolling
deploy hands them a clean slate. Neither is visible from inside any one process — every instance
believes it is enforcing the limit it was configured with, and it is, on the fraction of traffic it
happens to receive.

## Decision 1 — Postgres, not Redis

The instinct is that a limiter must not touch the database. The point of running it before anything
else on an unauthenticated path is to spend as little as possible on an attacker.

That instinct is right for a limiter protecting a static asset and wrong here. **This limiter
protects a scrypt verification** — N=2^15, 64 MiB, about a hundred milliseconds. An indexed upsert is
about one. A limiter two orders of magnitude cheaper than the thing it prevents is doing its job,
and the cost it adds is invisible next to the cost it avoids.

Redis would be faster still, and would be a new operational component, a new failure mode and a new
thing to secure, for a saving nobody could measure. ADR-0003 made the same call for the task queue.

## Decision 2 — sharing the store with the protected resource removes the fail-open question

Every shared limiter has to answer one thing: **when the store is unavailable, does it fail open or
closed?** Fail open and an outage silently removes the control. Fail closed and an outage locks every
client out of the portal.

With Redis this is a genuine dilemma, because **Redis can be down while Postgres is healthy** — and
then both answers are bad, and whichever is chosen is wrong in some real incident.

With Postgres it dissolves. Sign-in needs that same database to read the user, verify the password
and issue a session. If the counter is unreachable, the thing being protected is already
unavailable, so **failing closed costs nothing that was not already lost.** The dilemma is not
resolved by a clever policy; it is removed by the choice of store, which is the better kind of
answer because there is nothing left to get wrong later.

The limiter therefore fails closed, and it can do so without a caveat.

## Decision 3 — one statement, because a counter is a read-modify-write

Two instances that both read 4 and both write 5 have let six requests through on a limit of five.
That is the entire class of bug a shared store exists to prevent, and **a sequential test cannot see
it** — it only appears when requests overlap, which is exactly when an attack is happening.

So the increment is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, atomic in Postgres. No
transaction, no advisory lock, no read-then-write — [[feedback_postgres_lock_vs_snapshot]] is the
memory of what that path costs. The window rolls inside the same statement with `CASE WHEN`, so a
rolled window is neither a second row nor a second round trip.

The test fires ten overlapping requests through two limiters and asserts that **exactly three** were
allowed on a limit of three. Replacing the statement with the obvious read-then-write version makes
that test report **five allowed, and ten attempts counted as six** — the bug, reproduced.

Timestamps are bound as ISO strings cast to `::timestamp`, never as JS `Date`s:
[[feedback_prisma_raw_sql_timestamps]] — Prisma sends a `Date` as `timestamptz` against a naive
`timestamp(3)` column and Postgres then shifts the comparison by the session timezone. Wrong rows,
no error, invisible on a UTC machine.

## Decision 4 — the counter lives in the `identity` schema

11.1 already owns the other half of this control. Per-account lockout counts the victim; per-source
rate limiting counts the attacker (ADR-0022). They are two halves of one answer, and putting the two
counters in one schema is what stops somebody changing one without seeing the other.

## Decision 5 — the store is chosen, never defaulted

`PORTAL_RATE_LIMIT_STORE` has no default and the app refuses to start without it, for the reason
`PORTAL_TRUST_PROXY` has none: **both are settings whose wrong value produces a system that looks
like it is enforcing a control and is not**, and neither failure is visible from inside the process.

`memory` remains a supported answer rather than a deprecated one. For a single instance it is
correct, and it costs no round trip.

Both limiters are built by one factory from that one setting. A deployment with sign-in shared and
password reset per-process would be enforcing two different things and reporting neither.

## Consequences

**Semantics did not change.** Fixed window, same boundary burst of up to 2N across two adjacent
windows. Changing the algorithm and the storage in one slice would make it impossible to say which
change caused a difference in behaviour, so only the storage changed. The burst is stated, not
fixed.

**`RateLimiter.check` is now async**, including the in-memory implementation. Two interfaces — one
per implementation — would mean the transport choosing between them, which is how a deployment ends
up on the wrong one.

**`Retry-After` comes from the stored window start**, not from the request. Two instances answering
about one counter must not tell a client two different things.

**Rows are swept opportunistically**, on one write in a hundred, rather than by a scheduled job. A
job is a thing that can stop, and **if this sweep stops the cost is disk rather than a broken
limit** — ADR-0013's rule that staleness must move toward the safe answer. An unswept row keeps
counting correctly; it simply outlives its usefulness.

**The key is an IP address and it is stored as one.** A hash would look like pseudonymity and would
not be any: IPv4 is four billion values, so an unsalted digest is a lookup table, and a salted one
needs a secret this table would then have to be given. ADR-0020's rule applies — claiming anonymity
you do not have is worse than not claiming it. What limits the exposure is retention: rows live for
one window plus the sweep interval, and none of this reaches the Ledger or a log.

## Alternatives considered

**Redis.** Decision 1 and, more importantly, Decision 2 — it reintroduces a fail-open question that
Postgres does not have.

**A sliding window.** More accurate at the boundary and it needs per-request timestamps, which is a
row per request rather than a row per source. Not in the same slice as the storage change.

**Sticky sessions at the load balancer**, so one client always reaches one instance. It makes the
per-process counter correct for a _client_ and useless against an attacker, who is the party that
rotates addresses.

**A scheduled sweep job.** 11.4 could run it. A job that stops is invisible; the opportunistic sweep
is tied to the traffic that creates the rows.
