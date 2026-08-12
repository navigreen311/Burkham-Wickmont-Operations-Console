# ADR-0004 — `cron-parser` for schedule evaluation, and timezone as a stored field

**Status:** Accepted
**Date:** 2026-08-10
**Context documents:** Blueprint 2.2, Specification v2 §5.3, §10.1

## Context

The scheduler drives monthly Capital Command Briefs, 60/90-day promo expiry alerts, quarterly
reviews, lender-research staleness reviews, and annual partner recertification. §10.1 makes
"scheduled workflows fire on time" a success criterion.

The Console has so far avoided runtime dependencies outside Prisma, Express and Zod, so adding one
deserves a reason.

## Options considered

**A. Hand-rolled five-field evaluator.** No dependency, maybe eighty lines. Cron's semantics are
deceptively subtle:

- day-of-month and day-of-week are **OR'd** when both are restricted, not AND'd
- month lengths vary, so "the 31st" silently skips months
- a local wall-clock schedule must hold its hour across DST, which means the UTC instant has to
  move twice a year

Every one of those produces _silent wrongness_. A brief firing an hour early for half the year is
not something a client reports; it is something nobody notices.

**B. `cron-parser`.** _(chosen)_ Small, widely used, timezone-aware. Verified against the DST case
before adopting rather than after:

```
'0 9 1 * *' in America/Los_Angeles
  2026-09-01T16:00:00Z   09:00 PDT
  2026-10-01T16:00:00Z   09:00 PDT
  2026-11-01T17:00:00Z   09:00 PST   <- UTC instant moves, local hour holds
```

That is the behaviour a business schedule needs, and it is the case option A gets wrong.

## Decision

Adopt `cron-parser` as a **runtime dependency** of `@bwc/workflow` — declared on the package that
imports it, not only at the workspace root. Production installs with `--omit=dev`, and a runtime
import that resolves only through a devDependency is a failure the sibling platform has already
had once; pnpm's strict linking would surface it here, but declaring it correctly is the fix
rather than relying on the tool to catch it.

`nextOccurrence()` wraps it and returns an `Outcome` rather than throwing. An invalid expression
or unknown timezone is a configuration error the caller can report; a scheduler that throws on one
bad row stops processing every other tenant's schedules.

### Timezone is a stored field, not a default

`ScheduledWorkflow.timezone` (IANA). "Monthly on the 1st at 9am" is meaningless without one, and
silently defaulting to UTC would land every Capital Command Brief at 1am or 2am Pacific depending
on the season. The column defaults to `UTC` so the schema is valid, but every caller passes one
explicitly.

## Consequences

**Good.** DST, month lengths and dow/dom semantics are handled by code that is tested far more
heavily than ours would be. Schedules are expressed in the notation operators already know.

**Bad.** One more runtime dependency in a system that holds financial PII, so it joins the set
that vendor review covers. It is small, dependency-light and does no I/O, which is the profile
that makes that acceptable.

**Catch-up policy is ours, not the library's.** A due schedule fires **once** and advances to the
next occurrence after `now` — a worker down for a week must not emit seven monthly briefs on
restart. The skipped windows are not erased: `workflow.schedule_late` records the gap, so it is
visible rather than silently absorbed.

**Revisit when:** a schedule needs semantics cron cannot express (business days, "last working day
of the quarter"). That is a scheduling-calendar problem, not a cron problem, and would want its
own model rather than a more elaborate expression.
