# 0080 - The graph is an input to the assessment that gates it

- Status: accepted
- Date: 2026-08-12
- Context: `packages/core/src/authority.ts`, `apps/api/src/routes/{graph,outcomes,interventure}.ts`

## Context

Batch B was scoped as "the three Level 2 writes": venture tagging, funding outcomes, entity
records. Two of the three were not Level 2, and one of them carried a trap.

## Decision

### Six actions from three lines, at three levels

The same finding as Batch A: a capability line is a **surface**, and the acts behind it differ.

| Action                         | Level | Why it is not the others                          |
| ------------------------------ | ----- | ------------------------------------------------- |
| `generate_conflict_disclosure` | 1     | Generated mechanically, on purpose                |
| `tag_venture`                  | 2     | A determination about who a client is to the firm |
| `raise_intercompany_invoice`   | 3     | Money between related parties                     |
| `record_funding_outcome`       | 2     | Writing down what a provider decided              |
| `mark_attempt_funded`          | 3     | **Stops a refund clock**                          |
| `record_entity_graph`          | 2     | Structural facts the risk engines read as given   |

**`mark_attempt_funded` is separate from every other outcome because of what it stops.** Blueprint
1.4 drives refunds from objective triggers and the first is sixty days approved-but-unfunded. An
attempt wrongly marked funded silently takes a client out of the window that would have refunded
them — a financial consequence to somebody not in the room, arriving later and invisibly. Recording
a decline is bookkeeping; recording funding ends an entitlement.

**Generating a disclosure is Level 1 because it is deliberately mechanical.** A hand-written
conflict disclosure varies with how the writer feels about the conflict, and the version written by
somebody keen to proceed is the one that understates it (ADR-0063). Producing the artifact is
preparation. **Generating is not disclosing** — it is complete only when acknowledged, and
acknowledgement is offered at no level on this surface, because a control for it would manufacture
the evidence the disclosure exists to require.

### `record_entity_graph` is a governance action, and leaving it out would rebuild the original trap

Middleware step 4 refuses any compliance state that is not Pass or Pass with Findings. A client in
`pending_assessment` — **which is every client on the day their file opens** — could therefore not
have an entity, an owner, a relationship or a stated revenue recorded.

And the entity graph is an **input to the assessment** that would move them out of
`pending_assessment`. A new client could never be assessed, which is word for word the failure
`GOVERNANCE_ACTIONS` was created to prevent, one layer further out. The list's own comment already
said "a new client could never be assessed at all" about compliance transitions; this is the same
sentence about the data the transition is made from.

Verified by mutation. Removing `record_entity_graph` from the list produces exactly the trap:

> `refused: Compliance state is pending_assessment. Placement requires Pass or Pass with Findings.`

`record_funding_outcome`, `mark_attempt_funded` and `tag_venture` are governed for a related
reason: a client can be firewalled or moved to `fail` between an application going out and the
provider answering, and that is a common sequence rather than an exotic one. A gate on recording
the answer would leave the decline unrecorded — and 9.1's denominator would then improve _because_
a client's file went wrong, which is precisely backwards.

### Recording a stated figure is Level 2; changing it is Level 4

`recordStatedRevenue` writes down a claim somebody made. Turning that claim into a more useful
number is `fabricate_revenue`, which is on the prohibited list: blocked for every actor, at every
level, with no approval that unlocks it. The distinction is the whole of the rule and the panel
says it beside the control.

## Consequences

**Seven roadmap-blocked writes remain**, all in Batches C and D.

**ADR-0063 is now demonstrated rather than argued.** That ADR gave `unblockedBy` two values so a
reader could tell a capability that was coming from one refused on principle. Both interventure
entries were blocked when it was written. In this batch, the one whose `unblockedBy` said "a
declared action" **got one**, and the one that said "nothing on this surface, ever" did not move and
never will. The test that asserted the distinction now asserts it across the two lists, which is the
stronger form: it has been proved by time rather than by a field.

**A test failed for the right reason and was rewritten, not deleted.** It required both entries to
be in `blocked`. That was true when written and is now false for one of them, which is what a batch
is supposed to do.
