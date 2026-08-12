# 5.2 Lender Intelligence Database · 5.4 Capital Product Governance Board · 5.3 completed

**Packages:** `@bwc/lenders`, `@bwc/governance`, `@bwc/placement`
**Schemas:** `lenders`, `governance` · **ADR:** [ADR-0007](adr/0007-governance-status-lives-outside-the-provider-record.md)

---

## Why 5.2 was pulled forward from V1.5

The blueprint marks 5.2 _"Build in V1.5 (not V1)"_, and puts 5.3 and 5.4 in V1 — where 5.4
approves providers _in_ 5.2 and 5.3 _"turns Lender Intelligence Database data into client-specific
recommendations."_ Built literally, V1 ships a governance board with nothing to govern and a
recommendation engine with nothing to recommend.

What Decision D actually defers is **credit-union research scope**, not the existence of a
catalogue. The V1.5 work is researching five named credit unions; the database is what holds the
result, and it also holds the card issuers, national banks and fintech LOCs the blueprint puts
squarely in V1 scope.

So the database came forward and **the restriction is enforced in code**: a credit union other than
Navy Federal cannot be approved, and the five deferred CUs exist only as research-workstream rows
that no recommendation path can reach.

---

## The loop these three modules close

```
5.2 catalogue ──▶ 5.4 governance ──▶ 5.2 eligibility ──▶ 5.2 suitability ──▶ 5.3 recommendation
  what exists      may we, today?      does the client      should they          with provenance
                                        fit the box?        take this?
```

Governance runs **before** eligibility deliberately. A blacklisted provider must not have a
client's revenue evaluated against it at all — the answer is "no" for a reason that has nothing to
do with the client, and computing an eligibility verdict would produce a "you don't qualify" that
is both wrong and insulting.

---

## 5.2 Lender Intelligence Database

### Provenance is the asset

Blueprint 5.2 calls the database a "defensible long-term asset". What makes it defensible is not
the list of lenders — anyone can compile that — but the provenance on every rule. `recordRule`
takes a `Provenance` **value**, not loose columns, so there is no call shape that omits it.

Provenance is stored as discrete columns rather than inside a JSON blob, so _"what are we telling
clients that nobody has verified?"_ is one query (`unresearchedRules`) rather than a scan.

### Rules supersede, never overwrite

A rule current in March has to remain explicable when it justifies a March recommendation, and the
specification requires every rule change logged with source and verification method. Writing a rule
supersedes the prior version **in one transaction** — split, a crash leaves either two current
versions of a velocity rule with no way to know which governs, or none, which silently removes a
researched constraint from every later recommendation.

The superseded version keeps its own provenance. It _was_ an assumption at the time.

### Eligibility has three verdicts, not two

`eligible` / `ineligible` is the obvious model and is wrong here, because the third case is the
common one: the client's revenue is not recorded yet.

| Collapsing unknown into | Produces                                                                       |
| ----------------------- | ------------------------------------------------------------------------------ |
| `ineligible`            | Every good provider silently hidden until the file is complete, with no reason |
| `eligible`              | A fabricated recommendation the client cannot act on — the principle 1 failure |

So `unknown` is its own verdict and names the missing field, and `missingProfileFields()` inverts
it: _"record the entity's revenue and four more providers resolve."_

**Ineligible outranks unknown.** Filling in the revenue cannot make a provider serve a state it
does not serve, and reporting `unknown` would send someone to gather data that cannot help.

**A null threshold is not a threshold of zero.** A provider publishing no minimum score is not a
provider requiring 0.

### Suitability answers a different question from eligibility

Eligibility asks whether a client _can_ get a product. Suitability asks whether they _should_ — and
the products easiest to qualify for are frequently the worst fit. An advance will fund a 45-day
receivables gap in three days; a client who takes one for a five-year expansion services a
distressed obligation long after the reason for it ended. No underwriting box catches that. The
client qualified.

Scores run −2…3 on a small integer scale, not a percentage, because a percentage invites arithmetic
it cannot support and reads as a probability, which it is not. **Negative scores are surfaced as
cautions, never filtered out** — a client with no other option may still take one, and is entitled
to be told why it is a poor fit rather than to have it quietly removed from the list.

### Approval rate refuses to be a number computed from too little

Two approvals of three is "67%" arithmetically and nothing statistically. Below
`MINIMUM_OUTCOMES_FOR_RATE` (10 decided applications) the rate is **`null`** with a note saying
why. Withdrawals are excluded from the denominator — a withdrawn application was never decided, and
counting it against a provider would make them look worse the more clients changed their minds.

Profile keys are coarse on purpose: a finer key gives every client a cohort of one, and a cohort of
one produces rates of exactly 0% or 100% — numbers that look like knowledge and are noise.

### The V1.5 research workstream

The five deferred credit unions (Alliant, PenFed, BECU, First Tech, Lake Michigan) are seeded as
trackable workstreams with a status, assignee and target date. A research row is **not** a
Provider: no offerings, no governance record, so no recommendation query can reach it.

