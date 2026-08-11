# ADR-0053 — A payout is refused by the state that cannot answer, and by every state beside it

**Status:** Accepted · **Date:** 2026-08-11 · **Modules:** 8.2 Partner Agreement & Payout Center,
7.2 State-by-State Regulatory Engine

## Context

`payableToPartner` has returned `not_built` since 8.1 shipped, and the sentence it refused with is
the specification for this slice:

> A figure produced without them would look payable without anybody having checked whether it is
> lawful to pay.

Blueprint 8.2 lists four things it owns: referral fee terms, **the state-by-state restrictions on
referral fees**, payout approval, and refund clawback. The second is the one that decides the shape
of everything else.

## Decision 1 — 7.2 owns the restrictions; 8.2 asks

Read literally, the blueprint puts state referral-fee restrictions inside 8.2. That reading gives
this system **two sets of state rules** — 7.2's modules, and a copy beside the payout calculator.
They would drift, the drift would be silent, and it would surface as money that had already moved.

So `StateReferralFeeRule` lives in the `regulatory` schema, hangs off a **module version**, and
8.2 pulls it through `referralFeeRuleFor`. 8.2 holds no state rule of its own and has no code path
that could.

Hanging the rule off the version rather than the state is the load-bearing part. A rule is part of
what counsel reviewed. Republish Nevada materially and the new version carries no rule, so
`referralFeeRuleFor` starts refusing — which is correct, because a rule written against superseded
text is a rule nobody has checked against the current text.

### Four distinguishable answers

| Answer              | Meaning                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `refused`           | The state is not in a position to be relied on — not activated, or republished since counsel read it |
| `no_data`           | Activated, and nobody has recorded what it permits. **A gap in our research, not a permission**      |
| `ok` / `prohibited` | We asked, and the answer is no                                                                       |
| `ok` / otherwise    | We asked, and here are the terms                                                                     |

The second is the one that would be tempting to collapse into "no restriction found, proceed" —
which turns every state nobody has researched into a state that permits everything.

## Decision 2 — one unanswerable state stops the whole payout

The obvious implementation drops the unanswerable line and pays the rest. It produces a smaller
number that **still reads as a complete answer**, and what is missing does not show in it. That is
precisely the failure the V1 refusal was holding out against, reintroduced one line lower down.

So `computePayout` collects every jurisdiction it could not resolve and refuses the period, naming
them. A `prohibited` state is **not** one of these — it is an answer, so it excludes its referral,
cites the statute, and the rest of the period still pays.

### Staleness moves toward refusing to pay

ADR-0013 says staleness moves toward the safe answer, and ADR-0044 established that which
direction is safe differs per module. Here it is not close:

- A payout delayed by a day is recovered by paying it tomorrow.
- A referral fee paid into a state that prohibits it is **not recoverable by any act available to
  us**. It is an unlawful payment that has already happened, and the partner has spent it.

The asymmetry is total, so every ambiguity in this module resolves to `refuse`.

## Decision 3 — we pay on money received, not money invoiced

Gross is the sum of `payment` records, never `charge` records. A share of an invoice the client
never honoured is real money leaving against revenue that never arrived, and recovering it means
clawing back from a partner who has already spent it.

## Decision 4 — automatic in, human out, and there is no `paid`

The computation runs unattended and produces `pending_approval`. Approval is Level 3, because the
computation is unattended and the approval is the only point a person sees the figure before money
leaves.

**There is no status meaning `paid`**, and that is deliberate. Money movement is not this system's
act. A `paid` we could set without anybody moving money would be a figure two sets of books
disagreed about — the same reasoning ADR-0018 used to keep intercompany invoices from reaching
`settled`.

A clawback is its own row rather than a negative line on a past payout (ADR-0041's shape): netting
it into an earlier figure loses that it happened, when, and against which engagement. A period
whose clawbacks exceed its earnings nets to **zero, never negative** — the remainder stays
outstanding and the next period picks it up, because a payout that owes us money is not a payout.

## Consequences

**Most tenants cannot run a payout today, and that is the correct state.** A referral fee rule has
to be recorded per state, per module version, by somebody who has read the statute. Until then
`computePayout` refuses and names the state. The alternative was a number.

**The jurisdiction comes from the client's primary entity's `stateOfFormation`**, and a client
without one blocks the payout. This is `checkJurisdiction`'s rule applied to money: "we could not
tell which state this client is in" and "no state rule applies" are different statements.

**A state cap can bind below agreed terms**, and the line records `cappedByState` so a partner
asking why they were paid less than the contract says is answered by the record.

**`payableToPartner` changed signature** — it grew a tenant and a period. Both are load-bearing:
there is no such thing as what a partner is owed without a window, and a figure that silently meant
"since the beginning of time" would be paid twice. It kept its name so that readers who remember
the old one do not go on believing the capability is missing.

**The `MAXIMUM_SHARE_BASIS_POINTS` ceiling (50%) is in code, not in the 11.7 registry.** Above half
the fee, a referral arrangement starts looking like the partner selling our service, which is a
different regulatory character under principle 1 — not a number an operator should be able to cross
on a form. It is a candidate invariant for ADR-0019's list rather than a parameter.

## Alternatives considered

**Copy the state restrictions into 8.2, per the blueprint's literal wording.** Rejected — two sets
of state rules, drifting silently, discovered as money that had already moved.

**Pay the answerable lines and flag the rest.** Rejected — see Decision 2. It is the original
failure one level down.

**Treat "no rule recorded" as "no restriction".** Rejected. It makes every unresearched state a
state that permits everything, and the unresearched states are exactly the ones nobody has thought
about.

**Compute on charges rather than payments.** Rejected — see Decision 3.

**Let the computation approve itself below a threshold.** Rejected. A threshold is a number under
which nobody looks, and the amounts that would sit under it are the ones a mistake would repeat
monthly.
