# ADR-0050 — A refusal has to survive the transport and the page

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 9.1 Executive KPI Dashboard, 9.2 Unit Economics Dashboard, on the internal Console
**Extends:** ADR-0017

## Context

ADR-0017 made a metric a value with its basis: `value: T | null`, a numerator, a denominator, a
coverage and a `note` that says why when the value is null. Several figures on these two dashboards
are deliberately not produced — the placement approval rate, gross margin, projected LTV — and each
carries the argument for its own absence.

All of that lives in `@bwc/dashboards`, and until this slice nothing rendered it. **Putting a
transport and a page in front of it is where it gets destroyed**, because the three ways to destroy
it are the three things a careful person writes without thinking:

| Written by reflex            | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| coalesce a null to zero      | "we cannot measure gross margin" becomes "gross margin is zero"          |
| drop a null metric from JSON | a stated refusal becomes a missing row, which renders as nothing         |
| substitute a dash            | teaches its reader to ignore dashes, so the next real one is ignored too |

The first is the worst, and not because it is the most likely. **A zero is a claim about the
business; a refusal is a claim about the system**, and only the second one is true. A founder
reading a gross margin of zero concludes something about the company. A founder reading "gross
margin cannot be computed while the Plaid and bureau COGS lines are ungated" concludes something
about the data — which is the fact.

## Decision

**The transport forwards, and adds only what makes an absence findable.**

Neither route reshapes a metric. `executiveDashboard` and `unitEconomicsDashboard` are spread into
the response as the modules produced them, so `value: null` arrives as `value: null` and the note
arrives with it.

Two additions, both of which only ever surface a refusal that already existed:

**`withheld`** — every metric on the dashboard whose `value` is null, with its label, note, coverage
and blocked inputs. Derived by **walking the assembled dashboard** rather than from a list of keys,
so a metric added to either module appears here without anybody remembering to add it. A
hand-maintained list is wrong the first time somebody adds a KPI.

**`refusedOutright`** — `grossMargin` and `projectedLtv`. Neither is a field on either dashboard;
both are functions that return an `Outcome` refusal. **A route that forwarded only the dashboard
would show neither**, and the operator asked why margin is missing from the board would have
nothing to say. They are called explicitly so their reason and their governing principle travel to
the page.

The two are separate fields on purpose. An unmeasured metric may become measurable when more data
arrives; a refused one will not become computable without somebody making a decision. Collapsing
them would tell a reader to wait for something that is not coming.

**The page renders the words "not measured" where the number would be**, plus the note, plus the
basis. Never a zero, never a dash, never a hidden row.

## Consequences

**A malformed reporting period is refused rather than silently replaced with the default.** A
dashboard that quietly reported a different window from the one asked for is a dashboard whose
numbers cannot be checked against anything — and the check somebody would run is exactly the one
that would appear to confirm it.

**The compliance distribution is written out state by state, including states at zero.** 9.1 changed
this from an average between versions specifically to stop somebody averaging it; a page that
omitted the empty states would let a reader conclude there is no `needs_review` problem because
there is no `needs_review` row.

**The Gardner rollup is served on the internal Console.** It is the PII-stripped view that leaves the
tenant, and an operator should be able to see exactly what leaves before it does. A rollup nobody
can inspect is a disclosure nobody reviewed. It computes its own `withheld` list for its own
audience, which is why the route asks the module rather than reusing the one above.

**Mutation-tested at both layers.** Coalescing the placement approval rate to zero in the transport
fails two transport tests; rendering an unmeasured value as `0` in the view fails a browser test on
the visible text.

**One consequence of testing the rule textually.** `console-capital.test.ts` asserts the coalescing
operator followed by a zero appears nowhere in `views/dashboards.js` — which means that file cannot
name the anti-pattern in its own header. It describes it instead, exactly as `console.js` describes
the markup-assigning properties without naming them, and says why.

## Alternatives considered

**Render null metrics only in a separate "gaps" section.** Tidier board, and it moves the refusal
away from the figure it is about. Somebody scanning the placement row would see a blank and go no
further; the note belongs on the row.

**Have the transport compute a display string per metric.** It would guarantee the wording. It would
also put the decision about what a figure means in the transport, which is the layer ADR-0022 says
owns nothing but the envelope — and the day two consumers wanted different wording there would be
two.
