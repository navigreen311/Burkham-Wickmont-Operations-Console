# Plan — a shared rate-limit store

**Branch:** `ai-feature/shared-rate-limit` · **Follows:** MFA (merged, `ae98532`)

The last of the three gaps #27 named. The limiter's window lives in process memory, and it says so
in its own header: **two instances means twice the limit, and a restart clears every counter.**

---

## Mini-PRD

### Problem

Three replicas behind a load balancer give an attacker three times the sign-in budget, and a rolling
deploy hands them a clean slate. Neither is visible from inside any one process — every instance
believes it is enforcing the limit it was configured with.

### Success metrics

- Two independently constructed limiters, as two instances would be, share one counter.
- The count is correct under **concurrent** requests, not merely under sequential ones.
- The single-instance deployment can still run without a store, on purpose.
- The failure mode when the store is unavailable is stated and defensible.

### Risks

| Risk                                              | Mitigation                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Lost increments under concurrency**             | One atomic statement, never read-then-write                                              |
| A store outage locking every client out           | The store is the database sign-in already needs — see key decision 2                     |
| A per-request database round trip on the hot path | It protects a scrypt verification, which costs a hundred times more — see key decision 1 |
| The counter table growing without bound           | Swept on write; if the sweep stops, the cost is disk rather than a broken limit          |
| A silent downgrade to per-process counting        | The store is chosen by a setting with **no default**, as `PORTAL_TRUST_PROXY` is         |

---

## Key decision 1 — Postgres, not Redis

The instinct is that a limiter must not touch the database, because the point of running it first is
to spend as little as possible on an attacker.

That instinct is right for a limiter protecting a static asset and wrong here. **This limiter
protects a scrypt verification** — N=2^15, 64 MiB, about a hundred milliseconds. An indexed upsert is
about one. A limiter two orders of magnitude cheaper than the thing it prevents is doing its job.

Redis would be faster still and would be a new operational component, a new failure mode, and a new
thing to secure — for a saving that is invisible next to the work it is protecting. ADR-0003 made the
same call for the task queue and it has held.

## Key decision 2 — sharing the store with the protected resource makes the failure mode degenerate

Every shared limiter has to answer this: **when the store is unavailable, does it fail open or
closed?** Fail open and an outage removes the control. Fail closed and an outage locks out every
client.

With Redis this is a real dilemma, because Redis can be down while Postgres is healthy — and then
both answers are bad.

With Postgres it dissolves. Sign-in **needs the same database** to read the user, verify the
password and issue the session. If the store is unreachable, the thing being protected is already
unavailable, so failing closed costs nothing that was not already lost. **The dilemma is not solved,
it is removed**, and it is removed by the choice of store rather than by a clever policy.

## Key decision 3 — one statement, because a counter is a read-modify-write

Two instances that both read 4 and both write 5 have let six requests through on a limit of five.
That is the entire class of bug this slice exists to avoid, and it is not caught by a sequential
test.

So the increment is a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which Postgres executes
atomically. No transaction, no advisory lock, no read-then-write —
[[feedback_postgres_lock_vs_snapshot]] is the memory of what that costs.

The test drives concurrent requests through two limiters at once and asserts the total allowed equals
the limit exactly.

## Key decision 4 — the counter lives in the `identity` schema

11.1 already owns the other half of this control: per-account lockout. Rate limiting and lockout are
the two halves of one answer — one counts the victim, the other counts the attacker (ADR-0022) — and
putting the two counters in the same schema is what stops somebody changing one without seeing the
other.

## Semantics do not change

Fixed window, same as today, including its known boundary burst of up to 2N across two adjacent
windows. **Changing the algorithm and the storage in one slice would make it impossible to say which
change caused a difference in behaviour.** The burst is stated, not fixed.

---

## Architecture

```
packages/identity/src/rateLimit.ts    consumeRateLimit - one atomic upsert, and the sweep
apps/portal-api/src/limiter.ts        the interface, the in-memory implementation, and the shared one
apps/portal-api/src/config.ts         PORTAL_RATE_LIMIT_STORE, no default
prisma/schema.prisma                  RateLimitCounter, identity schema
```

`RateLimiter.check` becomes **async**, which is the one breaking change and an unavoidable one.

## Test strategy

- Two independently constructed shared limiters share a counter; two in-memory ones do not.
- **Concurrent** consumption never exceeds the limit.
- The window rolls, and the roll is per key.
- Retry-After is derived from the stored window rather than from the request.
- The sweep removes expired rows and leaves live ones.
- `PORTAL_RATE_LIMIT_STORE` refuses to default, and refuses a value it does not recognise.
- Over HTTP: a spray against one instance is counted by the other.

## Out of scope

A sliding window. Redis. Limiting the internal API, which is on a trusted network and whose caller
problem is `x-actor-id` rather than volume.
