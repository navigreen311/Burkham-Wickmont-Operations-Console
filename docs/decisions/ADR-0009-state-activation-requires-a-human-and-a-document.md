# ADR-0009 — State activation requires a Level 3 human and a document, and only material changes revoke it

**Status:** Accepted · **Date:** 2026-08-10
**Modules:** 7.2 State-by-State Regulatory Engine, 5.5 middleware chain

## Context

Specification §11.2: _"No state comes online without documented counsel review of the state's
Regulatory Engine module."_ Specification §5.5 step 5 and design principle 6: _"No client-facing
action fires without state compliance checks having passed."_

Two sentences, and between them a set of choices that decide whether the gate is real or
decorative:

- who may activate a state
- what counts as evidence that counsel reviewed it
- what happens to an activation when the rules change afterwards
- what happens when the system cannot tell which state applies

## Decision

**1. Activation requires a human actor at Authority Level 3, and the level is read from the
recorded actor rather than from the `EventActor` the caller supplied.**

**2. A counsel review is a row with a named reviewer, a review date and a document reference.**
All three required; there is no constructor that omits the document.

**3. Activation records the module version reviewed. Standing is derived** by asking whether any
version published since then was `material`.

**4. `changeKind` is a required argument on every publish**, not a defaulted one. Editorial changes
need a stated rationale. Version 1 cannot be editorial.

**5. An undeterminable jurisdiction is a refusal, not a pass.**

## Consequences

### Who may activate

An agent that could bring a state online would make every other part of this gate decorative. The
check is a refusal rather than a policy note, and it reads the actor from the database because the
caller supplies the `EventActor` — **a gate that believes its caller about whether the caller is
allowed through is not a gate.**

### What counts as evidence

A review nobody can produce is indistinguishable from one that never happened. Requiring a document
reference does not make the review good; it makes the claim falsifiable, which is the most a data
model can do.

### What a rule change does to an activation

The first implementation compared version numbers: any republish deactivated the state. That is
_stricter_ than the specification, and it was still wrong. It made `changeKind` decorative, and a
rule that punishes a typo fix exactly as hard as a rewrite teaches people to batch their typo fixes
into rewrites — which is the opposite of the behaviour wanted.

The rule is now "any **material** version since the one reviewed", not "the latest version differs"
and not "the latest change was material". An editorial patch on top of an unreviewed rewrite must
not launder it.

This deliberately differs from 5.4, where a complaint **flags** a provider rather than suspending
it. The difference is who acted and on what evidence: there, a third party's complaint is weak
evidence and auto-suspension would let one unhappy client remove a provider. Here **we** changed the
rules, deliberately, and the person who set `changeKind: 'material'` chose the consequence. Nobody
is surprised by a consequence they selected.

### The cost, stated plainly

**A client in a state that has not been activated cannot be served.** The refusal will block real
work, and it is supposed to. The alternative — serving them while the module sits unreviewed — is
the failure the gate exists to prevent, and it is the failure that reads as normal operation right
up until a regulator asks who reviewed it.

Withdrawal takes effect on the next action with no propagation step, because standing is derived.
There is no cache to invalidate and no job whose failure would leave a withdrawn state serving
clients.

## Alternatives rejected

**A boolean `active` column.** Drifts from the module version the moment anyone republishes, and
the stored value is the one that would silently be wrong. Same reasoning as ADR-0007.

**Defaulting `changeKind` to `material`.** Safer-looking, and it removes the moment where somebody
has to decide. The decision is the valuable part; a default is chosen once by whoever writes the
first call site and inherited silently forever after.

**Auto-deactivating a state when the law-change tracker records a change.** Would let anyone with
write access take a state offline by filing a bulletin, and noticing that a legislature acted is
not the same as knowing what our module should now say.

**Resolving the jurisdiction inside the chain from the Entity Graph.** Convenient, and it would put
the compliance gate downstream of the lender catalogue (`@bwc/graph` depends on `@bwc/lenders`).
The chain takes the jurisdiction as a value instead. Forgetting to pass one is safe: it produces a
refusal naming what to pass, not a silent pass.

**Passing when the state is unknown.** The whole value of a pre-action check is that a pass means
something was checked.
