# Burkham Wickmont Operations Console

The dedicated operating environment for the Burkham Wickmont Village — the surface through which
an AI agent workforce delivers a private-CFO-style capital operations service at national scale,
with human oversight concentrated at high-leverage decision points.

**This is a service-company platform, not a customer-facing SaaS product.** Clients experience the
Burkham Wickmont brand, deliverables, and outcomes. They touch the Console only through the
narrowly scoped Client Portal (module 11.10), which is a secure delivery and approval surface.

## Status

**Phase: V1 in progress. 2 of 46 modules' worth of foundation complete.**

| Slice                                                           | State                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Walking skeleton on the spine](docs/walking-skeleton-spine.md) | Event Ledger, Identity, Tenancy, the fixed seven-step middleware chain, and one path driven end to end: client intake → consent → compliance state → placement correctly refused with the governing principle named |
| [Workflow Engine core](docs/m2-2-workflow-engine.md)            | Playbooks, instances, durable Postgres task queue, retry/backoff/dead-letter, wait states, decision predicates, SLA escalation                                                                                      |
| [Scheduler, listener, worker](docs/m2-2-scheduler-listener.md)  | Cron schedules with timezones, Ledger-triggered workflows, event-wait resolution, and a worker process that runs it all                                                                                             |

**1309 tests green** (lint, types, format clean). Module 2.2 complete (all seven §5.3 components);
**Category 3 complete** (3.1, 3.2, 3.3, 3.4), plus 4.2, 7.4, and **Category 5's V1 modules complete**
(5.1, 5.3, 5.4, 5.6) with 5.2 pulled forward from V1.5 because 5.3 and 5.4 depend on it, plus
1.2 Entity Graph. No `not_built` remains anywhere on the funding path.

[**V1.5 engines, batch 1**](docs/v15-engines-batch-1.md) — 5.5 Funding Outcome Ledger, 7.5 Legal
Hold & Record Retention, 8.4 Partner Risk Score and 6.3 Client Conduct Monitoring, as engines with
no HTTP surface yet, plus the ordering key ADR-0034 named and left open. 9.1's placement approval
rate now has a denominator: it refuses on sample size rather than because a decline was never a row.

Next: routes and Console surfaces for the four V1.5 engines, or Category 1's remaining Client &
Engagement modules.

## Scope

58 modules across 11 functional categories. 46 build in V1.

| #   | Category                          | Modules | V1     |
| --- | --------------------------------- | ------- | ------ |
| 1   | Client & Engagement               | 5       | 5      |
| 2   | Operations                        | 6       | 6      |
| 3   | Document & Deliverable Management | 4       | 4      |
| 4   | Communications Hub                | 5       | 5      |
| 5   | Capital Operations & Intelligence | 6       | 4      |
| 6   | Risk & Defense                    | 5       | 3      |
| 7   | Compliance & Governance           | 5       | 4      |
| 8   | Partner & Referrer Portal         | 4       | 2      |
| 9   | KPI Dashboards & Reporting        | 4       | 2      |
| 10  | Inter-Venture Commerce            | 2       | 1      |
| 11  | Technical Platform                | 12      | 10     |
|     | **Total**                         | **58**  | **46** |

V1 targets 150–180 days. V1.5 adds the remaining 12 modules. V2 completes the 50-state Regulatory
Engine, cross-portfolio integration, and native statement parsing.

## Canonical documents

| Document                                                                     | What it holds                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/reference/blueprint-v2.md`](docs/reference/blueprint-v2.md)           | Module-by-module specification, dependencies, orchestration and data-flow patterns, V1/V1.5/V2 phasing                          |
| [`docs/reference/specifications-v2.md`](docs/reference/specifications-v2.md) | Cross-cutting architecture, security posture, governance, data model, success criteria                                          |
| [`CLAUDE.md`](CLAUDE.md)                                                     | Always-true development context: the nine principles, five locked decisions, hard invariants, middleware order, delivery recipe |

Read the reference documents before designing any module. `CLAUDE.md` is the distilled always-on
context, not a substitute for them.

## The five locked decisions

|       | Decision                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- |
| **A** | Statement parsing — **Plaid** (Link + Assets) is the V1 data source; native parsing is V2                                    |
| **B** | Bureau data — B2B aggregator for business credit + separate personal provider, **per-pull client authorization**             |
| **C** | Workflow execution — the **Console's Workflow Engine** is the runner; CapitalForge's workflow store is legacy and never read |
| **D** | Credit unions — V1 placement is **Navy Federal only**; provenance discipline is portfolio-wide                               |
| **E** | Compliance state — **categorical**, never numeric: `Pass` / `Pass with Findings` / `Needs Review` / `Fail`                   |

## Architectural position

```
Gardner (parent-level governance, five ventures)
    └── Burkham Wickmont (customer-facing operating brand)
          └── Burkham Wickmont Village (10 departments, AI agent workforce)
                └── Burkham Wickmont Operations Console  ← this repository
                      └── Forge platforms (CapitalForge, FunnelForge, SelfPublisherForge,
                          AnimaForge, VideoEditForge, ChamberForge)
                            └── Village OS framework
