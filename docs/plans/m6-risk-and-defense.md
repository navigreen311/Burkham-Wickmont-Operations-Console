# Plan — 6.4 Do Not Fund Governance, 6.5 Risk Event Timeline

**Blueprint:** 6.4, 6.5 · **Branch:** `ai-feature/m6-risk-and-defense`
**Follows:** 4.1 Communications Hub (merged, `c88221d`)

---

## Why these two, and why together

Category 6's V1 scope is three modules: 6.2 Funding Ethics Firewall (built with the walking
skeleton), 6.4 and 6.5. 6.1 and 6.3 are deferred to V1.5.

They belong in one slice because a Do Not Fund listing **is** a risk event, and a timeline that
omitted the most consequential determination the company makes about a client would be a timeline
nobody trusted.

There is also a loose end to close: `firewall.evaluate` already refuses a `fail` client with the
message _"the client routes to Do Not Fund Governance"_ — routing to a module that does not exist.

## Mini-PRD

### Problem

The Firewall freezes placement for a condition. Nothing records the standing determination that a
particular client should not receive further capital at all, why, who decided, or when it was last
looked at. Blueprint 6.4 is explicit that this is "not just a flag".

### Success metrics

- A listed client cannot be placed, and the refusal names Do Not Fund rather than something else.
- An override permits **one action**; it does not delist.
- Compliance state `fail` lists a client automatically, per Decision E.
- Every risk-relevant event about a client appears on one chronological timeline.

### Risks

| Risk                                                            | Mitigation                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **An override quietly becomes a delisting**                     | An override is scoped to one action and one use; delisting is a separate act with its own justification       |
| A stale review unblocks a listed client                         | Staleness flags for review and **keeps blocking** — the safe direction differs from a stale provider approval |
| The timeline duplicates the Evidence Vault                      | 6.5 is a chronological, risk-classified cut; 7.1 is a per-module completeness cut. Different questions        |
| Risk events nobody produces yet look like an empty risk profile | Sources with no producer are named, the same way 7.1 names its gaps                                           |
| An agent lists or delists a client                              | Both require a Level 3 human, read from the recorded actor                                                    |

---

## Key decision — an override permits one action, it does not delist

Blueprint 6.4: "requires human override with documented justification."

The obvious build is a flag that turns the listing off. That conflates two different decisions:
_"this specific application may proceed despite the listing"_ and _"this client should no longer be
listed."_

An override that silently delisted would let one considered exception become a permanent state
nobody revisited — and the person granting it would not know that is what they had done.

So an override names the action it permits, is consumed when used, and leaves the listing in force.
Delisting is `removeListing`, with its own justification and its own Level 3 human.

## Key decision — a stale review keeps blocking

5.4 made an approval that outran its review cadence **stop being usable**. This module does the
opposite: a Do Not Fund listing whose review is overdue is flagged, and keeps blocking.

The rule is the same in both cases — _staleness moves toward the safe answer_ — and the safe answer
is opposite because the direction of harm is. A stale provider approval risks placing a client with
a provider nobody has checked recently. A stale Do Not Fund listing risks nothing by continuing to
block; unblocking on staleness would mean the most serious determination in the system expires
quietly.

## Key decision — the timeline is a different cut, not a second copy

7.1 assembles a per-module completeness view: _did we look everywhere_. 6.5 assembles a
chronological, risk-classified view: _what has happened to this client, worst first_.

Both read the same underlying facts. Neither stores them. 6.5 becomes a source in 7.1, because a
regulator-ready file benefits from the risk cut and cannot reconstruct it from the sections.

---

## Architecture

```
packages/risk/
  listings.ts   6.4 - listing, override, delisting, review cadence
  gate.ts       the placement check, wired into the Firewall's evaluate
  timeline.ts   6.5 - chronological risk-classified assembly
  events.ts     6.5 - risk observations with no other home
```

### Data model — schema `risk`

- `DoNotFundListing` — one per client: status, trigger, who, review cadence, removal
- `DoNotFundOverride` — scoped to one action, consumed on use
- `RiskObservation` — a recorded risk fact that no other module produces (fraud alert, NSF report)

The timeline derives from the Ledger plus these observations. Nothing is copied.

---

## Test strategy

- A listed client is refused at the placement gate, and the reason names Do Not Fund.
- Do Not Fund refuses ahead of the Firewall and ahead of compliance state.
- An override permits the named action once, and the listing still blocks the next one.
- An override for a different action does not apply.
- Compliance `fail` auto-lists, and the listing records that it was automatic.
- An overdue review flags and keeps blocking.
- Listing, overriding and delisting each require a Level 3 human and a justification.
- The timeline orders by time and classifies severity.
- The timeline names risk sources nobody produces yet.
- 7.1 carries the timeline as a source.

---

## Out of scope

6.1 Risk & Defense Alerts (three-tier) and 6.3 Client Conduct Monitoring — both V1.5. Timeline
visualisation, which is UI. Missed payments, NSF and credit-line decreases as **automatic** feeds:
the producers are Plaid and issuer integrations, both ungated, so the timeline names them as
unproduced rather than pretending the absence is a clean risk profile.
