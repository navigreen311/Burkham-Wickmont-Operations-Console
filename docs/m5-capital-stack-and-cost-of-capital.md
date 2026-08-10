# 5.1 Capital Stack & Monitoring · 5.6 Cost of Capital Calculator

The two modules that answer the questions the business exists to answer: **what capital does this
client have, and what is it actually costing them.**

## Why not all four of Category 5's V1 modules

- **5.3 Funding Recommendation Engine** — refusal path shipped with the spine; the recommendation
  needs the Lender Intelligence Database (5.2, V1.5).
- **5.4 Capital Product Governance Board** — approves providers _in_ 5.2 and propagates a blacklist
  to 5.3. With 5.2 absent it has no catalogue to approve into and nothing to propagate. It belongs
  in the same slice as 5.2.

5.1 and 5.6 have no such dependency and are tightly coupled — blended cost needs the stack.

## Solve the real cash flows; do not approximate

Blueprint 5.6 exists because the cost of small-business capital is routinely hidden in plain sight.
A merchant cash advance quoted as a **"1.4 factor" sounds like 40%**. Repaid daily over six months
it is an APR well north of 140%, because principal is repaid from day one and the borrower never
has the full advance for the full term.

An MCA has no interest rate — it has a purchase price, a remittance and a schedule. The only honest
comparison to a term loan's APR is the **internal rate of return of the actual cash flows**.

**Bisection, not Newton–Raphson.** Newton is faster and has two failure modes that matter here: it
needs a derivative that is easy to get subtly wrong, and it diverges on the steep curves that
high-factor short-term products produce — exactly the products this module exists to expose.
Bisection cannot diverge. Performance is irrelevant: a stack has a handful of positions.

Closed-form approximations were rejected because they err in the direction that **flatters** short-
term high-cost products, by ignoring that principal is repaid throughout.

### Details that change the answer

| Decision                                                                  | Why                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Annualize by compounding, `(1+r)^n − 1`                                   | The simple `r × n` understates daily products badly — 252 compounding periods a year                                                                          |
| Daily cadence is **252 banking days**, not 365                            | Remittances do not run at weekends; 365 overstates the payment count and understates the rate                                                                 |
| Origination fee **netted from proceeds**, not added to repayment          | That is what happens — the borrower receives less and repays full principal. Adding it to repayment pretends they had the fee to use, and understates the APR |
| `factorRate` and `annualRate` are separately named and mutually exclusive | A factor rate is not a rate. A type that let one be assigned to the other would permit the exact confusion the module exists to prevent                       |
| Blended cost weighted by **outstanding balance**                          | One large cheap position genuinely dominates. A per-position average makes four small expensive cards outweigh a large cheap loan                             |
| Undrawn limits excluded                                                   | They cost nothing until drawn                                                                                                                                 |
| Refinance compares **total cost**, not APR                                | A lower APR over a longer term routinely costs more in absolute dollars; that result gets an explicit caveat rather than being left for the reader to notice  |

An uncostable stack returns `null`, never `0` — zero would read as "this stack is free", the most
dangerous possible answer here. Uncosted balance and coverage are reported alongside.

## The health score carries its components

Blueprint 5.1 names a "Capital Stack Health Score", so a number is specified. Decision E removed a
_different_ score for a reason that still applies: a bare number hides what a reader needs in order
to act. "Your stack health is 62" tells an operator nothing about what to fix.

So `HealthScore` holds its components and there is no constructor that omits them — the number
summarises the components rather than replacing them.

| Component               | Weight | Note                                                                         |
| ----------------------- | ------ | ---------------------------------------------------------------------------- |
| Utilization             | 0.30   | Over-limit scores **0** outright — a different condition, not a worse degree |
| Promo runway            | 0.20   | A 0% balance with 30 days left is not the same position as one with 300      |
| Guarantee concentration | 0.20   | PGs are normal; concentration on one owner and unlimited guarantees are not  |
| Cost of capital         | 0.20   | Uncosted scores **50**, not 100 — an unknown must not read as good news      |
| Account hygiene         | 0.10   | Stale observations mean everything above describes the past                  |

The thresholds are judgements, stated explicitly so a reader can disagree with a specific line
rather than with an opaque total.

## Monitoring

- **Over-limit positions are flagged, not clamped.** A client past their limit is in a different
  situation from one exactly at it; clamping renders them identically.
- **Limitless positions are excluded from the aggregate utilization denominator.** Including a term
  loan's balance while it contributes no limit inflates the ratio without bound — the arithmetic
  that turns a healthy client alarming on paper.
- **PG exposure aggregates by owner**, capped per position where the guarantee is limited, flagged
  where unlimited (exposure grows with draws not yet made).
- **Promo alerts fire on exact threshold days** (90 / 60 / 30), not "at or below" — the latter
  fires on all ninety of them, and a daily alert gets filtered into a folder.
- **The payment calendar normalizes cadences** to a monthly equivalent, because a stack routinely
  mixes a daily MCA remittance with a monthly card minimum and the two cannot be summed by eye.

Scheduling belongs to the **Workflow Engine (2.2)**, which already has cron, wait states and SLA
escalation. A second timer here would drift from it.

## Tests

```bash
pnpm test    # 287 tests
```

40 new. The cost suite anchors on **known answers** rather than self-consistency — a suite where
the implementation and the expectation come from the same reasoning proves only that the reasoning
is applied consistently, including when wrong. So: a textbook annuity at exactly 1%/period
recovers 1%; NPV lands on zero at the returned rate; 1% monthly annualizes to 12.68% not 12%.

Two corrections the tests forced:

- **The NPV assertion was absolute where it should have been relative.** It demanded a residual
  under 1e-6 _dollars_ on flows of $50,000, and failed at 1.2e-5 — a relative error of 2e-10, i.e.
  essentially exact. The solver's own tolerance had the same flaw and now scales to the initial
  flow, so it means the same thing on a $500 advance and a $500,000 one.
- **Under-repayment has a real negative IRR.** A test expected `null` and a comment claimed no rate
  existed; both were wrong. The negative rate is now returned and asserted, because a negative
  effective APR on a capital product is a data-quality signal, and suppressing it would hide bad
  inputs behind an empty result.

## Known gaps

- **No persistence yet.** These are pure functions over positions supplied by a caller. The schema
  for `CapitalPosition` and stack snapshots lands with the slice that populates them — from Plaid
  (ungated) and CapitalForge issuer feeds.
- **5.2 and 5.4 are the next Category 5 slice**, together.
- **The Payment Command Calendar as a _deliverable_** — the data is here; rendering it is a
  template in 3.1.
- **Health weights and thresholds are unvalidated against real portfolios.** They are explicit and
  in one place for exactly that reason.
