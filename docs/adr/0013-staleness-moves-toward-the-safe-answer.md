# ADR-0013 — Staleness moves toward the safe answer, which is not always "stop"

**Status:** Accepted · **Date:** 2026-08-10 · **Modules:** 5.4 Capital Product Governance Board,
6.4 Do Not Fund Governance

## Context

Two modules now hold a record with a review cadence, and they answer the same question in opposite
directions.

**5.4** — a provider approval reviewed less recently than its cadence **stops being usable**. The
provider drops out of placement until somebody reviews it.

**6.4** — a Do Not Fund listing reviewed less recently than its cadence **keeps blocking**, and is
flagged for review.

Written as two rules, they look inconsistent, and a future edit would reasonably try to make them
agree. This ADR exists to record why they should not.

## Decision

The rule is one rule: **when a record outruns its review cadence, the system moves toward the
answer that is safe if the stale record is wrong.**

That answer is opposite in the two cases because the direction of harm is opposite.

|                             | If the stale record is trusted and it is wrong                  | Safe direction |
| --------------------------- | --------------------------------------------------------------- | -------------- |
| **5.4** provider approval   | A client is placed with a provider nobody has checked in a year | Stop using it  |
| **6.4** Do Not Fund listing | A client the company decided not to fund stays blocked          | Keep blocking  |

An expiring Do Not Fund listing would mean the most serious determination in the system lapses in
silence — no decision, no reviewer, no event, just a date passing. Nothing is risked by continuing
to block: the client is inconvenienced, the operator sees a flag, and a human resolves it.

## Consequences

**A listing can outlive its own reasoning.** A stale listing keeps blocking whether or not anybody
still believes it. Mitigated by `listingsDueForReview`, which produces the queue, and by the
refusal text naming the overdue review so the operator knows what to escalate — but it is a real
cost and the right one.

**The two modules will keep looking inconsistent to a reader who sees only one.** Hence this ADR,
and the cross-reference in both module headers.

**A third cadenced record must decide explicitly.** The question to ask is not "what did the other
modules do" but "if this record is stale and wrong, which way is safe."

## Alternatives considered

**Both expire.** Rejected: makes the Do Not Fund list self-clearing on a timer.

**Both persist.** Rejected: leaves a provider nobody has reviewed in placement, which is the
failure 5.4's cadence exists to catch.

**Escalate rather than decide.** Raising a notification and leaving the gate unchanged sounds
neutral, but it is not — leaving the gate unchanged _is_ a decision, and in 5.4's case it is the
unsafe one. Notifications are additive to a decision, not a substitute for one.
