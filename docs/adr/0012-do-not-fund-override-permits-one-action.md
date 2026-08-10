# ADR-0012 — A Do Not Fund override permits one action; it does not delist

**Status:** Accepted · **Date:** 2026-08-10 · **Module:** 6.4 Do Not Fund Governance

## Context

Blueprint 6.4 requires "human override with documented justification" for a client on the Do Not
Fund list. It does not say what an override does to the listing.

The obvious reading is a switch: an authorised human turns the listing off, and the client becomes
fundable again. That is one mechanism serving two different decisions:

- _"This specific application may proceed despite the listing."_
- _"This client should no longer be listed."_

They are reached on different evidence. The first can be true because a single lender's product is
secured, or because counsel reviewed one transaction. The second requires believing the reason for
the listing no longer holds.

## Decision

**An override names one action, is consumed when used, and leaves the listing in force.**

Removing a listing is `removeListing` — its own act, its own Level 3 human, its own justification.

Concretely:

- `grantOverride(action, justification, approvedBy)` records a single-use exception.
- `checkDoNotFund(action)` finds an unspent override for that **exact** action and permits it.
- The check does **not** spend it. Whoever proceeds calls `consumeOverride`.
- After it is consumed, the same action is blocked again.

The middleware chain carries the override id out on `ChainResult.doNotFundOverrideId` rather than
spending it, for the same reason: a caller that checks and then abandons the action for an
unrelated reason would otherwise have burned an exception a Level 3 human granted, and the next
attempt would need a second approval for work that never happened.

## Consequences

**A considered exception cannot silently become a permanent state.** This is the whole point. Under
the switch design, the person granting one exception would not know they had also delisted the
client — and nothing downstream could tell the two apart afterwards.

**Repeated exceptions are visible as repetition.** Five overrides in a month is a pattern in the
Ledger. Under a switch, it would be one delisting and four uneventful applications.

**More friction, deliberately.** Each application for a listed client needs its own approval. That
is the correct cost for funding a client the company determined should not be funded.

**A caller can forget to consume.** The exception then stays available for a later action of the
same name. Mitigated by making the consume call part of the same flow as the action, but it is a
real seam and worth naming: the alternative — spending it at check time — has the worse failure,
because it destroys a granted exception on a code path that did nothing.

## Alternatives considered

**Override delists.** Rejected: conflates two decisions, and the conflation is invisible.

**Time-bounded override (valid 7 days).** Rejected as the primary mechanism. Time does not bound
what the exception is for, so a 7-day override permits an unlimited number of applications inside
the window. Single-use bounds the thing that matters. A time bound could be added on top later.

**Override at the listing level with a counter.** Rejected: "three exceptions remaining" invites
spending them rather than justifying each.
