# Plan — Workflow Engine: scheduler, event listener, worker runtime

**Blueprint:** 2.2 Workflow Engine (remaining components) · **Specification:** §5.3, §10.1
**Branch:** `ai-feature/m2-2-workflow-scheduler-listener`
**Follows:** `m2-2-workflow-engine-core` (merged, commit `3d8d10f`)

---

## Mini-PRD

### Problem

The core slice built five of §5.3's seven components. Two remain, and without them the Engine
cannot start anything by itself:

- **Scheduler** — recurring work: monthly Capital Command Briefs, 60/90-day promo expiry alerts,
  quarterly reviews, lender-research staleness reviews, annual partner recertification.
- **Event listener** — Ledger-triggered initiation, and resolution of the event-waits that
  currently park and never wake.

There is also no **worker runtime**: `tick()` is exported and tested but nothing calls it on an
interval, so today the Engine only runs when a test runs it.

### Success metrics

Specification v2 §10.1: "scheduled workflows fire on time, retries respect policy, wait-states
resolve correctly." §10.5: zero silent workflow failures.

Concretely:

- A monthly schedule fires once per month, at the right local wall-clock time, across a DST change.
- A ledger event fires its trigger **exactly once**, even if the worker crashes mid-pass.
- An event-wait resolves when its event arrives and not before.

### Risks

| Risk                                                  | Mitigation                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A schedule fires twice (two workers, same due row)    | Claim the schedule row by conditional update on `nextRunAt`; the loser updates zero rows           |
| A trigger fires twice after a crash                   | `(triggerId, ledgerEventId)` unique constraint — insert-then-start, conflict means already handled |
| The listener loops forever on its own events          | Each pass is bounded by the max ledger `seq` captured at the start of the pass                     |
| A missed schedule silently never fires                | Catch-up fires once and advances to the next future occurrence, and logs that it was late          |
| Cron correctness (DST, month ends, dow/dom semantics) | `cron-parser`, not hand-rolled — see below                                                         |

---

## Key decision — cron evaluation

**A. Hand-rolled 5-field evaluator.** No dependency. But cron has genuinely subtle semantics:
day-of-month and day-of-week are OR'd when both are restricted, month lengths vary, and local
wall-clock schedules must survive DST transitions. A monthly Capital Command Brief firing an hour
early for half the year is a silent defect nobody reports.

**B. `cron-parser`.** _(recommended)_ Small, widely used, timezone-aware. Verified before adopting:

```
'0 9 1 * *' in America/Los_Angeles
  next -> 2026-09-01T16:00:00Z   (09:00 PDT)
  next -> 2026-10-01T16:00:00Z   (09:00 PDT)
  across the 2026-11-01 DST end -> 2026-11-01T17:00:00Z   (09:00 PST)
```

Wall-clock 09:00 is preserved across the transition, which is the behaviour a business schedule
needs and the thing a naive implementation gets wrong.

**Recommendation: B**, as a runtime `dependency` (not dev) — production installs with
`--omit=dev`, and a runtime import resolving only to a devDependency is the failure the sibling
platform already hit once.

### Timezone is a first-class field

"Monthly on the 1st at 9am" is meaningless without a timezone. `ScheduledWorkflow` gains a
`timezone` column. Defaulting silently to UTC would make every brief land at 1am or 2am Pacific
depending on the season.

---

## Architecture

### New data model (schema `workflow`)

- `ScheduledWorkflow` — **+ `timezone`**
- `WorkflowTrigger` — tenant, `eventType`, `playbookKey`, optional `condition` (the same
  declarative predicate language), enabled
- `WorkflowTriggerFiring` — `(triggerId, ledgerEventId)` **unique**; the idempotency record
- `LedgerCursor` — `(tenantId, consumer)` → `lastSeq`; how far the listener has read

### Scheduler pass

```
due = ScheduledWorkflow where enabled and nextRunAt <= now
for each:
  claim by conditional update (WHERE nextRunAt = <the value we read>)   -- loser updates 0 rows
  start the instance
  nextRunAt = cron.next(after: now, tz)                                 -- skips missed windows
```

Claiming by conditional update rather than a lock keeps the scheduler stateless: two workers can
race and exactly one wins, with no lease to expire.

**Catch-up policy: fire once, then skip to the next future occurrence.** A worker down for a week
should not emit seven monthly briefs on restart. The lateness is logged as a ledger event so the
gap is visible rather than erased.

### Listener pass

```
maxSeq = current max ledger seq for the tenant        -- bounds the pass; own writes wait
events = ledger where seq in (cursor, maxSeq]
for each event:
  resolve event-waits: tasks status=waiting on a wait node awaiting this event type
                       (matched on tenant, and on client when the node is client-scoped)
  fire triggers:       insert (triggerId, eventId) -> on conflict, skip; else start instance
cursor = maxSeq
```

Idempotency lives in the unique constraint, not in the cursor. A crash between starting an
instance and advancing the cursor replays the event, and the insert conflicts, so nothing starts
twice. That matters here specifically: a duplicated workflow means duplicated client outreach.

### Worker runtime

`packages/workflow/src/worker.ts` + `apps/worker`. One loop: `schedulerPass → listenerPass →
tick`, on an interval, with graceful shutdown on SIGINT/SIGTERM and a bounded in-flight pass so
shutdown does not abandon a claim.

---

## Test strategy

- A monthly schedule fires once, and the next `nextRunAt` is a month later at the same local hour.
- **A schedule crossing the DST boundary keeps its wall-clock time.**
- Two concurrent scheduler passes fire a due schedule exactly once.
- A worker down for three months fires once on restart, not three times, and logs the lateness.
- A ledger event fires its trigger once; replaying the same event fires nothing.
- A trigger with a condition fires only when the predicate holds.
- An event-wait resolves on its event and not on an unrelated one.
- The listener does not loop on the events it writes itself.
- A disabled schedule and a disabled trigger do nothing.

---

## Out of scope

Playbook Builder UI (2.5), the Human Approval Console UI (2.4), multi-channel notification
delivery (blocked on the Communication Compliance Scanner, 4.2), and distributed worker
coordination beyond what the claim semantics already give.
