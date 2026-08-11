# ADR-0054 - A lender comparison is a set, not a ranking

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 9.4 Lender Performance Dashboard

## Context

Blueprint 9.4 asks for "per-lender historical trend; comparison across lenders for the same
product". The obvious rendering of a comparison is a league table.

Almost all of this module's honesty was already bought by 5.5, whose `byProvider` counts approvals
and declines, reports a mean time to decision, and withholds a rate below ten decided attempts. The
risk in 9.4 is undoing that on the way to a screen.

## Decision 1 - no ordering by performance

A league table is an ordering, an ordering implies a scalar, and the scalar somebody reaches for is
approval rate. That puts a provider who approves everything at the top and a provider we send only
hard cases to at the bottom - and the ranking then steers which provider gets the hard cases, which
changes the number that produced the ranking.

`lenderPerformance` sorts by **provider id**: not by anything meaningful, deliberately. The first
row of a sorted table is read as the recommendation whatever the header says.

## Decision 2 - the denominator rule is not re-derived here

`MINIMUM_DECIDED_FOR_RATE` is 5.5's and is imported, not copied. A second copy of a withholding
threshold is one that will eventually differ from the first, and the difference shows up as a rate
appearing on one screen and not another.

## Decision 3 - comparison is scoped to one product

`compareForProduct` takes a product kind. A term loan provider and a merchant cash advance provider
have different approval rates because they are different products; a comparison mixing them reads
as one being better at the job the other is not doing.

## Consequences

**Four of blueprint 9.4's figures are `UNPRODUCED_LENDER_FACTS`** - time to funding, client outcome
after funding, suitability score accuracy, renewal behaviour. Each names what would produce it. A
lender view silent about client outcomes reads as a lender whose clients did fine.

**Complaint counts are not divided by attempts.** 5.4 counts and severity-weights complaints;
dividing them by placement attempts gives a rate whose denominator has nothing to do with who
complained.

## Alternatives considered

**Rank by a composite score.** Rejected - the same problem with the scalar hidden.

**Omit the unproduced facts.** Rejected. A missing row asserts there is nothing to report.
