# Module 2.2 — Scheduler, Event Listener, and Worker Runtime

Completes module 2.2. All seven components from Specification v2 §5.3 now exist, and the Engine
runs on its own rather than only when a test calls it.

| §5.3 component            | Where                                 |
| ------------------------- | ------------------------------------- |
| Task queue                | `queue.ts` (core slice)               |
| Wait-state manager        | `queue.ts` + `engine.ts` (core slice) |
| Retry and failure policy  | `queue.ts` (core slice)               |
| Decision point evaluation | `predicate.ts` (core slice)           |
| Escalation routing        | `engine.ts` (core slice)              |
| **Scheduler**             | `scheduler.ts` — this slice           |
| **Event listener**        | `listener.ts` — this slice            |

Plus `worker.ts` and `apps/worker`, which are not a §5.3 component but are what makes the rest of
them run.

## Scheduler

Recurring work: monthly Capital Command Briefs, promo expiry alerts, quarterly reviews,
lender-research staleness, annual partner recertification.

```ts
await upsertSchedule({
  tenantId,
  key: 'monthly-capital-command-brief',
  playbookKey: 'capital-command-brief',
  cronExpression: '0 9 1 * *',
  timezone: 'America/Los_Angeles',
});
```

**Timezone is stored, not assumed** (ADR-0004). "Monthly on the 1st at 9am" is meaningless without
one, and defaulting to UTC would land every brief at 1am or 2am Pacific depending on the season.
`cron-parser` keeps the local hour across DST — `0 9 1 * *` in Los Angeles is `16:00Z` in summer
and `17:00Z` after the November transition.

**Claiming is a conditional update**, not a lock: the update matches the exact `nextRunAt` that
was read, so two workers racing produce one winner and one update-count of zero. Nothing to lease,
nothing to expire.

**Catch-up fires once.** A worker down for six months emits one brief on restart, not six. The
skipped windows are recorded as `workflow.schedule_late` — visible rather than silently absorbed.

A schedule whose cron or timezone cannot be evaluated, or whose playbook does not exist, is
**disabled and logged** rather than retried forever or skipped silently.

## Event listener

Ledger-triggered workflow initiation, and resolution of event-waits.

```ts
await upsertTrigger({
  tenantId,
  eventType: 'client.compliance_state_changed',
  playbookKey: 'compliance-escalation',
  condition: { field: 'context.to', op: 'eq', value: 'fail' },
});
```

Conditions use the same declarative predicate language as decision nodes — no `eval`, evaluated
against the event payload and the client it concerns.

**Exactly-once comes from a unique constraint, not the cursor.** `(triggerId, ledgerEventId)` is
unique; the listener inserts that pair _before_ starting anything. A crash between starting an
instance and advancing the cursor replays the event, the insert conflicts, and nothing starts
twice. The distinction matters here specifically: a duplicated workflow means duplicated client
outreach, and both instances look legitimate from inside the system.

**Each pass is bounded** by the max ledger `seq` read at the start. The listener writes ledger
events of its own, so without the bound a trigger on a `workflow.*` type could feed itself within
a single pass.

**`seekToLatest(tenantId)`** skips existing history. Registering a trigger should not fire it
retroactively across every event already in the Ledger — saving a configuration would otherwise
start a workflow per historical client.

**Event-waits resolve through the engine, not the listener.** The listener knows _that_ a wait is
satisfied; only the engine knows what comes next in the graph. A wait parked by a client-scoped
instance resolves only for events about that client — otherwise one client's document upload would
wake every other client's waiting workflow.

## Worker runtime

```
scheduler  ->  listener  ->  engine tick
```

Ordered deliberately: the scheduler and listener create instances whose first task is immediately
due, so ticking last executes them in the same pass. Ticking first would leave that work sitting
until the next interval, doubling the latency of every event-driven workflow.

A pass never overlaps itself — if one overruns the interval the next is skipped rather than
queued. A pass that throws is reported and the loop continues: one tenant's bad configuration must
not stop processing for everyone else.

### Running it

```bash
pnpm dev:worker          # tsx watch
pnpm worker              # built
```

| Variable             | Purpose                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORKER_ACTOR_ID`    | **Required.** Every ledger event carries an actor and principle 3 permits no anonymous state changes, so the worker acts as a real, resolvable actor. Startup refuses if it does not resolve. |
| `WORKER_INTERVAL_MS` | Pass interval (default 5000)                                                                                                                                                                  |
| `WORKER_BATCH_SIZE`  | Tasks claimed per tick (default 20)                                                                                                                                                           |
| `WORKER_TENANT_ID`   | Optional. Restrict to one tenant; omit to process all.                                                                                                                                        |

Verified live against the dev database — an overdue schedule and a `client.created` trigger, with
the worker started and left alone:

```
bwc-worker DESKTOP-...-29684 starting; interval=1500ms batch=20
scheduler(due=1 fired=1) listener(events=4 waits=0 triggers=1) engine(claimed=2 advanced=0 parked=2 failed=0) 50ms
scheduler(due=0 fired=0) listener(events=6 waits=0 triggers=0) engine(claimed=0 advanced=0 parked=0 failed=0) 9ms
```

Resulting ledger, chain intact at 10 entries:

```
#1 client.created          #6 workflow.trigger_fired
#2 workflow.schedule_late  #7 notification.raised
#3 workflow.started        #8 workflow.task_dispatched
#4 workflow.schedule_fired #9 notification.raised
#5 workflow.started        #10 workflow.task_dispatched
```

Idle passes log nothing — a line every five seconds saying nothing happened buries the lines that
matter.

## Tests

```bash
pnpm test              # 108 tests
pnpm test:invariants
```

Scheduler: DST wall-clock preservation, invalid cron and unknown timezone refused, fires once and
advances, catch-up fires once after a six-month outage and records lateness, concurrent passes
fire exactly once, disabled schedules do nothing, a missing playbook disables rather than loops.

Listener: trigger fires on a matching event; **a replayed event does not fire it twice** (cursor
rewound deliberately to simulate a crash); conditions gate firing; a malformed condition disables
the trigger; disabled triggers do nothing; a self-feeding trigger is refused; event-waits resolve
on their event and not on an unrelated one; another client's event does not wake a parked wait;
the listener terminates.

Worker: one pass carries a schedule from fire to dispatch; a trigger-started workflow reaches
completion across passes; the loop starts, runs, and stops cleanly with no pass arriving after
`stop()` resolves.

## Known gaps

- **No Playbook Builder** (2.5) — schedules, triggers and playbooks are registered in code.
- **No distributed coordination beyond claim semantics.** Multiple workers are safe (conditional
  update, `SKIP LOCKED`, unique constraints) but there is no leader election or work partitioning.
- **The listener reads a tenant's events with a filter in application code** rather than a bounded
  SQL range. Correct, and worth revisiting when a tenant's ledger is large.
- **Ledger write contention is still unmeasured** — append is `Serializable` and per-tenant
  sequential, and the worker now writes more events than anything before it.
