# Plan — 10.1 Inter-Venture Commerce Hooks

**Blueprint:** 10.1 · **Branch:** `ai-feature/m10-inter-venture-commerce`
**Follows:** 9.1 / 9.2 KPI Dashboards (merged, `bd777bc`)

Category 10's V1 scope is one of two. 10.2 Cross-Portfolio Opportunity Engine is V1.5.

---

## Mini-PRD

### Problem

MedLink, Greenstone, Argus and Collingswood are Green Companies ventures under common ownership
with Burkham Wickmont. When one of them becomes a client, the engagement is a **related-party
transaction** — and nothing in the system currently knows that.

Two things go wrong if it stays that way. A sibling venture gets priced differently from a stranger
and nobody notices, which is transfer pricing. And a conflict of interest that everybody involved
is aware of goes unrecorded, which is the version regulators and auditors care about.

### Success metrics

- A venture client is tagged automatically, not by somebody remembering.
- An intercompany engagement cannot proceed on an unacknowledged conflict disclosure.
- Any deviation from the published price requires Gardner approval, in either direction.
- A Collingswood handoff requires that individual's own per-handoff consent.

### Risks

| Risk                                                      | Mitigation                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **A self-filed conflict disclosure treated as a control** | Generating is not disclosing; the engagement gates on acknowledgement by the venture and by Gardner |
| **A sibling priced off-ladder**                           | Arm's length is the published price, not a computed one; deviations need approval either way        |
| Gardner visibility leaking to non-venture clients         | The flag is derived from venture status, never set directly                                         |
| A blanket handoff consent to Collingswood                 | Per-handoff, per-artifact, checked live at the point of transfer                                    |
| Intercompany invoices looking settled                     | Gardner-level ledger routing is a `not_built` seam                                                  |

---

## Key decision — arm's length is the price we charge strangers, not a price we compute

Blueprint 10.1 asks for "arm's-length pricing logic per Gardner-approved intercompany services
agreement". The dangerous reading is a pricing model: compute what the market would bear for a
sibling venture.

We do not need to model it. **1.4 already publishes an offer ladder, and those prices are what
unrelated clients actually pay.** That is arm's length, by the only definition that survives an
audit — a price a stranger paid, not a price we justified.

So an intercompany engagement is priced from the published offer, and **any deviation requires
Gardner approval with a stated basis, in either direction**. A discount to a sibling moves profit
out of Burkham Wickmont; a premium moves profit in. Both are transfer pricing, and a system that
only questioned discounts would police one direction of the same thing.

## Key decision — generating a disclosure is not disclosing

Blueprint 10.1 asks for "conflict-of-interest disclosures auto-generated and filed". Read as one
step, that is the conflicted party writing a document, putting it in its own file, and proceeding.

That is not a control. It is a record of a control that did not happen.

So the two halves are separated. The **artifact** is generated automatically — it should be, since
a hand-written conflict disclosure varies with how the writer feels about the conflict. The
**disclosure** is complete only when acknowledged by somebody who is not us:

1. the venture's own representative, who is the party the conflict is against; and
2. Gardner, who governs both sides and is the only party positioned to permit it.

Until both exist, `mayProceed` refuses. This is the Do Not Fund pattern applied to a different
gate: a determination that blocks work, with a documented human route through it.

---

## Architecture

```
packages/interventure/
  ventures.ts    the Green Companies register and automatic detection
  conflicts.ts   disclosure generation, acknowledgement, and the gate
  pricing.ts     arm's-length check against the published ladder
  handoff.ts     Founder Personal Layer to Collingswood, per-handoff consent
  invoicing.ts   intercompany invoice records; Gardner ledger routing as a seam
```

### Data model — schema `interventure`

`VentureRelationship`, `ConflictDisclosure`, `PricingDeviation`, `CrossPortfolioHandoff`,
`IntercompanyInvoice`.

`cross_portfolio_handoff` already exists as a consent kind in 1.5, seeded with the spine and unused
until now.

---

## Test strategy

- A client whose legal name matches a venture is tagged, and a stranger is not.
- An engagement with no acknowledged disclosure is refused; one acknowledgement is not enough.
- Ladder pricing passes; a discount and a premium both require approval.
- An approved deviation records its basis and who approved it.
- Gardner visibility is true for a venture and false for a normal client, and cannot be set.
- A handoff without live consent is refused; revocation stops the next one.
- Intercompany invoice routing reports `not_built` naming the Gardner ledger.

## Out of scope

10.2 (V1.5). The Gardner-level ledger itself. The intercompany services agreement as a legal
document — this checks against the published price and records deviations; counsel writes the
agreement.
