# ADR-0039 — A module read keyed by an id carries no tenant

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 2.4 Human Approval Console, 11.2 Tenant / Organization Model

## Context

Most module reads take a tenant. `accessLog(tenantId, documentId)`, `findContract(tenantId, id)`,
`balanceOf(tenantId, engagementId)`, `findEngagement(tenantId, id)` — each filters on it, and a
route can pass the id straight through.

Three do not. In `@bwc/workflow`:

```ts
export const find = async (taskId: string): Promise<QueuedTask | null> =>
  db().workflowTask.findUnique({ where: { id: taskId } });

export const findInstance = async (instanceId: string): Promise<WorkflowInstance | null> => …
export const forInstance = async (instanceId: string): Promise<QueuedTask[]> => …
```

**This is not a defect in those functions.** Their caller is the engine, which resolved its own scope
before it had an id at all: `claim` selects by tenant, `tick` is passed one. Adding a tenant
parameter to a lookup the engine already scoped would be ceremony.

It becomes a defect the moment the id arrives from outside. The Human Approval Console takes a task
id from a URL, which is a string a person can type.

## Decision

**A transport route that accepts an id re-scopes it, and does so before the id reaches any further
module call.**

`/api/console/approvals/:taskId` resolves the task, checks `task.tenantId` against the configured
tenant, and only then passes `task.instanceId` onward. The instance is checked too.

Three things follow, and each is a decision rather than an obvious consequence.

### The refusal says the same thing to both causes

A task in another tenant and a task that does not exist get the identical `no_data` and the identical
sentence. A route that distinguished them would be an existence oracle: paste ids until the wording
changes and you have learned which ones are real, which for a workflow task means learning that a
client file exists in a tenant you cannot see.

Same reasoning as the sign-in refusal (ADR-0032) and the password-reset response (ADR-0027). A test
asserts the two responses are equal string-for-string rather than asserting each separately, because
two assertions drift.

### Both checks stay, and mutation testing is why that is written down

Removing the task-level check leaves the cross-tenant test **passing**, because `start` creates a
task and its instance in one tenant, so no reachable state has them disagreeing. Removing both is
what fails it.

So neither check is the one the test proves, and it would have been easy to conclude the task check
was redundant and delete it. It stays because **the invariant it leans on is not enforced anywhere**
— nothing in the schema or the types says a task and its instance share a tenant. A guard that is
correct only because of an unstated invariant is a guard waiting for the invariant to change, and
the change would be silent.

This is the same finding shape as ADR-0033's — "a test that asserted only `refused` was passing for
the wrong reason" — reached by mutating the code rather than by reading it.

### The scope comes from configuration, never from the caller

`config.tenantId`, not a header, not a query parameter, not the actor's own `tenantId`. The last is
the tempting one and it is subtly worse: it would make the check "is this task in the actor's
tenant", which is right, but it would also mean a route's scope depends on who is asking. The Console
is deployed for one tenant. One source for that answer is one place to get it wrong.

## Consequences

**Every id-taking route added in this slice was audited against its module's signature.** Contracts,
engagements, billing and the vault access log all take a tenant and need nothing added; the two
workflow routes needed the check. The audit is the deliverable here as much as the code — the pattern
is "read the signature", not "add a check everywhere".

**`forInstance` is called with an id this route did not receive.** It comes off the task row after
that row's tenant was verified, which is what makes it safe. Worth stating because it looks like an
unchecked id at the call site.

**A future `@bwc/workflow` read taken by a transport needs the same treatment**, and there is nothing
in the type system that will say so. That is the honest limit of this ADR: it records a rule and a
reason, and the enforcement is a reviewer noticing.

## Alternatives considered

**Add a `tenantId` parameter to `find`, `findInstance` and `forInstance`.** The right long-term fix,
and it is in `packages/**`, which this slice does not own. It is also not free: it touches the
engine's hot path and the listener, and doing it as a side effect of building a page is how a
signature change lands without the thought it deserves. Recorded here as the follow-up.

**Filter the result rather than refusing.** Returning an empty task list for another tenant's
instance leaks less than returning the tasks and more than refusing — the empty list is
distinguishable from a real empty list only by luck.

**Trust that a Console operator will not paste another tenant's id.** They would not, on purpose. The
population that would is the one the check is for, and principle 5 says isolation is strict rather
than conventional.
