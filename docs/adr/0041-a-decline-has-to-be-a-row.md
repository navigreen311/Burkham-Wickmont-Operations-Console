# ADR-0041 — A decline has to be a row

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 5.5 Funding Outcome Ledger, with 9.1 Executive KPI Dashboard, 5.2 Lender Intelligence
Database, 1.4 Pricing / Billing / Offer Management

## Context

9.1 has published no placement approval rate since it was built, and the note it published instead
is the reason this module exists:

> Every row in the table is an approval, and a rate computed from it would be 100% forever — a
> figure that is arithmetically correct, extremely reassuring, and completely meaningless. It would
> also be the single most damaging number on this dashboard, because "our approval rate is 100%" is
> exactly the claim the Marketing Claim Library bans and the Funding Ethics Firewall exists
> downstream of.

The table it was reading is `billing.funding_outcomes`, whose own header calls it "a minimal stand-in
for 5.5 Funding Outcome Ledger, which will subsume it". It has an approved credit limit and an
approval date and **no column for a denial**, because 1.4 only ever needed it to answer "did approved
capital fund inside sixty days".

The temptation, when a metric refuses, is to find a denominator. There was one available: count
placement recommendations, or applications submitted, or clients in the period. Every one of those
produces a number, and every one of them is a different question wearing this one's name.

## Decision

**The record is an attempt, and its outcome is one of the things that can happen to an attempt.**

`outcomes.funding_attempts` holds a row from submission, with `outcome` starting at `pending` and
moving to exactly one of `approved`, `declined` or `withdrawn`. The denominator is `approved +
declined`. It was never an arithmetic problem: **the denominator had to be collected**, and nothing
was collecting it.

### What the outcomes mean, and why `pending` and `withdrawn` are excluded

`pending` is a real state and not a placeholder — an application sitting with a provider is a fact
about the world — and it counts in neither half, because it has not happened. Bucketing it into the
denominator would produce a rate that could only rise as answers arrived, which every reader would
take as final.

`withdrawn` is excluded for the reason 5.2 already gives about its own rate: a withdrawn application
was never decided, and counting it as a non-approval makes a provider look worse the more clients
change their minds.

### The refusal did not go away, it moved

`decidedIn` returns `rate: null` below ten decided attempts, with a note saying how many more are
needed. That is the fourth place in this system with a minimum sample (5.2, 1.3, 9.1's `rate()`, now
5.5), and the constant is deliberately restated in each rather than shared from one: these are rates
over different populations, and a single constant would make four judgements look like one.

Cohorts get the same treatment, and they are where it matters most — a bucket is by construction
narrower than the whole, and "clients like you are approved 100% of the time" computed over two
attempts is the most confident sentence this system could produce from the least knowledge. Cohorts
below the minimum are **returned with a null rate rather than dropped**: a list that silently omitted
them reads as "we have no data on that profile", which is different and less actionable information
than "we have four".

### Recording a decision writes every consequence of it

An approval that reaches 5.5 and not 1.4 is a refund that never fires, and the client owed it is by
construction the one least likely to chase it. An approval that reaches 5.5 and not 5.2 is an
appetite tracker quietly flattered.

So `approveAttempt` writes the attempt row, the `billing.funding_outcomes` row the 60-day trigger
runs against, and the 5.2 `LenderOutcome` the approval-rate tracker runs on — **inside the function,
with no second function a caller could reach for instead.** This is ADR-0034's shape, applied for the
reason ADR-0034 gives.

It is also, directly, ADR-0034's finding again. **`recordOutcome` in 5.2 has been exported, tested and
called by nothing for the whole life of this system** — the same state `autoListForComplianceFail`
was in. The feedback loop blueprint 5.2 describes has never once run outside a test. It runs now.

**A failure to feed back is reported, not swallowed.** The attempt row and its Ledger event are
already written and the Ledger is append-only, so nothing can be rolled back. What must not happen is
a caller receiving `ok` and believing 5.2 knows something it does not, so the return is `failed` with
a reason naming which direction the resulting rate is now wrong in.