**Completing research does not create a provider.** Learning PenFed's rules is not a decision to
place clients there. Auto-promotion would let a researcher silently widen V1's lender scope by
saving their notes.

---

## 5.4 Capital Product Governance Board

The full reasoning is in [ADR-0007](adr/0007-governance-status-lives-outside-the-provider-record.md).
In brief: **governance status lives in its own schema** (a provider the board has never seen has no
row, and absence resolves to _not approved_), and **standing is derived at read time** (a nightly
staleness job that stops leaves every stale provider reading as approved, with no signal).

### Four refusals on approval, each protecting something different

| Refusal                    | Why                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| No rationale               | A decision nobody can explain cannot be appealed, taught, or revisited when the provider improves |
| **Decision D**             | A credit union other than Navy Federal cannot be approved in V1, refused by name citing the rule  |
| Cadence beyond quarterly   | Silently clamping would hide that a caller tried to weaken the guarantee                          |
| Approving out of blacklist | Reversing a blacklist must be its own decision, not a side effect of a routine approval           |

**Reinstatement goes to `pending_review`, never straight to approved.** It restores candidacy, not
approval; someone has to look again before clients are placed there.

### Complaints: weighted, and they flag rather than suspend

Three low-severity billing gripes and three regulator complaints about undisclosed fees are not the
same signal, and a flat count says they are. Severity is weighted (low 1 / moderate 2 / severe 5)
against a threshold of 5, so **a single severe complaint reaches it**.

Crossing the threshold moves the provider to `under_review` — which pauses recommendations — and
puts the decision in front of the board. It does **not** auto-suspend: that would let a competitor
or one unhappy client remove a provider from the platform without a human ever weighing the
complaint.

The weighted score is recomputed from the complaint rows rather than read off the running counter.
A stored counter and its source rows drift the first time a window resets mid-write, and the stored
one is the one that would silently be wrong.

A complaint against a provider the board has never seen is still recorded. It is evidence, and
discarding it would mean the governance file, when opened, starts blind.

---

## 5.3 Funding Recommendation Engine, completed

The refusal shipped with the walking skeleton and returned `not_built` naming 5.2. That module now
exists, so the refusal had become a false statement the system was making about itself.

### The three empty states, now all reachable and distinct

| Condition                             | Outcome     | What it says                                    |
| ------------------------------------- | ----------- | ----------------------------------------------- |
| No underwriting profile supplied      | `not_built` | 1.2 Entity Graph does not exist to hold one     |
| Catalogue empty                       | `no_data`   | The module exists, was consulted, holds nothing |
| Catalogue non-empty, nothing survives | `no_data`   | With the tally by stage and what to record next |

The middle row is the upgrade. Before this slice an empty catalogue was `not_built`; it is now
`no_data`, and the difference is a materially different statement to make to a client.

### Rejected alternatives carry their reasons

Blueprint 5.3 names "alternatives rejected". A list of provider names is not reviewable — a
compliance officer cannot distinguish a sound rejection from a bug, and neither can the client. Each
rejection carries its stage and the rule that produced it, so a memo says _"Highbar Commercial Bank:
requires 60 months in business; the entity is at 48"_ rather than _"not recommended."_

Candidates that rank below the presentation limit are also recorded as rejected alternatives. A memo
claiming three options were considered when six were is a smaller lie than an empty list, and still
a lie.

### Ranking

Suitability first, then cheaper-first among equals. **An unpriced product ranks below a priced one
of equal suitability, because an unknown cost is not a low one** — and a factored product is treated
as unpriced rather than having its factor compared to an APR, which is exactly the confusion 5.6
exists to remove.

### What reaches the Ledger

`placement.recommended` carries offering ids, a rejection count and the unverified-inputs flag. It
carries **no client attributes** — the recommendation is computed from revenue and a credit score,
and the Ledger is the one store that cannot be corrected after the fact. Asserted directly in
`tests/integration/funding-recommendation.test.ts`.

---

## Correction the tests forced

A test expected a recommendation set for a profile with revenue and credit score blank, and got
`no_data`. The verdict was right — every provider resolves to `unknown` and nothing survives — and
**the message was wrong**: "none survived" reads as _there is nothing for this client_ when four
providers are one recorded field away. `no_data` now names the fields to record. The set-level
`missingProfileFields` was only reachable on the success path, which is the path where it matters
least.

---

## Known gaps

- **No underwriting profile source.** 1.2 Entity Graph is not built, so the profile arrives with
  the request. Reported as `not_built` rather than defaulted.
- **Appetite signals are written by callers**, not by Village agents on a weekly cadence — the
  agent that would write them is category 6. Staleness is visible in the meantime.
- **`LenderOutcome` is a minimal stand-in for 5.5 Funding Outcome Ledger** (V1.5), which will
  subsume it.
- **CapitalForge issuer-rule ingestion** is ungated, so rules are entered by hand.
- **The Regulatory Engine does not exist** to consume `stateRestrictions()`; the payload is built
  and pulled rather than pushed.
