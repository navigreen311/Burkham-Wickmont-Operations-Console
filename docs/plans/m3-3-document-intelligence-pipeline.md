# Plan — 3.3 Document Intelligence Pipeline

**Blueprint:** 3.3 Document Intelligence Pipeline · **Specification:** §5.8, Decisions A and B
**Branch:** `ai-feature/m3-3-document-intelligence-pipeline`
**Follows:** 3.2 Secure Document Vault (merged, `8ce95d2`)

Completes Category 3.

---

## The problem this module has

Blueprint 3.3 is the "primary integration point for Plaid (Decision A) and bureau data
(Decision B)", and its eight-step flow begins with _Plaid returns 24 months of transaction
history_. **Every vendor in that flow is ungated**: Plaid, the business bureau and the personal
credit provider all lack Argus review, a signed DPA and — for two of them — a chosen vendor
(§11.4, §12.3).

So the module cannot ingest anything. Built naively it would be eight stubs, and this codebase has
consistently refused that.

The way through is a split the blueprint's own step list implies but does not state:

| Half                                | Vendor-dependent? | This slice                                                               |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------ |
| **Ingestion** — steps 1, 2, 4, 5, 8 | Yes, entirely     | Consent-gated seams that report `not_built` and name what is outstanding |
| **Analysis** — steps 3, 6, 7        | **No**            | Fully built and fully tested                                             |

Step 3 is "enriches with categorization, revenue reconciliation, anomaly detection" and step 6 is
the bureau/bank correlation. Neither needs a vendor — they need _normalized data_. Normalizing on
our own shape rather than Plaid's is also what Decision A's V2 roadmap requires, since native
parsing eventually replaces Plaid for the parsing use case and must produce the same thing.

The analysis engine is therefore real, valuable, and testable against synthetic data today. That
is most of the module's actual intelligence.

---

## Mini-PRD

### Users

- **Capital Readiness** — Phase 0 intake: what is missing, what does the data say.
- **Funding Strategy** — application prep, resting on reconciled figures.
- **Risk & Defense** — NSF events and balance deterioration; blueprint 6.1 sources its alerts from
  exactly these findings.

### Success metrics

- Every derived fact carries provenance including the feed timestamp (principle 8, blueprint 3.3
  "provenance preservation on every enriched fact").
- Ingestion cannot run without the specific consent Decisions A and B require.
- An unavailable vendor reports `not_built` naming its outstanding preconditions — never an empty
  transaction list, which would read as "this client has no activity".

### Risks

| Risk                                   | Mitigation                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| A derived figure loses its source      | `Sourced<T>` throughout; a finding cannot be constructed without provenance       |
| Analysis silently runs on partial data | Coverage is computed and carried; a reconciliation over 3 of 24 months says so    |
| Correlation invents agreement          | Refuses when either side is absent, rather than treating missing as matching      |
| Categorization drifts into a black box | Deterministic rules with a stated basis per category, not a model                 |
| Findings leak PII                      | Findings carry amounts, dates and counterparty _classes_ — never raw descriptions |

---

## Key decision — normalize on our own shape

Analysis takes `NormalizedAccount` / `NormalizedTransaction`, not Plaid's payload.

Three reasons, in order of weight:

1. **It is the only way to build this at all today.** Vendor-shaped input would make every test a
   fixture of a payload nobody has seen.
2. **Decision A's V2 roadmap replaces Plaid for parsing.** If the analysis spoke Plaid, V2 would
   rewrite the analysis rather than swap the source.
3. **Bureau and bank data have to meet somewhere.** Step 6 correlates them, so a common shape is
   required regardless.

Each adapter's job becomes "produce the normalized shape", which is a much smaller and more
testable contract than "be Plaid".

## Key decision — findings are rows, transactions are not (yet)

`IntelligenceFinding` rows persist what downstream modules read: NSF events, large deposits,
revenue mismatches, owner transfers. Risk & Defense (6.1) consumes exactly these.

Raw transactions stay inside the ingestion run's payload rather than getting their own table. 24
months × thousands of transactions × every client is a real volume decision, and making it against
zero real data would be speculation. The normalized types are defined, so the table is a migration
rather than a redesign when volume arrives — noted as a known gap rather than pretended away.

---

## Architecture

```
packages/intelligence/
  normalized.ts   canonical account/transaction shape + Sourced provenance
  categorize.ts   deterministic transaction categorization
  analyze.ts      revenue reconciliation, NSF, large deposits, owner transfers, coverage
  correlate.ts    step 6 - bureau vs bank agreement, refusing when either side is absent
  documents.ts    classification + missing-document detection over the Vault
  ingest.ts       consent-gated seams; report not_built with outstanding preconditions
```

### Data model — schema `intelligence`

- `IngestionRun` — tenant, client, source, status, consent reference, `retrievedAt`, coverage,
  failure reason
- `IntelligenceFinding` — tenant, client, run, kind, severity, `Sourced` detail, occurredAt

### Consent gating

Decision A makes a Plaid connection GLBA-adjacent and Decision B makes bureau pulls FCRA-adjacent,
both requiring per-event authorization. `ingest()` checks the specific consent **before** touching
an adapter — so the refusal is "the client has not authorized this", which is the accurate reason,
rather than the vendor gate, which is ours.

---

## Test strategy

- Ingestion refuses without the matching consent, per source.
- Ingestion reports `not_built` naming outstanding preconditions once consent exists.
- Every finding carries provenance with the feed timestamp; an untagged finding cannot be built.
- Revenue reconciliation flags a mismatch beyond tolerance and passes within it.
- Partial coverage is reported, not silently averaged over.
- NSF events, large deposits and owner transfers are detected from synthetic transactions.
- Correlation refuses when either side is missing rather than reporting agreement.
- Categorization is deterministic and total — every transaction gets a category.
- Missing-document detection lists what a phase requires and the Vault lacks.
- Findings contain no raw transaction descriptions.

---

## Out of scope

Real vendor calls (all three ungated), CapitalForge statement handoff (step 7 — the normalized
output exists; the call is an Integration Layer adapter for a later slice), VisionAudioForge fraud
detection on PDFs (step 8, CapitalForge-side), and a transactions table.
