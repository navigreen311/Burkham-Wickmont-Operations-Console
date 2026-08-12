# 7.3 Contract & Disclosure Builder

**Package:** `@bwc/contracts` · **Schema:** `contracts`
**ADR:** [ADR-0010](adr/0010-an-issued-contract-is-frozen.md)

---

## What this does

7.2 holds what each state requires. 7.3 turns that into the documents a client actually signs — a
service agreement, a fee exhibit, authorization forms — with clauses scoped to the jurisdiction and
disclosures inserted from the Regulatory Engine rather than retyped.

---

## Generation is gated three ways

```
regulatory gate ──▶ template review ──▶ clause resolution ──▶ scanner ──▶ content model + hash
may we act in    counsel saw this     every named clause    no banned    the artifact, and
this state?      exact version        exists here           language     the evidence of it
```

The gate runs **first**, for the same reason governance runs before eligibility in 5.3: when the
answer is "we may not act in this state", the client's tier and product have nothing to do with it,
and computing a document to then discard invites somebody to reach for the intermediate result.

**A template naming a clause that does not resolve is a refusal.** Generating without it produces
an agreement silently missing a term somebody deliberately wrote, and nothing in the output would
show the gap.

**Banned language is a refusal, not a finding.** A banned phrase in a marketing email is a
compliance finding; the same phrase in a signed agreement is a term of the contract.

`requires_disclosure` is handled differently from a marketing email, and this is the one place the
scanner's verdict is not taken at face value: a contract may use language obliging a disclosure
**provided the disclosure is in the document**. Since 7.2's disclosures are already spliced in, what
gets checked is whether the obligation is actually met — and generation refuses when it is not.

---

## An issued contract is frozen

Full reasoning in [ADR-0010](adr/0010-an-issued-contract-is-frozen.md).

Blueprint 7.3 lists "auto-updates when Regulatory Engine flags rule changes". Read literally, that
is a feature which reaches into signed agreements and changes their terms — easy to build, and the
most destructive thing in this system. **A signed agreement is the only evidence of what was
agreed.**

So "auto-update" is implemented as two things that are not rewriting: the content of documents
generated **next**, and a **derived staleness report** over what was already issued.

The report is deliberately **stricter** than 7.2's activation gate. A state stays online through an
editorial module change because the obligations did not move; a document generated against any
superseded version is flagged, editorial included — but the report says which kind it was, so an
operator can triage. A staleness report that cannot tell "the law changed" from "we fixed a typo"
gets ignored wholesale.

---

## The fee exhibit, and the Seek Capital lesson

Blueprint 1.4:

> "success fees on cards computed from CapitalForge's `approvedCreditLimit` field, never
> `creditLimit`"

A success fee charged on what a client _asked for_ rather than what an issuer _granted_ is the
failure that ended another company. It is also easy to reproduce, because the two figures sit next
to each other on every application record and differ by a character.

**`FeeExhibitInput` has no field for a requested limit.** There is nowhere to put one, so there is
nothing for the arithmetic to reach for — and the computation goes through `successFeeBasis`, which
takes a single numeric argument so there is no second figure to pass by mistake. The fee's `basis`
line says _"Not the amount applied for"_ in the document the client signs.

**With no approval, the fee is contingent, not estimated.** An estimate in a fee exhibit reads as a
price, and estimating from the requested amount is exactly the failure being designed against.

The total states what is known and names what is not: a total quietly including a fee nobody has
incurred is a misstatement, and one omitting a contingent fee without saying so is another.

---

## Disclosure wording has one home

`not_a_lender` and `no_guarantee` appear in blueprint 7.3's list of documents to generate. They
already exist as clauses in 7.2's federal baseline, and the builder inserts them **by key**.

A second copy maintained here would not become wrong so much as become **ambiguous** — two texts
saying nearly the same thing, and nobody able to say which governs.

---

## Clause scoping

Three dimensions — jurisdiction, offer tier, channel — and one rule stated once:

> **An empty scope means "applies to all", not "applies to none."**

Read the other way, an omitted field would silently drop a required term from every document, which
is how a clause disappears from a contract with nobody having edited anything.

A **state-scoped clause beats a global one of the same key**. Returning both would put two versions
of one term in a single document, which is worse than the wrong version: nobody can tell which
governs.

Clauses need a citation — a statute, a policy decision, a partner agreement — for the same reason a
7.2 disclosure and a 7.4 banned phrase do. A term nobody can trace to a rule cannot be reviewed,
taught, or revisited.

---

## Template review mirrors 7.2 rather than sharing its code

The specification applies the same sentence to both: _"counsel review required for material
changes."_ So templates get the same discipline — required `changeKind`, a review naming a
document, Level 3 human only, material republish blocks generation, editorial carries forward.

**Deliberately mirrored, not shared.** The subject differs (a document versus a jurisdiction), the
blocking effect differs (one document type versus all client action in a state), and sharing would
couple state activation to template publishing. Two similar things are not yet a pattern.

**The trigger to extract is a third reviewable artifact type.** This note exists so whoever meets
it knows the decision was made rather than missed.

---

## Small things that matter

**Unresolved placeholders stay visible.** A contract reading _"between Burkham Wickmont and
{{clientLegalName}}"_ is obviously broken and gets caught. One reading _"between Burkham Wickmont
and "_ looks like a formatting slip and gets signed. `unresolvedPlaceholders` lets a caller refuse
to send.

**The Ledger carries the content hash**, so "what did they sign?" is answerable from the
tamper-evident chain without trusting the `contracts` schema.

---

## Known gaps

- **Rendering to PDF.** 3.1 owns rendering; the content model is the artifact either way.
- **E-signature capture.** 1.5 owns authorizations; a signature is its own module — which is also
  why reissue stays a human decision (see ADR-0010).
- **1.4's offer ladder.** Tier and fee figures arrive with the request, as the underwriting profile
  did before 1.2 existed.
- **No template content ships.** Unlike 7.2, this slice seeds no contract language: the state
  modules could be written from published statutes, but a service agreement is drafting, and
  drafting a contract is not something to scaffold from a specification.
