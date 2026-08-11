# ADR-0055 - The tiers are a judgement, and an alert does not age out

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 6.1 Risk & Defense Alerts

## Context

Blueprint 6.1 asks for "Yellow / Orange / Red alerts **per specification**; each level defines who
is notified, script used, options offered, human review requirement, whether new funding is
frozen".

**There is no such specification.** `specifications-v2.md` names the three colours exactly once, in
a list of Ledger event types. Nothing anywhere defines what a tier means or what follows from it.
That is the finding this slice starts from, and it is worth someone's attention independently of
the code.

## Decision 1 - the tiers are data, with the argument written beside them

`TIER_POLICY` is a judgement expressed as a table, in the shape 6.4's
`DO_NOT_FUND_PERMITTED_ACTIONS`, 6.5's `RISK_EVENT_CLASSIFICATION` and 6.3's `KIND_POLICY` already
use. Each entry carries a `rationale`, so the argument is with the reasoning rather than with the
colour. **A person should confirm these five judgements** - the move 7.2 made when it seeded state
rules as drafts saying counsel should confirm.

The line that matters most: **yellow does not freeze new funding and orange does.** Freezing at the
mildest tier makes the cheapest signal the most expensive one to raise, and everybody stops raising
it.

Red routes to Compliance & Evidence rather than Risk & Defense, because at that tier the question
is whether the Firewall should fire and only Compliance & Evidence can clear one. Resolution takes
Level 3 for the same reason.

## Decision 2 - no script is invented

A script is client-facing copy. Writing what we say to a client whose cash position is
deteriorating would be fabricating the most consequential sentences in the module, and 4.1 owns
client communication with templates that pass the Compliance Scanner. `scriptTemplateKey` names the
template each tier would use and `NO_SCRIPT_YET` records that none exists, so the gap points
somewhere instead of being filled.

## Decision 3 - staleness hardens; an alert leaves only when a human resolves it

ADR-0013 says staleness moves toward the safe answer, and ADR-0044 established that the direction
differs per module. Here: an alert open for ninety days is not less true than on day one, because
nothing about elapsed time investigates a cash position. An old unreviewed red alert is _worse_
news than a new one - it says the review nobody did is now ninety days overdue.

So there is no expiry column, no decay, no auto-resolution, and acknowledging is explicitly not
resolving. The comfortable choice would have let a serious signal leave a screen without anybody
deciding it should.

## Consequences

**The primary source does not exist.** Blueprint 6.1 says alerts come "primarily from Plaid feeds":
utilization changes, NSF events, cash balance deterioration. Plaid is gated pending Argus review, so
`alertStanding` reports `UNAVAILABLE_ALERT_SOURCES` on **every** read, including a clean one. An
empty alert list on a client whose bank feed nobody reads must not render as a client with nothing
wrong.

**6.1 currently sees only conduct breaches and hand-recorded observations**, a fraction of what it
is supposed to watch. `deriveAlerts` maps from the severity somebody already assigned rather than
making a fresh judgement, so there is no second severity model to drift from 6.3's.

**Freezing here is not the Firewall and not a Do Not Fund listing.** Both outrank this and are
separate determinations; this is narrower and stops new placement while a serious unreviewed signal
stands.

## Alternatives considered

**Invent the tier definitions and not say so.** Rejected - that is what "per specification" would
have licensed, and the reader would believe the colours were specified somewhere.

**Expire alerts after a review cadence.** Rejected - see Decision 3.

**Score risk numerically and derive the tier.** Rejected. Decision E's reasoning: a scale invites a
threshold, and there is no risk score anywhere in this package.
