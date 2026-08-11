# ADR-0034 — A control a caller can skip is not a control

**Status:** accepted
**Date:** 2026-08-11

## Context

ADR-0033 recorded a finding it did not fix: **`autoListForComplianceFail` had no production caller.**

Decision E says a client whose compliance state reaches `fail` routes to Do Not Fund Governance.
6.4 wrote the function that does it, with a careful header explaining why it takes no approver —

> Written by the system, so it takes no approver. […] Requiring a human to _start_ blocking would
> mean a client whose compliance failed on a Friday stayed fundable until Monday.

— and it was exported, tested, and **called by nothing**. For the whole life of this system, moving
a client to `fail` left them fundable. The tests passed because they called the lister themselves.

## Decision

**The listing happens inside `transitionComplianceState`, synchronously, and there is no way to
perform the transition without it.**

### Why inside, and not beside

Four places could have composed it, and three of them leave the same hole:

| Where                                                    | Why not                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The Console route                                        | Every other caller of `transitionComplianceState` — the worker, a script, the next module — still lists nobody |
| The middleware chain                                     | Same hole, plus it makes the gating layer perform writes                                                       |
| A `recordComplianceDetermination` wrapper in `@bwc/risk` | The plain function stays reachable, and it is the one named after what a caller wants to do. They will call it |
| **Inside the transition**                                | There is no second function to reach for                                                                       |

**A control a caller can skip by calling a different function is not a control.** This repository
has said the same thing in four other shapes already — a fail-closed allow-list rather than a
block-list (6.4), invariants that are _absent_ rather than permission-gated (ADR-0019), absence of a
governance row meaning not-approved (ADR-0007), absence of an activation row meaning not-active
(ADR-0009). Each is the same move: make the wrong thing unreachable rather than discouraged.

### Why synchronously, and not through a Ledger listener

A listener on `client.compliance_state_changed` is the tidier architecture. 2.2's trigger machinery
already consumes Ledger events exactly-once, and it would invert the dependency the right way round:
6.4 subscribing to a fact 1.1 publishes, with no import at all.

**It is the wrong shape for this control**, because it makes a safety decision
eventually-consistent on a queue that can stop. The window between the transition and the worker
picking it up is a window in which a failed client is fundable — which is the exact thing 6.4
refused when it made the listing automatic in the first place. And a worker that is down does not
list anybody, silently.

Tidier architecture, weaker control. The control wins.

### The cost, stated plainly

`@bwc/clients` now depends on `@bwc/risk`. **That is the wrong direction on a layer diagram**: 1.1 is
the client lifecycle and 6.4 is risk governance, and the lifecycle module should not know about the
governance one.

It is accepted knowingly, and two things make it tolerable rather than merely convenient. Decision E
is **already** enforced inside `@bwc/firewall`, which encodes "compliance state is Fail → routes to
Do Not Fund Governance" in its own gate — so the rule was never confined to one module. And there is
no cycle: `@bwc/risk` imports core, db, identity and ledger, and none of them reaches back.

The alternative to one wrong-direction import is a control anybody can walk past.

### If the listing cannot be written

`transitionComplianceState` returns `failed`, with a message saying the state was recorded, the
listing was not, **and that the client is not blocked**.

Nothing can be rolled back — the transition's Ledger event is already written and the Ledger is
append-only. What must not happen is a caller receiving `ok` and believing a client is blocked who
is not. Listing _before_ the transition was considered and rejected: a listing justified by
"Compliance state reached Fail" when the transition then failed is a fiction in the field a
reviewer reads, which is the mistake 6.4 avoided by leaving `listedBy` null.

## Consequences

**`TransitionInput` takes an optional `now`.** The listing is dated, and a listing's date is what its
review cadence counts from, so a caller reconstructing a past determination has to be able to say
when it happened. Consistent with everything else here that takes one.

