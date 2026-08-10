# 3.3 Document Intelligence Pipeline

The structured intelligence layer over client data. **Completes Category 3.**

## The problem this module has, and the split that solves it

Blueprint 3.3's eight-step flow begins with _Plaid returns 24 months of transaction history_.
**Every vendor in that flow is ungated** — Plaid, the business bureau and the personal credit
provider all lack Argus review and a signed DPA, and two lack a chosen vendor (§11.4, §12.3).

Built naively this module would be eight stubs. The way through is a split the step list implies
but does not state:

| Half                                | Vendor-dependent? | State                                                                          |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| **Ingestion** — steps 1, 2, 4, 5, 8 | Yes, entirely     | Consent-gated seams reporting `not_built` with outstanding preconditions named |
| **Analysis** — steps 3, 6, 7        | **No**            | Fully built, fully tested                                                      |

Step 3 is "categorization, revenue reconciliation, anomaly detection" and step 6 is the
bureau/bank correlation. Neither needs a vendor — they need _normalized data_. So most of the
module's actual intelligence ships now.

## Normalizing on our own shape

Analysis takes `NormalizedAccount` / `NormalizedTransaction`, not Plaid's payload. Three reasons,
in order of weight:

1. **It is the only way to build this today.** Vendor-shaped input makes every test a fixture of a
   payload nobody has seen.
2. **Decision A's V2 roadmap replaces Plaid for parsing.** If the analysis spoke Plaid, V2 would
   rewrite the analysis rather than swap the source.
3. **Bureau and bank data must meet somewhere** — step 6 correlates them.

Each adapter's job becomes "produce this shape", a far smaller contract than "be Plaid".

## Consent before the vendor gate

`ingest()` checks the source-specific consent **first**. Decision A makes a Plaid connection
GLBA-adjacent and Decision B makes bureau pulls FCRA-adjacent, both per-event.

If the client has not authorized the pull, that is the accurate reason to refuse. The vendor gate
is a fact about _us_, and reporting it first would misdescribe why nothing happened.

Every attempt is recorded, including the ones that go nowhere: a run row saying `unauthorized` or
`not_available` is how "we tried and could not" stays distinguishable from "we never tried", which
is what an absent row would mean.

Once authorized, an ungated vendor returns `not_built` naming what is outstanding — **never an
empty transaction list**, which downstream reads as "this client has no activity".

## Categorization is rules, not a model

Deterministic rules with a stated basis per category. Three reasons this is right _here_:

- A category feeds a funding recommendation, and principle 8 requires derived figures to ship how
  they were derived. "The classifier said so" is not a derivation anyone can audit.
- A rule can be shown to a client who disputes it. A weight cannot.
- Rules are reviewable by Compliance & Evidence, which owns this discipline.

The cost is coverage, so `uncategorized` is a first-class outcome and its share is reported — a
revenue figure resting on 40% unknown transactions is visibly weaker than one resting on 5%.

Internal transfers and owner contributions are excluded from revenue, which is the whole reason
categorization exists upstream: counting a transfer between the client's own accounts as revenue
is the most common way bank-derived revenue innocently diverges from reality.

## Coverage travels with every claim

A reconciliation over 3 of 24 months is a different statement from one over 24. `monthsCovered`
is carried through, `MINIMUM_COVERAGE` is two thirds and stated in one place so it can be argued
with, and thin coverage **downgrades severity rather than suppressing a finding** — three months
disagreeing with stated revenue is worth surfacing, just not as the same claim.

## Anomalies, relative to the client

| Finding                 | Basis                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `nsf_event`             | Escalates with frequency; one is a timing accident, five is a pattern                                                                  |
| `large_deposit`         | ≥3× the client's own median deposit, not a fixed threshold — $80k is unremarkable for one client and the event of the year for another |
| `owner_transfer`        | Draws reduce cash available to service debt; contributions can make revenue look stronger than the business generated                  |
| `balance_deterioration` | Net monthly cash flow trend per account; blueprint 6.1 sources alerts from these                                                       |

**No finding ever contains a transaction description.** Descriptions carry counterparty names and
findings reach the Event Ledger, which is retained indefinitely. Findings hold amounts, dates and
counts.

## Correlation refuses rather than inventing agreement

Step 6 is the natural place to accidentally invent agreement: with no bureau figure, a naive
implementation compares against zero or skips the check, and both read downstream as "no
disagreement found" — indistinguishable from a genuine match.

So an absent side returns `no_data` naming which side, never a clean result. Both sides' provenance
travels with every correlation, because "which one was stale" is the first question anyone asks.

Bureau debt service exceeding observed bank debt payments flags `possibleUndisclosedDebt`, which is
the shape blueprint 6.3 watches for.

## Missing-document detection

`PHASE_REQUIREMENTS` names what each phase needs; `assessCoverage` compares it against the Secure
Document Vault. One finding **per** missing document rather than one combined, because each is
independently actionable — a client can supply a debt schedule while an ID is outstanding.

`classifyByFilename` returns `null` rather than `other` when it cannot tell. "Could not classify"
and "classified as miscellaneous" are different states, and conflating them is how an unclassified
tax return ends up filed as `other`.

## Tests

```bash
pnpm test    # 247 tests
```

41 new. The analysis suite runs without a database or a vendor — the point of normalizing on our
own shape. Notable: every derived figure carries provenance; findings contain no descriptions
(asserted by serializing them and searching for the counterparty name); partial coverage is
reported not hidden; correlation refuses on each absent side; classification is deterministic and
total.

## Known gaps

- **No transactions table.** 24 months × thousands of transactions × every client is a real volume
  decision, and making it against zero real data would be speculation. Transactions live in the
  run's `normalized` payload; the types are defined, so this is a migration rather than a redesign.
- **Step 7 (CapitalForge statement handoff) is not wired.** The normalized output exists; the call
  is an Integration Layer adapter for a later slice.
- **Step 8 (VisionAudioForge fraud detection on PDFs) is CapitalForge-side** and not attempted here.
- **The `ingest()` normalizer is unwired** — it returns `failed` if an adapter ever returns data,
  because no vendor can. Wiring it is the first task when a gate clears.
- **Categorization rules are a starting set**, tuned against synthetic descriptions. Real bank
  descriptions are messier, and the uncategorized share is the metric that will show it.
