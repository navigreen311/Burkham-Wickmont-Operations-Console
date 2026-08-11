# ADR-0062 — An invariant has no control beside it

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 11.7 Admin Configuration Center, on the internal Console
**Extends:** ADR-0019

## Context

ADR-0019 established that configuration must not be able to turn a control off, and
`packages/admin/src/registry.ts` implements it with a distinction rather than a permission. Every
tunable constant is a PARAMETER — a policy choice with a defensible range — or an INVARIANT — law,
or something the architecture rests on. TCPA quiet hours. The Level 4 prohibited-action list. The
all-party recording-consent states.

The registry's mechanism is exact and worth restating, because a surface can undo it without
touching it:

> **Invariants are not permission-gated; they are absent.** A "Level 4 required" flag would be a
> permission somebody eventually holds - and the person most likely to hold it is the one under
> pressure to make a number move.

There is no code path in any package that writes an invariant. What a Console can still do is make
one _look_ editable, and that is enough: an operator who believes a setting exists goes looking for
whoever can change it.

## Decision

**Parameters and invariants are two collections with two shapes, all the way to the DOM.**

The route sends `parameters` (with `minimum`, `maximum`, `boundsBasis`, `owner`, `compiledDefault`)
and `invariants` (with `value` and `whyFixed`). Neither shape carries the other's fields, and no key
appears in both lists.

**Not one list with `editable: false`.** That is the design this ADR exists to reject, and the
reason is mechanical rather than aesthetic: a shared shape means one renderer with one branch, and a
branch is a thing that can be taken wrongly — by a truthy value, by a refactor, by a merge. Two
shapes mean the view has two functions, and `renderInvariant` has no parameter that could make it
draw a control. The property is _absence of a code path_, which is the same property the registry
has, carried to the layer where somebody would look for the setting.

**`whyFixed` is rendered in full, never truncated.** "I could not find the setting" and "the setting
does not exist because it is the law" are different answers, and only the second stops somebody
looking for a workaround. It is the single most load-bearing string on the panel.

### Staged changes are real, and are shown apart

`effectiveValue` reads applied changes only, so a high-risk change recorded with `appliedAt` null
genuinely is not in force. The route carries `staged` and `history` as separate collections from
`parameters`, and the page renders staged changes under their own heading marked NOT IN FORCE.

Rendering a staged value in the parameter row would be the staging mechanism working in the store
and lying on the screen — which is worse than not staging at all, because the operator now believes
a change landed that did not.

### Editing an invariant is not listed as a blocked write

`writes.blocked` names the configuration writes this Console cannot offer — `setParameter`,
`promoteStagedChange`, `rollback` — each waiting on a declared action.

**Editing an invariant is deliberately not on that list.** Listing it would put it on the same
footing as a parameter change waiting on a decision, and imply that declaring an action would unlock
it. It would not: there is no function to call, in any package, at any level. The invariants list
already says so in its own words, which is the right place for it.

## Consequences

**Three layers assert it, and each catches something the others cannot.** The transport test asserts
the shapes and that no key is in both lists. The source test asserts `admin.js` constructs no input,
select, form or textarea. The browser test counts controls inside the rendered invariants list — and
that last one holds whatever the code that produced the list looks like.

**Mutation-tested at both layers, per the brief.** Folding invariants into parameters with
`editable: true` and bounds fails the shape test. Replacing the `whyFixed` line in the view with a
text input fails the source test. Both were confirmed to apply before the result was trusted.

**The panel shows totals for both lists.** "Five parameters configurable, eleven fixed and not
configurable" is a sentence that answers the question before somebody scrolls looking for their
setting.

## Alternatives considered

**One list, sorted, with a `configurable` boolean.** Fewer fields and one renderer. It is the design
that produces `if (item.configurable) renderInput(item)` — a line nobody would write deliberately
and everybody would write eventually, because it is the shortest way to satisfy "show the settings".

**Omit invariants entirely.** The screen is then correct and the operator is not: a setting that is
silently absent reads as a setting somebody hid, and the next step is asking an administrator to
find it. The registry added `whyFixed` precisely so the system answers that question instead of
whoever remembers.

**Show invariants disabled rather than as text.** A disabled input is an input; it has a value
attribute, it is one line from being enabled, and it teaches the reader that the field exists and
they lack permission. That is the mental model ADR-0019 is trying to prevent.
