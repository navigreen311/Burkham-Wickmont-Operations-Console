# Plan — 9.1 Executive KPI Dashboard, 9.2 Unit Economics Dashboard

**Blueprint:** 9.1, 9.2 · **Branch:** `ai-feature/m9-kpi-dashboards`
**Follows:** 4.3 / 4.5 Calls & Marketing Ops (merged, `c33670f`)

Category 9's V1 scope is two of four. 9.3 Agent Productivity and 9.4 Lender Performance are V1.5.

---

## Mini-PRD

### Problem

9.1 is "the primary reporting surface to Gardner". 9.2 is how the founder decides whether the
service model works. These are the two modules where a wrong number does the most damage, because
a number on a dashboard is acted on and a number in a module is at least read in context.

Everything needed to compute them already exists in the modules that own it. **11.6 Data Warehouse
is not built**, so — like 7.1 — these dashboards read live and store nothing.

### Success metrics

- No metric returns a bare number. Every one carries its denominator, its period and its coverage.
- The compliance KPI is a **distribution**, and nothing in the package can average it.
- Gross margin is not reported as gross margin while the vendor COGS lines are unmeasured.
- A metric with no basis returns `null` **with a reason**, never `0`.

### Risks

| Risk                                                       | Mitigation                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **A rate computed over three data points read as a trend** | Minimum denominators, following 5.2 and 1.3; below them the rate is `null` with a reason |
| **A margin missing its COGS reported as margin**           | Named `marginBeforeUnmeasuredCosts`, and the unmeasured lines are listed on the value    |
| Someone averaging compliance state                         | Distribution only; no ordering or numeric helper exists, and 1.1 already refuses one     |
| An LTV projection presented as a measurement               | Realised revenue per client only; projected LTV refused, naming what it would need       |
| PII reaching a Gardner rollup                              | The rollup type has no field that could carry a client identifier                        |
| A partial period compared against a whole one              | Every value carries its period, and comparison refuses on mismatched lengths             |

---

## Key decision — a metric is a value with its basis, or it is nothing

Every module before this one has refused to produce a figure it could not stand behind: 5.2's
approval rate is `null` below ten outcomes, 1.3's conversion rate below ten decided leads, 5.1's
uncostable stack is `null` rather than `0`, 1.2's graph risk carries no number at all.

A dashboard is where that discipline either holds or quietly collapses, because a dashboard's job
is to put a number in front of somebody. So the shape here is a `Metric<T>`:

```ts
{
  value: T | null;
  basis: {
    (numerator, denominator, period, coverage);
  }
  note: string;
}
```

`value: null` with a note is the honest answer to "what is our approval rate" when eleven
placements have been made and four have been decided. `0` is not.

## Key decision — an incomplete margin is not a margin

Blueprint 9.2 requires "Plaid subscription cost per client, bureau pull costs per client" as COGS
lines feeding gross margin. **Neither vendor is gated in** — Decisions A and B put both behind a
security review that has not happened.

So the honest output is not a gross margin with two lines missing. It is a figure that says what it
excludes, named so a caller cannot mistake it: `marginBeforeUnmeasuredCosts`, carrying the list of
cost lines nobody can currently measure.

The alternative — reporting the margin anyway — produces a number that is wrong in a _known
direction by an unknown amount_, on the dashboard the founder uses to decide whether the business
works.

## Key decision — no projected LTV

Blueprint 9.2 lists "LTV by client type". LTV is a projection: it needs a churn rate, an expansion
rate and a discount assumption, and with the client counts this system currently holds, all three
would be invented.

So 9.2 reports **realised revenue per client to date**, which is a measurement, and refuses
projected LTV with a statement of what it would need. A projection presented next to measured
figures is read as a measurement.

---

## Architecture

```
packages/dashboards/
  metric.ts      the Metric<T> shape, minimum denominators, period handling
  compliance.ts  9.1 - the categorical distribution (Decision E)
  executive.ts   9.1 - the nine KPI domains, and the Gardner rollup
  economics.ts   9.2 - revenue, margin, CAC, cohorts
  costs.ts       9.2 - the vendor COGS seam, reported as not_built
```

No schema. Nothing here is owned; everything is computed. The one thing that could have been
stored — a snapshot — is deliberately not, for the reason derived seven times now: a stored
snapshot needs a job, and a job that stops leaves a dashboard showing last month as though it were
today.

## Test strategy

- A rate below its minimum denominator is `null` and says why.
- The compliance KPI is a distribution and the package exposes no way to average it.
- Margin is named for what it excludes, and lists the unmeasured lines.
- Vendor cost per client is `not_built`, naming Decisions A and B.
- Projected LTV is refused; realised revenue per client is computed.
- The Gardner rollup carries no client identifier — asserted structurally, not by inspection.
- A partial period is labelled, and comparing unequal periods refuses.

## Out of scope

9.3, 9.4 (V1.5). 11.6 Data Warehouse — these read live. Visualisation. Marketing spend has no owner
in this system, so CAC takes it as a supplied input and says so, following 5.1's precedent with
capital positions.
