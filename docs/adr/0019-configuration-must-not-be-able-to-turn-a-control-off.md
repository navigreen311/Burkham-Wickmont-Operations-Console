# ADR-0019 — Configuration must not be able to turn a control off, and `unmonitored` is not green

**Status:** Accepted · **Date:** 2026-08-11 · **Modules:** 11.7 Admin Configuration Center, 11.8 System Health & Observability

## Context

Two modules, two places where the obvious implementation is the dangerous one.

**11.7** lists what an admin may configure: "offers, pricing, success fees, templates, playbooks,
**authority levels**, **state rules**, lender profiles, partner rules, **risk thresholds**, KPI
targets, notification rules, escalation rules". Taken literally, that is a screen where somebody
sets the TCPA quiet-hours window to 24 hours, adds `guarantee_approval` to the permitted-action
list, or removes California from the all-party recording-consent states. Each is one field on a
"non-technical admin surface", and each turns off a control the rest of the system is built around.

**11.8** asks for health monitoring of twelve components, of which this system can genuinely
measure four. The naive implementation shows green for the other eight, because zero errors divided
by zero calls is zero.

## Decision 1 — parameters are configurable; invariants are absent

Every tunable constant is one of two kinds.

**Parameters** are genuine policy choices with a defensible range — a review cadence, an inactivity
window, a KPI target. Each declares its own bounds, the **basis** for those bounds, and its owner.
Changing one takes a Level 3 human and a readable reason, is appended to an audit trail, and is
reversible.

**Invariants** are law, or something the architecture depends on: TCPA quiet hours, the Level 4
prohibited-action list, all-party consent states, the compliance state categories, ADR-0011's money
representation, ADR-0014's cohort threshold, ADR-0017's minimum denominator.

**Invariants are not permission-gated. They are absent from the registry.** A "Level 4 required"
flag would be a permission somebody eventually holds — and the person most likely to hold it is the
one under pressure to make a number move. There is no code path that writes them, so the screen
cannot show them and the API cannot accept them.

They _are_ listed, as fixed values with a `whyFixed` line, because _"I couldn't find the setting"_
and _"the setting does not exist because it is the law"_ are different answers, and only one stops
somebody looking for a workaround.

Two supporting choices:

- **Cadences the specification states as minimums become ceilings.** 5.4's quarterly review and
  8.3's annual recertification may be tightened by a tenant, never loosened past the specification.
  9.1's 90% compliance target is a floor for the same reason.
- **There is no table of current values.** The effective value is the latest applied change or the
  compiled default, so the audit trail _is_ the store — nothing keeps two copies in step. Rollback
  writes a **new** change restoring the prior value; an undo that deleted the row would answer
  "what is it now" and lose "what happened".

## Decision 2 — `unmonitored` is a state, and it sits below `healthy`

9.1 established that `null` is not zero. The argument lands harder on a health dashboard, because
the default rendering of "no data" is a green tick and the person reading it is deciding whether to
go home.

So a component reports `failing`, `degraded`, `unmonitored` or `healthy`, and `unmonitored` is a
reported state with a reason — not an absence, and not a missing row.

The **ordering** is a judgement worth stating: `unmonitored` sits between `degraded` and `healthy`.
It is not worse than degraded — nobody watching is not evidence of a problem. It is worse than
healthy — "we are not looking" cannot be reported as "it is fine".

Structurally: **the `healthy` constructor takes a measurement as a required argument.** A component
nobody probed cannot be reported as working, because there is no way to build the value.

Overall health is the **worst** component, never an average — 6.5's rule, for the same reason. And
an empty check returns `unmonitored`, because a system nobody checked is not a healthy system.

## Consequences

**The health dashboard mostly says "unmonitored" today**, and that is the honest state of a system
with no metrics backend. Each row names what would measure it, so the surface is a list of gaps
somebody can close rather than a wall of green.

**Gated vendors never show green.** A healthy Plaid row on a system that has never called Plaid is
the most confidently wrong thing the module could produce.

**A high-risk parameter is staged**, and staging is real: `effectiveValue` reads applied changes
only, so a staged change does not move the value. A second approver is deliberately _not_ required
— staging exists to make a change deliberate and visible, not to add four-eyes approval, which this
codebase does elsewhere by name where it belongs.

**The registry is shorter than the constant list.** Most constants are not policy choices, and a
registry containing all of them would be one nobody could review.

## Alternatives considered

**Gate invariants behind a higher permission.** Rejected — a permission is something somebody
eventually holds.

**Let the admin edit anything, and rely on the audit trail.** Rejected. An audit trail records what
happened; it does not prevent it, and "we can see who turned off quiet hours" is not a control.

**Omit components nobody monitors.** Rejected: a missing row asserts there is nothing to report.

**Show unmonitored as healthy until proven otherwise.** Rejected — that is the default the whole
decision exists to prevent.
