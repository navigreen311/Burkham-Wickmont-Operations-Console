# ADR-0043 — A partner standing is not a score

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 8.4 Partner Risk Score, with 8.1 Partner & Referrer Portal, 8.3 Training &
Certification

## Context

Blueprint 8.4 is called Partner Risk **Score** and asks for "per-partner score across dimensions:
claim compliance, referral quality, conversion rate, complaint rate, refund rate, high-risk client
rate, documentation quality, unauthorized promises detected, revenue contribution".

Those are two different kinds of thing wearing one name.

- **Conduct** — claim compliance, unauthorized promises detected, documentation quality. A partner
  either told a client their funding was guaranteed or they did not.
- **Performance** — conversion rate, complaint rate, refund rate, revenue contribution. Numeric, and
  meaningless below a sample.

## Decision

**This module produces no score.** It produces a categorical `standing` and a set of numeric
`measures`, and nothing in it combines the two.

### Why not one number

A composite figure over these dimensions is a figure in which **revenue contribution offsets an
unauthorized promise**. That is exactly the trade design principle 1 forbids — compliance shape
first, dollars second — and a single number would make it _invisibly_, because the arithmetic gives
no sign that one of its inputs was a compliance breach. A partner with an excellent quarter and one
promise of guaranteed approval scores well, and nothing in the output says why.

It is Decision E's argument, transplanted. The reason compliance state is categorical is not that
numbers are distasteful; it is that **a number invites an average, and an average of a breach and a
success is a smaller breach.** The same pressure exists here and the same answer applies.

So the standing is **worst-of** over open findings. A partner with one unauthorized promise and
ninety clean referrals is a partner with an unauthorized promise. The ninety are still reported —
they are real, and Channel Partnerships should see them — but they are reported _beside_ the
standing, in their own field, where nobody can mistake them for mitigation.

### The blueprint asked for a score and does not get one

Stated plainly rather than quietly reinterpreted. What 8.4 wanted from a score is available:
per-partner assessment, threshold-based escalation, a weekly queue, and inputs to a decertification
decision. **The thresholds apply per dimension, never to a composite** — a threshold on a combined
score is a threshold a good quarter can hide.

If somebody later needs one number for a dashboard tile, the honest version is the standing rendered
as a colour, not the measures rolled into an index.

### What this module does not do

**It does not decertify, and it does not terminate.** 8.1 already recorded the reasoning: "a trigger
that fired on its own would end a commercial relationship — and cut off the referred clients'
visibility — with nobody answerable for it. Triggers surface; a person terminates." 8.3 owns
certification and 8.1 owns the relationship, and a second path into either would be the second door
ADR-0034 is about. The strongest standing this module can reach is
`decertification_recommended`, and the name is the whole point.

### The one exception, and why it is one

**A `critical` finding suspends the partner immediately, from inside `recordFinding`.**

An unauthorized promise is a Level 4 prohibited action performed by somebody outside the authority
system that would have blocked it. Leaving it to wait for a review is 6.4's Friday problem with a
client on the other end of it — and 6.4's answer, `autoListForComplianceFail`, is the precedent:
automatic in, human out. Reinstatement takes a person.

It is written **inside** the recording function rather than beside it, for the reason ADR-0034
gives: four places could have composed the two calls and three of them leave the same hole. If the
suspension cannot be written the function returns `failed` and says in the reason that the partner
is **not** suspended — the finding row and its Ledger event are already written and the Ledger is
append-only, so nothing can be rolled back, and what must not happen is a caller receiving `ok` and
believing a partner is stopped who is not.

### The assessment is consulted, so it is a control

`canRefer` now has three gates: the relationship, **the conduct standing**, then the training.

Without the middle one, 8.4 would compute `review_required` for a partner making unapproved claims
and that partner would go on introducing clients — which is precisely the state ADR-0034 found
`autoListForComplianceFail` in, and the same class of defect as 5.2's `recordOutcome` having no
production caller (ADR-0041). **An assessment nothing consults is a report, not a control.**

`review_required` and `decertification_recommended` stop new referrals; `watch` does not. The line
sits there because a review is a decision somebody owes the partner within a week and introducing
more clients meanwhile deepens whatever is being reviewed — whereas `watch` exists precisely to be
the state that costs nothing.

The gate order matters and is the order 8.1 established: "your relationship is suspended", "we are
reviewing something you did" and "your certification lapsed" are different problems with different
fixes, and a partner given the wrong one solves the wrong problem.

## Consequences

**A dismissed finding stays on the record.** `resolveFinding` sets `upheld: false` rather than
deleting the row, because a pattern of dismissed complaints about one partner is itself a signal and
it is invisible if dismissal erases the evidence. Same reasoning as a released legal hold and a
removed Do Not Fund listing.

**Two dimensions blueprint 8.4 names are reported as unmeasured rather than omitted.** Refund rate
and revenue contribution need 8.2 Partner Agreement & Payout Center, which owns fee terms, the state
restrictions on referral fees, and clawback — the same refusal `payableToPartner` already makes.
High-risk client rate would require reading 6.4's listings per referred client, which is a link from
the partner network into client risk governance that nobody has decided to draw. **A dimension left
silently out of a list reads as a dimension that came back clean.**

**The standing is derived on read, not stored.** Fifth appearance of this call (ADR-0007, 0009, 0010,
0011, and 1.3's inactivity): a stored standing needs a job to maintain it, and a job that stops
leaves every partner reading as freshly assessed — the most reassuring possible failure. Blueprint
8.4's "weekly score updates" is `partnersNeedingReview`, a query, run whenever somebody asks.

**Three CHECK constraints**, the load-bearing one being that a resolution is complete. The
half-resolved shape is the dangerous one: `resolvedAt` set means the finding stops counting toward
the standing, so the partner comes off review — with `upheld` null, meaning nobody recorded whether
the complaint was true.

**Mutation-tested.** Replacing worst-of with a mean fails five tests; stubbing out `canRefer`'s
standing check fails the one that distinguishes a control from a report.

## Alternatives considered

**Produce the score and also produce the standing.** Superficially the safest option — nobody has to
argue with the blueprint. Rejected because the number would be the one that ends up on a dashboard
and in a partner conversation, and the standing would become the small print. A figure that exists
gets used.

**Weight the compliance dimensions so heavily that a breach dominates.** This is a score that
behaves like a worst-of, and it is worse than either: the behaviour depends on weights somebody can
tune, and the day a weight is adjusted for a reason that seemed good the compliance dominance
quietly stops holding. ADR-0019 already says a control configuration can switch off is not a
control.

**Make `assessPartner` advisory and leave `canRefer` alone.** The smaller change, and the one that
would have reproduced this repository's most-repeated defect for the third time in one PR.
