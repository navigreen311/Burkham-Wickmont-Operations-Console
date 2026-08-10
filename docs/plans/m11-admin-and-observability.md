# Plan — 11.7 Admin Configuration Center, 11.8 System Health & Observability

**Blueprint:** 11.7, 11.8 · **Branch:** `ai-feature/m11-admin-and-observability`
**Follows:** 10.1 Inter-Venture Commerce (merged, `82edcc0`)

Category 11's V1 scope is ten of twelve; 11.1–11.5 shipped with the walking skeleton. **11.9 Cost &
Performance Governance and 11.12 Disaster Recovery are V1.5.** This slice takes 11.7 and 11.8; 11.6
Data Warehouse, 11.10 Client Portal and 11.11 Founder / Executive Workbench remain.

> Correction to an earlier note: I previously called these "11.9 Client Portal, 11.10 Founder
> Workbench". The blueprint numbers them 11.10 and 11.11, with 11.9 being Cost & Performance
> Governance, which is deferred.

---

## Mini-PRD

### Problem

**11.7.** Roughly forty tunable numbers are compiled into this codebase — review cadences,
inactivity windows, thresholds, KPI targets. Changing any of them today is a code change. Blueprint
11.7 asks for a "non-technical admin surface for parameter management".

**11.8.** Nothing reports whether the system is working. The task queue can be backed up, workflows
can be dead-lettering, and the only way to know is to look.

### Success metrics

- An operator can change a policy parameter, and every change is audited and reversible.
- A **compliance invariant cannot be changed at all** — not by an admin, not by a Level 3 human.
- The health surface reports `unmonitored` as its own state, distinct from healthy.
- A component nobody watches never shows green.

### Risks

| Risk                                                | Mitigation                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **A config surface that can turn off a control**    | Invariants are structurally inexpressible — not permission-gated                          |
| A parameter set beyond a safe range                 | Every parameter declares its own bounds and refuses outside them                          |
| A change nobody can undo                            | Every change is an append-only row; `rollback` writes a new row restoring the prior value |
| **A green dashboard for something nobody measures** | `unmonitored` is a distinct state; there is no default-healthy path                       |
| Vendor health reported from nothing                 | Ungated vendors report `not_built`, naming the Decision that gates them                   |

---

## Key decision — a configuration surface must not be able to turn a control off

Blueprint 11.7 lists what is configurable: "offers, pricing, success fees, templates, playbooks,
**authority levels**, **state rules**, lender profiles, partner rules, **risk thresholds**, KPI
targets, notification rules, escalation rules".

Taken literally, that is a screen where somebody sets the TCPA quiet-hours window to 24 hours, or
adds `guarantee_approval` to the permitted-action list, or removes California from the all-party
recording-consent states. Every one of those is a single field on a "non-technical admin surface",
and each turns off a control the rest of the system is built around.

So the registry splits every constant in the codebase into two kinds:

- **Parameters** — genuine policy choices with a defensible range. A review cadence, an inactivity
  window, a KPI target. Configurable, bounded, audited, reversible.
- **Invariants** — the ones that are law, or that the architecture depends on. TCPA quiet hours.
  The Level 4 prohibited-action list. All-party consent states. Compliance state categories.
  Minimum denominators for a published rate.

**Invariants are not permission-gated; they are absent from the registry.** A Level 4 permission
would be a permission somebody eventually holds. There is no code path that writes them, so the
screen cannot show them, and the API cannot accept them.

Each invariant carries a `whyFixed` line, so the answer to "why can't I change this" is in the
system rather than in somebody's memory.

## Key decision — `unmonitored` is a state, and it is not green

9.1 established that `null` is not zero. The same argument lands harder on a health dashboard,
because the default rendering of "no data" is green and the person reading it is deciding whether
to go home.

So a health check returns `healthy`, `degraded`, `failing` **or `unmonitored`**, and `unmonitored`
is not an absence — it is a reported state with a reason. A component with no probe never shows
green.

Overall health is the **worst** component, never an average — the same rule 6.5 applies to risk
severity, for the same reason: averaging a failing component with nine healthy ones produces
"mostly fine".

---

## Architecture

```
packages/admin/
  registry.ts    every parameter, its bounds, its owner; and the invariants, with why
  settings.ts    read the effective value; change it; audit; stage; promote; rollback
packages/observability/
  probes.ts      the probe registry and the health verdict type
  health.ts      queue depth, dead letters, workflow failures, ledger integrity, SLA breaches
  vendors.ts     vendor API health - not_built, naming the gating Decision
```

Schema `admin`: `ConfigurationChange` (append-only). No table for current values — the effective
value is the latest change, or the compiled default. Deriving it means there is no second place a
value lives, and no job to keep them in step.

## Test strategy

- A parameter changes, and the effective value follows.
- A value outside a parameter's bounds is refused, naming the bounds.
- An unknown key is refused rather than stored.
- **No invariant appears in the registry**, asserted by name against the real constants.
- Rollback restores the prior value and is itself a change.
- A high-risk change is staged and does not take effect until promoted.
- Health reports `unmonitored` for a component with no probe, and it is never green.
- Overall health is the worst component, not the average.
- Vendor probes report `not_built` naming Decisions A and B.

## Out of scope

11.6, 11.10, 11.11. The admin UI itself. Real APM, uptime and latency — no metrics backend exists,
so those are `unmonitored` with a named reason rather than invented.

## Deviation from this plan

The plan listed a separate `staging.ts`. Staging turned out to be two fields on a change row -
`staged`, and a null `appliedAt` - plus `effectiveValue` reading applied changes only. A separate
file would have been a module whose entire content was one boolean, and splitting it from
`setParameter` would have made it possible to write a change without deciding whether it stages.
