# ADR-0063 — Two reasons a button is absent, and only one of them is temporary

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 10.1 Inter-Venture Commerce Hooks, with 11.7, 3.1, 3.3, 11.6, on the internal Console
**Extends:** ADR-0018, ADR-0032

## Context

All five surfaces in this batch are read-only, and for the reason ADR-0032 established: every write
in these packages emits a Ledger event, so every one must pass `chain()` with a declared action, and
`ACTION_MINIMUM_LEVEL` declares none for configuration, deliverables, the intelligence pipeline,
inter-venture commerce or the warehouse. Declaring one is a judgement about Authority Levels that
belongs in `packages/core`, next to the fifteen that each carry a paragraph arguing for their
number.

Each surface therefore reports `writes.blocked`, so an operator meets a reason rather than an
absence.

**10.1 is where that pattern breaks, and the break is the point of this ADR.**

A conflict-of-interest disclosure completes only on acknowledgement by the venture's own
representative and by Gardner (ADR-0018). Those parties are **not us**. Put an acknowledgement
control on the internal Console and it would write `interventure.disclosure.acknowledged` from a
staff session — manufacturing the exact evidence the control exists to require, and producing a
record indistinguishable from the real thing afterwards.

Listed in the same `blocked` array as `setParameter`, that would read as one more thing waiting on a
decision in `packages/core`. It is not. **No Authority Level makes us the counterparty.**

## Decision

**`writes.blocked` carries `unblockedBy`, and the two kinds read differently.**

| Capability                                    | `missingAction`  | `unblockedBy`                 |
| --------------------------------------------- | ---------------- | ----------------------------- |
| Generate a disclosure, tag a venture          | `none declared`  | a declared action             |
| Acknowledge a disclosure (venture or Gardner) | `not applicable` | nothing on this surface, ever |

The second row's `why` says it in full: a control here would manufacture the evidence the disclosure
exists to require. The page renders `unblockedBy` beside the capability, so somebody reading the
panel learns which absences are a roadmap item and which are the design.

**Generating the artifact is not disclosing.** The module already separates them and the surface
keeps them separate: the artifact is generated automatically because a hand-written conflict
disclosure varies with how the writer feels about the conflict, and the version written by somebody
keen to proceed is the one that understates it. The disclosure is complete only when acknowledged.

**The content hash is shown on the page.** The body is stored as generated and hashed, and the hash
is checked when an acknowledgement lands, so a later template change cannot rewrite what was
acknowledged. An operator chasing a signature needs to be able to say which version they are
chasing.

**`mayProceed` is asked, not reconstructed.** The gate checks both acknowledgements in a fixed order
and its refusal names which is missing — which is what tells an operator whom to chase. A page
inferring the verdict from two timestamps would eventually disagree with the gate, and the
disagreement would show as a Console saying work may proceed while the system refuses it.

## Consequences

**The other four surfaces use the same field with the ordinary value.** `unblockedBy: 'a declared
action'` is not decoration on those: it makes the 10.1 entry legible as an exception rather than as
a differently-worded version of the same thing.

**Two near-miss actions were considered and rejected by name**, so the next person does not have to
re-derive it:

- `analyze_file` (Level 0) for 3.3's `ingest`. Wrong: it authorises reading a file, not creating
  risk findings about a client, and an ingestion also turns on a per-pull consent the action name
  would not carry.
- `draft_communication` / `send_client_communication` for 3.1's `draft` and `deliver`. Wrong: a
  Capital Command Brief is a deliverable rather than a communication, and approving one is a
  governance determination with no counterpart in the catalogue at all — so adopting the near
  misses would ship half a workflow and label the wrong half.

**A defect this rule caught in its own implementation.** The intelligence route defaulted a missing
`phase` to 0, which answers a different question from the one asked and looks identical in the reply
— phase 0 has its own document requirements, and a caller who omitted the phase would read them as
"the requirements". The transport test caught it and the route now refuses. Same failure shape as a
defaulted period on the warehouse surface (ADR-0064), arriving through a different module.

## Alternatives considered

**One `blocked` list with no `unblockedBy`.** Simpler payload. It also makes the most important
absence on this surface look like the least important one, and the day somebody adds
`acknowledge_disclosure` to the catalogue is the day that matters.

**Omit the acknowledgement rows entirely, since they will never be offered.** Then the panel shows a
disclosure that is not complete and nothing about why it cannot be completed here — and the obvious
next step for an operator is to ask an engineer for a button.

**Offer the acknowledgement behind a Level 3 gate anyway, on the argument that a senior human is
trustworthy.** This is the argument ADR-0019 rejects in a different costume. The control is not
about trust; it is about who the parties are. A trustworthy person acknowledging on behalf of a
counterparty is still not the counterparty.
