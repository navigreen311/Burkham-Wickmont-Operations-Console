# 9.1 Executive KPI Dashboard · 9.2 Unit Economics Dashboard

Package: `@bwc/dashboards` · **No schema** · ADR: [0017](adr/0017-a-metric-is-a-value-with-its-basis.md)

Category 9's V1 scope. 9.3 Agent Productivity and 9.4 Lender Performance are V1.5.

---

## The shape — ADR-0017

Every figure is a `Metric<T>`: a value that may be `null`, plus the basis it was computed from.

```ts
{ key, label, value: T | null, basis: { numerator, denominator, period, coverage, unmeasured }, note }
```

`null` is not zero. Zero is a measurement; `null` means there was nothing to measure, and the note
says what would make a number appear. A rate below its minimum denominator (10, matching 5.2 and
1.3) still shows its **counts** — those are real — and withholds the rate.

`compare` refuses across unequal period lengths and across any period that has not finished.
Month-to-date against a completed month is the most common way a dashboard misleads without anybody
intending it.

**Nothing is stored.** 11.6 Data Warehouse is not built, and even when it is, a snapshot would need
a job — and a job that stops leaves a dashboard showing last month's numbers under this month's
date. That failure is invisible, on the surface the company steers by.

---

## 9.1 Executive KPI Dashboard

### Compliance is a distribution, never an average

Blueprint 9.1 changed this between versions specifically to stop somebody averaging it:

> **Change from v1:** Compliance KPI is now percentage of clients per categorical state, **not
> average numeric score**. Target: 90%+ in Pass or Pass with Findings.

So `complianceDistribution` returns counts and shares **per state, every state present including
those at zero** — a dashboard that omits `fail` when empty teaches its reader that a missing row
means no problem, and the day a client lands there the row appears somewhere nobody was looking.

`healthyShare` exists because the blueprint states a target against it. It is a share of two
**named** states, not a weighted score.

Transition direction comes from a hard-coded pairwise table, not an ordering — the moment an
ordering exists somebody averages it. `pending_assessment → needs_review` is **lateral**: nothing
improved or worsened, somebody finally looked.

### The approval rate is refused, and that is the finding

`FundingOutcome` records an approval — an approved credit limit and a date. There is no column for
a denial, because **denials and adverse-action notices belong to 5.5 Funding Outcome Ledger, which
is V1.5**.

So the denominator does not exist, and a rate computed from the table would read **100% forever**:
arithmetically correct, extremely reassuring, and the exact claim the Marketing Claim Library bans
and the Funding Ethics Firewall exists downstream of.

What _is_ measurable is how many placement attempts our own gate stopped. That is reported as
`internalGateRefusalRate` — named so nobody reads it as the metric 9.1 asked for, because it
measures us rather than the capital providers.

### What is measured, and what is named as missing

| Measured                          | Note                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Readiness improvement             | Mean change across clients with **two** readings; a single reading is a position, not an improvement |
| Firewall resolution rate          | Real at n=1 — "how many triggers did we clear" is answerable where an approval rate is not           |
| Open correction obligations (4.3) | A count with overdue separated, not a percentage; this is the number somebody acts on                |
| Partner referral conversion       | Decided referrals only                                                                               |
| Refund rate                       | Decided refund positions only                                                                        |
| Revenue per client                | **Billed, not collected**; only `charge` lines count, so a payment cannot double-count               |

`UNPRODUCED_DOMAINS` carries the rest — placement approval rate, stack utilization, forecast
accuracy, NPS, complaint rate, gross margin — each naming the integration or module that would fill
it. A dashboard silently missing a domain asserts a completeness it does not have.

### The Gardner rollup

PII stripping is **structural**: `GardnerRollup` has no field a client identifier could occupy,
rather than a redaction pass over a richer object — which works until somebody adds a field.

It also carries `withheld`, so a portfolio view cannot read as complete.

---

## 9.2 Unit Economics Dashboard

### An incomplete margin is not a margin

Blueprint 9.2 requires per-client Plaid and bureau costs as COGS lines feeding gross margin.
**Neither vendor is gated in** — Decisions A and B put both behind a security review that has not
happened.

So `grossMargin` **refuses**. `offerEconomics` returns the same arithmetic as
`marginBeforeUnmeasuredCostsCents`, carrying the list of cost lines nobody can measure. The awkward
name is the point: a caller cannot use it while believing it is a margin.

`vendorCostForClient` returns `not_built` rather than `0`. Zero would flow into a margin as a
measurement and overstate every engagement by exactly the amount nobody has counted.

### No projected LTV

LTV needs an observed churn rate, an observed expansion rate and a chosen discount rate. None
exists, so all three would be assumptions sitting next to measurements — and the result would be
compared against a measured CAC to decide whether acquisition is profitable.

`realisedRevenuePerClient` reports what has actually been billed per client to date, by offer, with
**mean tenure alongside** so a reader can see how much of a lifetime the figure covers. It is a
measurement and a floor.

The refusal names what would make it computable — enough _ended_ engagements to observe retention —
so it is a piece of work rather than a permanent gap.

### CAC takes spend from the caller

No module owns marketing spend. 4.5 holds campaigns and their channel values but no budget, and
inventing a spend store in a dashboard package would make the company's cost base a second source
of truth the day a finance system arrives. 5.1 made the same call with capital positions.

A channel with conversions and no supplied spend is reported **with its conversion count and a null
CAC** rather than dropped — a channel missing from a CAC report reads as a channel that acquired
nobody. Spend with zero conversions gives a null CAC too: not infinity, not zero.

### Refusals travel with the dashboard

`unitEconomicsDashboard` carries a `refused` list — gross margin, projected LTV, cost per funded
dollar — each with why. The absence is a stated decision rather than a missing row a reader has to
notice.

---

## Tested

33 tests: `tests/integration/kpi-dashboards.test.ts` (19) and
`tests/invariants/dashboard-metrics.test.ts` (14). Suite total **778**.

Mutation-verified:

| Mutation                                   | Failures |
| ------------------------------------------ | -------- |
| Remove the minimum-denominator guard       | 1        |
| Compute the placement approval rate anyway | 1        |
| Report a gross margin                      | 1        |

One invariant is asserted structurally rather than by example: the package exports nothing matching
`/score|rank|average/` for compliance, because if a rank function existed an average would follow.
