# ADR-0003 — Postgres-backed task queue for the Workflow Engine

**Status:** Accepted
**Date:** 2026-08-10
**Context documents:** Blueprint 2.2, Specification v2 §5.3, §10.1, §10.5

## Context

Decision C makes the Console the runner for all workflows, and blueprint 2.2 estimates the
Workflow Engine at 25–35% of V1 effort. It needs a durable task queue, a wait-state manager for
workflows that sleep **weeks or months**, retry with backoff and dead-lettering, and "recovery
from failure at task boundaries."

Memurai (Redis-compatible) is already running on the development machine, so BullMQ was the
obvious first candidate.

## Options considered

**A. BullMQ on Memurai/Redis.** Mature and well-understood: delayed jobs, backoff, repeatable
cron jobs, dead-letter sets. The problem is that it puts workflow state in a _second durability
domain_. A job in Redis and a `WorkflowInstance` row in Postgres can disagree after a crash, and
reconciling them is precisely the "recovery at task boundaries" problem we were trying to solve —
now with two systems instead of one. Multi-month delayed jobs also depend on Redis persistence
holding for months, which is not what Redis is for.

**B. Postgres queue using `FOR UPDATE SKIP LOCKED`.** _(chosen)_ One durability domain.
Enqueueing a task, transitioning an instance, and appending the ledger event happen in a single
transaction, so a crash cannot leave them disagreeing. A wait state is a row with a future
`runAt`; ninety days is the same code path as ninety seconds. `SKIP LOCKED` lets concurrent
workers take disjoint batches without blocking. Crash recovery is a lease with a reclaim sweep.

**C. Hybrid** — Postgres as source of truth, Redis as a dispatch accelerator. The right answer if
throughput ever demands it, and two systems to operate today for no measured benefit.

## Decision

Option B. `packages/workflow/src/queue.ts`.

Throughput is not the binding constraint here and it is worth being explicit about why: this
system serves thousands of clients with monthly deliverables, quarterly reviews, and promo-expiry
alerts. That is a workload measured in tasks per minute, several orders of magnitude below where
Postgres queueing strains. What _is_ binding is auditability and single-domain durability, which
is where option B wins outright.

## Consequences

**Good.** Task state, instance state, and the Event Ledger commit together. A wait state needs no
special mechanism. Operationally there is one thing to back up, restore, and reason about. Every
queue property is testable against an injected clock rather than a real one.

**Bad.** Claiming is raw SQL, because Prisma has no `SKIP LOCKED` — so the queue is the one place
in the codebase not covered by Prisma's type checking. Contained to one file and covered by
tests that assert against Prisma's own view of the same rows.

Polling latency is bounded by the tick interval rather than push-driven. For workflows whose
units are days and months, this does not matter.

**A sharp edge this exposed.** Prisma maps `DateTime` to a naive `timestamp(3)` holding UTC, and
binding a JS `Date` into raw SQL sends a _timestamptz_ — so Postgres converts through the session
timezone and the comparison shifts by the local UTC offset. Nothing errors; the claim query
simply returns the wrong rows, and on a UTC machine it looks correct. Timestamps now cross into
raw SQL as ISO strings cast to `timestamp`, and
`tests/invariants/raw-sql-timestamps.test.ts` asserts raw SQL and Prisma agree on which tasks are
due. Recorded in `CLAUDE.md` as well, because the next raw query will face the same trap.

**Revisit when:** a measured claim-latency or contention problem appears, or a workload arrives
whose natural unit is seconds rather than hours. Option C is the migration path and it does not
require rewriting callers.
