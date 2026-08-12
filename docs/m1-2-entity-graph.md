# 1.2 Client Household / Entity Graph

**Package:** `@bwc/graph` · **Schema:** `graph`
**ADR:** [ADR-0008](adr/0008-relationship-detection-produces-questions.md)

---

## What this answers

A client signs a personal guarantee on a facility for their operating company. A second for the
real-estate entity that leases them their premises. A third for a partner's DBA. Each was
reasonable alone, and nobody holds the total — including the client.

The first lender to ask _"what else do you guarantee?"_ gets an answer that is wrong. The graph
exists so that question has an answer.

---

## Structure

`Entity` and `Owner` nodes, and one `GraphEdge` table with a `kind` discriminant: `ownership`,
`control`, `guarantee`, `cross_guarantee`, `debt`, `intercompany_transfer`.

A single edge table rather than one per kind, because the traversals are kind-agnostic and five
tables would make every walk a five-way union. The type safety that would have bought is recovered
by **`EDGE_RULES`** — a table saying which endpoint kinds each edge may connect and what it must
carry. It is data rather than a chain of conditionals so a test can iterate it, and so adding a
kind is one entry rather than an edit in five places somebody will make in four.

The failure it prevents is specific: nothing in the shape of a generic edge stops an `ownership`
edge pointing from an entity to an owner, and a reversed edge produces **numbers rather than
errors** — every exposure figure derived from it means the opposite of what it says.

Edges are **ended, not deleted**. A guarantee released in March still explains the exposure figure
that justified a March recommendation.

---

## Exposure

The distinction that makes the arithmetic right or wrong:

- a guarantee **of an entity** covers everything that entity owes, so it picks up debt signed
  _after_ the guarantee was given;
- a guarantee **of a named facility** covers that facility alone.

Collapsing them either overstates a guarantor by sweeping in unrelated debt, or hides most of their
exposure by pinning an entity-wide guarantee to one line. Both produce a confident number, which is
worse than producing none.

A guarantee limit caps the **owner's contribution from that guarantee**, not the underlying debt: a
$50k cap against a $400k mortgage is $50k of exposure. Applied per guarantee, because two capped
guarantees are two caps.

Obligations whose amount is not recorded are **counted, not treated as zero** — a total computed
over a graph with unpriced facilities is a floor, and the caller has to be able to say so.

> **Relationship to `pgExposureMap` in `@bwc/capital`.** That one aggregates over _observed_ Plaid
> positions; this one over _declared_ graph relationships. Same question, different sources — and a
> disagreement between them is itself a signal. Not implemented, because 5.1 has no persistence
> layer yet to compare against.

---

## Detection produces questions

Full reasoning in [ADR-0008](adr/0008-relationship-detection-produces-questions.md).

Six checks, each carrying the question to ask rather than a conclusion:

| Finding                            | The question                                                 |
| ---------------------------------- | ------------------------------------------------------------ |
| `undeclared_common_control`        | Are these two companies related beyond sharing an owner?     |
| `cross_guarantee_cycle`            | Were these cross-guarantees intended to be circular?         |
| `undeclared_intercompany_transfer` | What was the transfer for — a fee, a shared cost, or a loan? |
| `ownership_does_not_total`         | Who holds the rest? / Who owns this company?                 |
| `guarantee_without_ownership`      | What is this person's relationship to the entity?            |
| `guarantor_concentration`          | Does this guarantor know their combined total?               |

The common-control threshold is **25%**, the FinCEN beneficial-ownership line — the same number a
lender's own KYC uses, so a relationship flagged here is one an underwriter would independently
find.

Cycle detection is deduplicated by rotating each ring to its lexicographically smallest member: the
same ring found from three entry points reads as three problems and gets discounted as noise.

---

## Risk rating: categorical, worst-component

No numeric score anywhere — asserted directly in the tests. Four components:
`guarantor_concentration`, `structural_contagion`, `graph_completeness`, `unlimited_exposure`.

**Concentration alone is not risk.** A single-owner business _should_ have one guarantor; flagging
that would flag every sole proprietor in the portfolio. What raises the band is concentration
**across multiple entities**.

