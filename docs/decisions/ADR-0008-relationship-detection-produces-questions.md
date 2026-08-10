# ADR-0008 — Relationship detection produces questions, and the graph risk rating carries no number

**Status:** Accepted · **Date:** 2026-08-10
**Modules:** 1.2 Client Household / Entity Graph

## Context

Blueprint 1.2 names two features whose obvious implementations are both wrong in ways that would
not show up as bugs.

**"Hidden-relationship detection."** Taken literally, this is a feature that tells an operator their
client concealed something. The system would be asserting a conclusion about a person, from a graph
somebody typed in by hand, on evidence that is circumstantial in every case.

**"Graph-level Risk Rating aggregation."** The Capital Stack Health Score (5.1) had already
resolved a similar tension — blueprint names a score, Decision E warns against bare numbers — by
producing a number that carries its components. Following that precedent here looks like
consistency.

## Decision

**1. A `RelationshipFinding` carries the question to put to the client, and has no field in which a
verdict could be recorded.**

Every finding has an `observation` (facts only), a `question`, and a `whyItMatters` explaining what
a lender would do with it. `weight` is `informational` or `ask_before_applying` — how much
attention it warrants, not how likely wrongdoing is. There is deliberately no level above
`ask_before_applying`.

**2. The graph risk rating is categorical with no numeric score at all**, and the overall band is
the **worst** component rather than an average.

## Consequences

### Detection

Every signal available here has an innocent explanation that is usually the true one:

| Observation                            | Usual explanation                    |
| -------------------------------------- | ------------------------------------ |
| Two entities share a controlling owner | The client has a second business     |
| A guarantee with no ownership          | A spouse or a business partner       |
| An intercompany transfer               | A management fee or a shared cost    |
| A cap table that does not total 100%   | A co-owner nobody thought to mention |

A system that flagged these as concealment would be wrong most of the time, and the times it was
"right" would be indistinguishable from the times it was not — because a graph cannot tell the
difference.

The value survives the reframing completely, which is the point. An underwriter reviewing the file
_will_ find these, running the same checks against the same public records — 25% is used as the
common-control threshold precisely because it is the FinCEN beneficial-ownership line a lender's
own KYC uses. The client should hear the question from us, in a preparation conversation, rather
than from a lender in a decline.

The cost is that an operator must actually ask. Nothing here auto-resolves, and a finding stays
open until somebody records the answer as an edge.

### The risk rating

The difference from 5.1 is what sits underneath. A health score summarises **measured quantities** —
balances, rates, days remaining — where a weighted total means something. A graph rating summarises
**structural facts**: whether guarantees concentrate on one person, whether cross-guarantees close
into a ring, whether the cap table adds up. There is no measurement, so a number would be
arithmetic performed on judgements and would read as far more precise than the thing it describes.

Taking the worst component rather than averaging follows from the same reasoning. Averaging is what
lets a cross-guarantee ring be diluted by three tidy components into "elevated" — and the ring is
precisely the thing somebody needs to see. A ring converts four independent lender relationships
into one credit.

A `graph_completeness` component exists so a thin graph cannot read as a safe one. A household with
entities and no relationships recorded scores well on every other dimension for the same reason an
empty room is quiet.

## Alternatives rejected

**A confidence score per finding.** Invites the reader to treat high-confidence findings as
established, which is the accusation this ADR avoids by another route.

**Filtering out low-weight findings.** An operator preparing a client for underwriting wants the
whole list; deciding which questions to ask is their judgement, not the detector's.

**A numeric risk score with components, matching 5.1.** Rejected above. Consistency with 5.1's
_shape_ would have cost consistency with Decision E's _reasoning_, and the reasoning is what
matters.

**Auto-suspending or blocking on findings.** Nothing here is certain enough to block on, and a
graph observation that halted an application would make the module something operators route
around.
