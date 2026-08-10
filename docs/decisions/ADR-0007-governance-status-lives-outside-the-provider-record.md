# ADR-0007 — Governance status lives outside the provider record, and standing is derived

**Status:** Accepted · **Date:** 2026-08-10
**Modules:** 5.2 Lender Intelligence Database, 5.3 Funding Recommendation Engine, 5.4 Capital
Product Governance Board

## Context

Blueprint 5.4 requires that a provider be approved by the Capital Product Governance Board before
any agent may recommend it, with a "periodic re-review cadence (quarterly minimum)" and blacklist
propagation to 5.3.

The obvious implementation is one that most systems reach for:

- a `governanceStatus` column on the provider record, and
- a nightly job that flips approved providers to an overdue status once their review lapses.

Both are simpler than what was built. Both have a failure mode that is silent.

## Decision

**1. Governance status lives in its own schema (`governance`), keyed by provider id, with no
foreign key into `lenders`.**

A provider the board has never seen has no governance row at all. Absence resolves to _not
approved_, so the safe default is structural rather than a default value somebody can edit. The
Lender Intelligence Database — the module that _describes_ providers — has no field with which to
mark one usable.

**2. Recommendability is derived at read time, never stored.**

`standing(providerId, snapshot, today, state)` is a pure function computing the verdict from the
status, `lastReviewedAt`, the cadence and the current date. There is no persisted "overdue" flag
and no job that maintains one.

**3. State restrictions are pulled, not pushed.**

The Regulatory Engine (category 7) reads `stateRestrictions()` when it needs them, rather than
receiving a propagated copy it has to keep in sync.

## Consequences

### What this buys

A stored status column lets the wrong module decide the most consequential question in the system.
Splitting the schemas means an agent that can write provider intelligence still cannot make a
provider recommendable — not by policy, but because the column is not there to write.

The derived cadence removes an entire class of silent failure. A nightly job that stops leaves
every stale provider reading as approved, and _nothing changes_ — no error, no alert, no
difference in any query. The system's most load-bearing claim, **this provider was reviewed
recently**, decays with no signal. Deriving it means a provider reviewed 91 days ago is overdue the
moment it is asked about, on every machine, including one switched off for a month.

The same argument retires the propagation queue. A push needs a retry and a reconciliation job to
answer "did the engine receive it?", and each can lag — so a provider blacklisted on Monday might
still be recommendable on Tuesday. A pull has no lag to have.

### What it costs

Every recommendation request reads governance rows for its candidates. `standingFor()` batches
them into one query, and a tenant's provider catalogue is tens of rows, not millions. If that ever
stops being true, the answer is a cache with an explicit TTL — not a stored flag, because the
staleness would become invisible again.

`reviewQueue()` loads approved providers and filters them in memory rather than expressing the
cadence as a SQL date predicate. That is deliberate: the queue is built by asking `standing()`,
so the board's working queue and the gate that blocks recommendations cannot disagree about what
overdue means. Two definitions would drift, and the drift would favour whichever one was wrong.

## Alternatives rejected

**Status column on the provider, cadence job nightly.** Simplest, and both failure modes above are
silent. Rejected.

**Status column plus a database trigger for staleness.** Removes the job, keeps the coupling, and
puts business policy in a place nobody reviews. Rejected.

**Event-sourced governance with a projection.** The Ledger already carries every decision, so this
is nearly free — and the projection is a cache that can lag, which is the problem being solved.
The decision rows are the queryable minute book; the Ledger is the tamper-evident chain. Both are
written on every transition, and neither is a projection of the other.

## Related

Decision D is enforced in `approve()` rather than at registration: recording what we know about a
deferred credit union is the V1.5 research work and should not be blocked, while deciding that
agents may place clients there is a different act — and it is the one V1 restricts. See
`docs/m5-lender-intelligence-and-governance.md`.
