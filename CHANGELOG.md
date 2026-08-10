# Changelog

All notable changes to the Burkham Wickmont Operations Console are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed — PII value-shape detector destroyed identifiers ending in digits (`ai-feature/fix-listener-intermittent`)

Diagnosis and fix for the intermittent flagged during 1.2. **It was not a test defect and not in
the workflow listener** — it was silent data loss in the Event Ledger.

- **Root cause.** `redactPii`'s value-shape rule was `/\b\d{8,17}\b/`. `\b` sits between a word and
  a non-word character, and `-` and `_` are non-word characters — so it matched the digit run
  _inside_ an identifier. Tenant slugs end in eight hex characters, which are all digits **2.34%**
  of the time, so `playbookKey: 'escalate-test-wf-listen-12345678'` was replaced wholesale with
  `[REDACTED]` on its way into an append-only store. Every payload field carrying a slug —
  `playbookKey`, `scope`, `applicationRef` — was affected at the same rate.
- **The listener was innocent.** The test matched a fired trigger by `playbookKey` and found
  `[REDACTED]`, roughly one run in forty. Reverting the regex reproduces the CI failure verbatim,
  including its message.
- **Second occurrence of the same defect**, previously fixed for full UUIDs by stripping them
  before shape-matching. That does nothing for a truncated UUID, or for any identifier that merely
  ends in digits — the first fix listed a shape where it should have fixed the boundary. Now
  `/(?<![A-Za-z0-9_-])\d{8,17}(?![A-Za-z0-9_-])/`: `Account 123456789012 was debited` still
  redacts, `order-123456789012` does not.
- **Accepted false negative, stated rather than buried:** an account number glued to a text prefix
  (`acct-123456789012`) under a non-PII field name is no longer caught by shape. The field-name
  list and `assertNoPii` are the primary defences and are unchanged; value-shape matching is a
  backstop, and a backstop that destroys 2.3% of identifiers costs more than it saves.
- **The module doc now records that a false positive is not cheap.** The same redactor runs on
  Ledger payloads, so it destroys an identifier in the same uneditable store — both directions are
  data loss, and only one announces itself.
- **Regression guards are deterministic, not probabilistic.** A fixed all-digit playbook key in
  `workflow-listener.test.ts` fails every time rather than 2.3% of the time, plus a generative test
  over 10,000 generated slugs that asserts the failing case is actually exercised.

> **Not repairable:** any Ledger row already written with `[REDACTED]` in place of an identifier
> stays that way. The store is append-only by design, so this fix stops the loss rather than
> reversing it.

**Tests:** 434 pass (4 new). Mutation-verified — restoring the old regex fails all three new guards.

### Added — Client Household / Entity Graph (`ai-feature/m1-2-entity-graph`)

**1.2 Client Household / Entity Graph**, which closes the last `not_built` in the funding path. See
[docs/m1-2-entity-graph.md](docs/m1-2-entity-graph.md) and
[ADR-0008](docs/decisions/ADR-0008-relationship-detection-produces-questions.md).

- **The question it answers**: a client guarantees a facility for their operating company, another
  for the real-estate entity that leases them premises, another for a partner's DBA. Each was
  reasonable alone; nobody holds the total, including the client. The first lender to ask gets a
  wrong answer.
- **Detection produces questions, not conclusions.** Every signal has an innocent explanation that
  is usually the true one, so a `RelationshipFinding` carries the question to put to the client and
  has no field in which a verdict could be recorded. The value survives the reframing intact — an
  underwriter runs the same checks, so the client should hear the question from us first. The
  common-control threshold is 25%, the FinCEN line a lender's own KYC uses.
- **The risk rating is categorical with no number at all**, deliberately not following 5.1's
  precedent: a health score summarises measured quantities, a graph rating summarises structural
  facts, and a number there would be arithmetic performed on judgements. The band is the **worst**
  component, not an average — averaging is what lets a cross-guarantee ring be diluted into
  "elevated" by three tidy components.
- **Exposure distinguishes a guarantee of an entity from a guarantee of a facility.** The first
  picks up debt signed after it was given; the second does not. Collapsing them overstates or hides,
  and both produce a confident number. Limits cap the guarantor's contribution per guarantee;
  obligations with no recorded amount are counted, not zeroed.
