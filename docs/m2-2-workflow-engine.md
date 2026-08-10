# Module 2.2 — Workflow Engine (core)

The orchestration backbone for the five-phase service delivery model. Decision C: the Console is
the runner for **all** workflows; CapitalForge's saved-but-never-executed workflow store is legacy
and is never read.

Also lands **11.4 Notification & Task Queue**, which Specification v2 §5.3 names as the substrate
the Engine's task queue runs on.

## What is built

| §5.3 component            | Status                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Task queue                | Built — Postgres-backed, `FOR UPDATE SKIP LOCKED`, leases with reclaim (ADR-0003)     |
| Wait-state manager        | Built — a wait is a row with a future `runAt`; 90 days is the same path as 90 seconds |
| Retry and failure policy  | Built — exponential backoff capped at 24h, dead-letter on exhaustion                  |
| Decision point evaluation | Built — declarative predicates, no `eval`                                             |
| Escalation routing        | Built — SLA breach escalates once and notifies compliance                             |
| Scheduler                 | **Next slice** — the `ScheduledWorkflow` registry exists; cron evaluation does not    |
| Event listener            | **Next slice** — event-waits park correctly and report what they await                |

## Playbooks

A playbook is a versioned node graph, stored as JSON.

```ts
startNode: 'collect_documents'
nodes: {
  collect_documents: { kind: 'agent_task', department: 'capital_readiness',
                       action: 'Collect Phase 0 intake documents', slaMinutes: 60, next: 'assess' },
  assess:            { kind: 'decision',
                       branches: [{ when: { field: 'client.complianceState',
                                            op: 'in', value: ['pass', 'pass_with_findings'] },
                                    next: 'cooling_period' }],
                       otherwise: 'route_to_review' },
  cooling_period:    { kind: 'wait', until: { durationMinutes: 129600 }, next: 'blueprint_review' },
  blueprint_review:  { kind: 'human_checkpoint', queue: 'compliance_and_evidence',
                       summary: 'Readiness Blueprint review call', next: 'done' },
  done:              { kind: 'terminal', outcome: 'completed' },
}
```

**Validated at publish, not at execution.** A dangling `next` found three weeks into a client
engagement fails mid-workflow; found at publish it is an authoring error with nothing at stake.
`validate()` also reports unreachable nodes and a graph with no terminal.

**Versions are pinned at start.** Publishing v2 does not re-route an instance already running v1.
The engagement a client is in is the one they were assessed under; changing the rules mid-flight
is a human decision, not a side effect of a publish.

## Decision predicates are declarative, never `eval`

Playbooks are editable by non-technical admins through the Playbook Builder (2.5) and stored as
JSON. If a branch condition were an expression string, publishing a playbook would be a
code-execution path into a system holding SSNs and bank data. There is no `eval`, no `Function`,
and no template interpolation.

Operators: `eq` `neq` `in` `not_in` `gt` `gte` `lt` `lte` `exists` `not_exists`, composed with
`all` / `any` / `not`. Only three roots are reachable — `client`, `context`, `instance` — and
prototype keys are rejected outright.

Two deliberate refusals:

- **Ordered comparison is numbers and dates only.** `gte` on strings would give lexicographic
  ordering, and a playbook comparing compliance states that way would reintroduce exactly the
  ranking Decision E removed.
- **A malformed predicate refuses rather than evaluating false.** Treating it as false takes the
  `otherwise` branch — a workflow quietly running the wrong path, which is worse than one that
  stops and says the playbook is broken.

## The worker tick

```
reclaim expired leases  ->  escalate SLA breaches  ->  claim due tasks  ->  execute
```

Idempotent, safe to run concurrently, and callable directly with an explicit `now`. The clock is
a parameter throughout — a wait of 90 days is untestable against a real clock, and a scheduler
tested with `sleep` is slow and flaky.

`agent_task` and `human_checkpoint` are **dispatched, not executed**: the Engine raises a
notification and parks the task, and completion arrives via `completeExternalTask`. The Engine
deliberately does not perform the work, because doing so would route around the middleware chain
and its Authority Level check.

## Failure handling

Every failure writes a ledger event — §10.5 requires zero silent workflow failures, and "the
retry succeeded so nobody needed to know" is how a degrading integration stays invisible until it
fails permanently.

- Retry with exponential backoff from the task's `backoffSeconds`, capped at 24 hours.
- On exhaustion: `dead_letter`, plus `workflow.task_dead_lettered` and `workflow.failed`, and the
  instance is marked `failed`. Leaving it `running` with nothing left to run is the silent stall
  the specification counts as a failure.
- A crashed worker's task is reclaimed via lease expiry. **Attempts are not reset** — a task that
  kills every worker must exhaust its retries rather than loop forever.

## Events written

`workflow.started` · `workflow.completed` · `workflow.cancelled` · `workflow.failed` ·
`workflow.task_dispatched` · `workflow.task_succeeded` · `workflow.task_failed` ·
`workflow.task_retry_scheduled` · `workflow.task_dead_lettered` · `workflow.task_lease_reclaimed` ·
`workflow.decision_evaluated` · `workflow.wait_started` · `workflow.wait_resolved` ·
`workflow.sla_breached` · `notification.raised` · `notification.completed`

## Tenant scoping

`tick`, `claim`, `reclaimExpiredLeases` and `breachedSlas` take an optional `tenantId`. Omitted,
a worker processes every tenant, which is the right default for a single pool. Supplied, it keeps
one tenant's backlog from filling every batch and starving the others.

## Testing

```bash
pnpm test:invariants   # includes queue, predicate and raw-SQL-timestamp invariants
pnpm test              # 84 tests
```

Notable coverage: concurrent claim is exclusive; a dead worker's task is reclaimed and not lost;
attempts survive reclaim so a poison task still dead-letters; a dead-lettered task never runs
again; every failure/retry/dead-letter writes a ledger event; a 90-day wait does not resolve at
89 days; an instance keeps its pinned version when a new one is published; SLA escalates exactly
once.

## Known gaps

- **No scheduler and no event listener yet.** `ScheduledWorkflow` rows are inert; event-waits park
  and report what they await but nothing resolves them. Next slice.
- **No worker process.** `tick()` is exported and tested but nothing runs it on an interval yet;
  wiring it to a runtime belongs with the scheduler.
- **Claiming is raw SQL** — the one place outside Prisma's type checking. Contained to one file
  and cross-checked against Prisma's own view in `tests/invariants/raw-sql-timestamps.test.ts`.
- **No Playbook Builder** (2.5). Playbooks are published through `publishPlaybook()` in code.
- **Playbooks are not tenant-scoped.** They are the operating company's own definitions. If
  white-label partners ever need their own, this becomes a real modelling decision.
