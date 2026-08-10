# Plan — 1.2 Client Household / Entity Graph

**Blueprint:** 1.2 · **Branch:** `ai-feature/m1-2-entity-graph`
**Follows:** 5.2 + 5.4 + 5.3 completed (merged, `a5c0c96`)

---

## Why this module next

5.3 currently returns `not_built` naming **1.2 Client Household / Entity Graph**. The Console holds
a client's legal name and compliance state and nothing else about them — no formation date, no
state, no industry, no ownership, no guarantors. Every recommendation therefore depends on a
caller assembling an underwriting profile by hand.

This is the same shape of gap 5.2 was: a module three others declare as a dependency, absent, with
the absence honestly reported. Building it closes the last `not_built` in the funding path.

## Mini-PRD

### Problem

The blueprint's own worked example of what goes wrong: a client signs a personal guarantee on a
facility for their operating company, and a second on a facility for the real-estate entity that
leases them their premises, and a third for a partner's DBA. Each was reasonable alone. Nobody
holds the total, including the client — and the first lender to ask _"what else do you guarantee?"_
gets an answer that is wrong.

The graph exists so that question has an answer.

### Success metrics

- Total personal-guarantee exposure per owner across **every** entity, not per facility.
- Relationships a client has not declared are surfaced as **questions to ask**, never as findings
  asserted about them.
- An underwriting profile derives from the graph, with each field's source stated.
- SSN and EIN are field-level encrypted and never reach a log, an error or the Ledger.

### Risks

| Risk                                               | Mitigation                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A detection reads as an accusation**             | Every finding carries the _question to put to the client_, not a conclusion; the type has no verdict field     |
| SSN reaches a log or the Ledger                    | Stored as ciphertext with a display-only last 4; the plaintext never leaves the decrypt call                   |
| A cycle in the graph hangs a traversal             | Cycles are the thing being looked for; every walk is visited-set bounded and tested against a deliberate cycle |
| A derived profile presents an assumption as a fact | Each field carries where it came from; what the graph cannot know is `null`, not a default                     |
| Risk rating becomes an opaque number               | Categorical, with components — and unlike the capital health score there is no measured quantity underneath    |

---

## Key decision — detection produces questions, not conclusions

"Hidden-relationship detection" is the blueprint's phrase, and taken literally it invites a feature
that tells an operator a client concealed something. Every signal available here has an innocent
explanation that is usually the true one: a shared owner between two entities is a second business,
a guarantee without ownership is a spouse, an intercompany transfer is a management fee.

So a `RelationshipFinding` carries **the question to put to the client** and the observation that
prompted it, and has no field expressing a verdict. The value is real and it is the same value
either way: an underwriter _will_ find these, and the client should hear the question from us
first.

## Key decision — the risk rating is categorical, with no number at all

Blueprint 1.2 names a "graph-level Risk Rating aggregation". The Capital Stack Health Score (5.1)
resolved the same tension with a number that carries its components, and this module deliberately
does **not** follow that precedent.

The difference is what sits underneath. A health score summarises measured quantities — balances,
rates, days. A graph risk rating summarises _structural_ facts: whether guarantees concentrate on
one person, whether cross-guarantees form a cycle. There is no underlying measurement, so a number
would be arithmetic performed on judgements and would read as far more precise than the thing it
describes.

Bands and components only. The consistency being preserved is with Decision E's reasoning, not
with 5.1's shape.

## Key decision — `client_stated` becomes a provenance tag in core

A client's stated annual revenue is neither an `issuer_rule`, nor a `vendor_feed`, nor an
`unresearched_default` — nobody assumed it, the client said it. Storing it under one of the
existing tags would present a self-reported figure identically to a Plaid-derived one, which is
Decision D's exact failure in different clothing.

`isUnverified` widens to include it, because a deliverable resting on a client-stated figure should
say so. `fromProvenance` in `@bwc/lenders` throws on it: a lender rule cannot be client-stated, and
a silent coercion there would be the bug this tag exists to prevent.

---

## Architecture

```
packages/graph/
  model.ts      the Graph value: nodes, edges, and the kind/endpoint validity table
  store.ts      persistence; SSN and EIN encrypted at rest; loads a Graph
  traverse.ts   pure - reachability, cycle detection, subgraph extraction
  exposure.ts   pure - personal-guarantee exposure per owner across the whole graph
  detect.ts     pure - relationship findings, each carrying the question to ask
  risk.ts       pure - categorical graph risk with components
  profile.ts    derives the 5.3 underwriting profile, with per-field sources
```

Everything except `store.ts` is pure over a `Graph` value, so the interesting behaviour is testable
exhaustively without a database.

### Data model — schema `graph`

- `Entity` — legal entity: role, state of formation, formation date, industry, encrypted EIN,
  stated revenue with who stated it and when, primary-operating flag
- `Owner` — individual: name, encrypted SSN, display last 4
- `GraphEdge` — one table with a `kind` discriminant (`ownership`, `control`, `guarantee`,
  `cross_guarantee`, `debt`, `intercompany_transfer`) and a validity table in code constraining
  which endpoint kinds each may connect

A single edge table rather than one per kind: the traversals are kind-agnostic, and five tables
would make every walk a five-way union. The type safety a table-per-kind would give is recovered
by a validity table that is itself tested.

### 5.3 wiring

`requestRecommendation` derives the profile from the graph when the caller does not supply one.
Its `not_built` on 1.2 becomes `no_data` when the client has no primary operating entity — the
same transition 5.2 caused, and for the same reason: the module now exists and was consulted.

---

## Test strategy

- Edge validity: every `kind` rejects endpoint kinds it cannot connect.
- PG exposure aggregates per owner across entities, caps limited guarantees, flags unlimited.
- A guarantee of an entity reaches that entity's debt; a guarantee of a specific facility does not
  sweep in the rest of the entity's obligations.
- Cycle detection terminates on a deliberate cross-guarantee cycle and names its members.
- Two entities sharing a controlling owner with no edge between them raises a finding.
- A guarantee without ownership raises a finding; ownership without guarantee does not.
- Every finding carries a question and no verdict.
- Risk bands move on structure, not on magnitude.
- SSN round-trips through encryption, and neither plaintext nor ciphertext appears in any event.
- A derived profile reports formation-date-derived tenure, and `null` for what needs an ungated
  vendor, with sources naming both.
- 5.3 end-to-end without a supplied profile.

---

## Out of scope

The visual graph interface and expand/collapse (blueprint 1.2 names them; they are UI, and this
repository is the API). Entity extraction from documents (3.3 produces findings; promoting one to
an entity is a human act). Bureau pulls for owner credit scores — ungated vendor, so the profile
reports the field as unavailable rather than guessing.
