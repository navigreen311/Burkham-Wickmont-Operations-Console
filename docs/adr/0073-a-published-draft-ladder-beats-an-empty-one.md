# ADR-0073 - A published draft ladder beats an empty one, and round numbers beat researched-looking ones

**Status:** Accepted · **Date:** 2026-08-12 · **Modules:** 1.4 Pricing, Billing & Offer Management,
10.1 Inter-Venture Commerce Hooks

## Context

1.4 has been built and empty since it shipped. That is not merely an unfinished feature, because of
what ADR-0018 decided: **the published offer ladder is the DEFINITION of an arm's-length price.**
An intercompany engagement is checked against what unrelated clients actually pay, on the reasoning
that a price a stranger paid is better evidence than any transfer-pricing model this firm could
defend.

With no ladder published there is no such price. `mayCharge` cannot show that any related-party
engagement is priced correctly, and MedLink, Greenstone, Argus and Collingswood are all related
parties. The empty ladder is therefore a live gap in a control, not a blank screen.

**Nobody has told me what this firm charges.** So the question is not what the prices are; it is
what to publish when you do not know them.

## Decision 1 - publish a draft, marked as one, rather than leave it empty

The alternative is to wait for real prices, which leaves the arm's-length control inoperable for
as long as that takes. A draft ladder makes the control operable and makes its inputs visibly
provisional. Every description begins `DRAFT PRICING.`, and `LADDER_FIGURES_TO_CONFIRM` enumerates
every invented number.

## Decision 2 - the numbers are round on purpose

$2,500, not $2,485. 300 basis points, not 287.

**A round number is visibly a placeholder and gets changed. A specific one looks like the output of
an analysis somebody did, and it survives review** because nobody wants to argue with research that
does not exist. This is the same failure the regulatory seed avoids by writing "counsel should
confirm" into a state module rather than inventing a requirement: an invented rule is worse than a
missing one because it looks reviewed.

The precision I did not invent is the point of the decision.

## Decision 3 - the shape is a claim; the figures are not

Three properties are defensible on principle and are the part worth keeping if every number changes:

- **Rung 1 carries no success fee.** A client paying for readiness work has not been placed with
  anybody, and charging a placement rate for advice is the shape principle 1 fails.
- **The retainer rises faster than the success fee across the ladder.** Principle 2 says structure
  rewards stewardship, not transactions: the higher rungs should be worth more through the
  recurring relationship than through a bigger cut of one placement. An owner may reasonably want
  the success fee FLAT or falling, and the list says so.
- **Every rung has a non-zero minimum**, because 1.4 owns engagement-minimum tracking and a minimum
  of zero is not a minimum.

The tests assert the ordering rather than the values, so the drafts can be corrected without
rewriting the suite.

## Decision 4 - the seed skips what already exists

`publishOffer` supersedes the current version and creates a new one on **every** call. A seed that
always published would walk the whole ladder to version 2 on its second run and leave an owner's
corrections superseded by these drafts. So `seedOfferLadder` reads `currentOffer` per rung and skips
any that exists, unless `republishExisting` is passed deliberately.

A refusal from any rung returns rather than being collected: a ladder published with a hole in it
would be invisible to a caller that only checked the status.

## Consequences

**The arm's-length check becomes operable against figures that are wrong.** That is the trade, and
it is the right way round only because the figures are labelled. If an intercompany engagement is
priced against this ladder before the owner corrects it, the deviation approval ADR-0018 requires
will be measured from an invented baseline.

**Units are integer cents and basis points throughout** (ADR-0011). `fromDollars` is used at the
boundary because it throws on a fraction of a cent rather than truncating. `@bwc/lenders` stores
whole dollars and nothing here reads a lender figure; a number crossing that boundary unconverted
would be wrong by a factor of a hundred, in the direction that flatters us.

**Annual prepay is not modelled.** Rung 5 is intended as prepay-only and 1.4 owns prepay
accounting; this seed states the intent in the description and implements none of it.

## Alternatives considered

**Leave the ladder empty until real prices exist.** Rejected - it leaves the arm's-length control
inoperable, and the control is needed now because related-party engagements exist now.

**Publish one rung as a placeholder.** Rejected. Blueprint 1.4 owns a five-offer ladder and the
credit chain across rungs is what makes upgrades computable; one rung tests nothing.

**Derive prices from the sibling platform.** Rejected - a price CapitalForge charges is not evidence
of what this firm charges, and importing it would give an invented figure a false provenance.
