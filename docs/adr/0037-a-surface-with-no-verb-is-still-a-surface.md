# ADR-0037 — A surface with no verb is still a surface

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 2.4 Human Approval Console, 7.3 Contract & Disclosure Builder, 3.2 Secure Document Vault,
1.4 Pricing, Billing & Offer Management, 11.11 Founder / Executive Workbench

## Context

Forty-six modules are built with tests. Around ten are reachable from a browser. This slice was
asked to close part of that gap for five of them, with writes "only where the module already exposes
one, and every write through `chain()` with a declared action".

All five expose writes. **None of those writes can go through `chain()` today**, and the reason is
one line in `@bwc/identity`:

```ts
const required = (ACTION_MINIMUM_LEVEL as Record<string, AuthorityLevel>)[action];
if (required === undefined) {
  return refused(`Action '${action}' is not in the permitted-action catalogue …`);
}
```

`decideAuthority` refuses an action it has never heard of — correctly, and by design: principle 4
says an undeclared action is refused, never assumed permitted. Middleware step 3 calls it on every
request. So a write whose action is not in the catalogue cannot be authorised at all; it can only be
refused.

The catalogue has fifteen entries. Not one of them names resolving an approval, generating a
contract, placing a legal hold, or deciding a refund.

## Decision

**The five surfaces ship as reads, and every write they would need is reported rather than
invented.**

`packages/core/src/authority.ts` is owned by another slice. Adding five entries to it from here
would be the shape ADR-0033 already argued against, arriving from the other side: that ADR put the
governance actions in one table so a reviewer could argue with the levels, and the argument is with
the reasoning rather than with the number. Five more levels chosen by whoever happened to be
building a page is exactly the authorship that table exists to prevent.

### What is needed, and what each is worth

Written out so the argument is with the reasoning. **Every level below is a proposal, not a
decision** — the same posture ADR-0033 took, and 7.2 before it.

| Action                          | Module | Proposed | Why                                                                                                                                                                                                                                                             |
| ------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve_human_checkpoint`      | 2.4    | **3**    | It is the act the Human Approval Console exists for, and 2.1 routes here precisely because an agent may not decide. A checkpoint resolved below Level 3 would make the escalation ceremonial                                                                     |
| `generate_client_contract`      | 7.3    | **2**    | ADR-0018 says generating a disclosure is not disclosing, so this is not Level 3. It is not Level 1 either: the document is the evidence of what was agreed, an issued one is frozen (ADR-0010), and there is no unwind                                            |
| `set_legal_hold`                | 3.2    | **3**    | The module already refuses a non-human actor on its own account. A hold blocks export during litigation; releasing one during litigation is the failure it exists to prevent                                                                                     |
| `decide_refund`                 | 1.4    | **3**    | Asymmetric, and 1.4 says so: paying needs nobody's approval because the record already says the money is owed, while **declining** needs a Level 3 human and a recorded reason. One action at 3 keeps the asymmetry in the module rather than splitting it in two |
| `publish_offer_definition`      | 1.4    | **3**    | Pricing. 11.7 stages high-risk configuration for a reason, and what the firm charges is the definition of one                                                                                                                                                   |

`resolve_human_checkpoint` is the one worth arguing about hardest. It is **not** a governance action
in ADR-0033's sense: resolving a checkpoint acts *for* a client — it releases work that was frozen —
so middleware step 4 should apply to it, unlike a compliance transition. Adding it to
`GOVERNANCE_ACTIONS` would reintroduce exactly the one-way door ADR-0033 closed, pointed the other
way: a client frozen at `needs_review` would have their review blocked by the freeze the review
exists to lift. **That needs its own thought, and it is why this is a report rather than a patch.**

### The page says so, rather than being quiet about it

`/api/console/approvals/:taskId` carries a `resolution` object naming `available: false`, the action
it would need, and the reason. The page prints it.

A surface that simply had no button would read as one somebody had not finished. This is the
distinction principle 9 draws between `not_built` and `no_data`, applied to a control rather than to
an endpoint — and a transport test asserts the `false`, so the day the action is added the assertion
fails and the sentence gets revisited with it.

## Consequences

**Five surfaces are useful without being complete, and 25 packages became 20.** Reading a queue,
reading what a client signed, reading who tried to open a document, reading what a client owes, and
reading what only a founder can decide are each worth having on their own. The Vault surface would
be read-only regardless (ADR-0038).

**One route's shape is a promise about a write that does not exist.** `resolution.requiredAction`
names `resolve_human_checkpoint` before anything of that name exists. That is deliberate — a name in
one place is what makes the follow-up a rename rather than a design — and it is a string a reviewer
should check against the catalogue when the action lands.

**Nothing here changed the middleware chain, and nothing needed to.** Every route added is a read,
so no route added calls `chain()`. That is worth stating because the previous slice's finding was
the opposite: writes that skipped the chain entirely.

## Alternatives considered

**Add the five actions to the catalogue and wire the writes.** What the slice would have been. It
edits a file another agent owns, and it picks five Authority Levels — the most consequential numbers
in the system — as a side effect of building a page. ADR-0033 wrote its four levels out with a
paragraph each and still asked for a person to confirm them; doing five more silently would be worse
on both counts.

**Reuse an existing action rather than adding one.** `generate_internal_report` is Level 0 and would
technically let a contract be generated. It is the worst option available: a client-facing binding
document authorised under the action for an internal memo, and the catalogue would then be lying
about what Level 0 permits. A misclassification is worse than an absence, because the absence
refuses and the misclassification proceeds.

**Ship nothing until the actions exist.** Blocks five read surfaces on one file this slice may not
touch, and leaves the reads — which are most of the value here, and all of the value for 3.2 and
11.11 — unbuilt for no safety gain.

**Put the writes behind a flag, off by default.** A code path that cannot be authorised is not a
feature behind a flag; it is a route that returns the same refusal with more machinery in front of
it.
