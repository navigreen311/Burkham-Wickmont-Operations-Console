# 0077 - The client hears the answer, and a new version is how

- Status: accepted
- Date: 2026-08-12
- Context: `packages/workflow/src/seed.ts`, `packages/comms/src/seed.ts`

## Context

ADR-0076 recorded seven message templates describing moments no playbook step reached, and said
closing that gap was a proposal about how the firm treats clients — the owner's call, not an
engineer's. The owner made it.

The severest case was Phase 1. After a client authorised a specific application, the playbook ran
`submit_application`, `await_provider_decision` and `record_outcome` and **never contacted them
again** — not on submission, not on an offer, not on a decline. Templates for all three existed and
nothing sent them.

## Decision

### The sends are steps, and the steps are `agent_task`s naming 4.1

Four nodes: `send_welcome` in Phase 0, and `notify_submission`, `notify_offer` and `notify_decline`
in Phase 1. None of them sends — each dispatches to the Concierge Desk naming 4.1, which is the
rule the playbook seed already held itself to. A node that sent would be a workflow that appears to
contact clients while the Communications Hub still reports `not_built` at the provider seam.

### The decline is reached by a branch, not by remembering

`outcome_gate` is a decision node reading `context.fundingOutcome`, written by `record_outcome`.

**It reads the context and not the event, because the engine cannot see the event.** `resolveWaits`
matches a waiting task to an event type and a client, resolves the wait, and **discards the
payload**; `buildScope` exposes only `client.{id,legalName,complianceState}`, `context` and
`instance`. So the provider's decision — carried in `billing.funding_outcome.recorded` — is
invisible to a branch. The fix is the one Phase 2 already uses: `compute_stack_position` writes
`stackHealth` into the context for the branch below it, and `record_outcome` now writes
`fundingOutcome` the same way, through the `contextPatch` on `completeExternalTask`.

That this was the third time an obvious next step turned out to rest on something absent is the
pattern of this whole integration, and it is recorded rather than routed around: **an event wait
does not carry its payload into context, and until it does, any branch on an event's contents needs
a task to copy the fact across.**

`otherwise` completes silently. A withdrawn application is neither an offer nor a decline, and
guessing between two messages is worse than sending none — a client told an offer arrived when it
did not is a mistake no later correction undoes.

### It ships as v2, and v1 stays

`publishPlaybook` upserts on `(key, version)`, and `tick` reads
`definitionFor(instance.playbookKey, instance.playbookVersion)`. **Editing v1 in place would rewrite
the graph under every running instance**, which would pick up new nodes at its next tick — the
engine's own comment says re-routing a live engagement "is a decision for a human, not a side effect
of a publish."

So Phase 0 and Phase 1 declare `version: 2` and Phase 2, unchanged, stays at 1. Verified live: after
seeding, `phase-0-capital-readiness` and `phase-1-placement` each have a v1 row and a v2 row, both
active, and `start` takes the latest while a pinned instance keeps running what it began on.

This is the same class of hazard as ADR-0075 — a write that looks idempotent, is not, and does its
damage to something already running — and it is the reason that ADR is worth having found first.

### Every new node is `inferred`, and says why at length

The blueprint names none of these steps. Each carries reasoning rather than a citation, so the
generated review list grew by four and a reviewer can argue with the reasoning without opening the
blueprint. "Whether a firm greets a client it has just signed is not really a question, but the
blueprint not asking it is why this is an inference."

## Consequences

**Three templates remain unreachable, each blocked on a named capability rather than on nobody
having got round to it.**

- `document-request-reminder-sms` and `appointment-reminder-sms` both want a timer running
  **alongside** a wait, firing if the wait has not resolved. `WaitNode.until` is a duration or an
  event and never both, an event wait carries no timeout, and `slaMinutes` records `slaDueAt`
  without anything acting on a breach. Expressing a nudge as a duration wait in the main path would
  stall the client who answered promptly — the one it would punish. The appointment reminder is
  worse: it is due relative to a time held in Sales Motion (1.3), not in the workflow context.
- `post-funding-checkin` fires some months after a facility funds. That is a schedule, not a
  position in Phase 2's monthly cycle; placing it after `deliver_brief` would send it every month.
  It wants a trigger of its own.

**The invariant from ADR-0076 did its job in both directions.** The test that recorded the Phase 1
silence failed the moment the silence ended — it was written to say so — and the exhaustiveness
assertion forced each of the four new nodes to be classified as it was added, rather than being
noticed later.

**A pre-existing test fragility surfaced.** `is idempotent` asserted a row count and
`version === 1`. Playbooks are firm-wide and their rows outlive a tenant fixture, so the count
measured how many times the suite had ever run — passing on a fresh CI database and failing on a
local one. It now asserts, per seed, one row at the version that seed declares.
