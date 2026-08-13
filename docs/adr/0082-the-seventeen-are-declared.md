# 0082 - The seventeen are declared

- Status: accepted
- Date: 2026-08-12
- Context: `packages/core/src/authority.ts`, `apps/api/src/routes/*`

## Context

Seventeen Console capabilities had a working module function and no declared action. Batch D is the
last five, and every one of them bundled routine casework with something consequential — which is
why they were left until a pattern existed for splitting.

## Decision

Eleven actions from five lines.

| Line                                                            | Became                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Draft, QA, approve, reject, deliver; register a template        | `draft_deliverable` 1, `deliver_deliverable` 2, `register_deliverable_template` 3 |
| Register, qualify, onboard, suspend, terminate a partner        | `onboard_partner` 2, `end_partner_relationship` 3                                 |
| Record a completion, approve or withdraw a claim                | `record_partner_completion` 2, `approve_partner_claim` 3                          |
| Record activity, a readiness reading, an attribution correction | `record_lead_activity` 1, `correct_attribution` 3                                 |
| Publish a playbook, start an instance, complete a task          | `publish_playbook` 3, `run_workflow` 1                                            |

**The sales line is the clearest case in the whole seventeen of a surface hiding what it
contained.** "Record activity, a readiness reading, or an attribution correction" reads as one
job. Logging a phone call is Level 1 pipeline hygiene. Correcting an attribution changes who a
referral fee is owed to — and `correctAttribution` had been refusing below Level 3 in its own words
the entire time:

> "It moves money between partners, and an agent able to do it would make the record unreliable in
> exactly the place it needs to be trusted."

The module knew. The blocked list did not, because it was organised by what an operator does rather
than by what an act can do.

**`publish_playbook` is 3 and `run_workflow` is 1**, and the reason is worth stating: the
consequential acts _inside_ a playbook are gated where they happen. A task that transitions a
compliance state still needs `transition_compliance_state`. Gating the act of running a workflow at
the level of the heaviest thing any workflow might do would be gating the door at the level of the
most dangerous room in the building.

## Consequences

**No roadmap-blocked write remains anywhere in the Console.** Seventeen lines became forty-seven
declared actions, from fifteen at the start.

Three blocked entries survive, and all three are blocked **by design** — a distinction ADR-0063
built before there was anything to distinguish:

- `deliberately absent` — downloading a document. Bytes reach a client through the Client Portal,
  on its own trust boundary.
- `not applicable` — acknowledging a conflict disclosure. A control here would manufacture the
  evidence the disclosure exists to require.
- `no module read exists` — listing running workflow instances. Not an Authority Level problem;
  there is no function to call, and querying the table from a route would put a module read in the
  transport.

**Four batches, four times the same finding.** A capability line describes a surface an operator
uses. An Authority Level describes what an act can do. Seventeen lines were sixty-one functions,
and every batch that assumed one line meant one level found otherwise before it finished.

**Twenty modules had already chosen a level for their own most consequential act, and every one
chose 3.** ADR-0079 counted nineteen; `correctAttribution` is the twentieth, found in the last
batch. Not one module that thought about it picked lower.
