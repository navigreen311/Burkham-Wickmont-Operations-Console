# 0083 - Attribution is required, or it is decorative

- Status: accepted
- Date: 2026-08-12
- Context: `packages/workflow/src/engine.ts`, `packages/core/src/events.ts`

## Context

Two gaps the codebase had reported about itself, and neither was an Authority Level problem.

**`publishPlaybook` wrote no Ledger event.** Principle 3 says every state change is an event, and
publishing a playbook is the firm changing the rules by which it serves every client who starts on
one afterwards. ADR-0069 recorded this when only tests could reach the function. **Batch D then put
a Level 3 button on it**, which turned a documented gap into an unrecorded act one click away.

**`@bwc/workflow` had no tenant-scoped list read.** It offered `findInstance(instanceId)` and
nothing that answered "what is running". The Console route refused to fill the gap by querying the
table itself — a module read living in the transport is what this repository has refused everywhere
else — so it reported the absence on the panel and waited. It was the last `no module read exists`
entry anywhere in the Console.

## Decision

### `tenantId` and `actor` are REQUIRED on `PublishInput`

The smaller change was to make them optional, and it would have been the wrong one. Every existing
caller — the seed, thirty-five test call sites — would have gone on publishing anonymously, and the
Console button would have been the only place the act was recorded. **A control a caller can skip is
not a control** (ADR-0034), and an event that most callers omit is not an audit trail.

So the signature changed and every caller was updated, including `seedV1Playbooks`, which now takes
a tenant and an actor for the same reason.

A playbook row is firm-wide and carries no tenant column. The **event** is tenant-scoped because the
Ledger is, and a Console process serves one tenant.

### The event says whether it was a republish

`upsert` on `(key, version)` makes a first publish and a republish identical in the row, and they
are different acts: one adds a version, the other **rewrites a definition instances may already be
pinned to**. The payload carries `republished`, read before the upsert.

### `instancesFor(tenantId, filter)` lives in the module

Newest first, capped at 200. An unbounded list of every instance a tenant has ever run is a page
nobody can use and a query that gets slower every month. The route forwards it and counts running,
waiting and failed separately — "12 instances" hides the only distinction an operator cares about.

## Consequences

**Both were verified by mutation, not by passing.** Removing the `append` and hard-coding
`republished: false` each fail on the intended assertion. A ledger test that only checked "an event
exists" would pass against a version that recorded the wrong thing.

**No `no module read exists` entry remains anywhere in the Console**, and the three surviving blocked
entries are all blocked by design.

**The test that asserted the gap was rewritten, not deleted.** It expected a 404 from
`/api/console/workflow/instances` and was right to, for as long as no module read existed. It now
asserts the shape of the answer, including that the surface reports nothing blocked.
