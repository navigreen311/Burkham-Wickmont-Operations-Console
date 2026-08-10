# Walking Skeleton on the Spine

The first build slice. Establishes the Event Ledger, Identity, Tenancy, and the fixed
seven-step middleware chain, then drives one thin path all the way through them: client intake →
consent → compliance state → **placement correctly refused, with the reason and the governing
principle named**.

## Why this first

The Workflow Engine (module 2.2) is 25–35% of V1 engineering effort. Committing that before the
spine is proven against running code is the largest avoidable risk in the build. This slice
proves the middleware order, honest refusals, provenance, tenant isolation, and the append-only
Ledger are real — not prose — before anything expensive is built on them.

## Modules in scope

| Module                             | Built                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| 11.3 Event Ledger                  | Append-only, hash-chained, HMAC-signed, integrity verification     |
| 11.1 Identity & Access             | Actors, Authority Levels 0–3, prohibited-action perimeter          |
| 11.2 Tenant / Organization Model   | Tenants and the isolation check                                    |
| 11.5 Integration Layer             | Adapter seam + vendor activation gates (all V1 vendors ungated)    |
| 1.1 Client Lifecycle & CRM         | Client record + compliance categorical state only                  |
| 1.5 Consent & Authorization Center | Per-application / per-pull / per-connection capture                |
| 6.2 Funding Ethics Firewall        | Trigger, human-only clear, the placement gate                      |
| 5.3 Funding Recommendation Engine  | **Refusal path only** — the recommendation itself needs 5.2 (V1.5) |

Deliberately absent, not stubbed: Workflow Engine execution, Plaid/bureau live calls, the
Regulatory Engine's state modules, deliverable generation, the Human Approval Console UI.

## Architecture

```
apps/api            Express 5. Wires the chain, serializes Outcome. No business logic.
packages/
  core              Types and invariants. No I/O, no dependencies.
  db                The only package that talks to Postgres.
  ledger            11.3 - append, read, verifyIntegrity
  identity          11.1 - actors, authority decisions
  tenancy           11.2 - isolation check
  clients           1.1  - compliance state + transitions
  consent           1.5  - per-event authorization
  firewall          6.2  - trigger / clear / evaluate
  integration       11.5 - gated adapters
  middleware        the fixed 7-step chain
  placement         5.3  - refusal path
```

Each module owns a Postgres schema (ADR-0001). `Outcome<T>` makes honest refusals a type rather
than a convention (ADR-0002).

## The middleware chain

Specification v2 §5.5, fixed order, not per-route configurable:

```
authentication → tenant_scope → authority_level → firewall → regulatory → event_emission → compliance_scan
```

Every response — refusals included — carries the step trace, so "which step blocked this" never
requires reconstructing the chain from logs. Steps that do not apply are marked `skipped`
explicitly, never passed over silently.

Step 5 currently **refuses** every client-facing action with `not_built`, because the Regulatory
Engine (7.2) does not exist and principle 6 gates client-facing action on that check. Passing
silently would assert a check that never ran.

## Endpoints

| Method | Path                                      | Purpose                                               |
| ------ | ----------------------------------------- | ----------------------------------------------------- |
| GET    | `/api/health`                             | Liveness                                              |
| GET    | `/api/health/integrations`                | Vendor activation gates and outstanding preconditions |
| POST   | `/api/clients`                            | Create a client (`pending_assessment`)                |
| GET    | `/api/clients/:clientId`                  | Read within tenant                                    |
| POST   | `/api/clients/:clientId/compliance`       | Categorical state transition with findings            |
| POST   | `/api/clients/:clientId/consents`         | Grant a scoped consent                                |
| GET    | `/api/clients/:clientId/firewall`         | Firewall status                                       |
| POST   | `/api/clients/:clientId/firewall/trigger` | Trigger the Firewall                                  |
| POST   | `/api/clients/:clientId/placements`       | **The point** — refused unless every gate clears      |
| GET    | `/api/clients/:clientId/ledger`           | Events for a client                                   |
| GET    | `/api/ledger/integrity`                   | Verify the tenant's chain                             |

Actor identity arrives as an `x-actor-id` header. **That is a development seam, not
authentication** — real Identity & Access issues and verifies credentials, and this is replaced
when it does.

### Outcome → HTTP

