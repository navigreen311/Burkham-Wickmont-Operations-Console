# 0076 - The map lives with the templates, and the gap is a list

- Status: accepted
- Date: 2026-08-12
- Context: `packages/comms/src/seed.ts`, `tests/invariants/playbook-comms-linkage.test.ts`

## Context

The Phase 0-2 playbooks and the nine message templates were authored in the same wave by different
people. The playbooks describe six client-facing steps. The Communications Hub holds nine
templates. **Nothing referenced anything, in either direction.**

Two matched a step by coincidence of naming. Three steps that say they send had nothing to send.
Six templates described moments no step reached.

This is not a disagreement, which is what made it invisible. Each side is internally coherent and
neither is wrong alone. A playbook step reads as complete — it names 4.1 and dispatches to the
Concierge Desk — whether or not a template exists. A published template reads as ready whether or
not anything can reach it.

`TEMPLATES_BY_PLAYBOOK` in `@bwc/deliverables` already solved this shape for the documents a
playbook produces, with a two-direction invariant test. It exists because **one person happened to
own both files**. Where the boundary fell between two people, nothing was built. The wave was
partitioned by file ownership, which is what made three parallel branches possible; this is the
cost of that partition, and it is the second one found at integration after ADR-0075.

## Decision

**The map lives beside the templates, keyed by plain strings.**

`TEMPLATES_BY_PLAYBOOK_NODE` maps `playbook-key/node-key` to template keys, in `@bwc/comms`,
mirroring `TEMPLATES_BY_PLAYBOOK` exactly — including that it names playbooks as **strings**, so
`@bwc/comms` gains no dependency on `@bwc/workflow`. The test imports both and asserts they agree.

**Rejected: a `templateKey` field on `AgentTaskNode`.** It reads as the tidier answer and it is
worse in three ways. It puts a Communications concern inside the playbook definition, which is a
description of how the firm works rather than of which module renders a message. It makes
`validate` either useless on the field or dependent on comms at publish time. And it changes a
published node schema to record something no engine behaviour consumes — the send is already an
`agent_task`, and the map is documentation for whoever performs it.

**Exhaustiveness is the assertion, not the mapping.** Every Concierge Desk node in every seeded
playbook must appear in exactly one of three lists: it sends named templates, it sends and has
none yet (`SENDS_WITHOUT_A_TEMPLATE`), or it is not a send (`NOT_A_SEND` — `book_review_call`
schedules a call and names 1.3). A new client-facing step fails the suite until somebody decides
which. Every seeded template must likewise be either reachable or recorded in
`TEMPLATES_WITHOUT_A_STEP`.

**Classification is structural, by department, not by matching the action prose for "4.1".** ADR-0071
caught a string match that quietly fired on nothing; a prose match here would silently stop
classifying the day somebody wrote "the Communications Hub" instead.

## Consequences

**The gaps are now recorded rather than remembered.** Three steps that send nothing, and seven
templates nothing reaches — including the three that matter most: after a client authorises an
application, Phase 1 submits it, awaits a decision and records the outcome **without contacting
them again**. Not on submission, not on an offer, not on a decline. The templates were written; the
steps were not.

**Closing those gaps is a proposal about how the firm treats clients**, which ADR-0067 places with
the owner rather than with whoever is editing the file. This ADR deliberately does not close them.
It makes them fail loudly enough to be decided.

**The lists are not asserted non-empty.** They are known-absence records. When the missing
templates and steps land, entries move between lists and exhaustiveness still holds — no test has
to be rewritten to accept the fix.

**The suite was verified by mutation, not by passing.** Unclassifying a step, adding a template
with no home, and mapping a template that was never seeded each fail on the intended assertion with
a readable message. A green invariant that has never been seen red is a green invariant that may
assert nothing — the failure mode this repo has already hit once, in a test whose name said
"leaves activation intact" while its assertion agreed with the code.
