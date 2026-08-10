# Plan — 5.2 Lender Intelligence Database, 5.4 Capital Product Governance Board

**Blueprint:** 5.2, 5.4, and the completion of 5.3 · **Branch:** `ai-feature/m5-lender-intelligence-and-governance`
**Follows:** 5.1 + 5.6 (merged, `4c687b1`)

---

## The scheduling conflict this slice resolves

The blueprint marks **5.2 as _"Build in V1.5 (not V1)"_**. It also puts **5.4 in V1**, and 5.4's
function is _"approval workflow for lenders … before agents can recommend them"_ — approval of
providers held in 5.2. And 5.3 is in V1, defined as _"turns Lender Intelligence Database data into
client-specific recommendations."_

Two V1 modules therefore read from and write to a V1.5 module. Built literally, V1 ships a
governance board with nothing to govern and a recommendation engine with nothing to recommend —
which is exactly what has been sitting in `@bwc/placement` since the walking skeleton, returning
`not_built` and naming 5.2 as the reason.

Reading the deferral more carefully resolves it. What Decision D actually defers is **credit-union
research scope**, not the existence of a catalogue:

> "V1 CU placement restricted to Navy Federal only."
> "Now formally tracks research workstream for the five credit unions deferred to V1.5 — Alliant,
> PenFed, BECU, First Tech, Lake Michigan CU."

The V1.5 work is _researching five credit unions_. The database is what holds the result, and it is
also what holds the card issuers, national banks and fintech LOCs the blueprint puts squarely in
V1 scope. So the database comes forward and **the scope restriction is enforced in code**: a
credit union other than Navy Federal cannot be approved, and the five deferred CUs exist only as
research-workstream rows that no recommendation path can reach.

That is the honest reading — V1 keeps the restriction the deferral existed to impose, and stops
pretending two of its own modules can work without their dependency.

---

## Alternatives considered

**A. Build 5.4 alone against a stubbed catalogue.** Honours the letter of the V1.5 deferral. But a
governance board whose provider records are fixtures has no approval workflow worth testing — the
interesting behaviour is entirely in what happens to a real catalogue. Rejected.

**B. 5.2 + 5.4, leave 5.3 refusing.** Defensible and smaller. But 5.3's `not_built` names 5.2
explicitly; once 5.2 exists, that refusal becomes a lie told by the system about itself. Leaving it
would mean shipping a module whose stated reason for refusing is no longer true.

**C. 5.2 + 5.4 + complete 5.3's recommendation path.** _(chosen.)_ The three modules form one
closed loop: the catalogue holds providers, the board decides which may be recommended, the engine
recommends from what survives. Any two of them is a system with a hole in it.

---

## Mini-PRD

### Problem

The Console can compute what a client's capital costs, and cannot say where better capital would
come from. It holds no structured knowledge of a single provider — no underwriting box, no state
coverage, no appetite, no complaint history, and no record of whether anyone ever approved a
provider for use at all.

The specific failure this prevents is the one Decision D was written for: **a lender velocity rule
that nobody researched, presented to a client with the same confidence as one read off the issuer's
published terms.** Without a database that carries provenance on every rule, the difference is
invisible to the client and to the agent alike.

### Success metrics

- Every lender rule carries `issuer_rule` or `unresearched_default`, structurally — an untagged
  rule is a rejected write, not a lint warning.
- No provider is recommendable without an explicit governance approval that a named human made.
- A credit union other than Navy Federal cannot be approved in V1.
- 5.3 returns a real recommendation, with rejected alternatives carrying their reasons.

### Risks

| Risk                                                                          | Mitigation                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A provider slips into recommendation without governance approval              | Governance status lives in a different schema from the provider profile; 5.2 has no field with which to grant it   |
| An approval goes stale and nobody notices                                     | Standing is derived at read time from `lastReviewedAt`, never stored — a scheduler outage cannot fake currency     |
| An `unresearched_default` reaches a client unlabelled                         | It propagates into `containsUnverifiedInputs` on the recommendation and into the rejection reasons                 |
| An approval probability is invented from three data points                    | Approval rate returns `null` below a minimum sample; a rate is a claim about frequency and needs frequency to make |
| The V1.5 credit unions leak into V1 placement through the research workstream | Research rows are not providers; they have no product offerings and no governance record, so no query reaches them |

---

## Key decision — governance status is not a field on the provider

`Provider` (schema `lenders`) carries the profile. `ProviderGovernance` (schema `governance`)
carries approval status, review date, restricted states and blacklist. They are separate records in
separate schemas.

