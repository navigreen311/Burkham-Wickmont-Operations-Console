# Changelog

All notable changes to the Burkham Wickmont Operations Console are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Walking Skeleton on the Spine (`ai-feature/walking-skeleton-spine`)

- **pnpm + Turborepo monorepo**, TypeScript end-to-end. Eleven workspace packages named for the
  blueprint modules they implement, plus `apps/api`.
- **11.3 Event Ledger** — append-only, hash-chained, HMAC-signed, with `verifyIntegrity` that
  reports how many entries it checked. UPDATE, DELETE and TRUNCATE are rejected by database
  triggers, not by repository convention.
- **11.1 Identity & Access** — actors, Authority Levels 0–3, and the Level 4 prohibited-action
  perimeter that no actor can cross at any level.
- **11.2 Tenant / Organization Model** — the isolation check, called once by the chain.
- **Middleware chain** — the seven steps of Specification v2 §5.5 in fixed order, not
  per-route configurable, returning a step trace on every response including refusals.
- **1.1 Client Lifecycle & CRM** — client record and compliance categorical state; findings
  travel with each transition into the ledger event.
- **1.5 Consent & Authorization Center** — per-application, per-pull and per-connection consent;
  an unscoped consent is refused rather than stored.
- **6.2 Funding Ethics Firewall** — trigger, human-only clear, and the placement gate that
  couples Firewall state to compliance state per Decision E.
- **11.5 Integration Layer** — gated adapters. All V1 vendors report `not_built` with their
  outstanding preconditions named; none fabricate data.
- **5.3 Funding Recommendation Engine** — the refusal path. The recommendation itself awaits the
  Lender Intelligence Database (5.2, V1.5).
- **`Outcome<T>`** — five variants with no empty-success case, mapped to distinct status codes
  (200 / 409 / 501 / 404 / 500). See ADR-0002.
- **53 tests** — an invariant suite with one test per hard invariant, plus middleware-order
  integration tests. Mutation-checked: widening the placement-eligible states turns it red.
- **CI** — four jobs: lint & types, tests, a separately named invariants check, and secret
  hygiene (tracked secret-shaped files, SSN-shaped literals in source).
- `scripts/demo-walking-skeleton.mjs` — one runnable command that drives the whole path.
- ADR-0001 (modular monolith with a Postgres schema per module) and ADR-0002 (`Outcome<T>`).
- `docs/walking-skeleton-spine.md`, `docs/plans/walking-skeleton-spine.md`.

### Fixed

- Placement requests that were refused after the middleware chain (missing per-application
  authorization, or the lender catalogue not existing) left `placement.requested` in the Ledger
  with no terminal event. The Compliance Evidence Vault generates regulator-ready files from that
  history, and a request with no recorded outcome cannot be explained after the fact. Found by
  running the demo; now covered by a test.

### Added — repository setup

- Repository initialized for AI-assisted development.
- `CLAUDE.md` — global AI development context: persona, interaction mode, version control
  conventions, the nine design principles, the five locked decisions (A–E), hard invariants,
  the fixed middleware order, and the six-step delivery recipe.
- `.claude/commands/` — five reusable commands: `impl-feature`, `test-suite`, `deploy-prod`,
  `code-review`, `api-test`, each adapted to the Console's compliance and provenance discipline.
- `docs/reference/blueprint-v2.md` — canonical module-by-module specification (58 modules).
- `docs/reference/specifications-v2.md` — canonical cross-cutting architecture specification.
- `scripts/setup.ps1` — idempotent repository setup and verification script.
- `README.md` — scope, architectural position, locked decisions, workflow, security notice.

### Notes

- No application code scaffolded. Stack selection pending.
