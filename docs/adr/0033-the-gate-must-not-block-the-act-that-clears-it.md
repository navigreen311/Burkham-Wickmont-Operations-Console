# ADR-0033 — The gate must not block the act that clears it

**Status:** accepted
**Date:** 2026-08-11

## Context

The Console got buttons. Before writing any, I went looking for what enforced the writes it would be
driving, and found two things.

**The first is that nothing did.** `apps/api`'s own header said:

> Every route acting on a client still goes through the middleware chain, because the chain is where
> authority, tenancy, the Firewall, the compliance gate and event emission are enforced.

That sentence was false. `chain()` ran in **two places in the entire system** — `@bwc/placement` and
`@bwc/comms`. The compliance transition, the Firewall trigger and the consent grant called their
modules directly, so **no Authority Level was checked on any of them**. A Level 0 observer with a
Console session could move a client to `pass`.

I wrote that sentence forward into the rewrite last slice without checking it. That is the more
useful half of the finding: a comment describing a control is not a control, and it had been read
past for as long as it had existed.

**The second is that the obvious fix does not work.** Routing the writes through `chain()` unchanged
puts them behind step 4, which refuses when the client is Do Not Fund listed, when the Firewall is
triggered, or when the compliance state is anything but `pass` / `pass_with_findings`
(`@bwc/firewall`'s `evaluate`). Applied to a compliance transition, that is a **one-way door**:

| Client state                                | What becomes impossible                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `fail`                                      | Being moved back to `pass` when the findings are resolved |
| `needs_review`                              | Being resolved at all                                     |
| `pending_assessment` — **every new client** | Being assessed                                            |

A gate that blocks the act of clearing the gate is a trap, and it is the kind only discovered by the
person it traps.

## Decision

**Actions are classified, and the classification decides which steps apply.**

`GOVERNANCE_ACTIONS` in `@bwc/core` names the actions that **record a determination about a client**
rather than acting for or upon one. For those, middleware step 4 is **skipped** — and steps 1, 2, 3
and 6 are not. Authentication, tenant scope, the Authority Level and the Ledger event all still
apply, which is the whole of what was missing.

Four actions were added to `ACTION_MINIMUM_LEVEL` to make this expressible at all, since
`decideAuthority` refuses any action absent from the catalogue:

| Action                        | Level | Why that level                                                                                                                                                                                                               |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transition_compliance_state` | **3** | Compliance state is the gate every downstream module reads (Decision E). Moving it to `pass` is what unblocks placement                                                                                                      |
| `trigger_firewall`            | **1** | The Firewall **stops** things. A Firewall nobody raised is a placement that should have been frozen; one raised in error is visible immediately and takes a human to clear. Same asymmetry 6.4's fail-closed allow-list uses |
| `record_client_consent`       | **2** | Asserting something the client said, and what authorises acts downstream                                                                                                                                                     |
| `create_client_record`        | **2** | Opening a file starts a commercial relationship                                                                                                                                                                              |

**These four levels are a judgement and a person should confirm them.** The blueprint states levels
for agent actions taken on a client's behalf; it does not state one for recording a determination
about a client. The reasoning is written beside each entry so the argument is with the reasoning
rather than with the number — the same move 7.2 made when it seeded state rules as drafts saying
"counsel should confirm" instead of inventing a rule.

### A table, not an option on the call

The alternative was a flag on `ChainRequest` — `skipClientGate: true`. Rejected: **an option is a
thing a caller can pass, and the first caller who wants step 4 out of the way for a reason of its
own will pass it.** The classification is a property of the action, it lives in one place, and a
reviewer can argue with it. That is the same shape as `RISK_EVENT_CLASSIFICATION` (6.5) and
`DO_NOT_FUND_PERMITTED_ACTIONS` (6.4), both of which are judgements expressed as data for the same
reason.

Membership is not a licence. `trigger_firewall` is on the list because you must be able to raise a
Firewall on a client who is already listed — not because the Firewall does not apply to it.

### `skipped`, not `passed`

The trace entry says `skipped` and carries the reason. A step reporting `passed` here would be
claiming a check ran, and the trace is shown to operators on the page.

### A new event: `authority.action_authorised`

The chain writes this rather than the action's own event, because the module still writes what
happened afterwards and passing the module's event here would write it twice — once before the work
and once after.

It also fills a real gap. The Ledger has always recorded what the chain **refused**
(`authority.action_blocked`) and never what it **permitted**, so an audit could see the attempts
that failed and not the ones that succeeded. On a staff console the second is the more common
question.

## Consequences

**The page hides what an actor may not do, and that is a courtesy rather than a control.**
`/api/console/me` reports `mayWrite`; the chain refuses regardless of what was offered, and the
tests assert the refusal directly rather than through the page. Hiding is worth doing anyway:
offering an action that will certainly be refused teaches people that refusals are noise, which is
the opposite of what a refusal is for here.

**Authorisation now runs before body validation on every write.** A caller with no session who was
told `legalName is required` had learned that the route exists and what it wants.

**A test that asserted only `refused` was passing for the wrong reason.** Widening
`GOVERNANCE_ACTIONS` to include a client-facing action survived the first version of the
"still refuses a client-facing action" test, because the placement module refuses a failed client
on its own account too. The assertion now names the **step** that blocked it.

**`autoListForComplianceFail` is still not wired to anything.** See below — it is a finding this
slice surfaced and deliberately did not fix.

## The finding this slice did not fix

`@bwc/risk`'s `autoListForComplianceFail` implements Decision E's rule that a failed compliance state
routes the client to Do Not Fund Governance. It is exported, it is tested, and **nothing in
production code calls it.** Moving a client to `fail` — through the API before this slice, through
the page now — does not list them.

It is not fixed here because the fix is a layering decision worth its own slice: `@bwc/clients`
calling `@bwc/risk` inverts the dependency (1.1 would know about 6.4), and the alternatives are a
Ledger-driven listener or moving the composition into `@bwc/middleware`. Doing it badly in a UI
slice is how a control ends up in the wrong place permanently.

What this slice does instead is **stop the page from implying otherwise**: the consequence text
under the compliance dropdown says what `fail` does and says that the automatic listing is not
wired today. A button that quietly did less than the documentation promised would be worse than the
gap itself.

## Alternatives considered

**Leave the writes as they were and only add buttons.** What the slice started as, and the reason it
is not what it is. The gap predates the page; the page collects on it.

**Enforce the level in each module instead.** `transitionComplianceState` could take an actor and
refuse below Level 3 itself. Rejected: `packages/core/src/authority.ts` says it in its own header —
_"Never reimplemented per module: a local check is a second implementation that will drift from this
one, and the drift will be silent."_ Three modules would be three drifts.

**Add the governance actions to `DO_NOT_FUND_PERMITTED_ACTIONS`.** Solves one third of the problem.
That list governs the Do Not Fund half of step 4 only; the compliance gate and the Firewall check
would still shut the door.

**A `pending_assessment` exemption instead of an action class.** Would let a new client be assessed
and would still trap every client in `fail`. The trap is not about one state.
