# Plan — Walking Skeleton on the Spine

**Branch:** `ai-feature/walking-skeleton-spine`
**Blueprint modules in scope:** 11.3 Event Ledger, 11.1 Identity & Access, 11.2 Tenant / Organization
Model, 11.5 Integration Layer (adapter seam only), 1.1 Client Lifecycle & CRM (compliance state
only), 1.5 Consent & Authorization Center (capture only), 6.2 Funding Ethics Firewall, 5.3 Funding
Recommendation Engine (refusal path only)
**Status:** approved approach, implementing

---

## Mini-PRD

### Problem

46 modules will be built against a set of principles that are currently prose. Prose does not
enforce anything. If the Event Ledger, the middleware order, honest refusals, provenance and tenant
isolation are not _structurally_ real before module work begins, every later module will re-derive
them slightly differently and the discipline will erode exactly where it matters most — the
placement path.

The Workflow Engine (2.2) is 25–35% of V1 effort. Committing that budget before the spine is proven
against real code is the single largest avoidable risk in the build.

### Users

- **Village agents** — act through the middleware; must be hard-blocked outside their Authority Level.
- **Compliance officers** — need every state change to have produced a ledger event with an actor.
- **Engineers** — need one worked example of "how a module is built here" to copy.

### Success metrics

- One request travels the full seven-step middleware chain in order and is observable doing so.
- A placement request against a `needs_review` or `fail` client is **refused with an explicit
  reason**, not silently dropped and not 500'd.
- Every state change in the slice produced a signed, append-only ledger event.
- A cross-tenant read is refused.
- A Level 4 action is blocked and logged, never executed.
- `not_built` / `no_data` / `failed` / `refused` are distinguishable in an API response.
- Invariant tests exist for each of the above and run in CI.

### Constraints

- Principles 3 (events), 4 (middleware), 5 (isolation), 7 (firewall precedence), 8 (provenance),
  9 (honest refusals) all bear directly on this slice.
- Decision E: compliance state is categorical. No numeric representation anywhere, including
  sort keys and database columns.
- Decision D: provenance tag on every lender rule, even the stub one.
- Spec §5.5 fixes the middleware order; it is not per-route configurable.

### Risks

| Risk                                                                      | Mitigation                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Ledger becomes "a table we also write to" rather than the source of state | Ledger append is the only write path in this slice; module read models project from it               |
| Refusals implemented as HTTP status codes only, losing the reason         | `Outcome<T>` is a discriminated union in `@bwc/core`; the HTTP layer serializes it, never invents it |
| Compliance state drifts ordinal                                           | No ordering exported, no numeric column; a test asserts comparison helpers do not exist              |
| Middleware order becomes per-route                                        | One `chain()` export; routes cannot reorder it                                                       |

---

## Architecture

### Package topology

```
apps/
  api/                Express 5 host. Wires the chain, serializes Outcome, nothing else.
  web/                Next.js 15. Minimal surface proving the refusal is visible to a human.
packages/
  core/               Types and invariants shared by everything. No I/O, no deps.
  ledger/             11.3 Event Ledger. Append-only, signed, queryable.
  identity/           11.1 Actors, roles, Authority Levels.
  tenancy/            11.2 Tenants and the isolation check.
  middleware/         The fixed 7-step chain (spec 5.5).
  clients/            1.1 Client record + compliance categorical state.
  consent/            1.5 Consent capture (per-application, per-pull, per-connection).
  firewall/           6.2 Funding Ethics Firewall.
  placement/          5.3 Recommendation Engine - refusal path only in this slice.
  integration/        11.5 Integration Layer seam + a stub adapter that honestly reports not_built.
```

Dependency rule: `core` depends on nothing. `ledger`, `identity`, `tenancy` depend only on `core`.
Everything else may depend on those. **No package imports another package's Prisma client.**

### The `Outcome` type — honest refusals as a type, not a convention

```ts
type Outcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'refused'; reason: string; principle: string }
  | { status: 'not_built'; module: string; reason: string }
  | { status: 'no_data'; reason: string }
  | { status: 'failed'; reason: string; cause?: string };
```

A handler returning `Outcome` cannot silently no-op: there is no empty success. `apps/api`
serializes each variant to a distinct status code (`ok` 200, `refused` 409, `not_built` 501,
`no_data` 200 with an explicit marker, `failed` 500) and always carries the reason.

### Middleware chain — fixed order, spec §5.5

```
authenticate -> tenantScope -> authorityLevel -> firewall -> regulatory -> emitEvent -> complianceScan
```

Exported as a single composed `chain()`. Individual steps are not exported for reordering.
`firewall` checks Firewall state **and** compliance categorical state together, because
Decision E makes them one gate.

### Walking-skeleton request path

```
POST /api/clients                     -> client created, compliance state pending_assessment
POST /api/clients/:id/consents        -> consent captured, ledger event
POST /api/clients/:id/compliance      -> state transition, ledger event with finding list
POST /api/clients/:id/placements      -> THE POINT: refused when state is needs_review | fail,
                                         or when the firewall is triggered, with explicit reason
GET  /api/clients/:id/ledger          -> the events that prove all of the above
```

### Data model (this slice only)

- `Tenant` — id, slug
- `Actor` — id, tenantId, kind (`village_agent` | `human`), authorityLevel 0–4
- `Client` — id, tenantId, legalName, complianceState (enum), createdAt
- `ComplianceFinding` — id, clientId, code, summary, openedAt, resolvedAt
- `Consent` — id, clientId, kind (`application` | `bureau_pull` | `plaid_connection`), grantedAt, revokedAt, scope
- `FirewallState` — clientId, state (`clear` | `triggered`), reason, updatedAt
- `LedgerEvent` — id, tenantId, seq, type, actorId, clientId, payload, signature, prevHash, createdAt

`LedgerEvent` is append-only: no update or delete in the Prisma client surface, enforced by a
repository that exposes only `append` and `read`, plus a DB-level trigger.

---

## Test strategy

**Invariant tests** (`tests/invariants/`) — the priority class, each mapping to a CLAUDE.md rule:

1. Compliance state is categorical — no ordering helper exists; enum values are non-numeric.
2. Placement is refused when state is `needs_review` or `fail`.
3. Placement is refused when the firewall is triggered, independent of compliance state.
4. A Level 4 action is blocked and produces a ledger event recording the block.
5. A cross-tenant read is refused.
6. Ledger is append-only — update and delete are unavailable and rejected at the DB.
7. `not_built` / `no_data` / `failed` / `refused` serialize distinguishably.
8. Every lender rule carries a provenance tag; an untagged write is rejected.
9. No PII appears in any ledger payload or log line.

**Unit tests** per package. **Integration tests** for the chain in order, asserting each step runs
and that a failure at step N prevents step N+1.

---

## Out of scope for this slice

Workflow Engine execution, Plaid/bureau live calls, Regulatory Engine state modules (the middleware
step exists and is a pass-through stub that reports `not_built` honestly), deliverable generation,
the Human Approval Console UI, partner and KPI surfaces.
