# Plan — Module 2.2 Workflow Engine

**Blueprint:** 2.2 Workflow Engine · **Specification:** §5.3
**Also in scope:** 11.4 Notification & Task Queue (the substrate §5.3 says the task queue runs on)
**Branch:** `ai-feature/m2-2-workflow-engine-core`

---

## Mini-PRD

### Problem

The Workflow Engine is the orchestration backbone for the five-phase service delivery model, and
Decision C makes it load-bearing: the Console owns **all** workflow execution, and CapitalForge's
saved-but-never-executed workflow store is legacy the Console never reads. Blueprint 2.2 estimates
it at 25–35% of V1 engineering effort — the largest single build item.

Specification v2 §5.3 names seven required components:

| Component                 | Why it exists                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler                 | Recurring work — monthly Capital Command Briefs, 60/90-day promo expiry, quarterly reviews, lender-research staleness, annual partner recertification |
| Task queue                | Reliable dispatch to Village Agent Orchestration, on top of 11.4                                                                                      |
| Wait-state manager        | Workflows that sleep **weeks or months** for real-world events                                                                                        |
| Retry and failure policy  | Per-task retry, exponential backoff, dead-letter on exhaustion                                                                                        |
| Event listener            | Ledger-triggered workflow initiation                                                                                                                  |
| Decision point evaluation | Branching within playbook trees                                                                                                                       |
| Escalation routing        | SLA breaches, human approval, failure paths                                                                                                           |

### Users

- **Village agents** — receive tasks scoped to their department and phase.
- **Compliance officers** — receive human checkpoints and SLA escalations.
- **The business** — recurring deliverables fire on time without anyone remembering them.

### Success metrics

Specification v2 §10.1 and §10.5:

- Scheduled workflows fire on time; retries respect policy; wait-states resolve correctly.
- **Zero silent workflow failures** — every failure logged and routed per retry policy.
- Recovery from failure at task boundaries: a crashed worker loses no work and duplicates none.

### Constraints

- Principle 3 — every state change is an event. The Engine both writes to and listens to the Ledger.
- Principle 4 — dispatched work still passes the middleware chain; the Engine does not become a
  side door around Authority Levels.
- Principle 9 — a workflow that cannot proceed says so; it does not stall silently.
- Wait states of weeks-to-months are normal, not an edge case.

### Risks

| Risk                                              | Mitigation                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A task runs twice (double-dispatch after a crash) | Claim under `FOR UPDATE SKIP LOCKED`; lease with reclaim; task transition is transactional                                                        |
| A task is silently lost                           | Lease reclaim returns orphaned `running` tasks to `pending`; dead-letter is an explicit terminal state with a ledger event                        |
| Decision points become arbitrary code             | Declarative predicate language, no `eval`. See below                                                                                              |
| Ledger write contention                           | Ledger append is `Serializable` and per-tenant sequential; workflow events are frequent. Measured, not assumed — noted as a follow-up if it bites |
| Engine becomes an authority bypass                | Dispatch records intent; execution still goes through the chain                                                                                   |

---

## Key decision — queue substrate

**Option A: BullMQ on Memurai/Redis.** Mature, delayed jobs, backoff, repeatable cron jobs.
But it puts workflow state in a second durability domain: a job in Redis and an instance row in
Postgres can diverge, and reconciling them after a crash is exactly the "recovery at task
boundaries" problem the specification asks us to solve. Multi-month delayed jobs also sit
uncomfortably in Redis persistence.

**Option B: Postgres-backed queue using `FOR UPDATE SKIP LOCKED`.** _(recommended)_ One durability
domain. Enqueueing a task, transitioning an instance, and appending the ledger event are a single
transaction, so a crash cannot leave them disagreeing. A wait state is just a row with a future
`runAt` — weeks or months is the same code path as seconds. Throughput is far below where
Postgres queueing strains: this system serves thousands of clients with monthly deliverables, not
thousands of jobs per second.

**Option C: Hybrid** — Postgres as source of truth, Redis as dispatch accelerator. Right answer
later if throughput ever demands it; today it is two systems to operate for no measured gain.

