# 10.1 Inter-Venture Commerce Hooks

Package: `@bwc/interventure` · Schema: `interventure` · ADR: [0018](adr/0018-generating-a-disclosure-is-not-disclosing.md)

Category 10's V1 scope. 10.2 Cross-Portfolio Opportunity Engine is V1.5.

---

## What this module is for

MedLink, Greenstone, Argus and Collingswood are Green Companies ventures under common ownership
with Burkham Wickmont. When one of them becomes a client, the engagement is a **related-party
transaction**, and until now nothing in the system knew that.

Two things go wrong if it stays that way, and neither is anybody's deliberate choice. A sibling gets
priced differently from a stranger and nobody notices. A conflict everybody involved is aware of
goes unrecorded — which is the version an auditor cares about.

---

## Automatic tagging

`tagIfVenture` runs off the client's legal name and is idempotent, so it can be called wherever a
client is created. Tagging by hand would put the control behind the knowledge it exists to supply.

Three verdicts, and the middle one matters:

| Verdict     | Result                                                 |
| ----------- | ------------------------------------------------------ |
| `venture`   | Tagged; `gardnerVisible` derived as true               |
| `unrelated` | `no_data` — being a normal client is not an error path |
| `possible`  | **Refused** until a person confirms                    |

A name containing a token that appears in a venture name without identifying one — "Green Valley
Landscaping" against Greenstone — gets `possible`. Both wrong answers are expensive in opposite
directions: a false tag blocks a stranger behind a conflict process nobody can complete, because
there is no sibling to acknowledge the disclosure; a missed one is an undisclosed related-party
transaction. A question costs less than either.

**Gardner visibility is derived, never set.** A settable flag would eventually be set on a normal
client, at which point the portfolio's common owner is reading the file of somebody with no
relationship to them.

Each venture carries its **own** conflict basis, not a generic one — Argus performs the security
reviews that gate our vendor integrations under Decisions A and B, and Collingswood receives our
handoffs. Those are not the same problem as MedLink simply being a sibling.

---

## Generating a disclosure is not disclosing — ADR-0018

Blueprint 10.1 says "conflict-of-interest disclosures auto-generated and filed". Read as one step,
that's the conflicted party writing a document, filing it with itself, and proceeding.

So the halves are separated. The **artifact** is generated automatically — a hand-written conflict
disclosure varies with how the writer feels about the conflict. The **disclosure** completes only on
acknowledgement by parties that are not us:

1. the venture's own representative — the party the conflict is against;
2. Gardner — who governs both sides and is the only party positioned to permit it.

`mayProceed` refuses until both exist, naming which is missing. One acknowledgement is not enough,
and that is the assertion the test file is built around.

The disclosure text is **hashed and the hash is checked at acknowledgement** — acknowledging means
acknowledging a specific document. The venture's representative is recorded as a **name, not an
actor id**: they are on the other side of the transaction, and an actor record for them would make
their acknowledgement look like an internal approval.

The generated text states the conflict, its specific basis, what we are not, and — the part that
makes it a disclosure rather than a notification — that the reader **may decline**, or ask that the
work be done by an unrelated provider.

---

## Arm's length is the price we charge strangers

The dangerous reading of "arm's-length pricing logic" is a pricing model. We don't need one: **1.4's
published ladder is what unrelated clients actually pay**, which is arm's length by the only
definition that survives an audit.

**Any deviation needs Gardner approval, in either direction.** A discount moves profit out of
Burkham Wickmont; a premium moves it in. Both are transfer pricing, and a system that questioned
only discounts would police one direction of the same thing — ignoring the direction that flatters
our own numbers, which is the one nobody would report.

`mayCharge` permits an off-ladder price only when an approved deviation exists **for that exact
amount**; approving one figure and charging another is the loophole that closes. A deviation
recorded at the published price is refused — it would fill the exception register with
non-exceptions.

Deviation is measured in **basis points, rounded away from zero**, so a price a hair off the
published one still reports as a deviation rather than rounding into compliance.

---

## Collingswood handoff

CLAUDE.md, on the locked decision: _"Collingswood requires per-handoff consent. No back doors."_

**The data subject changes here.** Everything else in this system is about a business. Personal-side
complexity means the founder's own finances — their personal credit, their household. A client who
authorised us to work on their company's capital position has not authorised us to describe their
personal circumstances to another company, however common the ownership.

- `observation` is required — what we noticed. Without it, a handoff is a referral looking for a
  justification, and referring every client to a sibling is what a conflict review asks about.
- `scope` is named **before** the client is asked. Consent to "a referral to Collingswood" is not
  informed; consent to a named set of personal information is. The consent's scope is compared
  against the handoff's, because a mismatch is invisible unless somebody compares them.
- **Consent is re-checked live at transfer**, not trusted from the state field. People change their
  minds about personal financial information, and the gap between consenting and transferring is
  exactly where they do it.

The consent kind `cross_portfolio_handoff` has existed in 1.5 since the walking skeleton and is used
here for the first time.

---

## Intercompany invoicing

The invoice **record** is real — what was billed, to which venture, for what period, on which
engagement. Raising one is gated on the conflict disclosure being complete, because the invoice is
the point at which money actually moves.

The **routing** is a seam. `routeToGardnerLedger` returns `not_built` and moves the invoice to
`routed_pending` so the queue is visible; it never reaches `settled`. A settled invoice nobody
routed would read as money that moved between two entities when none did — in two sets of accounts,
one of which is not ours.

---

## Tested

41 tests: `tests/integration/inter-venture-commerce.test.ts` (27) and
`tests/invariants/venture-detection.test.ts` (14). Suite total **819**.

Mutation-verified:

| Mutation                                             | Failures |
| ---------------------------------------------------- | -------- |
| One acknowledgement completes the disclosure         | 2        |
| Only discounts need approval                         | 1        |
| Trust the state field instead of re-checking consent | 1        |
