# The shared rate-limit store

Module: 11.1 Identity & Access (for 11.10) · Schema: `identity` ·
ADR: [0025](adr/0025-a-shared-counter-is-one-statement.md)

The last of the three gaps #27 named. The limiter's window lived in process memory and said so in
its own header: **two instances means twice the limit, and a restart clears every counter.**

Three replicas give an attacker three times the sign-in budget. **Neither failure is visible from
inside any one process** — every instance is enforcing the limit it was configured with, on the
fraction of traffic it happens to receive.

---

## Postgres, not Redis

The instinct is that a limiter must not touch the database — the point of running it first is to
spend as little as possible on an attacker.

Right for a limiter protecting a static asset, wrong here. **This one protects a scrypt
verification**: N=2^15, 64 MiB, ~100ms. An indexed upsert is ~1ms. A limiter two orders of magnitude
cheaper than what it prevents is doing its job.

### The decisive reason is not speed

Every shared limiter must answer: **when the store is unavailable, fail open or fail closed?**

|              | Fail open                              | Fail closed                                                                  |
| ------------ | -------------------------------------- | ---------------------------------------------------------------------------- |
| **Redis**    | An outage silently removes the control | An outage locks every client out — while sign-in would otherwise have worked |
| **Postgres** | —                                      | **Costs nothing that was not already lost**                                  |

Sign-in needs the same database to read the user, verify the password and issue a session. If the
counter is unreachable, the thing being protected is already unavailable. **The dilemma is removed by
the choice of store rather than papered over by a policy** — which is the better kind of answer,
because there is nothing left to get wrong later.

## One statement, because a counter is a read-modify-write

Two instances that both read 4 and both write 5 have let six requests through on a limit of five —
and **a sequential test cannot see it**. It only appears when requests overlap, which is exactly when
an attack is happening.

```sql
INSERT INTO identity.rate_limit_counters (...) VALUES (...)
ON CONFLICT ("id") DO UPDATE SET
  "attempts" = CASE WHEN "windowStartedAt" <= cutoff THEN 1 ELSE "attempts" + 1 END,
  ...
RETURNING "attempts", "windowStartedAt"
```

Atomic in Postgres. No transaction, no advisory lock, no read-then-write. The window rolls inside the
same statement, so a rolled window is neither a second row nor a second round trip.

Timestamps bind as ISO strings cast to `::timestamp`, never as JS `Date`s — a `Date` goes as
`timestamptz` against a naive `timestamp(3)` column and Postgres shifts the comparison by the session
timezone: wrong rows, no error, invisible on a UTC machine.

**The test fires ten overlapping requests through two limiters and asserts exactly three were allowed
on a limit of three.** Swapping the statement for the obvious read-then-write version makes it report
**five allowed and ten attempts counted as six** — the bug, reproduced on demand.

## The counter lives in `identity`

11.1 already owns the other half: per-account lockout counts the victim, per-source rate limiting
counts the attacker. Two halves of one answer, and one schema is what stops somebody changing one
without seeing the other.

## The store is chosen, never defaulted

`PORTAL_RATE_LIMIT_STORE` has no default and the app refuses to start without it — the same reason
`PORTAL_TRUST_PROXY` has none: **both are settings whose wrong value produces a system that looks
like it is enforcing a control and is not.**

| Value    | When                                                                                |
| -------- | ----------------------------------------------------------------------------------- |
| `memory` | Exactly one instance. Still supported, still correct there, and costs no round trip |
| `shared` | More than one. The counter lives in Postgres                                        |

Both limiters — sign-in and password reset — are built by one factory from that one setting. A
deployment with one shared and one per-process would be enforcing two different things and reporting
neither.

## What did not change

**Fixed window**, including its boundary burst of up to 2N across two adjacent windows. Changing the
algorithm and the storage in one slice would make it impossible to say which change caused a
difference in behaviour. The burst is stated, not fixed.

## Consequences

- **`RateLimiter.check` is async**, in memory too. Two interfaces would mean the transport choosing
  between them, which is how a deployment ends up on the wrong one.
- **`Retry-After` comes from the stored window start**, not the request — two instances answering
  about one counter must not tell a client two different things.
- **Swept on one write in a hundred**, not by a scheduled job. A job can stop, and **if this sweep
  stops the cost is disk rather than a broken limit** (ADR-0013's rule). An unswept row keeps
  counting correctly.
- **The key is an IP address and is stored as one.** A hash would look like pseudonymity and would
  not be any — IPv4 is four billion values, so an unsalted digest is a lookup table and a salted one
  needs a secret this table would then have to be given. What limits exposure is retention, and none
  of it reaches the Ledger or a log.

---

## Tested

12 tests in `tests/integration/shared-rate-limit.test.ts`, including two instances over real sockets.
Suite total **1022**.

| Mutation                                                     | Failures                          |
| ------------------------------------------------------------ | --------------------------------- |
| Read-then-write instead of one atomic statement              | 2 (**5 allowed on a limit of 3**) |
| The app ignores the configured store                         | 1                                 |
| `PORTAL_RATE_LIMIT_STORE` silently defaults                  | 1                                 |
| `Retry-After` from the request rather than the stored window | 1                                 |

## Not built

A sliding window. Redis. Rate limiting on the internal API — it is on a trusted network and its
caller problem is `x-actor-id`, not volume.