```

The Console **calls** the Forge platforms as services; it does not embed them. CapitalForge lives
at [`navigreen311/Capitalforge`](https://github.com/navigreen311/Capitalforge) and is checked out
locally at `../capitalforge`.

## What the Console owns vs. calls

**Owns:** all workflow execution · per-application authorization · per-pull bureau authorization ·
Plaid connection authorization · compliance categorical state · provenance metadata on
recommendations · multi-tenant isolation · cross-portfolio handoff to Collingswood.

**Calls:** capital operations → CapitalForge · voice → VoiceForge · vision/audio → VisionAudioForge ·
marketing automation → FunnelForge · long-form content → SelfPublisherForge · animation → AnimaForge ·
video → VideoEditForge · UHNW handoff → ChamberForge · bank data → Plaid · business bureau → Nav or
equivalent · personal credit → Array or equivalent.

## AI development workflow

This repository is set up for AI-assisted development. See [`CLAUDE.md`](CLAUDE.md) for the full
contract.

| Command         | Purpose                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `/impl-feature` | Plan and implement a complete feature end-to-end in its own branch                |
| `/test-suite`   | Create or extend unit / integration / e2e coverage and wire into CI               |
| `/deploy-prod`  | Prepare production deployment assets and a repeatable pipeline                    |
| `/code-review`  | Example-driven review across architecture, correctness, security, maintainability |
| `/api-test`     | Generate API contract and integration tests from a spec or live endpoints         |

Branch convention: `ai-feature/<slug>`, prefixed with the blueprint module number where one
applies — `ai-feature/m11-3-event-ledger`.

## Getting started

```bash
git clone https://github.com/navigreen311/Burkham-Wickmont-Operations-Console.git
cd Burkham-Wickmont-Operations-Console

cp .env.example .env          # fill in DATABASE_URL and LEDGER_SIGNING_KEY
pnpm install
pnpm db:generate
pnpm db:deploy                # migrations, including the ledger append-only triggers
pnpm dev                      # API on http://127.0.0.1:4100
```

Generate a ledger signing key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

See the whole slice work end to end, with the API running:

```bash
node scripts/demo-walking-skeleton.mjs
```

## Commands

| Command                                | Purpose                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                             | Run the API                                              |
| `pnpm dev:worker`                      | Run the Workflow Engine worker (needs `WORKER_ACTOR_ID`) |
| `pnpm test`                            | All suites                                               |
| `pnpm test:invariants`                 | The invariant suite alone                                |
| `pnpm verify`                          | lint + typecheck + test                                  |
| `pnpm db:migrate`                      | Create and apply a migration                             |
| `pnpm db:studio`                       | Browse the database                                      |
| `pwsh -File scripts/setup.ps1 -Verify` | Verify toolchain, files, secret hygiene, remote          |

## Repository layout

```
apps/api            Express host. Wires the chain, serializes Outcome. No business logic.
packages/core       Types and invariants. No I/O, no dependencies.
packages/ledger     11.3 Event Ledger - append-only, hash-chained, signed
packages/identity   11.1 Identity & Access
packages/tenancy    11.2 Tenant / Organization Model
packages/clients    1.1  Client Lifecycle & CRM (compliance state)
packages/consent    1.5  Consent & Authorization Center
packages/firewall   6.2  Funding Ethics Firewall
packages/integration 11.5 Integration Layer - gated vendor adapters
packages/middleware  the fixed seven-step chain
packages/placement  5.3  Funding Recommendation Engine
packages/graph      1.2  Client Household / Entity Graph - entities, owners, guarantees, exposure
packages/regulatory 7.2  State-by-State Regulatory Engine - modules, counsel-review activation gate
packages/contracts  7.3  Contract & Disclosure Builder - templates, clauses, fee exhibit, generation
packages/billing    1.4  Pricing, Billing & Offer Management - ladder, credit chain, refund triggers
packages/sales      1.3  Sales Motion & Engagement Tracking - leads, attribution, conversion
packages/evidence   7.1  Compliance Evidence Vault - regulator-ready assembly with coverage
packages/comms      4.1  Communications Hub + 4.4 Preference Center - the send gate and the log
packages/lenders    5.2  Lender Intelligence Database - catalogue, rules, eligibility, suitability
packages/governance 5.4  Capital Product Governance Board - approval, cadence, complaints, blacklist
tests/invariants    one test per hard invariant
docs/decisions      ADRs
docs/plans          feature plans, editable before implementation
```

## Local environment

Available on the development machine and expected by the stack:

- Node 24 · pnpm 9 · npm 11
- PostgreSQL 17 (native service `postgresql-x64-17`)
- Memurai (Redis-compatible, native service `Memurai`) — for the Workflow Engine's queue
- GitHub CLI 2.92, authenticated as `navigreen311`

## Security notice

This system handles the most sensitive data class in the Green Companies portfolio: SSNs, EINs,
full bank statements via Plaid, tax returns, government IDs, and personal and business credit
reports for clients across all 50 states.

- Never commit `.env`, credentials, or API keys.
- Never log PII. SSN, EIN, bank account numbers, and tax IDs are field-level encrypted.
- Vendor integrations require Argus security review and a signed DPA before activation.
- No state comes online without documented counsel review of its Regulatory Engine module.

## License

Private and proprietary. All rights reserved.
