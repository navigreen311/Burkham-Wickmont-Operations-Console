# Writes from the Console page

App: `apps/api` · Packages: `@bwc/core`, `@bwc/middleware` · **No schema** · ADR:
[0033](adr/0033-the-gate-must-not-block-the-act-that-clears-it.md)

The Console could read a client's file. Now it can record a determination about one — and the
enforcement that should have been behind those routes all along exists.

---

## What I found before writing a button

`apps/api`'s header said every route acting on a client went through the middleware chain. **It did
not.** `chain()` ran in two places in the whole system — `@bwc/placement` and `@bwc/comms`. The
compliance transition, the Firewall trigger and the consent grant called their modules directly, so
**no Authority Level was checked on any of them**.

A Level 0 observer with a Console session could move a client to `pass`.

I wrote that sentence forward into the file myself last slice without checking it, which is the more
useful half of the finding: **a comment describing a control is not a control**, and this one had
been read past for as long as it existed.

---

## Why the obvious fix is a trap

Route the writes through `chain()` unchanged and they sit behind step 4, which refuses a client who
is Do Not Fund listed, behind a triggered Firewall, or in any compliance state other than
`pass` / `pass_with_findings`.

| Client state                                | What becomes impossible                               |
| ------------------------------------------- | ----------------------------------------------------- |
| `fail`                                      | Being moved back to `pass` when findings are resolved |
| `needs_review`                              | Being resolved at all                                 |
| `pending_assessment` — **every new client** | Being assessed                                        |

**A gate that blocks the act of clearing the gate is a trap**, and it is the kind only discovered by
the person it traps.

---

## The classification

`GOVERNANCE_ACTIONS` names the actions that **record a determination about a client** rather than
acting for or upon one. Step 4 is skipped for those. Steps 1, 2, 3 and 6 are not.

```
authentication   → runs
tenant_scope     → runs
authority_level  → runs      ← the whole of what was missing
firewall         → skipped   ← with the reason in the trace
event_emission   → runs
```

| Action                        | Level | Reasoning                                                                                                                                            |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transition_compliance_state` | **3** | The gate every downstream module reads (Decision E)                                                                                                  |
| `trigger_firewall`            | **1** | It **stops** things. A Firewall nobody raised is a placement that should have been frozen; one raised in error is visible and takes a human to clear |
| `record_client_consent`       | **2** | Asserting something the client said                                                                                                                  |
| `create_client_record`        | **2** | Opening a file starts a relationship                                                                                                                 |

> **These four levels are a judgement and a person should confirm them.** The blueprint states levels
> for agent actions on a client's behalf, not for recording a determination about one. The reasoning
> sits beside each entry so the argument is with the reasoning rather than the number.

**A table rather than a flag on the call.** An option is a thing a caller can pass, and the first
caller who wants step 4 out of the way for its own reasons will pass it. Same shape as
`RISK_EVENT_CLASSIFICATION` and `DO_NOT_FUND_PERMITTED_ACTIONS`: a judgement expressed as data.

The trace says **`skipped`, not `passed`** — a step reporting `passed` would be claiming a check ran,
and operators read this trace on the page.

---

## What the page does with it

- **The trace is shown after every write, successes included.** A page that only explained failures
  would leave an operator unable to see which checks their action passed.
- **The consequence is on the page before the click.** A dropdown of five lowercase identifiers does
  not say that `needs_review` freezes placement; somebody would reasonably read it as a note to a
  colleague. The submit button reads `Record: fail` rather than `Record`.
- **The dropdown opens on the state the client is already in**, so the commonest mistake — reading
  the first option as the current value — is not available.
- **A finding needs both a code and a summary, or neither.** One without the other is a row nobody
  can act on or resolve.
- **Actions above the actor's level are not offered** — and that is a courtesy, never the control.
  `mayWrite` comes from `/api/console/me`, and the browser test proves the point by taking the
  Level 0 session, posting the write directly, and being refused.

---

## The finding this slice did not fix

**`autoListForComplianceFail` is not called by anything.** Decision E says a failed compliance state
routes the client to Do Not Fund Governance; the function implementing it is exported, tested, and
has no production caller. Moving a client to `fail` does not list them.

Not fixed here because the fix is a layering decision worth its own slice — `@bwc/clients` calling
`@bwc/risk` inverts the dependency, and the alternatives are a Ledger-driven listener or moving the
composition into `@bwc/middleware`. Doing that badly inside a UI slice is how a control ends up in
the wrong place permanently.

**What this slice does instead is stop the page implying otherwise.** The consequence text under the
compliance dropdown says what `fail` does and says the automatic listing is not wired today. A button
quietly doing less than the documentation promises is worse than the gap.

---

## Tests

|                                               |                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tests/integration/console-transport.test.ts` | 50 (+9) — every write refused below its level, the one-way-door case, the Ledger pair |
| `tests/e2e/console.spec.ts`                   | 14 (+4) — a write through the page, and an operator who may not                       |

Three mutations:

| Mutation                                               | Result                                             |
| ------------------------------------------------------ | -------------------------------------------------- |
| Step 4 applies to governance actions                   | `lets a failed client be moved back to pass` fails |
| `GOVERNANCE_ACTIONS` widened to a client-facing action | `still refuses a client-facing action` fails       |
| The chain's verdict is ignored                         | all five level tests fail                          |

**The second mutation survived the first version of that test**, which asserted only that the
placement was `refused` — and it would have been refused anyway, because the placement module checks
consent on its own account. The assertion now names the **step** that blocked it. A test that agrees
with the code for the wrong reason is worse than no test, because it is counted.

**One client per spec that changes one**, for the third time in this repository (after
`E2E_MUTABLE_ACCOUNTS` and one Console account per signing-in spec). A compliance transition and a
triggered Firewall are permanent, and a shared file makes the reading spec fail as though it were
flaky.
