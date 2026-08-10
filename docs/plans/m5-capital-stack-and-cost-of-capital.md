# Plan — 5.1 Capital Stack & Monitoring, 5.6 Cost of Capital Calculator

**Blueprint:** 5.1, 5.6 · **Branch:** `ai-feature/m5-capital-stack-and-cost-of-capital`
**Follows:** Category 3 complete (merged, `fcedd29`)

---

## Why these two, and not all four of Category 5's V1 modules

Category 5 builds four modules in V1: 5.1, 5.3, 5.4, 5.6.

- **5.3 Funding Recommendation Engine** — its refusal path shipped with the spine. The
  recommendation itself needs the Lender Intelligence Database (5.2), deferred to V1.5.
- **5.4 Capital Product Governance Board** — approves providers _in_ the Lender Intelligence
  Database and propagates a blacklist to 5.3. With 5.2 absent, its blacklist has nothing to
  propagate to and its approval workflow has no catalogue to approve into. It belongs in the same
  slice as 5.2.

5.1 and 5.6 have no such dependency, are tightly coupled (blended cost of capital needs the
stack), and both feed deliverables that already exist. 5.6 is also the most correctness-critical
computation in the platform so far.

---

## Mini-PRD

### Problem

The Console can now hold documents, analyse bank feeds, run workflows and produce deliverables —
and cannot answer the two questions the business exists to answer: _what capital does this client
have, and what is it costing them?_

Blueprint 5.6 exists because the answer is routinely hidden. A merchant cash advance quoted as a
"1.4 factor" sounds like 40%. Repaid daily over six months it is an APR north of 90%. That gap is
the single most valuable thing this module surfaces, and getting the arithmetic wrong would make
the Console a more confident source of the same error.

### Success metrics

- Every position's true cost is computed on its **actual repayment schedule**, not its headline.
- Blended cost of a stack is weighted by outstanding balance, not by count.
- Every derived figure carries provenance (principle 8).
- Promo expirations surface with enough runway to act — blueprint 5.1's 60/90-day alerts.

### Risks

| Risk                                                                  | Mitigation                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **APR arithmetic is subtly wrong**                                    | Solve the actual cash-flow IRR by bisection, and test against hand-computable cases including a known-answer amortizing loan |
| A factor rate is compared to an APR as though they were the same unit | Factor rate is never returned as a rate; it is converted through the schedule, and the type names which is which             |
| A health score becomes an opaque number                               | Components are returned alongside it and the score cannot be constructed without them — the Decision E lesson generalized    |
| Monitoring implies live data it does not have                         | Positions carry `asOf` and provenance; a stale stack says how stale                                                          |

---

## Key decision — solve for the real rate, do not approximate

An MCA has no interest rate. It has a purchase price, a remittance amount, and a schedule. The
only honest comparison to a term loan's APR is the **internal rate of return of the actual cash
flows**.

Two approaches:

**A. Closed-form approximations.** `(total cost / principal) × (365 / term days)` and similar.
Fast, and wrong in exactly the direction that flatters short-term high-cost products, because it
ignores that principal is being repaid throughout.

**B. IRR by bisection over the real payment schedule.** _(chosen)_ Build the actual cash-flow
vector — advance in, remittances out on their real cadence — and solve for the periodic rate where
NPV is zero, then annualize. Bisection rather than Newton–Raphson: slower and utterly reliable,
with no derivative to get wrong and no divergence on the awkward curves that high-factor short-term
products produce.

Performance is irrelevant here — a stack has a handful of positions, not a million.

## Key decision — the health score carries its components

Blueprint 5.1 names a "Capital Stack Health Score", so a number is specified. Decision E removed a
_different_ score (compliance) for a reason that still applies to this one: a bare number hides the
thing a reader needs.

So `HealthScore` holds its components, and the type has no constructor that omits them. The score
is a summary of the components rather than a replacement for them — the Decision E lesson applied
without contradicting the blueprint.

---

## Architecture

```
packages/capital/
  positions.ts   the stack: cards, LOCs, term loans, MCAs; utilization; PG exposure
  cost.ts        5.6 - IRR, APR, factor-rate conversion, blended cost, refi comparison
  health.ts      5.1 - health score with its components
  calendar.ts    5.1 - payment calendar, promo expiry, re-stack windows
  stack.ts       5.1 - persistence, snapshots, monitoring findings
```

> **Deviation from plan, recorded after the fact:** `stack.ts` and the `capital` schema were not
> built. Every position in this slice is supplied by a caller, and the two sources that would
> populate them — Plaid and CapitalForge issuer feeds — are both ungated. Persisting a table that
> nothing can fill would have been schema written against a shape no real data has yet exercised.
> The pure functions are complete and tested; persistence lands with the slice that populates it.
> See the Known Gaps section of `docs/m5-capital-stack-and-cost-of-capital.md`.

### Data model — schema `capital`

- `CapitalPosition` — client, provider, product kind, limit, balance, rate/factor, schedule,
  promo window, PG status, `asOf`, provenance
- `StackSnapshot` — a point-in-time roll-up with the health score and its components

Promo expiry and re-stack windows are emitted as **workflow findings**, not as their own alerting
mechanism — module 2.2 already schedules and escalates, and a second timer would drift from it.

---

## Test strategy

- A 12-month amortizing loan at a known payment returns the known APR (hand-checkable).
- A 1.4-factor MCA over 6 months of daily remittances returns an APR far above 40% — the
  headline-versus-truth gap this module exists to expose.
- The same factor rate over a longer term returns a **lower** APR; term is what makes a factor rate
  meaningless on its own.
- Blended cost is balance-weighted, so one large cheap position outweighs several small expensive
  ones.
- Zero-interest promo positions cost nothing until expiry and are costed correctly after.
- Utilization is per-position and aggregate; a position over its limit is flagged rather than
  clamped.
- PG exposure aggregates by owner across positions.
- A health score cannot be built without its components.
- Promo expiry surfaces at 90 and 60 days, and not at 120.
- Every derived figure carries provenance.

---

## Out of scope

5.2 Lender Intelligence Database and 5.4 Capital Product Governance Board (same later slice), live
issuer feeds (CapitalForge integration), and the Payment Command Calendar as a _deliverable_ — the
calendar data is built here; rendering it is a template in 3.1.
