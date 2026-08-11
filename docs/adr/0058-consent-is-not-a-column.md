# ADR-0058 - Consent is not a column, and Gardner's approval is not the client's

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 10.2 Cross-Portfolio Opportunity Engine

## Context

10.2 suggests moving a client between Green Companies ventures. It is the module most able to
produce a confident wrong answer, because the wrong answer looks like helpfulness.

ADR-0018 and principle 5 put the constraint plainly: on a cross-portfolio handoff **the data subject
changes** - the client is consenting to a different party holding their information - consent is per
handoff, and it is re-checked live at transfer.

**An opportunity that assumes consent is a referral looking for a justification.**

## Decision 1 - the model has no consent column

A stored `consented: true` is a claim about a permission that may have been revoked since. There is
no such field on `CrossPortfolioOpportunity`, so no code path can write one and nothing downstream
can read a stale answer.

## Decision 2 - detection is not permission, and neither is Gardner approval

`detected -> gardner_approved -> routed`, and only `route` performs an act.

Gardner governs both sides and is the only party positioned to permit a handoff - but Gardner's
approval is about whether the **transaction** is proper. It is not the client's consent and cannot
substitute for it. Both are required, from different parties, and a test asserts that Gardner
approval alone still refuses.

## Decision 3 - consent is read inside `route`, at that moment, and never passed in

`mayRoute` exists so a screen can explain why something is not actionable, and it returns
`advisoryOnly: true` **in its own payload**. `route` does not accept its result as an argument and
re-reads consent itself. A consent granted last month and revoked yesterday passes any cached check
and fails this one, which is the entire point - and the test proves it by revoking between two
routings.

The refusal is a Ledger event (`interventure.opportunity.routing_refused`), for ADR-0041's reason: a
handoff that was stopped is a thing that happened.

## Decision 4 - the scope of a handoff consent is the venture

Per-handoff means per counterparty. A client who agreed to be introduced to Collingswood has not
agreed to be introduced to MedLink, and a single `cross_portfolio_handoff` scope covering both would
turn one permission into a standing one. `consentScopeFor(venture)` is the scope.

## Decision 5 - there is no opportunity score

Blueprint 10.2 asks for "opportunity scoring". A score ranks clients by how much capital they might
be moved toward, which is the shape principle 2 rejects, and it would be computed on data the client
has not agreed to have used this way. Opportunities carry a `basis` a person can argue with, and
`detectOpportunity` refuses one shorter than a sentence - an opportunity nobody can argue with is a
recommendation nobody can refuse.

## Consequences

**No Ledger event from this module carries a client id.** These travel to a portfolio-level reader
and principle 5 gives Gardner PII-stripped aggregates. `detected` carries
`concernsANamedClient: true` instead - the fact that a client is involved, without saying which.

**`routed` records `consentVerifiedAt`**, because the control is not that consent existed but that
it was read at that moment.

**A portfolio-level opportunity naming no client engages no handoff consent**, since there is no data
subject to consent. That is the only kind that can be discussed freely, and it is the only case
`mayRoute` permits without a consent read.

**An already-routed opportunity cannot be dismissed** - principle 3: corrections are compensating
events, never mutations.

**Nothing detects opportunities automatically yet.** Blueprint 10.2's dependency is "Gardner data
feeds", and no such feed exists in this system. `detectOpportunity` is the entry point a feed would
call; until there is one, opportunities are recorded by hand. That is named rather than papered
over with a detector that invents them from client data.

## Alternatives considered

**Cache the consent check from `mayRoute`.** Rejected - precisely the stale read the live re-check
exists to prevent.

**Treat the engagement's own consent as covering handoffs.** Rejected. The data subject changes;
that is the whole distinction.

**Let Gardner approval stand in for consent when the client is a venture rather than a person.**
Rejected - it is a special case that would be applied by whoever finds the consent step
inconvenient.