- **`EDGE_RULES` recovers the type safety a single edge table gives up.** A reversed `ownership`
  edge produces numbers rather than errors, so every kind's legal endpoints are declared as data a
  test can iterate.
- **Cycles are the thing being looked for**, not a hazard to guard against: rings are deduplicated
  by rotation so one ring is not reported three times.
- **The derived profile closes 5.3.** Tenure is derived from the formation date every time and
  counted the way a lender counts. What the graph cannot know stays `null` — a credit score needs an
  ungated bureau vendor — which is exactly what 5.2's three-valued eligibility was built for.
- **SSN and EIN never enter a `Graph` value.** Envelope-encrypted at rest, display last-4 only, so
  no traversal, finding or ledger payload can carry one. `revealSsn`/`revealEin` require a stated
  purpose and write an access event.
- **`client_stated` is a new provenance tag in core.** A self-reported revenue is neither a vendor
  feed nor our assumption, and storing it as either is Decision D's failure in different clothing.
  `fromProvenance` in `@bwc/lenders` throws on it — a lender rule cannot be client-stated.

**There is no `not_built` left in the funding path.** The assertion in `placement-gate.test.ts` has
moved twice, each time because a module named in a refusal got built; it is now `no_data`.
`notBuilt` is no longer imported by `@bwc/placement`.

**Corrected:** an entity with debt and no recorded owner produced no finding, though "who owns this
company?" is a lender's first question. Surfaced by a test that expected findings and got none.

**Fixed (pre-existing):** `vault-encryption.test.ts` tampered with an auth tag by overwriting its
first two hex characters with `00`, which is a no-op roughly once in 256 runs. It failed once during
a full-suite run on unrelated work — the only way a 0.4% flake ever surfaces. The tampered value is
now derived from the real one.

**Tests:** 430 pass (57 new). The guarantee-cap arithmetic and the SSN payload discipline were
mutation-verified; the SSN leak was caught twice, once by the payload assertion and once by the
Ledger's own redactor.

### Added — Lender Intelligence & Capital Product Governance (`ai-feature/m5-lender-intelligence-and-governance`)

**5.2 Lender Intelligence Database**, **5.4 Capital Product Governance Board**, and the
**completion of 5.3 Funding Recommendation Engine**. See
[docs/m5-lender-intelligence-and-governance.md](docs/m5-lender-intelligence-and-governance.md) and
[ADR-0007](docs/decisions/ADR-0007-governance-status-lives-outside-the-provider-record.md).

- **5.2 pulled forward from V1.5.** The blueprint defers 5.2 while putting 5.3 and 5.4 in V1 — two
  V1 modules whose stated function is reading from and writing to it. What Decision D actually
  defers is credit-union _research scope_, not the existence of a catalogue, so the database comes
  forward and **the restriction is enforced in code**.
- **Decision D is enforced at approval, not registration.** Recording what we know about a deferred
  credit union is the V1.5 research work; deciding agents may place clients there is a different
  act, and it is the one V1 restricts. `approve()` refuses a non–Navy Federal credit union by name,
  citing the decision.
- **Governance status lives in its own schema.** A provider the board has never seen has no
  governance row, and absence resolves to _not approved_ — the Lender Intelligence Database has no
  field with which to say otherwise.
- **Standing is derived at read time, never stored.** A nightly staleness job that stops leaves
  every stale provider reading as approved with no signal at all; deriving it means a provider
  reviewed 91 days ago is overdue on every machine, including one switched off for a month. State
  restrictions are pulled by the Regulatory Engine for the same reason — a push can lag.
- **Provenance on every rule, structurally.** `recordRule` takes a `Provenance` value, not loose
  columns, and stores it as queryable columns so _"what are we telling clients that nobody
  verified?"_ is one query. Rules **supersede rather than overwrite**, in one transaction, and the
  superseded version keeps its own provenance — it was an assumption at the time.
