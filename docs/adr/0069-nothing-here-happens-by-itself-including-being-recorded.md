# ADR-0069 — Nothing here happens by itself, including being recorded

**Status:** accepted
**Date:** 2026-08-12
**Modules:** 2.2 Workflow Engine, 3.1 Document & Deliverable Management, 11.3 Event Ledger

## Context

Seeds are the one kind of code that is tempting to make automatic. A playbook library that appeared
when the process booted would mean nobody ever had to remember to publish it, and the Workflow
Engine would stop being empty everywhere at once.

That temptation is exactly what makes a seed dangerous. These playbooks are drafts of how a firm
serves clients (ADR-0067), and a draft that installs itself is one nobody chose.

## Decision 1 — an exported function, called by somebody who decided to

`seedV1Playbooks` and `seedV1DeliverableTemplates` are exported functions with no import side
effects. Importing `@bwc/workflow` publishes nothing. Neither seed is wired into a script here: the
wiring is a decision about when a deployment starts running on this content, and it belongs to
whoever is integrating rather than to the file that authored it.

The regulatory seed set this shape and the reasoning carries over unchanged.

## Decision 2 — idempotent, and more simply than the regulatory seed is

`publishPlaybook` upserts on (key, version), so running the seed twice republishes the same
definition at the same version and leaves the row where it was. `registerTemplate` does the same on
(key, version). Both are asserted by comparing rows before and after a second run — not by checking
that the call did not throw, which is what "idempotent" usually turns out to mean.

**This differs from the regulatory seed deliberately.** That one bumps a material version on every
run, and says why: a state module is a claim about the law, so re-seeding is a change to the rules of
record and an activated state goes back to counsel. A playbook re-seeded from unchanged source is the
same playbook, and instances already running v1 stay pinned to v1 regardless of what is published
after them.

Bumping a version here would move every _future_ instance onto a definition nobody reviewed, for no
reason but that somebody ran a command twice.

## Decision 3 — the seed records nothing in the Ledger, and says so rather than borrowing a type

The regulatory seed appends `regulatory.seed.published`. There is no `workflow.seed.published` in
`packages/core/src/events.ts`, and this slice does not own that file.

The options were to invent one (not ours to add), to borrow a neighbouring type (a false entry in an
append-only store — worse than a missing one), or to record nothing and report it. **This records
nothing and reports it**, and the function's own header says so at the point somebody would look.

### The larger half of that finding is not about seeding

`publishPlaybook` writes no Ledger event either. So publishing a playbook — the rules by which this
firm serves clients — is **unrecorded however it is done**, not merely when a seed does it. Principle
3 says every state change is an event, and this is one of the most consequential state changes the
system has: it decides what happens to every client who enters a phase afterwards.

That is a gap in 2.2 rather than in this seed, it predates this slice, and it is reported rather than
fixed here because the fix needs an event type this slice cannot add.

What core would need:

| Event type                    | Why                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `workflow.playbook_published` | The rules changed. Appended by `publishPlaybook`, so it is recorded however publication happens               |
| `workflow.seed.published`     | Optional if the above exists — a seed run is then visible as a burst of publishes rather than as its own fact |

`workflow.playbook_published` is the one that matters. A seed event without it records that somebody
ran a script and not that the rules moved.

## Consequences

**A deployment that wants these playbooks live calls two functions.** Until it does, the engine is
still empty — which is the correct state for a firm that has not reviewed the drafts.

**Running the seed leaves no trace outside the rows it wrote.** An operator asking "when did these
playbooks appear" has the `publishedAt` column and nothing else. That is the gap above, visible.

**The two seeds are independent and the invariant test ties them together.** Running the playbook
seed without the template seed produces playbooks that draft templates nobody registered;
`TEMPLATES_BY_PLAYBOOK` is checked in CI so the pairing is not left to whoever writes the integration
script.

## Alternatives considered

**Auto-seed on first boot when the playbook table is empty.** Convenient, and it means a firm starts
running on drafts nobody read. It also makes "the table is empty" load-bearing, so restoring a
database from before the first publish would silently republish.

**Add the event types and append.** One line in `packages/core/src/events.ts`, which this slice does
not own, and the missing type is a symptom of the real gap rather than the gap itself — adding
`workflow.seed.published` alone would record the script and not the rule change.

**Append under `regulatory.seed.published`.** A false entry. An append-only store cannot be corrected,
only compensated, so a wrong type is permanent in a way a missing one is not.

**Bump the playbook version on every seed run, as the regulatory seed does.** Decision 2. Right for a
claim about the law, wrong for a definition that instances pin themselves to.