**Two tests changed because the world did.** `do-not-fund.test.ts` no longer calls the lister — it
asserts the transition listed the client, which is the assertion that would have failed for the
whole life of this system. `warehouse-portal-workbench.test.ts` had a hand-written `listClient`
after its `fail` transition, and that call is now correctly refused as a second determination on an
already-listed client.

**Removal is unchanged.** A listing survives the client being moved back to `pass`; delisting takes
`removeListing`, a Level 3 human and a justification (ADR-0012, ADR-0013). Automatic in, human out.

## The intermittent suite failures, chased down

`pnpm verify` had failed and passed-on-rerun three times without the failing file ever being
captured. Captured on the fourth attempt by running the suite in a loop with the output kept. Three
distinct causes, none of them a flake, and **the first fix I wrote for the second one was wrong** —
which is the part worth reading.

### 1. A four-character substring search a UUID can satisfy by accident

`entity-graph-store.test.ts` asserted that no Ledger payload contained `'4321'`, the last four of a
test SSN. A payload carries UUIDs; a UUID is hexadecimal; four decimal digits turn up in one **0.1%
of the time**, measured over 200,000 UUIDs. It failed on
`ownerId: 'd221b536-aa6a-4ea3-9940-a81143c14321'`.

The assertion now checks payload **values** rather than a substring of the document, so a last-four
that leaked as a field is caught and a UUID that merely spells one is not. The nine- and ten-digit
identifiers are still checked as substrings, where the length makes the search honest.

### 2. Ordering ties that no key resolves — and a fix that did not work

`registeredKeys` and `activityFor` ordered by a single timestamp. Two rows written in the same
millisecond tie, and Postgres then returns them in whatever order it likes.

**The obvious fix was to add `id` as a tie-break, and it does not do what it looks like it does.**
`id` is a random UUID, so a secondary sort on it makes a result _stable for a given set of rows_ and
leaves it _unrelated to insertion order_. The suite kept failing, differently, until that was
noticed. `createdAt` is `timestamp(3)`: at millisecond granularity **nothing in this system decides
which of two same-millisecond rows came first.**

Two things followed.

**The tie-break sweep was kept** — 59 files, every single-key `orderBy` given `{ id: 'asc' }` behind
it. It is worth having on its own terms: the same query now returns the same order every time it is
run against the same rows, which is what stops a page reshuffling under a reload. Prisma's types
were the safety net for models without an `id`; the typecheck passed unchanged.

**Two tests were over-specified and now assert what the data can carry.** A client with two keys is
owed both, under the names they chose; they are not owed a ruling on which of two keys registered in
the same millisecond came first. The sales trail asserts that every step is present and that the two
steps it dates explicitly are in the order it dated them.

**The underlying limitation is real and is not fixed here**: ties at millisecond granularity have no
defined resolution, so any surface that displays a strict sequence can show two same-millisecond
rows in either order. A monotonic sequence column would fix it properly, and that is a migration on
several tables — a slice of its own, named rather than smuggled into this one.

### A pattern, now on its third sighting

ADR-0023's PR found `orderBy: { appliedAt: 'desc' }` returning different rows on CI and locally,
after passing 23 CI runs. This makes three. **A sort with a non-unique key is not a sort; it is a
sort most of the time** — and the second half of the lesson is that adding _any_ second key is not
enough. The tie-break has to carry the meaning the caller is relying on, or the test relying on it
has to stop.

## Alternatives considered

**Leave it unwired and document the gap.** What ADR-0033 did, deliberately, because the fix is a
layering decision and a UI slice is a bad place to take one. Taken here as its own slice, which is
what it wanted.

**A database trigger.** The Ledger's append-only enforcement is a trigger, so there is precedent.
Rejected: the listing writes a Ledger event of its own, and a trigger writing hash-chained,
HMAC-signed events from inside Postgres would put the chain's integrity in two languages.

**Make `transitionComplianceState` private and export only a composed function.** Equivalent
protection, more churn — every existing caller changes name for no gain, and the module's public
surface stops matching what the module is called.