The alternative — a `status` column on `Provider` — is simpler and quietly wrong. It lets the module
that _describes_ providers also decide which are usable, which is the separation 5.4 exists to
create. Splitting them means **a provider the board has never seen has no governance record at all,
and absence resolves to "not approved."** The safe default is the structural one rather than a
default value someone can change.

## Key decision — standing is derived, never stored

Blueprint 5.4 requires a "periodic re-review cadence (quarterly minimum)". The obvious
implementation is a nightly job that flips approved providers to `review_overdue`.

That job is a single point of silent failure: if it stops, every stale provider keeps reading as
approved and the system's most load-bearing claim — _this provider was reviewed recently_ — degrades
with no signal. So `standing()` computes recommendability at the moment of asking, from status,
`lastReviewedAt`, the cadence and today's date. There is nothing to run and nothing to miss.

## Key decision — rejected alternatives carry their reasons

Blueprint 5.3's data model names "alternatives rejected". A list of provider names is not reviewable
— a compliance officer cannot tell a sound rejection from a bug, and neither can the client. Every
rejection carries the rule that produced it, so the memo can say _"Provider X: minimum time in
business 24 months, client at 14"_ rather than _"Provider X: not recommended."_

---

## Architecture

```
packages/lenders/            5.2
  provider.ts     catalogue: register, update, query by kind and state
  rules.ts        versioned rules; provenance mandatory; supersede-not-overwrite
  offerings.ts    product offerings and their underwriting boxes
  eligibility.ts  pure - does a client profile fit an underwriting box, and why not
  suitability.ts  pure - the Funding Product Suitability Matrix
  appetite.ts     weekly appetite signals, with staleness visible
  performance.ts  approval rate by lender x profile, with a minimum sample
  research.ts     the V1.5 credit-union research workstream (Decision D)

packages/governance/         5.4
  board.ts        submit / approve / suspend / blacklist / re-review + audit trail
  standing.ts     pure - derives recommendability from status, cadence and today
  complaints.ts   complaint records and the auto-flag threshold
  restrictions.ts state restrictions, and the payload the Regulatory Engine consumes

packages/placement/          5.3 completed
  index.ts        recommend() - catalogue -> governance -> eligibility -> suitability
```

### Data model

**Schema `lenders`** — `Provider`, `LenderRule`, `ProductOffering`, `AppetiteSignal`,
`LenderOutcome`, `ProviderContact`, `ResearchWorkstream`.

**Schema `governance`** — `ProviderGovernance`, `GovernanceDecision`, `ProviderComplaint`.

> **Decision recorded:** complaint _records_ live in `governance`, though blueprint 5.2 lists
> "complaint history" in the provider profile. 5.4 owns "complaint trends" and the auto-flag
> threshold, and the module that acts on a record should own it. 5.2 reads complaint history through
> the governance package's API rather than by cross-schema join — specification 5.1, no service
> reaches into another service's database.

Rule changes **supersede rather than overwrite**: a new version is written and the prior one gets
`supersededAt`. Specification section on versioning requires "every rule change logged with source,
verification method, `lastVerified` timestamp", and a rule that was current in March has to remain
explicable when it justifies a March recommendation.

---

## Test strategy

- An untagged rule is a rejected write.
- An `unresearched_default` rule surfaces on the recommendation as unverified.
- Superseding a rule leaves the prior version readable and marked.
- A provider with no governance record is not recommendable.
- A credit union other than Navy Federal cannot be approved — Decision D, by name.
- The five deferred CUs exist as research rows and are absent from every recommendation query.
- An approval older than the cadence is not recommendable, computed from the clock rather than a flag.
- A blacklisted provider is refused even while its status row still says it was once approved.
- Complaints crossing the threshold auto-flag the provider for review.
- Every governance decision writes an audit row and a ledger event.
- Eligibility rejects on each box dimension and names the dimension it rejected on.
- Approval rate returns `null` below the minimum sample rather than a number.
- 5.3 end-to-end: firewall gate, consent, catalogue, governance filter, ranked recommendation.
- 5.3 returns `no_data` — not `not_built` — when the catalogue exists but nothing in it fits.

---

## Out of scope

5.5 Funding Outcome Ledger (V1.5) — `LenderOutcome` here is the minimum needed for approval-rate
tracking and will be subsumed by it. CapitalForge issuer-rule ingestion (ungated vendor). Automatic
weekly appetite updates from Village agents — the signal model is built, the agent that writes it
is category 6. The Regulatory Engine consumes the state-restriction payload; the engine itself is
category 7.