- **Eligibility has three verdicts.** `unknown` is its own answer naming the missing field:
  collapsing it into `ineligible` hides every good provider until a file is complete, and into
  `eligible` fabricates a recommendation. Ineligible outranks unknown. A null threshold is not a
  threshold of zero.
- **Suitability is separate from eligibility**, because the products easiest to qualify for are
  frequently the worst fit. Poor fits are surfaced as **cautions, never filtered out**.
- **Approval rate returns `null` below 10 decided applications.** Withdrawals are excluded from the
  denominator; profile cohorts are coarse so no client becomes a cohort of one.
- **Complaints are severity-weighted and flag rather than suspend.** One severe complaint reaches
  the threshold and moves the provider to `under_review`; auto-suspension would let one complaint
  remove a provider without a human weighing it.
- **5.3 now recommends.** Its `not_built` named 5.2, which had become a false statement about
  itself. Rejected alternatives carry the rule that produced them; options below the presentation
  limit are still counted as considered. `placement.recommended` carries offering ids and never
  client attributes.
- **The three empty states are now all reachable and distinct**: `not_built` (1.2 Entity Graph
  holds no underwriting profile), `no_data` for an empty catalogue, `no_data` with a per-stage tally
  when nothing survives.

**Corrected:** `no_data` said "none survived" when an incomplete file was the cause, reading as
_there is nothing for this client_ when providers were one recorded field away. It now names the
fields to record.

**Tests:** 373 pass (86 new). Decision D and the derived review cadence were mutation-verified —
disabling either produces 9 failures.

### Added — Capital Stack & Cost of Capital (`ai-feature/m5-capital-stack-and-cost-of-capital`)

**5.1 Capital Stack & Monitoring** and **5.6 Cost of Capital Calculator** — the two modules that
answer what capital a client has and what it is actually costing them. (5.3 needs the Lender
Intelligence Database and 5.4 governs providers inside it; both belong with 5.2 in a later slice.)

- **The cost engine solves the real cash flows** rather than approximating. A "1.4 factor" sounds
  like 40%; repaid daily over six months it is an APR well north of 140%, because principal is
  repaid from day one. Closed-form approximations err in the direction that flatters exactly those
  products. **Bisection, not Newton–Raphson** — Newton needs a derivative that is easy to get
  subtly wrong and diverges on precisely the steep curves this module exists to expose.
- **Details that change the answer:** compounding annualization, 252 banking days for daily
  cadence, origination fees netted from proceeds rather than added to repayment, `factorRate` and
  `annualRate` separately named and mutually exclusive, blended cost weighted by outstanding
  balance, undrawn limits excluded, refinance compared on **total cost** with an explicit caveat
  when a lower APR carries a higher one.
- **An uncostable stack returns `null`, never `0`** — zero would read as "this stack is free".
- **The health score carries its components** and has no constructor that omits them: Decision E's
  lesson applied without contradicting blueprint 5.1's named score. Over-limit zeroes utilization
  outright; an uncosted stack scores 50 rather than 100, because an unknown must not read as good
  news.
- **Monitoring:** over-limit flagged not clamped; limitless positions excluded from the aggregate
  utilization denominator; PG exposure aggregated per owner and capped per limited guarantee; promo
  alerts fire on exact threshold days (90/60/30) rather than every day below them; payment calendar
  normalizes mixed cadences to a monthly equivalent. Scheduling stays with the Workflow Engine.
- 40 new tests (287 total), anchored on known answers rather than self-consistency.

### Fixed

- **The IRR solver's NPV tolerance was absolute where it had to be relative.** An absolute
  threshold is unreachable at double precision on flows of hundreds of thousands and far too loose
  on a small advance; it now scales to the initial flow. Surfaced by a test assertion that had the
  same flaw and failed at a relative error of 2e-10.
- **Under-repayment has a real negative IRR.** The solver documented and a test asserted that no
  rate existed; both were wrong. The negative rate is returned, because a negative effective APR is
  a data-quality signal and suppressing it would hide bad inputs behind an empty result.

### Added — Document Intelligence Pipeline (`ai-feature/m3-3-document-intelligence-pipeline`)

**3.3 Document Intelligence Pipeline. Completes Category 3.**

