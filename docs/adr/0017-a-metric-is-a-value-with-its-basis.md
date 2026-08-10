# ADR-0017 — A metric is a value with its basis, or it is nothing

**Status:** Accepted · **Date:** 2026-08-10 · **Modules:** 9.1 Executive KPI Dashboard, 9.2 Unit Economics Dashboard

## Context

Every module built before this one has refused to produce a figure it could not stand behind:

- 5.2 returns `null` for a provider approval rate below ten decided outcomes.
- 1.3 returns `null` for a channel conversion rate below ten decided leads.
- 5.1 returns `null` rather than `0` for an uncostable capital stack.
- 1.2 gives graph risk no number at all.
- 6.5 gives risk severity no score.

A dashboard is where that discipline either holds or collapses, because a dashboard's entire job
is to put a number in front of somebody who will act on it. The pressure runs the other way from
everywhere else in the system: an empty cell looks like a bug, and `4/4 = 100%` is right there.

## Decision

Every figure produced by `@bwc/dashboards` is a `Metric<T>`:

```ts
{ key, label, value: T | null, basis: { numerator, denominator, period, coverage, unmeasured }, note }
```

- **`value: null` never means zero.** Zero is a measurement; `null` means there was nothing to
  measure, and `note` says what would make a number appear.
- **Rates require a minimum denominator** (10, matching 5.2 and 1.3), and below it the _counts are
  still shown_ — they are real — while the rate is withheld.
- **Coverage is `complete` / `partial` / `unavailable`**, and `unmeasured` lists inputs the
  specification names that could not be read.
- **Periods are half-open `[from, to)`** so consecutive periods neither overlap nor gap, and carry
  `partial: true` when they have not finished.
- **`compare` refuses** on unequal period lengths and on any partial period. Month-to-date against
  a completed month is the most common way a dashboard misleads without anybody intending it: the
  arithmetic is fine, it describes nothing, and it always flatters the past.

### Three metrics this produces by refusal

**Placement approval rate** — refused. `FundingOutcome` records approvals only; denials and
adverse-action notices belong to **5.5 Funding Outcome Ledger, V1.5**. A rate from what exists
would read 100% forever: arithmetically correct, extremely reassuring, and the exact claim the
Marketing Claim Library bans. What _is_ measurable — how many placements our own gate stopped — is
reported under its own name, `internalGateRefusalRate`, because it measures us and not the
providers.

**Gross margin** — refused. Blueprint 9.2 defines it as including per-client Plaid and bureau
costs, and both vendors are ungated under Decisions A and B. A margin without them is wrong _in a
known direction by an unknown amount_ on the surface the founder steers by. `offerEconomics`
returns the same arithmetic as `marginBeforeUnmeasuredCostsCents`; the awkward name is the point.

**Projected LTV** — refused. It needs an observed churn rate, an observed expansion rate and a
chosen discount rate; none exists, so all three would be assumptions sitting next to measurements —
and the number would then be compared against a measured CAC to decide whether acquisition is
profitable. `realisedRevenuePerClient` is reported instead: a measurement, and a floor.

## Consequences

**A new dashboard will look sparse.** Several headline metrics are `null` on day one. That is the
correct first impression, and the notes say what each is waiting for.

**Nothing is stored.** No snapshot table, no materialised view. A stored snapshot needs a job, and
a job that stops leaves a dashboard showing last month's numbers under this month's date — an
invisible failure on the surface the company steers by. 11.6 Data Warehouse does not change this
argument; it changes where the reads come from.

**The Gardner rollup strips PII structurally.** `GardnerRollup` has no field a client identifier
could occupy, rather than a redaction pass over a richer object — which works until somebody adds a
field. It also carries a `withheld` list, so a portfolio view cannot read as complete.

**Compliance stays categorical.** Blueprint 9.1 restates Decision E as an explicit change from v1,
so `complianceDistribution` returns counts and shares per state — every state present, including
those at zero — and transition direction comes from a hard-coded pairwise table rather than an
ordering. The moment an ordering exists, somebody averages it.

## Alternatives considered

**Return `0` and let the UI decide.** Rejected. The UI does not know the difference between "no
clients failed" and "no clients assessed", and the caller most likely to get it wrong is a
spreadsheet.

**Report every metric and footnote the gaps.** Rejected: the footnote is read once and the number
is read every month.

**Lower the minimum denominator for a young company.** Rejected. The denominator is small precisely
when the temptation to quote a rate is highest, and a 100% approval rate over four decisions is the
number most likely to end up in a marketing claim.