| Outcome     | Code | Meaning                                          |
| ----------- | ---- | ------------------------------------------------ |
| `ok`        | 200  | Succeeded                                        |
| `refused`   | 409  | Policy declined; body carries `principle`        |
| `not_built` | 501  | Capability does not exist; body carries `module` |
| `no_data`   | 404  | We looked; there is nothing                      |
| `failed`    | 500  | We tried; it broke                               |

## Environment variables

| Variable             | Purpose                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL 17 connection string                                                                   |
| `LEDGER_SIGNING_KEY` | HMAC key for ledger signatures; ≥32 chars. Load from a secret manager in any deployed environment |
| `API_PORT`           | API port (default 4100)                                                                           |
| `INTEGRATION_MODE`   | `stub` \| `sandbox` \| `live`                                                                     |

## How to run

```bash
cp .env.example .env          # then fill in DATABASE_URL and LEDGER_SIGNING_KEY
pnpm install
pnpm db:generate
pnpm db:deploy                # applies migrations, including the append-only triggers
pnpm dev                      # API on http://127.0.0.1:4100
```

Generate a signing key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## How to test

```bash
pnpm test              # all suites
pnpm test:invariants   # the invariant suite alone
pnpm verify            # lint + typecheck + test
```

## Demo

With the API running:

```bash
node scripts/demo-walking-skeleton.mjs
```

Drives the whole path and prints each step. Idempotent — creates a fresh tenant per run.
Abridged output:

```
409  refused    request placement -> Compliance state is pending_assessment...  [Decision E]
409  refused    request placement -> Compliance state is Needs Review...        [Decision E]
409  refused    request placement -> No live application authorization...       [Blueprint 1.5]
501  not_built  request placement -> no lender catalogue exists to recommend from
                                                          [module: 5.2 Lender Intelligence Database]
409  refused    request placement -> Funding Ethics Firewall is triggered...    [Principle 7]

intact=true  entries checked=12
```

## Invariants under test

| Invariant                                                                     | Where                                               |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Compliance state categorical; no ordering helper exists                       | `tests/invariants/compliance-state.test.ts`         |
| Level 4 blocked **and logged**, for every actor at every level                | `tests/invariants/authority-levels.test.ts`         |
| Ledger rejects UPDATE / DELETE / TRUNCATE **at the database**                 | `tests/invariants/ledger-append-only.test.ts`       |
| Forged signature and sequence gaps detected                                   | `tests/invariants/ledger-append-only.test.ts`       |
| Placement refused on every blocking state; permitted on the two eligible ones | `tests/invariants/placement-gate.test.ts`           |
| Firewall precedence; agents cannot self-clear                                 | `tests/invariants/placement-gate.test.ts`           |
| Every requested placement has a terminal outcome event                        | `tests/invariants/placement-gate.test.ts`           |
| Cross-tenant read refused; block logged to the actor's tenant only            | `tests/invariants/isolation-provenance-pii.test.ts` |
| Provenance structurally required; untagged write rejected                     | `tests/invariants/isolation-provenance-pii.test.ts` |
| Ungated vendor reports `not_built`, never empty data                          | `tests/invariants/isolation-provenance-pii.test.ts` |
| PII redacted before the Ledger                                                | `tests/invariants/isolation-provenance-pii.test.ts` |
| Success fee takes only `approvedCreditLimit`                                  | `tests/invariants/isolation-provenance-pii.test.ts` |
| Chain runs in order; a block prevents later steps                             | `tests/integration/middleware-chain.test.ts`        |

The suite was mutation-checked: widening `PLACEMENT_ELIGIBLE_STATES` to include `needs_review`
turns it red. A suite that has never been shown a break has been run, not tested.

## Known gaps

- **`x-actor-id` is not authentication.** Replaced by Identity & Access (11.1).
- **Step 5 refuses all client-facing actions** until the Regulatory Engine (7.2) exists. Correct
  by principle 6, and it means no client-facing content path is usable yet.
- **Step 7 is unreachable** while step 5 refuses. Retained so the order stays visible.
- **No web surface.** The Client Portal (11.10) and Founder Workbench (11.11) are later slices.
- **All V1 vendors ungated.** Plaid, business bureau, and personal credit report `not_built` with
  outstanding preconditions named. Two still need vendor selection.
- **Compliance transitions are unvalidated.** Any state may follow any other; the workflow that
  governs transitions belongs to the Human Approval Console (2.4).

## Next

Workflow Engine (2.2) — scheduler, task queue, wait-state manager, retry policy, event listener —
now that the Ledger it listens to and the chain it dispatches through both exist and are tested.