Every vendor in 3.3's eight-step flow is ungated (§11.4, §12.3), so the module is split along the
line the gates draw: ingestion is consent-gated seams reporting `not_built`, while normalization,
enrichment and correlation are pure functions over a shape we own — fully built and fully tested.

- **Normalized on our own shape**, not Plaid's. It is the only way to build this today, Decision
  A's V2 roadmap replaces Plaid for parsing, and bureau and bank data have to meet somewhere.
- **Consent is checked before the vendor gate.** If the client has not authorized the pull, that
  is the accurate reason — our vendor gate is a fact about us. Every attempt is recorded, so
  "tried and could not" stays distinguishable from "never tried".
- **Deterministic categorization with a stated basis per category**, not a model: a category feeds
  a funding recommendation, and "the classifier said so" is not a derivation anyone can audit.
  `uncategorized` share is reported rather than hidden.
- **Coverage travels with every claim.** Thin coverage downgrades severity rather than suppressing
  a finding.
- **Anomalies relative to the client**, not fixed thresholds — a large deposit is 3× that client's
  own median, because $80k is unremarkable for one client and the event of the year for another.
- **No finding contains a transaction description.** Descriptions carry counterparty names and
  findings reach the Ledger.
- **Correlation refuses rather than inventing agreement** — an absent side returns `no_data`
  naming which side, because an empty correlation result reads downstream as "checked, no
  disagreement".
- **Missing-document detection** over the Vault, one finding per missing document since each is
  independently actionable. `classifyByFilename` returns `null` rather than `other` when it cannot
  tell.
- 41 new tests (247 total). The analysis suite needs no database and no vendor.

### Fixed

- Tax-return filename classification never matched a real IRS form. `\b1120\b` fails on `1120S`,
  because the word boundary needs a non-word character after the `0` — and every real form carries
  a letter suffix.

### Added — Secure Document Vault (`ai-feature/m3-2-secure-document-vault`)

**3.2 Secure Document Vault.** Encrypted storage for the most sensitive data class in the
portfolio. Everything before this protected decisions, which can be corrected; this protects
documents, and a leaked tax return cannot be.

- **Envelope encryption, AES-256-GCM** (ADR-0006). A random DEK per document, wrapped by a KEK.
  GCM authenticates, so tampering fails loudly rather than decrypting to plausible garbage. KEK
  rotation re-wraps DEKs instead of re-encrypting every document. `KekProvider` is the seam for
  the HSM §6.2 wants.
- **The blob store handles ciphertext only.** "The store never receives plaintext" holds even if
  the store is wrong; "the store encrypts things" would not. Blob keys carry no filename, client
  name or document kind.
- **Two independent integrity checks** — the GCM tag catches tampering with the ciphertext, a
  sha256 of the plaintext catches a blob that decrypts perfectly but is the wrong document.
- **Least privilege by document class** — government IDs at level 3, tax returns and credit
  reports at 2, ordinary financial statements at 0.
- **Access logged before bytes are returned**, refusals included. If the log write fails, the
  caller gets nothing.
- **Watermarking on the bytes** — `pdf-lib` stamps viewer identity, timestamp and document id
  into every exported PDF. Non-PDF exports report `watermarked: false` rather than implying a stamp.
- **Legal hold** blocks export and deletion while still permitting viewing; a human actor is
  required to set or release it.
- **Field-level encryption** for SSN / EIN / account / tax ID, non-deterministic so read access
  cannot become an equality oracle.
- 37 new tests (203 total). The encryption-at-rest test reads the actual file from disk; the
  watermark test inflates content streams and decodes hex text operands.

### Fixed

- **PII redaction was silently destroying UUIDs in the Event Ledger.** The value-shape detector
  matched "8-17 consecutive digits", which also matches a UUID whose first group happens to be all
  digits - roughly 2.3% of them. Instance, document and task ids travel in ledger payloads, so
  about one in forty was replaced with `[REDACTED]` in an append-only store that cannot be
  corrected, and code reading the id back got that string. Surfaced only as an unrelated Prisma
  error ("invalid character ... found `[`") in a workflow test. Identifiers are now stripped
  before shape-matching, so a real SSN beside a UUID is still caught.