### Why the CHECK constraints are in the database

Blueprint 5.5 asks for the `creditLimit` / `approvedCreditLimit` distinction to be "CHECK-constraint
enforced", and the reason to take that literally is the one this repository keeps relearning: a rule
the application enforces is a rule a script, a backfill, a psql session or the next module can walk
past.

Seven constraints, and the load-bearing one is that **an approved amount exists if and only if the
outcome is `approved`**. A success fee computes against `approvedCreditLimit` and only against it, so
a declined row carrying an approved amount is a fee waiting to be charged for an approval that never
happened — and a pending row carrying one is worse, because it will be counted by whichever query
looks at the amount rather than at the outcome.

Zero is rejected as an approved amount, not merely negatives. **An approval for nothing is a decline
with the reason thrown away**, and a zero computes a fee where a null does not.

`tests/invariants/funding-outcomes.test.ts` asserts all seven by going around the engine with raw
SQL, because a suite that only exercised the engine would pass identically against a table with no
constraints on it. It also asserts the five legal shapes: a set of CHECKs that rejected everything
would pass every negative test and none of the ones that matter.

## Consequences

**`9.1 placementApprovalRate` publishes a number**, once ten attempts have been decided, and
`placementApprovalRateByProduct` gives blueprint 9.1 the by-product form it actually asked for. It is
a separate function rather than an optional argument, because "our approval rate" and "our approval
rate for merchant cash advances" are different claims and a defaulted parameter makes the second
answer to the first one's name.

**`internalGateRefusalRate` stays exactly where it is.** It measures this company's own gate, not the
capital providers, and it is still the honest answer to a different question.

**`billing.funding_outcomes` is not deleted, and 5.5 does not fully subsume it yet.** 5.5 writes it,
stores the row id it created, and marks it funded through 1.4's own function — so the two agree by
construction for anything recorded from now on. What remains open is that `recordFundingOutcome` is
still reachable directly, so an approval booked straight into billing would be invisible to 5.5 and
would under-count the denominator. Closing that means either moving 1.4's refund trigger onto 5.5's
table — which inverts a dependency the blueprint draws the other way — or making the billing function
private, which breaks 1.4's own tests. **It is named here rather than fixed, and it is the first
thing to look at when 1.4 is next opened.** ADR-0033 did the same thing, and ADR-0034 is what came of
it.

**The 60-day window is a constant in two modules.** `APPROVED_NOT_FUNDED_DAYS` is 60 in both 1.4 and
5.5, deliberately the same number, and a test asserts they fire on the same day. Two windows meant to
agree that drifted apart would produce a client the ledger says is owed a refund and billing says is
not, and the disagreement is invisible from either side.

**The decline reason is not in the Ledger payload.** It is free text a provider wrote about a named
applicant, and the Ledger is the one store here that cannot be corrected. It stays in the attempt row
and a test asserts it never reaches the chain.

## Alternatives considered

**Add a `declined` boolean to `billing.funding_outcomes`.** Shortest change, and wrong. It puts
placement outcomes in the billing schema, where they would be read by a module that only cares about
fees, and it still has nowhere to record a withdrawal, a submission date, a cohort, or the reason —
which is to say it produces the denominator and none of the rest of blueprint 5.5.

**Compute the rate from Ledger events.** `placement.recommended` and `placement.refused` are already
there and already counted, by `internalGateRefusalRate`. They measure whether _our own gate_ let a
placement through, not whether a provider approved it. Using them would put a number under 9.1's
label that describes something else entirely, which is the failure this whole ADR is about.

**Make the outcome nullable rather than adding `pending`.** A null outcome and a pending one look the
same in the column and completely different in a `WHERE` clause — every query would have to remember
`IS NULL OR outcome = ...`, and the one that forgot would silently drop live applications. An
explicit state is a state a reader can see.
