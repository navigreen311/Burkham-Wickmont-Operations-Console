# ADR-0018 — Generating a disclosure is not disclosing, and arm's length is the price strangers pay

**Status:** Accepted · **Date:** 2026-08-10 · **Module:** 10.1 Inter-Venture Commerce Hooks

## Context

MedLink, Greenstone, Argus and Collingswood are Green Companies ventures under common ownership
with Burkham Wickmont. When one becomes a client, the engagement is a **related-party
transaction** — and until this module, nothing in the system knew that.

Blueprint 10.1 asks for two controls, and both have a plausible-looking implementation that isn't
a control at all.

## Decision 1 — the artifact is generated; the disclosure is acknowledged

Blueprint 10.1: _"conflict-of-interest disclosures auto-generated and filed."_

Read as one step, that describes the conflicted party writing a document, filing it with itself,
and proceeding. **That is not a control. It is a record of a control that did not happen.**

So the halves are separated:

- The **artifact** is generated automatically — and should be. A hand-written conflict disclosure
  varies with how the writer feels about the conflict, and the version written by somebody keen to
  proceed is the one that understates it.
- The **disclosure** is complete only when acknowledged by parties that are not us: the venture's
  own representative (the party the conflict is against) and Gardner (who governs both sides and is
  the only party positioned to permit it).

`mayProceed` refuses until both exist, and names which is missing. Same shape as 6.4's Do Not Fund
gate: a determination that blocks work, with a documented human route through it.

Two supporting choices:

- **The acknowledged text is hashed and checked.** Acknowledging means acknowledging a specific
  document; if the body changed after they read it, what was acknowledged is something else. 7.3's
  frozen-contract rule applied to a disclosure.
- **The venture's representative is a name, not an actor id.** They are on the other side of the
  transaction. Creating an actor record for them would put a party we don't control inside our
  identity system, where their acknowledgement would then look like an internal approval.

## Decision 2 — arm's length is the price we charge strangers

Blueprint 10.1: _"arm's-length pricing logic per Gardner-approved intercompany services
agreement."_

The dangerous reading is a pricing model — compute what the market would bear for a sibling.

**We don't need to model it.** 1.4 publishes an offer ladder, and those prices are what unrelated
clients actually pay. That is arm's length by the only definition that survives an audit: a price a
stranger paid, not a price we justified.

So an intercompany engagement is checked against the published offer, and **any deviation requires
Gardner approval with a stated basis — in either direction.**

The both-directions rule is the part worth arguing about. A discount to a sibling moves profit out
of Burkham Wickmont; a premium moves profit in. Both are transfer pricing. **A system that
questioned only discounts would police one direction of the same thing — and the direction it
ignored is the one that flatters this company's own numbers, which is exactly the direction nobody
would report.**

`mayCharge` permits an off-ladder price only when an approved deviation exists **for that exact
amount**. Approving one figure and charging another is the loophole that closes.

## Consequences

**An intercompany engagement is slower to start**, by two acknowledgements. That is the cost, and
it is the point.

**Withdrawal doesn't delete.** A disclosure withdrawn because the scope changed keeps its
acknowledged text — "what did they agree to in March" survives the engagement changing in April.

**Gardner visibility is derived, never set.** A settable flag would eventually be set on a normal
client, at which point the portfolio's common owner is reading the file of somebody with no
relationship to them, and the engagement letter says nothing about it.

**Detection refuses on ambiguity.** A name containing a token that appears in a venture name
without identifying one produces `possible`, which refuses until a person confirms. Both wrong
answers are expensive in opposite directions: a false tag blocks a stranger behind a conflict
process that cannot be completed — there is no sibling to acknowledge the disclosure — and a missed
one is an undisclosed related-party transaction.

**Intercompany invoices never reach `settled`.** The Gardner-level ledger is the portfolio's, not
ours. A settled invoice nobody routed would read as money that moved between two entities when none
did, in two sets of accounts, one of which is not ours.

## Alternatives considered

**Generate and file, per the blueprint's literal wording.** Rejected — see Decision 1.

**A standing conflict waiver covering all future work with a venture.** Rejected. The conflict
differs per engagement, and a waiver signed once is acknowledged by somebody who did not know what
they were agreeing to.

**Compute a market rate for intercompany services.** Rejected: a rate we computed is a rate we
justified, and the published ladder is better evidence than any model we could defend.

**Question discounts only.** Rejected — see Decision 2.