**Honest gaps, not silent ones.** No virus scanner exists, so documents land `pending` and are
unreadable until scanned — defaulting to `clean` would assert a check that never ran. Retention
rules come from 7.2/7.5, neither built, so deletion without a resolved schedule returns
`not_built`: over-retention is a liability, but destroying a document a regulator was entitled to
see is irreversible.

### Added — Deliverables, approval pipeline and the Compliance Scanner (`ai-feature/m3-deliverables-and-compliance-scanner`)

Category 3 slice A. **3.1** Document & Deliverable Management, **3.4** Deliverable Approval
Workflow, **4.2** Communication Compliance Scanner, **7.4** Marketing Claim Library. The first
slice that produces something a client receives.

4.2 and 7.4 are included because blueprint 3.4 puts the Scanner in the middle of the approval
pipeline. Without them the pipeline could never complete, on top of middleware step 5 already
refusing every client-facing action — one honest blockage is discipline, two stacked is a system
that cannot be demonstrated.

- **The content model is the artifact** (ADR-0005). A deliverable is a structured document,
  versioned and hashed over canonical JSON, anchored in the Ledger; the PDF is a rendering. Hashing
  bytes would let a font substitution change the evidence while every word stayed the same.
- **Provenance cannot be omitted** — `KeyFigure.value` is `Sourced<T>`, so a figure cannot be
  constructed without it. Unresearched defaults render as `[Unverified assumption]` plus a
  document-level notice (Decision D).
- **Compliance state has no numeric field**, so no renderer can print a score (Decision E).
- **Approval ordering is enforced by state**, not call order: `deliver()` requires `approved`,
  reachable only from `scanned`, reachable only from `qa_checked`. Approval requires a human actor.
- **The Scanner blocks, and scans the content model** — so banned language cannot enter during
  rendering, and a phrase interpolated from client data is checked as thoroughly as the template.
  Word-boundary matching: "guaranteed approval" blocks, "no guarantee of approval" does not.
  An empty claim library **refuses rather than reporting clean**.
- **Claim library entries carry a rationale and are deprecated, never deleted.** Jurisdiction uses
  a `*` sentinel rather than NULL, because `NULL != NULL` in Postgres would have let the unique
  constraint accept two global entries for the same phrase.
- Two real templates (Capital Command Brief, Funding Suitability Memo), both carrying the
  not-a-lender and no-guarantee disclosures.
- ADR-0005, `docs/m3-deliverables-and-compliance-scanner.md`, plan doc.
- 57 new tests (165 total).

### Fixed

- **Any stored deliverable would have failed to render.** `Provenance` carried `Date` objects, but
  deliverable content is stored as JSON — so timestamps came back as strings and
  `describeProvenance` threw on `.toISOString()`. Invisible to unit tests, which never persist.
  Provenance timestamps are now `IsoTimestamp` (ISO strings): a type that crosses a JSON boundary
  should be JSON-native. Guarded by a test that re-reads a deliverable from the database before
  rendering it.

### Added — Workflow Engine scheduler, listener and worker (`ai-feature/m2-2-workflow-scheduler-listener`)

Completes module 2.2. All seven components of Specification v2 §5.3 now exist, and the Engine runs
on its own rather than only when a test calls it.

- **Scheduler** — cron-driven recurring workflows with a stored IANA timezone. Claiming is a
  conditional update on `nextRunAt`, so concurrent workers produce exactly one winner. Catch-up
  fires **once** after an outage rather than once per missed window, recording the gap as
  `workflow.schedule_late`. A schedule that cannot be evaluated, or whose playbook is missing, is
  disabled and logged rather than retried forever.
- **Event listener** — Ledger-triggered workflow initiation and event-wait resolution. Triggers
  carry optional declarative conditions (the playbook predicate language). `seekToLatest()` skips
  existing history so registering a trigger does not fire it retroactively.
- **Worker runtime** (`packages/workflow/src/worker.ts`, `apps/worker`) — scheduler → listener →
  engine on an interval, non-overlapping passes, graceful shutdown, and a loop that survives a
  throwing pass. `pnpm dev:worker` / `pnpm worker`.