**`graph_completeness` stops a thin graph reading as a safe one.** A household with entities and no
relationships recorded scores well on everything else for the same reason an empty room is quiet.

---

## The derived profile — closing 5.3

5.3 returned `not_built` naming this module. It now derives the profile from the household:

| Field                  | Source                                                       |
| ---------------------- | ------------------------------------------------------------ |
| `state`                | Primary entity's state of formation                          |
| `timeInBusinessMonths` | **Derived** from the formation date, every time              |
| `industry`             | Primary entity                                               |
| `annualRevenue`        | What the client stated — `client_stated` provenance          |
| `personalCreditScore`  | **`null`** — needs an authorized bureau pull, vendor ungated |

Tenure is derived rather than stored: a stored month count is wrong the day after it is written,
and wrong silently. It counts whole months only once the day-of-month is reached, the way a lender
counts — a month of overstated tenure is enough to cross a 24-month underwriting threshold the
client has not actually met.

**What the graph cannot know is `null`, never a default.** This is where 5.2's three-valued
eligibility earns its keep: a null credit score produces "unknown — record this field" rather than
a fabricated pass or a spurious rejection. The end-to-end test shows exactly that, with a provider
requiring a 680 score resolving to `unknown` while one requiring none survives.

`no_data` rather than a profile of nulls when no primary entity is designated: a profile of nulls
reads as a data-gathering problem when the actual problem is that nobody said which company is
applying.

### There is no `not_built` left in the funding path

The assertion in `placement-gate.test.ts` has moved twice, and each move was the same event — a
module named in a `not_built` got built, so naming it became a false statement the system was
making about itself. First 5.2, then 1.2. It is now `no_data`.

`notBuilt` is no longer imported by `@bwc/placement` at all, which is how the lint caught it.

---

## PII

SSN and EIN are envelope-encrypted at rest (reusing `@bwc/vault`'s `encryptField`). **Neither ever
enters a `Graph` value** — it carries a display last-4 only, so no traversal, finding, rationale or
ledger payload can include one. Not because each of those strips it, but because they were never
given it.

`revealSsn` / `revealEin` are the only readers, are separate functions a caller must deliberately
reach for, **require a stated purpose**, and write an access event. The question a regulator asks
about an encrypted field is not whether it was encrypted but who read it.

A mutation test that deliberately wrote an SSN into a ledger payload was caught twice: by the
payload-shape assertion, and by the Ledger's own `redactPii` guard, which recognises `ssn` as a PII
field name. Defence in depth, verified rather than assumed.

---

## `client_stated` — a new provenance tag in core

A client's stated revenue is none of the existing tags: nobody assumed it, no issuer published it,
no vendor returned it. Storing it as `vendor_feed` would present a self-reported figure identically
to a Plaid-derived one; as `unresearched_default` it would describe the client's own statement as
our assumption. Both are Decision D's failure in different clothing.

`isUnverified` widens to include it. `fromProvenance` in `@bwc/lenders` **throws** on it — a lender
rule cannot be client-stated, and a silent coercion there would be the bug the tag exists to
prevent.

---

## Correction the tests forced

A test asserting findings over a persisted household returned none — correctly, because every gap
there was an untouched entity, which `isolatedEntities` covers as a data-quality signal rather than
a question. What it exposed was a real hole: **an entity with debt and no recorded owner also
produced nothing**, and "who owns this company?" is the first question a lender asks.
`ownership_does_not_total` now fires at zero recorded ownership when the entity is otherwise
engaged in the household, and stays quiet for a freshly created record.

---

## Known gaps

- **Visual graph interface**, expand/collapse subgraphs — blueprint 1.2 names them; they are UI and
  this repository is the API. `componentOf` and `nodeIds` on findings exist for one to build on.
- **Entity extraction from documents.** 3.3 produces findings; promoting one to an entity is a
  human act and stays one.
- **Bureau pulls.** Ungated vendor, so no owner credit score can exist on file.
- **Graph-versus-observed exposure reconciliation.** Needs 5.1 persistence, which does not exist.