**Recommendation: B.** Revisit if a measured bottleneck appears. ADR-0003.

---

## Decision points — declarative, never `eval`

Branching evaluates a small predicate language against client state, compliance state, and
workflow context:

```json
{
  "all": [
    { "field": "client.complianceState", "op": "in", "value": ["pass", "pass_with_findings"] },
    { "field": "context.documentsReceived", "op": "gte", "value": 3 }
  ]
}
```

`eval` or a JS expression string would be arbitrary code execution inside a compliance system,
reachable by anyone who can edit a playbook through the Playbook Builder (2.5). Declarative
predicates are auditable, safely storable, and diffable in a playbook version.

---

## Architecture

### Playbook as a node graph

```
Playbook (key, version, phase, status: draft | review | active)
  nodes: Record<nodeKey, Node>
  startNode: nodeKey

Node kinds:
  agent_task        department, action, slaMinutes, next
  human_checkpoint  queue, slaMinutes, next            -> Human Approval Console (2.4)
  decision          branches: [{ when: Predicate, next }], otherwise: next
  wait              until: { durationMinutes } | { event: EventType }, next
  terminal          outcome: completed | cancelled
```

### Data model — schema `workflow`

- `Playbook` — key + version unique, status, definition JSON, publishedAt
- `WorkflowInstance` — tenant, client, playbook key+version pinned at start, status, currentNodeKey,
  context JSON, startedAt, completedAt
- `WorkflowTask` — the queue row: instance, nodeKey, kind, status, department, priority, `runAt`,
  attempts, maxAttempts, backoff config, `leaseExpiresAt`, `lockedBy`, lastError, `slaDueAt`
- `ScheduledWorkflow` — recurring registry: key, playbookKey, cron, nextRunAt, lastRunAt, enabled

Task status: `pending → running → succeeded | failed → (retry) pending | dead_letter`, plus
`waiting` for wait nodes and `cancelled`.

**Version pinning matters.** An instance records the playbook version it started under, so
publishing a new version does not silently re-route workflows already in flight — the same
reasoning as the cert-suspension-on-amendment pattern.

### The worker tick

One idempotent function, run on an interval or invoked directly in tests:

1. **Reclaim** leases expired past their timeout → back to `pending` (crash recovery).
2. **Promote** due schedules → start instances.
3. **Claim** a batch of `pending` tasks where `runAt <= now` using `FOR UPDATE SKIP LOCKED`.
4. **Execute** each per node kind; decisions and waits resolve in-engine, agent tasks and human
   checkpoints dispatch through 11.4 and await external completion.
5. **Escalate** tasks past `slaDueAt`.

Injectable clock. A scheduler tested with `sleep` is a scheduler tested slowly and flakily;
`now()` as a parameter makes "three months later" a unit test.

---

## Test strategy

**Invariants:**

- A task is claimed by exactly one worker under concurrency.
- A crashed worker's in-flight task is reclaimed and not lost.
- Retries respect maxAttempts, then dead-letter — and **every** failure writes a ledger event
  (zero silent failures).
- Backoff grows exponentially and is capped.
- A wait state resolves only at or after its due time.
- An instance pins its playbook version; publishing a new version does not re-route it.
- Decision evaluation cannot execute arbitrary code; unknown operators refuse.
- A dead-lettered task never runs again.

**Integration:** a multi-node playbook runs start → decision → wait → checkpoint → terminal with a
controlled clock, and the ledger tells the whole story afterwards.

---

## Scope

**This slice:** playbook model and validation, instance lifecycle, durable task queue with
claim/lease/reclaim, retry + backoff + dead-letter, wait states, decision evaluation, escalation
on SLA breach, minimal 11.4 Notification & Task Queue, and the worker tick.

**Next slice (`m2-2-workflow-scheduler-listener`):** cron scheduler evaluation, Event-Ledger
listener for event-triggered starts and event-resolved waits, and the recurring registry wired to
real playbooks.

**Not in this module:** Playbook Builder UI (2.5), vertical/client-type playbook subtrees,
deliverable templates, Human Approval Console UI (2.4), department routing beyond a field.