- ADR-0004 — `cron-parser` over a hand-rolled evaluator, with the DST case verified before
  adopting; timezone as a stored field rather than a silent UTC default.
- `docs/m2-2-scheduler-listener.md`, `docs/plans/m2-2-scheduler-listener.md`.
- 24 new tests (108 total).

**Exactly-once is enforced by a unique constraint on `(triggerId, ledgerEventId)`, not by the
cursor.** A crash between starting an instance and advancing the cursor replays the event, the
insert conflicts, and nothing starts twice — a duplicated workflow here means duplicated client
outreach, and both instances would look legitimate.

### Fixed

- **Concurrent Event Ledger appends to the same tenant threw instead of ordering.** `append` ran
  under `Serializable` with a monotonic per-tenant `seq`, so two appends racing — two workers, or
  a worker and the API — aborted one with a serialization failure. Surfaced by the concurrent
  scheduler test on CI's faster machine while passing locally.

  The fix is a per-tenant transaction-scoped advisory lock **plus `ReadCommitted`**. An advisory
  lock alone was not enough: under `Serializable` the snapshot is fixed at transaction start, so
  the waiter acquired the lock and still read a tail from before the other commit. A lock
  serializes entry; it cannot refresh a snapshot. Guarded by a test that fires 12 concurrent
  appends and asserts a contiguous sequence and an intact chain.

- **Event-waits could never advance.** The listener set a resolved wait back to `pending`, but the
  engine's `wait` handler re-parks any event-wait it claims — so the task ping-ponged between
  `pending` and `waiting` forever and the workflow never progressed, with nothing failing.
  Resolution now goes through `resolveEventWait()` in the engine, which owns graph advancement.
- `@bwc/db` exported `Prisma` type-only, so `Prisma.DbNull` — a runtime sentinel needed to write a
  nullable JSON column — was unavailable to consumers.

### Added — Workflow Engine core (`ai-feature/m2-2-workflow-engine-core`)

- **2.2 Workflow Engine** — playbooks as versioned node graphs, instance lifecycle, and the worker
  tick. Decision C: the Console is the runner for all workflows.
  - Durable Postgres task queue with `FOR UPDATE SKIP LOCKED`, claim leases and reclaim-on-expiry
    for crash recovery (ADR-0003).
  - Retry with exponential backoff capped at 24h, then dead-letter. Every failure, retry and
    dead-letter writes a ledger event — §10.5 requires zero silent workflow failures.
  - Wait states: a row with a future `runAt`, so 90 days is the same code path as 90 seconds.
  - Decision points via a declarative predicate language — no `eval`, three reachable roots,
    prototype keys rejected, ordered comparison restricted to numbers and dates.
  - SLA breach escalation, exactly once per task, notifying Compliance & Evidence.
  - Playbooks validated at publish (dangling `next`, unreachable nodes, no terminal), and versions
    pinned at instance start so publishing a new version does not re-route work in flight.
- **11.4 Notification & Task Queue** — the assignment record the Engine dispatches through.
- ADR-0003 — Postgres-backed queue over BullMQ/Redis: one durability domain, so task state,
  instance state and the ledger commit together.
- `docs/m2-2-workflow-engine.md`, `docs/plans/m2-2-workflow-engine.md`.
- 31 new tests (84 total).

### Fixed

- **Raw SQL timestamp comparisons shifted by the local UTC offset.** Prisma maps `DateTime` to a
  naive `timestamp(3)` holding UTC, but a JS `Date` bound into `$queryRaw` is sent as
  _timestamptz_, so Postgres converted through the session timezone. The task-queue claim query
  returned the wrong rows with no error — and would have looked correct on a UTC machine.
  Timestamps now cross into raw SQL as ISO strings cast to `timestamp`; guarded by
  `tests/invariants/raw-sql-timestamps.test.ts`, which asserts raw SQL and Prisma agree.
- **`start()` ignored the injected clock**, stamping the first task's `runAt` and `slaDueAt` from
  wall-clock time while every other engine function took `now`. Instances started under a test
  clock got SLA deadlines already breached.

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
