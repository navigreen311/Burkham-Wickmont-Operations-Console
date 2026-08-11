# ADR-0056 - Five productivity figures are refused, and the refusal is the module

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 9.3 Agent Productivity Dashboard

## Context

Blueprint 9.3 lists nine figures: tasks completed, cycle time, error rate, human correction rate,
compliance violations, client satisfaction impact per agent, rework rate, escalation rate, cost per
workflow.

This is the module most able to produce a metric that punishes the right behaviour, and the
punishment is invisible because the metric looks objective.

## Decision - four are computed, five are refused with the reason

`REFUSED_PRODUCTIVITY_METRICS` is exported and asserted in a test, because a refusal that can be
deleted without anything failing is a refusal that will be deleted.

| Figure                     | Why it is refused                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error rate                 | Nothing records an agent being wrong. What exists is a human changing something an agent drafted, and most such edits add context the agent could not have had. Reporting corrections as errors makes drafting-and-handing-over - the safest behaviour available to an agent - look like the worst performance |
| Human correction rate      | The agents with the highest rate are on the hardest files. Published per agent, it rewards taking easy work                                                                                                                                                                                                    |
| Escalation rate            | Escalating at the edge of authority is the control working. Principle 4 puts a Level 3 human at every consequential decision. Counting escalations against an agent teaches agents not to escalate, and that is the one failure this system cannot absorb                                                      |
| Client satisfaction impact | Nothing measures client satisfaction, and attributing the experience a client had to one agent needs a causal claim nothing supports - clients are worked by several agents and a human                                                                                                                        |
| Cost per workflow          | 11.9 owns cost. A second cost model here would disagree with the first, and the disagreement would surface inside a unit-economics figure somebody had already acted on                                                                                                                                        |

What remains is volume and latency: actions completed, blocked actions, mean gap between actions,
and the department rollup. **None of it is quality**, and `productivityView.note` says so, because
a productivity dashboard is read as a performance review whatever its header says.

Blocked actions are reported at **department** level only - a capacity signal, never a per-agent
failing.

## Consequences

**Degradation detection reports direction with no threshold and no verdict.** A threshold is a
number under which nobody looks, and the slow change nobody notices is what degradation detection
exists for. `volumeDirection` returns `unknown` rather than `steady` when either window is below
`MINIMUM_ACTIONS_TO_COMPARE`, because "no change detected" and "not enough to detect a change in"
are different statements and the first is the reassuring one.

**This module reads `ledger_events` and `actors` through `db()` directly.** That follows the
existing pattern in `packages/dashboards/src/executive.ts` rather than introducing a new one -
dashboards is treated here as a read-side projection. It is still a deviation from "no service
reaches into another service's database", and it is flagged rather than hidden: the fix is a
versioned read API on `@bwc/ledger` and `@bwc/identity`, applied to `executive.ts` at the same time
so the two do not diverge.

## Alternatives considered

**Compute the five and label them "directional".** Rejected. A label does not survive the number
being put on a slide.

**Omit them silently.** Rejected - somebody would add them later, not having seen the argument.

**Publish escalation rate to department heads only.** Rejected as a half-measure: the number still
exists per agent, and access controls on a number are weaker than not computing it.
