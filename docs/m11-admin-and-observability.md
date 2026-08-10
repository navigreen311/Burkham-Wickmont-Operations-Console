# 11.7 Admin Configuration Center · 11.8 System Health & Observability

Packages: `@bwc/admin`, `@bwc/observability` · Schema: `admin` · ADR: [0019](adr/0019-configuration-must-not-be-able-to-turn-a-control-off.md)

Two of Category 11's five remaining V1 modules. **11.6 Data Warehouse, 11.10 Client Portal and
11.11 Founder / Executive Workbench remain.** (11.9 Cost & Performance Governance and 11.12
Disaster Recovery are V1.5.)

---

## 11.7 — a config surface must not be able to turn a control off

Blueprint 11.7 lists "authority levels" and "state rules" among the configurable things. Taken
literally, that is a screen where somebody sets TCPA quiet hours to 24 hours or adds
`guarantee_approval` to the permitted-action list.

So every tunable constant is one of two kinds.

### Parameters — configurable, bounded, audited, reversible

Ten of them. Each declares its bounds, **the basis for those bounds**, and its owner:

```ts
{
  key: 'sales.INACTIVITY_DAYS',
  compiledDefault: 45, minimum: 7, maximum: 120,
  boundsBasis: 'Under a week escalates leads that are simply waiting on a document. Over four
                months, the escalation arrives after the lead is cold.',
  owner: 'Concierge Desk', highRisk: false,
}
```

Cadences the specification states as **minimums become ceilings**: 5.4's quarterly review and 8.3's
annual recertification may be tightened, never loosened past what the specification requires. 9.1's
90% compliance target is a floor for the same reason.

### Invariants — absent, not permission-gated

TCPA quiet hours. The Level 4 prohibited-action list. All-party consent states. Compliance state
categories. ADR-0011's money representation, ADR-0014's cohort threshold, ADR-0017's minimum
denominator.

**There is no code path that writes these**, so the screen cannot show them and the API cannot
accept them. A "Level 4 required" flag would be a permission somebody eventually holds — and the
person most likely to hold it is the one under pressure to make a number move.

They _are_ listed as fixed, each with a `whyFixed` line, because "I couldn't find the setting" and
"the setting does not exist because it is the law" are different answers and only one stops
somebody looking for a workaround.

> The unit test asserts the **absence** — against the real constants imported from the packages
> that own them — and also that no parameter key _looks_ like a compliance control, so a new
> invariant added by mistake fails even if nobody thought to name it.

### No table of current values

The effective value is the latest applied change, or the compiled default. The audit trail **is**
the store, so nothing keeps two copies in step — the eighth time this codebase has derived rather
than stored.

`rollback` writes a **new** change restoring the prior value. An undo that deleted the row would
answer "what is it now" and lose "what happened", which is the question an audit asks.

### Staged rollout

A high-risk parameter is recorded with `appliedAt: null`, and `effectiveValue` reads applied changes
only — so staging is real rather than a label. A second approver is deliberately **not** required:
staging makes a change deliberate and visible, and four-eyes approval is something this codebase
does elsewhere by name, where it belongs.

---

## 11.8 — `unmonitored` is a state, and it is not green

9.1 established that `null` is not zero. It lands harder here: the default rendering of "no data"
on a health dashboard is a green tick, and the reader is deciding whether to go home.

| State         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `failing`     | Measured, and broken                                                        |
| `degraded`    | Measured, and behind                                                        |
| `unmonitored` | **No probe.** Not an absence — a reported state, with what would monitor it |
| `healthy`     | Measured, and fine                                                          |

`unmonitored` ranks **between `degraded` and `healthy`**. Not worse than degraded — nobody watching
is not evidence of a problem. Worse than healthy — "we are not looking" cannot be reported as "it is
fine".

**Structurally: the `healthy` constructor takes a measurement as a required argument.** A component
nobody probed cannot be reported as working, because there is no way to build the value. An empty
check returns `unmonitored`, because a system nobody checked is not a healthy system.

Overall is the **worst** component, never an average — 6.5's rule.

### What is genuinely measured

Four things, because 11.3 and 11.4 keep real records:

| Component          | Rule                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task queue         | Depth counts work that is **due** — a follow-up booked for next month is not backlog. **Dead letters fail at one**: a threshold would be a decision that some abandoned work is acceptable, taken in advance by somebody who has not seen which work |
| Event Ledger       | The hash chain verifies or it does not. No degraded case — a chain with one broken link is not a chain. An **empty** ledger is `unmonitored`, not intact                                                                                             |
| Workflow execution | Failure share over 24 hours. **No activity is `unmonitored`**, not clean — nothing ran is a different fact from everything running cleanly                                                                                                           |
| Workflow SLA       | Breaches in 7 days. Degraded rather than failing: late is not broken, but it is what a client experiences                                                                                                                                            |

### What is not

Uptime, API latency, OCR failures, VoiceForge, CapitalForge sync, payment processing, security
alerts — each `unmonitored` with what would measure it. And the three gated vendors (Plaid, business
bureau, personal credit), each naming the Decision that gates it.

**A gated vendor never shows green.** Zero calls is not zero errors, and a healthy Plaid row on a
system that has never called Plaid is the most confidently wrong thing this module could produce.

---

## Tested

38 tests: `tests/integration/admin-and-health.test.ts` (24) and
`tests/invariants/admin-registry.test.ts` (14). Suite total **857**.

Mutation-verified:

| Mutation                                    | Failures |
| ------------------------------------------- | -------- |
| Expose TCPA quiet hours as a parameter      | 2        |
| Staging sets a flag but applies immediately | 2        |
| An unmonitored set reads as healthy         | 4        |

> Incidental finding: the broken-chain test could not tamper with a ledger row by `UPDATE` — 11.3's
> database trigger rejects it outright. The chain had to be broken by a direct `INSERT`, which is
> the append-only guarantee working exactly as intended.
