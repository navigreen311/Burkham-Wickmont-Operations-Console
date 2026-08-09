# Burkham Wickmont Operations Console — Blueprint v2

**Document version:** v2
**Supersedes:** Blueprint v1 (2026-08-08)
**Status:** Working blueprint, revised post CapitalForge audit and five cross-platform decisions
**Parent documents:** Burkham Wickmont Company Specifications v2, CapitalForge Specification (commit 45b2513)
**Scope:** Module-by-module specification of the Burkham Wickmont Operations Console with dependencies, cross-Forge orchestration patterns, data flow patterns, and V1 / V1.5 / V2 phasing.

---

## Preface — what changed in v2

Five cross-platform decisions locked since v1 materially change several module specifications:

- **Decision A (Statement parsing):** Plaid integration (Link + Assets) is V1's statement data source. Console builds native parsing capability post-V1.
- **Decision B (Bureau data source):** B2B aggregator API (Nav for Partners, Experian Business API, or D&B Direct+) plus separate personal credit provider (Array or equivalent). Burkham Wickmont holds vendor relationships; client authorizes per-pull.
- **Decision C (Workflow execution):** Console's Workflow Engine (module 2.2) is the runner for all workflows. CapitalForge's workflow store is legacy artifact.
- **Decision D (Credit union velocity rules):** V1 CU placement restricted to Navy Federal only. Portfolio-wide provenance discipline applies to all lender recommendations.
- **Decision E (Compliance score meaning):** Replace numeric score with 4-category categorical (Pass / Pass with Findings / Needs Review / Fail) driving workflow.

Additional context from CapitalForge audit at commit 45b2513: CapitalForge ships JSON-only statement ingest with no PDF/CSV/OFX parser, no bureau pull, no workflow execution, ten endpoints that refuse explicitly (501). The Console must design around these limits, not assume them away.

The v1 module topology (11 categories, ~58 modules) survives largely intact. What changes is what several modules have to do, how they integrate, and what infrastructure they depend on.

---

## Executive summary

The Burkham Wickmont Operations Console is the dedicated operating environment for the Burkham Wickmont Village. Approximately 58 modules across 11 functional categories. Built on a technical foundation of an immutable Event Ledger, versioned module APIs, middleware-enforced Authority Levels, strict multi-tenant data isolation, a first-class state-by-state Regulatory Engine, and a Funding Ethics Firewall with precedence over placement workflows.

The Console is architecturally distinct from CapitalForge. CapitalForge is a horizontal Forge platform shared across all five Green Companies Villages; the Console is Burkham Wickmont's dedicated workspace. The Console calls CapitalForge and other Forge platforms as services rather than embedding their functionality.

V1 build estimated at 150–180 days (revised upward from 120–150 in v1). The revision reflects: (a) Workflow Engine as load-bearing infrastructure with full scheduler/runner requirements, (b) Plaid integration as first-class V1 capability, (c) bureau data integration with per-pull authorization workflow, (d) provenance discipline throughout Recommendation Engine and Deliverable output, and (e) categorical compliance state replacing numeric score with workflow implications.

---

## 1. Architectural principles (revised)

Nine principles now govern every module design decision, incorporating the seven architectural standards inherited from the CapitalForge audit. When principles conflict, earlier wins.

### 1.1 Compliance shape first, dollars second

No module design, feature, or workflow survives if it recharacterizes Burkham Wickmont as a lender, advisor, or credit repair organization. Every architectural decision passes a Seek Capital test.

### 1.2 Event Ledger as system of record

Every state change generates an immutable event. Modules query the Ledger for state rather than each other. Cryptographically signed entries; append-only; canonical source across the platform.

### 1.3 Versioned module APIs

Semver semantics. Major version for breaking changes with deprecation window of at least one major version. Module compatibility matrix maintained by CapitalForge Ops.

### 1.4 Authority Levels as middleware

Every agent action passes through single middleware layer that enforces Level 0–4 scope. Agent prompts declare their operating level; middleware checks each action; violations are blocked before execution and logged.

### 1.5 Multi-tenant isolation is strict

Burkham Wickmont client data lives in the Burkham Wickmont tenant. Aggregation to Gardner strips PII. Cross-portfolio handoffs to Collingswood require explicit per-handoff consent. No back doors.

### 1.6 State compliance is a workflow gate

The Regulatory Engine is not a post-hoc check. No client-facing action fires without state compliance checks having passed. State activation requires documented counsel review.

### 1.7 Firewall precedence

The Funding Ethics Firewall and Do Not Fund Governance module have precedence over all placement-related modules. When either fires, downstream placement workflows freeze. Only Compliance & Evidence with human approval can unfreeze.

### 1.8 Provenance on output (portfolio-wide)

Every derived figure ships how it was derived. Applies not just to lender recommendations but to bureau data sources, workflow inputs, compliance categorizations, and deliverable content. Inherited from CapitalForge audit Section 5.

### 1.9 Honest empty states and honest refusals

Three states distinguishable at a glance: `not_built`, `no_data`, `failed`. Endpoints that cannot fulfill their contract refuse with explicit reason (following CapitalForge's 501 pattern). No silent no-ops. Inherited from CapitalForge audit Section 5 discipline.

---

## 2. Module category overview

The Console's 58 modules organized into 11 categories.

| # | Category | Modules | V1 build | V1.5 add | V2 add |
|---|---|---|---|---|---|
| 1 | Client & Engagement | 5 | 5 | — | — |
| 2 | Operations | 6 | 6 | — | — |
| 3 | Document & Deliverable Management | 4 | 4 | — | — |
| 4 | Communications Hub | 5 | 5 | — | — |
| 5 | Capital Operations & Intelligence | 6 | 4 | 2 | — |
| 6 | Risk & Defense | 5 | 3 | 2 | — |
| 7 | Compliance & Governance | 5 | 4 | 1 | — |
| 8 | Partner & Referrer Portal | 4 | 2 | 2 | — |
| 9 | KPI Dashboards & Reporting | 4 | 2 | 2 | — |
| 10 | Inter-Venture Commerce | 2 | 1 | 1 | — |
| 11 | Technical Platform | 12 | 10 | 2 | — |
| | **Total** | **58** | **46** | **12** | **0** |

V2 completes full national footprint (Regulatory Engine coverage of remaining states), ChamberForge bridge integration, native statement parsing in Console (Decision A future roadmap), and potential ConsoleForge framework extraction.

---

## 3. Module specifications

### Category 1 — Client & Engagement (5 modules)

#### 1.1 Client Lifecycle & CRM

**Function:** System of record for every client across every offer tier and phase.

**Data model owned:** Client entities, contact records, engagement history, offer tier, phase status, application freeze status, Client Acceptance Score, Risk Rating (Low / Moderate / High / Distressed / Do Not Fund), Client Classification (8 types), vertical playbook assignment, per-engagement status, compliance categorical state (Pass / Pass with Findings / Needs Review / Fail — per Decision E).

**Key features:** Intake forms wired to Client Acceptance Score → routing to Accept / Build First / Partner Refer / Decline / Escalate; full relationship timeline; document trail; communication log; audit log to Event Ledger.

**Change from v1:** Now stores compliance categorical state as a first-class field (was numeric score in v1). Field values drive workflow implications per Decision E — Pass allows Village autonomous action within Authority Levels; Needs Review routes to Human Approval Console with placement frozen; Fail integrates with Do Not Fund Governance.

**Village ownership:** Concierge Desk (primary), Capital Readiness for Phase 0 intake.

**Dependencies:** Event Ledger, Identity & Access, Notification & Task Queue.

#### 1.2 Client Household / Entity Graph

**Function:** Graph view of client's entities, guarantors, and relationships.

**Data model owned:** Owner nodes, spouse / co-owner nodes, guarantor relationships, LLC / DBA nodes, holding company nodes, operating company nodes, related real estate entity nodes, existing debt edges, cross-guarantee edges, intercompany transfer edges.

**Key features:** Visual graph interface; expand/collapse subgraphs; automatic PG exposure calculation; graph-level Risk Rating aggregation; hidden-relationship detection.

**Village ownership:** Capital Readiness (construction), all departments (maintenance).

**Dependencies:** Client Lifecycle & CRM, Document Intelligence Pipeline (for entity extraction from Plaid data and uploaded docs).

#### 1.3 Sales Motion & Engagement Tracking

**Function:** Pipeline management from lead through conversion through expansion.

**Data model owned:** Lead records with source attribution, qualification status, Readiness Blueprint status, review call scheduling, conversion event logging, expansion trigger status, renewal / save motion status.

**Key features:** Founder-led-call scheduling; conversion event logging with structured outcome data; expansion-path trigger firing based on time-since-Blueprint and readiness-score deltas; integration with Concierge Desk for human handoffs; automatic escalation on 45-day inactivity.

**Village ownership:** Concierge Desk (primary), Capital Readiness for Blueprint Review Calls, Channel Partnerships for referrer attribution.

**Dependencies:** Client Lifecycle & CRM, Communications Hub, Notification & Task Queue.

#### 1.4 Pricing, Billing & Offer Management

**Function:** All client-facing economic operations.

**Data model owned:** Offer definitions (5-offer ladder), tier configurations, retainer billing records, success fee triggers, credit / upgrade logic, refund records, annual prepay accounting, engagement minimum tracking, all-in fee exhibit generation, per-application authorization workflow.

**Key features:** Auto-generation of all-in fee exhibit per engagement; per-application written authorization workflow before Level 3 submissions; success fee disclosure box on every funding recommendation; refund logic driven by objective triggers (60-day approved-but-unfunded, engagement quality failure); credit chain tracking across the offer ladder; **success fees on cards computed from CapitalForge's `approvedCreditLimit` field, never `creditLimit`** (Seek Capital lesson).

**Village ownership:** Concierge Desk, Compliance & Evidence for authorization workflow.

**Dependencies:** Client Lifecycle & CRM, Consent & Authorization Center, Event Ledger, Contract & Disclosure Builder, CapitalForge (for application data).

#### 1.5 Consent & Authorization Center

**Function:** Legal permission layer for all Village activity.

**Data model owned:** Credit pull authorizations (personal + business bureau — per Decision B), document sharing consents, application submission consents (per-application, not blanket), Plaid connection authorizations (per Decision A), partner referral consents, data processing consents, SMS / email / call consents, e-signature logs, revoked permissions, expiring authorizations, cross-portfolio handoff consents (Collingswood Founder Personal Layer).

**Change from v1:** Now owns per-pull authorization workflow for bureau data (Decision B) and Plaid connection authorization (Decision A). These are FCRA-adjacent and Gramm-Leach-Bliley relevant respectively; per-event authorization runs through this module.

**Key features:** Per-application authorization workflow; per-bureau-pull authorization workflow; Plaid connection authorization with explicit institution list; expiration tracking with re-consent prompts; revocation propagation (dependent workflows freeze on revocation); e-signature audit trail; jurisdiction-aware consent language.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Client Lifecycle & CRM, Regulatory Engine, Event Ledger.

---

### Category 2 — Operations (6 modules)

#### 2.1 Village Agent Orchestration & Authority Levels

**Function:** Control plane for the Burkham Wickmont Village.

**Data model owned:** Agent definitions, department memberships, current Authority Level per agent, active task assignments, agent performance metrics, incident logs.

**Key features:** Configuration for all 10 Village departments; middleware-enforced Authority Levels 0–4 (every agent action passes through the check); human approval queue integration; Agent QA random file audits, hallucination checks, compliance phrase scanner, data mismatch detector, feedback loop; incident postmortems.

**Village ownership:** CapitalForge Ops (technical), Compliance & Evidence (audit).

**Dependencies:** Identity & Access, Event Ledger, Human Approval Console.

#### 2.2 Workflow Engine

**Function:** The orchestration backbone for the 5-phase service delivery model. **Load-bearing infrastructure per Decision C.**

**Data model owned:** Playbook tree per phase (Phase 0 through Phase 5) with subtrees per vertical playbook and per client type; task states; decision points; human checkpoints; deliverable templates; per-workflow SLA targets; scheduled task registry; wait-state records; retry policy configurations.

**Change from v1:** The Workflow Engine is now specified as a real execution engine, not just a state machine. Per Decision C, the Console owns all workflow execution — CapitalForge's saved-but-never-executed workflow store is legacy and unused by the Console. The Engine requires:

- **Scheduler component** — cron-like capability for recurring workflows (monthly Capital Command Briefs, 60/90-day promo expiration alerts, quarterly reviews, staleness reviews on lender research)
- **Task queue** — reliable dispatch to Village Agent Orchestration
- **Wait-state manager** — workflows that sleep for weeks/months waiting for real-world events (promo period expiration, re-stack windows, retention triggers)
- **Retry and failure policy engine** — per-task retry logic with exponential backoff, dead-letter handling
- **Event listener** — triggers on Event Ledger emissions
- **Decision point evaluation** — the branching logic in playbooks
- **Escalation routing** — SLA breaches, human approval requests, failure paths

**Key features:** Routes tasks to right department based on client phase, vertical, and type; escalates to Human Approval Console at defined checkpoints; produces auditable artifacts at every step; supports Playbook Builder for adding/modifying flows; per-client workflow instance state persisted; recovery from failure at task boundaries.

**Village ownership:** Cross-department. Each phase's primary Village department owns its playbook subtree.

**Dependencies:** Playbook Builder, Event Ledger, Notification & Task Queue, all downstream modules for step execution.

**Build effort estimate:** Approximately 25–35% of V1 engineering effort. Largest single build item.

#### 2.3 Agent Workbench

**Function:** Dedicated work surface for Village agents.

**Data model owned:** Per-agent active task list, client context caches, allowed authority scope, required tool references, data source references, current phase/step context, risk flags, required output format, next checkpoint reference, human approval requirements, provenance metadata for input data (Plaid feed timestamp, bureau pull timestamp, lender rule source).

**Change from v1:** Now surfaces data provenance to agents at task time. When an agent recommends against a lender rule, the workbench shows whether that rule is `issuer_rule` (sourced) or `unresearched_default` (per Decision D portfolio-wide discipline). When an agent references bureau data, the workbench shows source and timestamp.

**Key features:** Presents each agent with only what it needs; prevents loose action outside assigned scope; enforces required output format; provenance metadata visible on every input.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Village Agent Orchestration, Identity & Access, Event Ledger.

#### 2.4 Human Approval Console

**Function:** First-class module for all human-approval workflows.

**Data model owned:** Pending application approvals, high-risk recommendation approvals, client file inconsistency approvals, red-flag language approvals, state compliance alert approvals, refund decisions, complaint escalations, partner misconduct alerts, Do Not Fund override requests, **Needs Review compliance state approvals (per Decision E)**.

**Change from v1:** Now owns the Needs Review compliance state workflow. Any client entering Needs Review has their placement workflows frozen and routes to this queue. Human reviewer resolves the underlying finding(s); state transitions back to Pass with Findings or forward to Fail depending on resolution.

**Key features:** Each approval item shows recommended action, supporting evidence, risk score, compliance notes, agent confidence, required disclosures; approve/reject/request-changes decision workflow; approver accountability logged; SLA timers per approval type; escalation to founder / senior compliance for stalled items.

**Village ownership:** Compliance & Evidence (staffing), all departments (department-specific approvals).

**Dependencies:** Village Agent Orchestration, Event Ledger, Notification & Task Queue.

#### 2.5 Playbook Builder

**Function:** Admin surface for creating and modifying workflows.

**Data model owned:** Playbook definitions (vertical, offer-tier, client-type, compliance, partner, escalation), document request flows, call scripts, email/SMS sequences.

**Change from v1:** Now the sole source of workflow definitions in the Console. Per Decision C, CapitalForge's workflow store is legacy and not read by the Console's Workflow Engine.

**Key features:** Non-technical admins can create playbook variants; version control on every playbook; publish workflow with staged rollout (draft → review → active); playbook change diff tracking; automatic notification to affected agents.

**Village ownership:** Founder / senior operators (admins), Compliance & Evidence (compliance playbooks).

**Dependencies:** Workflow Engine, Admin Configuration Center, Event Ledger.

#### 2.6 Agent QA & Evaluation Studio

**Function:** Continuous quality control for AI agent performance.

**Data model owned:** Prompt version control, output scoring per agent per task type, hallucination test suite, policy violation tests, compliance phrase tests, data mismatch tests, recommendation accuracy reviews, human correction tracking, agent performance metrics by department, audit sampling records, incident postmortems.

**Key features:** Random sampling of agent outputs for audit; automated test suite runs against every deployed prompt change; degradation detection; comparison view of agent-recommended vs human-corrected outputs; feedback loop for prompt improvements.

**Village ownership:** CapitalForge Ops (technical), Compliance & Evidence (compliance QA).

**Dependencies:** Village Agent Orchestration, Event Ledger, Data Warehouse.

---

### Category 3 — Document & Deliverable Management (4 modules)

#### 3.1 Document & Deliverable Management (Templates & Generation)

**Function:** Template library and PDF generation with Burkham Wickmont stationery.

**Data model owned:** Template library (15+ required templates); versioned deliverables per client; brand asset library; PDF generation pipeline.

**Change from v1:** Every deliverable that includes lender recommendations, bureau data, or compliance state now carries provenance metadata visibly. Per Decision D, unresearched defaults are labeled as such in client-facing outputs. Per Decision E, compliance state appears as category (Pass / Pass with Findings / Needs Review / Fail) with finding list, not as a number.

**Key features:** Every deliverable version-controlled and audit-logged; signed and dated; automatic brand consistency (Burkham Wickmont stationery, VideoEditForge Style Clone patterns); template inheritance; provenance surfacing.

**Village ownership:** Compliance & Evidence (template governance), all departments (phase-specific deliverables).

**Dependencies:** SelfPublisherForge (long-form deliverables), Deliverable Approval Workflow, Event Ledger.

#### 3.2 Secure Document Vault

**Function:** Encrypted storage for sensitive client documents.

**Data model owned:** Bank statements (Plaid-sourced JSON + optional PDF fallback per Decision A), tax returns, IDs, entity documents, credit reports (bureau-pulled), P&Ls, balance sheets, debt schedules, lender applications, signed authorizations, adverse-action notices.

**Change from v1:** Now stores Plaid-sourced JSON as the primary bank statement format alongside PDF originals when Plaid Assets is used for fallback. Bureau reports (personal + business) stored with pull timestamps and consent references.

**Key features:** At-rest and in-transit encryption; role-based access from Identity & Access; watermarking on view/export; download controls; access logs; document expiration; redaction tools; virus scanning on upload; retention rules per Regulatory Engine; legal hold with export lockout.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Identity & Access, Regulatory Engine, Legal Hold & Record Retention, Event Ledger.

#### 3.3 Document Intelligence Pipeline

**Function:** Structured intelligence layer over client data.

**Data model owned:** Document classifications, extracted field records, Plaid transaction data with categorization, bank statement transaction tags, revenue consistency analyses, NSF event records, debt payment records, large deposit flags, owner transfer detections, tax return vs bank statement mismatches, fraud / synthetic document risk flags, bureau data enrichment records.

**Change from v1:** Major expansion. Now the primary integration point for Plaid data (per Decision A) and bureau data (per Decision B). Pipeline flow:

1. Plaid Link connection captured via Consent & Authorization Center
2. Plaid returns 24 months of transaction history + balances + account metadata
3. Pipeline enriches with categorization, revenue reconciliation, anomaly detection
4. For clients using PDF fallback (per Decision A), Plaid Assets processes PDFs to same JSON structure
5. Bureau pulls (personal via Array; business via Nav for Partners or equivalent per Decision B) triggered per-client with per-pull consent
6. Pipeline correlates bureau data with Plaid data (does personal spending in bureau match Plaid outflows? does business revenue in bureau match Plaid deposits?)
7. Normalized output handed to CapitalForge's JSON-accepting statement endpoint
8. Fraud / synthetic document detection runs on any uploaded PDFs (CapitalForge → VisionAudioForge)

**Key features:** Automatic classification; missing document detection; field-level validation; bank statement transaction tagging; revenue reconciliation between multiple sources; fraud pattern detection; provenance preservation on every enriched fact (Plaid feed timestamp, bureau pull timestamp, OCR confidence for PDF fallback).

**Village ownership:** Capital Readiness (Phase 0 intake), Funding Strategy (application prep), Risk & Defense (fraud escalation).

**Dependencies:** Plaid (via Integration Layer), Nav for Partners or equivalent (via Integration Layer), Array or equivalent (via Integration Layer), CapitalForge → VisionAudioForge (for OCR primitives on PDF fallback), Secure Document Vault, Consent & Authorization Center, Event Ledger.

#### 3.4 Deliverable Approval Workflow

**Function:** Pre-delivery review pipeline that prevents noncompliant deliverables from reaching clients.

**Data model owned:** Agent draft records, QA check results, Compliance Scanner results, human review status, final PDF generation records, client delivery log.

**Key features:** Every deliverable passes: agent draft → QA check → Communication Compliance Scanner → human review (if required by risk or content type) → final PDF generation → client delivery log; SLA timers; automatic escalation.

**Village ownership:** Compliance & Evidence (final approval), authoring department (draft).

**Dependencies:** Document & Deliverable Management, Communication Compliance Scanner, Human Approval Console, Event Ledger.

---

### Category 4 — Communications Hub (5 modules)

#### 4.1 Communications Hub (Core)

**Function:** Multi-channel client communication orchestration.

**Data model owned:** Email / SMS templates, sequence definitions, per-client communication log, channel routing rules, timezone-aware delivery windows.

**Key features:** Onboarding sequences; status update templates; document chase workflows; approval notifications; post-funding check-in cadence; Concierge Desk routing rules per offer tier; full client comms log preserved for compliance audit.

**Village ownership:** Concierge Desk.

**Dependencies:** Client Lifecycle & CRM, Client Notification Preference Center, Communication Compliance Scanner, Event Ledger. Voice communications route through CapitalForge → VoiceForge.

#### 4.2 Communication Compliance Scanner

**Function:** Pre-delivery scanner that blocks noncompliant language.

**Data model owned:** Approved phrase library, banned phrase library, per-jurisdiction phrase rules, escalation triggers, scan history log.

**Key features:** Scans every outbound message before send; blocks banned language ("guaranteed approval," "no risk," "we can remove negative items," etc.); flags requires-disclaimer content; escalates novel language for Compliance Review Board review; feeds back into Marketing Claim Library.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Marketing Claim Library (via Regulatory Engine), Event Ledger, Human Approval Console.

#### 4.3 Call Recording, Summaries & Promise Tracking

**Function:** Voice-driven communication capture and analysis. Called through CapitalForge → VoiceForge.

**Data model owned:** Call recordings, AI-generated call summaries, extracted promises, follow-up tasks, compliance risk phrases detected on calls, client objections, buying signals, required disclosures mentioned, next-step confirmations.

**Key features:** Every founder-led and Concierge call recorded (with consent); AI summary generation; Promise Tracking flags when anyone says something like "we can probably get you $100K" and requires correction / disclosure workflow; buying signal detection for sales motion; disclosure completeness check.

**Village ownership:** Concierge Desk, Compliance & Evidence.

**Dependencies:** CapitalForge → VoiceForge, Client Notification Preference Center, Consent & Authorization Center.

#### 4.4 Client Notification Preference Center

**Function:** Client-side control over how they're contacted.

**Data model owned:** Email allowed, SMS allowed, voice allowed, timezone, preferred contact method, do-not-call status, partner communication permissions, urgent alert routing.

**Key features:** Client-facing preference management (via Client Portal); default preferences on onboarding; TCPA compliance for SMS / voice; do-not-call list synchronization; urgent alert override rules with escalation paths.

**Village ownership:** Concierge Desk.

**Dependencies:** Client Lifecycle & CRM, Consent & Authorization Center, Client Portal.

#### 4.5 Marketing Ops

**Function:** Campaign, content, and marketing asset workflow (net new module in v2).

**Data model owned:** Campaign records, content workflow states, asset library, founder approval queue for new claims, A/B test configurations within compliance constraints, channel attribution feeds to Sales Motion.

**Key features:** Governance layer over content produced via SelfPublisherForge / AnimaForge / VideoEditForge cascades; new marketing claims route through Compliance Review Board before Marketing Claim Library additions; A/B testing constrained by Marketing Claim Library; channel attribution feeds Unit Economics Dashboard.

**Village ownership:** Channel Partnerships, Concierge Desk.

**Dependencies:** Marketing Claim Library, SelfPublisherForge, AnimaForge, VideoEditForge, FunnelForge, Unit Economics Dashboard, Event Ledger.

---

### Category 5 — Capital Operations & Intelligence (6 modules)

#### 5.1 Capital Stack & Monitoring

**Function:** Per-client capital stack visualization and monitoring.

**Data model owned:** Per-client stack composition, utilization records, promo period schedules, payment calendars, Capital Stack Health Score, re-stack trigger schedule, PG Exposure Map, account hygiene indicators.

**Change from v1:** Monitoring inputs now flow primarily from Plaid feeds (per Decision A) rather than assumed monitoring feeds from CapitalForge. Ongoing balance and transaction data comes from Plaid; account status changes come from CapitalForge's issuer integrations where available; the rest is Village-monitored via scheduled workflows.

**Key features:** Real-time stack visualization; utilization orchestration; promo period orchestration with 60/90-day expiration alerts; Payment Command Calendar (monthly productized deliverable); Capital Stack Health Score; Re-Stack Calendar; PG Exposure Map; provenance metadata on every data point.

**Village ownership:** Capital Operations.

**Dependencies:** Plaid (via Integration Layer), CapitalForge (Issuer Rules Engine, monitoring data), Event Ledger.

#### 5.2 Lender Intelligence Database

**Function:** Structured intelligence layer on every provider we work with. Defensible long-term asset.

**Data model owned:** Per-provider profiles (product type, states served, fee model, broker / referral rules, disclosure requirements, complaint history, average approval profile, industries accepted / excluded, repayment structure, renewal behavior, known risks); underwriting boxes; **provenance tags on every rule per Decision D — `issuer_rule` (sourced with URL and lastVerified) vs `unresearched_default`**; current appetite signals (updated weekly); win / loss records; contact directory; Funding Product Eligibility Rules; Funding Product Suitability Matrix logic; **research workstream state for V1.5 credit union expansion**.

**Change from v1:** Now formally tracks research workstream for the five credit unions deferred to V1.5 per Decision D — Alliant, PenFed, BECU, First Tech, Lake Michigan CU. Each has a research status, assigned researcher, target completion date. Progress feeds V1.5 lender activation.

**Key features:** Weekly appetite signal updates from Village agents; historical approval-rate tracking by lender × client profile; complaint pattern surfacing; automatic blacklist propagation; integrated with Capital Product Governance Board.

**V1 lender scope:** All major card issuers (with published velocity rules), national banks, fintech LOCs, **Navy Federal only among credit unions per Decision D**.

**Village ownership:** Funding Strategy (primary), Compliance & Evidence (blacklist governance).

**Dependencies:** CapitalForge (Issuer Rules Engine), Capital Product Governance Board, Funding Outcome Ledger, Event Ledger, Data Warehouse.

*Build in V1.5 (not V1).*

#### 5.3 Funding Recommendation Engine

**Function:** Turns Lender Intelligence Database data into client-specific recommendations.

**Data model owned:** Per-recommendation records (recommended product, recommended provider, reason, alternatives rejected, approval probability, cost estimate, risk summary, required documents, human approval level, required disclosures, client authorization packet, **data-source provenance on every input**).

**Change from v1:** Now surfaces provenance visibly in every recommendation per Decision D portfolio-wide discipline. Recommendation memo template explicitly labels whether the underlying rule is `issuer_rule` or `unresearched_default`. Client-facing deliverables inherit this. Recommendation refuses to generate when Funding Ethics Firewall or Do Not Fund Governance triggers, or when compliance categorical state is Needs Review or Fail (per Decision E).

**Key features:** Multi-factor recommendation logic combining client profile, Lender Intelligence Database, Funding Product Suitability Matrix; firewall integration; provenance surfacing on every recommendation; automatic authorization packet generation.

**Village ownership:** Funding Strategy.

**Dependencies:** Lender Intelligence Database, Funding Ethics Firewall, Do Not Fund Governance, Capital Product Governance Board, Client Household / Entity Graph, Client Lifecycle & CRM (for compliance categorical state), Event Ledger.

#### 5.4 Capital Product Governance Board

**Function:** Approval workflow for lenders, fintechs, factors, and any other provider before agents can recommend them.

**Data model owned:** Provider approval status, last review date, complaint trends, pricing changes, state restrictions, referral agreements, disclosure requirements, reputation risk indicators, removal / blacklist status.

**Key features:** New provider approval workflow; periodic re-review cadence (quarterly minimum); complaint threshold auto-flag; state-restriction propagation to Regulatory Engine; blacklist propagation to Funding Recommendation Engine; audit trail on every decision.

**Village ownership:** Compliance & Evidence, Funding Strategy.

**Dependencies:** Lender Intelligence Database, Regulatory Engine, Event Ledger.

#### 5.5 Funding Outcome Ledger

**Function:** Structured record of every funding attempt outcome.

**Data model owned:** Per-attempt records (product, provider, requested amount from `creditLimit`, approved amount from `approvedCreditLimit`, funded amount, declined reason, time to approval, time to funding, fees earned, refund status, client satisfaction, underwriting notes, next recommended move).

**Change from v1:** Now explicit about the CapitalForge distinction between `creditLimit` (requested) and `approvedCreditLimit` (granted, CHECK-constraint enforced). Success fees compute against `approvedCreditLimit` only, never against `creditLimit`.

**Key features:** Automatic capture on every placement outcome; refund logic trigger when approved capital fails to fund within 60 days; feedback loop into Lender Intelligence Database appetite signals and approval-rate tracking; cohort analysis.

**Village ownership:** Funding Strategy, Capital Operations.

**Dependencies:** CapitalForge (application state machine outputs), Lender Intelligence Database, Pricing / Billing / Offer Management, Event Ledger, Data Warehouse.

*Build in V1.5 (not V1).*

#### 5.6 Cost of Capital Calculator

**Function:** Native calculator for cost-of-capital analysis across products.

**Data model owned:** APR, factor rate, origination fee, monthly payment, daily / weekly repayment burden, total cost of capital, blended cost of stack, cash-flow impact, break-even use case, refinance comparison.

**Key features:** Embedded in Funding Suitability Memos, Capital Command Briefs, Quarterly Capital Reviews; per-product comparison tables; scenario modeling; refi opportunity detection.

**Village ownership:** Funding Strategy, CFO Advisory.

**Dependencies:** Funding Recommendation Engine, Capital Stack & Monitoring, Event Ledger.

---

### Category 6 — Risk & Defense (5 modules)

#### 6.1 Risk & Defense System (Alerts & Response)

**Function:** Continuous risk monitoring with three-tier alert system.

**Data model owned:** Client risk state, active alerts (Yellow / Orange / Red), alert history, response workflow states, resolution records.

**Key features:** Yellow / Orange / Red alerts per specification; each level defines who is notified, script used, options offered, human review requirement, whether new funding is frozen. **Alerts sourced primarily from Plaid feeds** (per Decision A) — utilization changes visible in real-time transaction data, NSF events detectable from account activity, cash balance deterioration visible from balance feed.

**Village ownership:** Risk & Defense.

**Dependencies:** Capital Stack & Monitoring, Client Conduct Monitoring, Funding Ethics Firewall, Plaid (via Integration Layer), Event Ledger, Notification & Task Queue.

*Full three-tier system builds in V1.5; V1 ships with basic alert capture.*

#### 6.2 Funding Ethics Firewall

**Function:** Automated enforcement of five ethical rules on placement eligibility.

**Data model owned:** Per-client firewall state (active / triggered / cleared), trigger reasons, trigger history, override records (with human approval).

**Key features:** Continuously evaluates the five rules; when triggered, all placement workflows freeze automatically; Funding Recommendation Engine refuses to generate recommendations; only Compliance & Evidence with human approval can unfreeze.

**Change from v1:** Now integrates with categorical compliance state per Decision E. Compliance state of Fail auto-triggers Firewall. Compliance state of Needs Review requires human approval before placement can proceed.

**Village ownership:** Compliance & Evidence, Risk & Defense.

**Dependencies:** Funding Recommendation Engine, Capital Stack & Monitoring, Client Conduct Monitoring, Debt Service Capacity Score, Client Lifecycle & CRM (compliance state), Event Ledger.

#### 6.3 Client Conduct Monitoring

**Function:** Detection layer for client-generated risk.

**Data model owned:** Independent application detection (after freeze), undisclosed debt detection, funds-usage anomaly detection, document inconsistency detection, payment alert non-response tracking, staff / agent pressure incidents, post-funding non-response tracking, unfounded fee dispute records, abuse records.

**Key features:** Triggers service pause, escalation, or termination based on defined thresholds; integrates with Client Conduct Breach Policy; audit trail for every flag.

**Village ownership:** Risk & Defense, Compliance & Evidence.

**Dependencies:** Capital Stack & Monitoring, Document Intelligence Pipeline, Communications Hub, Event Ledger.

*Build in V1.5 (not V1).*

#### 6.4 Do Not Fund Governance

**Function:** Formal governance for clients who should not receive additional capital.

**Data model owned:** Do Not Fund status per client, trigger reasons, override request records, review cadence.

**Key features:** Not just a flag — blocks placement workflows entirely; requires human override with documented justification; periodic review cadence; automatic Funding Ethics Firewall integration; **auto-populated by compliance state Fail per Decision E**.

**Village ownership:** Compliance & Evidence, Risk & Defense.

**Dependencies:** Funding Ethics Firewall, Funding Recommendation Engine, Human Approval Console, Client Lifecycle & CRM, Event Ledger.

#### 6.5 Risk Event Timeline

**Function:** Chronological timeline of every risk-relevant event per client.

**Data model owned:** Funding events, missed payments, utilization changes, credit line decreases, adverse actions, disputes, fraud alerts, NSF events, complaint events, new debt discoveries, freeze events, human interventions, compliance state transitions.

**Key features:** Timeline visualization; searchable and filterable; export for compliance audit; feeds into Compliance Evidence Vault.

**Village ownership:** Risk & Defense.

**Dependencies:** All risk-generating modules, Event Ledger.

---

### Category 7 — Compliance & Governance (5 modules)

#### 7.1 Compliance Evidence Vault

**Function:** Complete audit trail per client and per engagement.

**Data model owned:** Signed authorizations (application, bureau pull, Plaid connection, disclosure sent and received), client-submitted documents, application versions, human approval logs, communication records, funding outcome records, denial / adverse-action notices, complaint history, refund analyses, **compliance categorical state transitions with reasoning per Decision E**.

**Change from v1:** Now stores compliance state as categorical with finding lists rather than as a numeric score. Regulator-ready file generation includes state transition history, findings that produced each transition, resolution actions.

**Key features:** Regulator-ready file generation in minutes; per-client vault view; per-engagement vault view; export packages; integrated with Compliance Review Board interface for weekly reviews.

**Village ownership:** Compliance & Evidence.

**Dependencies:** All modules generating audit artifacts, Legal Hold & Record Retention, Event Ledger.

#### 7.2 State-by-State Regulatory Engine

**Function:** 50-state compliance matrix.

**Data model owned:** Per-state modules; required disclosures per state per product; counsel-review flags; state activation status; per-state marketing claim rules.

**Key features:** Every application submission checked against client state(s); required disclosures auto-attached; counsel-review flags raised when needed; state activation gate; state-law change tracker.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Marketing Claim Library, Contract & Disclosure Builder, Event Ledger.

*V1 covers priority states (NV, CA, NY, TX, FL, AZ, UT); full 50 states by V2.*

#### 7.3 Contract & Disclosure Builder

**Function:** Dynamic contract and disclosure generation based on client state, offer tier, product, and channel.

**Data model owned:** Contract template library, disclosure template library, generation rules, jurisdiction-aware clause library, per-generated-contract audit trail.

**Key features:** Generates service agreement, fee exhibit, authorization forms, product-specific disclosures, partner disclosure, refund policy, not-a-lender disclosure, no-guarantee disclosure; per-jurisdiction clause insertion; auto-updates when Regulatory Engine flags rule changes.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Regulatory Engine, State-Law Change Tracker, Event Ledger.

#### 7.4 Marketing Claim Library

**Function:** Version-controlled repository of approved and banned marketing / communication language.

**Data model owned:** Approved phrases, banned phrases, per-jurisdiction variants, deprecation tracking, source citations, Compliance Review Board approval records.

**Key features:** Weekly Compliance Review Board updates; propagation to Communication Compliance Scanner; propagation to Deliverable Approval Workflow; partner training curriculum sync; public documentation of ban rationale for internal training.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Communication Compliance Scanner, Deliverable Approval Workflow, Partner Training & Certification, Event Ledger.

#### 7.5 Legal Hold & Record Retention

**Function:** Retention schedule and legal hold management.

**Data model owned:** Default retention schedule per document type, state-specific retention rules, litigation hold records, complaint hold records, regulator request hold records, deletion approval workflow, client data deletion request workflow, evidence export packages.

**Key features:** Automatic retention enforcement; hold override for active litigation / complaints / regulator requests; state-specific retention rule variants; client data deletion request workflow (GDPR / CCPA analog); evidence export packet generation on demand.

**Village ownership:** Compliance & Evidence.

**Dependencies:** Secure Document Vault, Regulatory Engine, Event Ledger.

*Build in V1.5 (not V1).*

---

### Category 8 — Partner & Referrer Portal (4 modules)

#### 8.1 Partner & Referrer Portal (Core)

**Function:** Channel management for the seven partner tracks.

**Data model owned:** Partner records (CPA / Bookkeeper, Fractional CFO, Business Attorney, Wealth Advisor, M&A Advisor, CRE / Business Broker, Payroll / HR), onboarding status, training tracking, approved-claims library per partner, referral fee tracking, anonymized client status sharing, co-brand configurations, white-label configurations, brand-usage rules, termination triggers, conduct monitoring.

**Key features:** Per-partner-track qualification requirements; partner-facing portal for referred-client status; co-brand and white-label workspace provisioning; partner communication log; Partner Risk Score integration.

**Village ownership:** Channel Partnerships.

**Dependencies:** Client Lifecycle & CRM, Partner Training & Certification, Partner Risk Score, Event Ledger.

#### 8.2 Partner Agreement & Payout Center

**Function:** Financial and legal operations for partner relationships.

**Data model owned:** Partner contracts, referral fee terms, state restrictions on referral fees, disclosure requirements, payout approval records, payout dates, chargeback / refund clawback logic, co-brand rules, white-label rules, data-sharing permissions.

**Key features:** State-aware referral fee compliance; automatic payout workflow with human approval; clawback logic on refunds / chargebacks; data-sharing consent tracking.

**Village ownership:** Channel Partnerships, Compliance & Evidence.

**Dependencies:** Partner & Referrer Portal, Regulatory Engine, Pricing / Billing / Offer Management, Event Ledger.

*Build in V1.5 (not V1).*

#### 8.3 Partner Training & Certification

**Function:** Training curriculum and certification tracking.

**Data model owned:** Curriculum modules (approved claims, prohibited claims, client suitability, data privacy, referral disclosure), completion tracking, certification status, annual recertification cadence.

**Key features:** Required completion before partner can refer / co-brand / white-label; annual recertification with change delta training; automatic decertification on non-completion; integrated with Marketing Claim Library.

**Village ownership:** Channel Partnerships.

**Dependencies:** Marketing Claim Library, Partner & Referrer Portal, SelfPublisherForge (curriculum content), Event Ledger.

#### 8.4 Partner Risk Score

**Function:** Continuous scoring of partner quality and risk.

**Data model owned:** Per-partner score across dimensions: claim compliance, referral quality, conversion rate, complaint rate, refund rate, high-risk client rate, documentation quality, unauthorized promises detected, revenue contribution.

**Key features:** Weekly score updates; threshold-based escalation to Channel Partnerships review; automatic decertification triggers; feeds Partner Performance Dashboard.

**Village ownership:** Channel Partnerships, Compliance & Evidence.

**Dependencies:** Partner & Referrer Portal, Communication Compliance Scanner, Funding Outcome Ledger, Event Ledger.

*Build in V1.5 (not V1).*

---

### Category 9 — KPI Dashboards & Reporting (4 modules)

#### 9.1 Executive KPI Dashboard

**Function:** Operational performance view. Primary reporting surface to Gardner.

**Data model owned:** KPIs by domain — Readiness (score improvement), Placement (approval rate by product), **Compliance (% clients per categorical state per Decision E)**, Stack Management (utilization under target), Defense (alert resolution rate), Advisory (forecast accuracy), Partners (referral-to-client conversion), Client Success (retention, NPS, complaint rate), Finance (revenue per client, gross margin).

**Change from v1:** Compliance KPI is now percentage of clients per categorical state (Pass / Pass with Findings / Needs Review / Fail), not average numeric score. Target: 90%+ in Pass or Pass with Findings.

**Key features:** Cohort analysis; outcome tracking; trend visualization; Gardner-facing rollup with PII stripped.

**Village ownership:** Gardner (primary consumer), CapitalForge Ops (data operations).

**Dependencies:** Data Warehouse, Event Ledger, all data-generating modules.

#### 9.2 Unit Economics Dashboard

**Function:** Financial health of the service model.

**Data model owned:** CAC by channel, revenue per client, gross margin per offer, agent time per engagement, human review time, refund rate, complaint rate, partner payout, cost per funded dollar, LTV by client type, retention by offer tier, expansion rate, **Plaid subscription cost per client, bureau pull costs per client per Decision A and B**.

**Change from v1:** Now tracks per-client vendor costs (Plaid, bureau data providers) as COGS lines feeding gross margin calculation.

**Key features:** Per-offer P&L; per-channel CAC / LTV ratios; margin trend analysis; cohort retention curves; expansion path analysis.

**Village ownership:** Founder / Executive, Gardner.

**Dependencies:** Data Warehouse, Pricing / Billing / Offer Management, Funding Outcome Ledger, Cost & Performance Governance, Event Ledger.

#### 9.3 Agent Productivity Dashboard

**Function:** Workforce analytics for the Village.

**Data model owned:** Tasks completed by agent, cycle time, error rate, human correction rate, compliance violations, client satisfaction impact per agent, rework rate, escalation rate, cost per workflow.

**Key features:** Per-agent performance tracking; department-level rollup; degradation detection over time; workforce cost analytics; capacity planning inputs.

**Village ownership:** CapitalForge Ops, department heads.

**Dependencies:** Village Agent Orchestration, Agent QA & Evaluation Studio, Data Warehouse, Event Ledger.

*Build in V1.5 (not V1).*

#### 9.4 Lender Performance Dashboard

**Function:** Analytics on lender / provider performance over time.

**Data model owned:** Approval rate, decline rate, time to decision, time to funding, average funded amount, complaint rate, renewal behavior, pull type, cost of capital, client outcome after funding, suitability score accuracy.

**Key features:** Per-lender historical trend; comparison across lenders for the same product; complaint pattern detection; feeds back into Lender Intelligence Database appetite signals.

**Village ownership:** Funding Strategy, Compliance & Evidence.

**Dependencies:** Funding Outcome Ledger, Lender Intelligence Database, Data Warehouse, Event Ledger.

*Build in V1.5 (not V1).*

---

### Category 10 — Inter-Venture Commerce (2 modules)

#### 10.1 Inter-Venture Commerce Hooks

**Function:** Mechanics for handling MedLink / Greenstone / Argus / Collingswood as Burkham Wickmont clients.

**Data model owned:** Special engagement tags per intercompany relationship, transfer-pricing configurations, intercompany invoicing records, conflict-of-interest disclosures per engagement, Gardner-visibility flags, **cross-portfolio handoff records (Founder Personal Layer to Collingswood)**.

**Change from v1:** Now owns Founder Personal Layer handoff workflow to Collingswood per locked decision. When Burkham Wickmont identifies personal-side complexity for a client, this module produces the handoff artifact, captures per-handoff consent through Consent & Authorization Center, and routes to Gardner-governed cross-portfolio commerce.

**Key features:** Automatic tagging when client entity is a Green Companies venture; arm's-length pricing logic per Gardner-approved intercompany services agreement; intercompany invoicing routes to Gardner-level ledger; conflict-of-interest disclosures auto-generated and filed; audit trail per intercompany engagement.

**Village ownership:** Gardner-governed, Compliance & Evidence for disclosure filing.

**Dependencies:** Client Lifecycle & CRM, Pricing / Billing / Offer Management, Consent & Authorization Center, Event Ledger.

#### 10.2 Cross-Portfolio Opportunity Engine

**Function:** Identifies capital opportunities across Green Companies portfolio.

**Data model owned:** Detected opportunities across MedLink payroll float, Greenstone EMD / marketing capital, Argus project funding, Collingswood advisor / client acquisition needs, shared vendor financing, shared insurance premium financing, shared tax reserve planning.

**Key features:** Cross-Venture data feed from Gardner; opportunity scoring; automatic routing to appropriate Village department; Gardner-approval workflow.

**Village ownership:** Gardner, Funding Strategy.

**Dependencies:** Gardner data feeds, Client Lifecycle & CRM, Funding Recommendation Engine, Event Ledger.

*Build in V1.5 (not V1).*

---

### Category 11 — Technical Platform (12 modules)

#### 11.1 Identity & Access

**Function:** Authentication, authorization, and permissions across the Console.

**Data model owned:** User records (Village agents, human staff, partners, clients), role definitions, attribute-based access control policies, department permissions, client-file permissions, partner permissions, human approver permissions, break-glass emergency access records, MFA configurations, session logs, access reviews, permission expirations.

**Key features:** RBAC + ABAC hybrid; per-tenant enforcement; break-glass with audit trail; automatic permission expiration; access review workflow.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Tenant / Organization Model, Event Ledger.

#### 11.2 Tenant / Organization Model

**Function:** Multi-tenant structure supporting internal, client, and partner organizations.

**Data model owned:** Tenant hierarchy (Green Companies parent → Burkham Wickmont → clients / partners), organization records, users-across-multiple-roles model, clients-with-multiple-businesses model, white-label partner tenants, co-branded partner workspaces.

**Key features:** Data isolation enforcement per tenant; cross-tenant relationship modeling; role-per-tenant support; tenant-level configuration.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Identity & Access, Event Ledger.

#### 11.3 Event Ledger

**Function:** Immutable log of every state-changing action.

**Data model owned:** Client created, document uploaded, readiness score changed, application freeze triggered, human approval granted, client authorization signed (application / bureau pull / Plaid connection / disclosure), disclosure sent, application submitted, funding approved (with `approvedCreditLimit`), funding failed to fund, fee triggered, refund issued, complaint filed, partner paid, agent overrode recommendation, **compliance categorical state transitions**, **workflow execution events (per Decision C)**, **cross-portfolio handoff to Collingswood**, plus all other state changes.

**Change from v1:** Now the canonical event source for workflow execution per Decision C. Workflow Engine both emits events (task started, task completed, workflow triggered) and listens for events (state changes that trigger workflows).

**Key features:** Immutable append-only log; cryptographically signed entries; queryable by every module; powers compliance audit, reporting, and dispute defense; canonical source for cross-module state.

**Village ownership:** CapitalForge Ops (technical), Compliance & Evidence (audit consumer).

**Dependencies:** Foundation module — everything depends on Event Ledger.

#### 11.4 Notification & Task Queue

**Function:** Task assignment, deadlines, escalation, and reminders.

**Data model owned:** Task records, SLA due dates, escalation timers, missed deadline alerts, recurring tasks, human approval reminders, client document reminders, partner follow-up reminders, compliance review reminders.

**Change from v1:** Now the substrate the Workflow Engine's task queue runs on per Decision C. Workflow Engine dispatches tasks through Notification & Task Queue; Village agents pull tasks from it; humans receive Human Approval Console items through it.

**Key features:** Multi-channel notification (email, SMS, voice, in-app); escalation chains; SLA breach alerts; recurring task templates; integrated with Workflow Engine.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Identity & Access, Event Ledger, Communications Hub for external notifications, Workflow Engine.

#### 11.5 Integration Layer / API Gateway

**Function:** Consolidated integration surface for Forge platforms and third-party services.

**Data model owned:** Integration configurations for CapitalForge, FunnelForge, SelfPublisherForge, AnimaForge, VideoEditForge, ChamberForge, **Plaid (per Decision A), Nav for Partners or equivalent (per Decision B), Array or equivalent (per Decision B)**, e-signature, payment processor, accounting system, calendar, credit monitoring providers, business bureau data, banking data, third-party CRM, secure document storage.

**Change from v1:** Now hosts the Plaid, bureau data, and personal credit provider integrations per Decisions A and B. These are venture-specific integrations for Burkham Wickmont; they do not live in CapitalForge.

**Key features:** Versioned API contracts per integration; automatic failover / retry logic; rate-limit management; integration health monitoring; unified logging.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Event Ledger, System Health & Observability.

#### 11.6 Data Warehouse & Analytics Layer

**Function:** Analytics-optimized data store.

**Data model owned:** Reporting tables, cohort analytics, lender performance analytics, client outcome analytics, agent productivity analytics, partner performance analytics, financial performance analytics, compliance incident analytics.

**Key features:** ETL from operational systems; historical retention independent of operational data retention; supports cohort and trend analysis; feeds all dashboard modules.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Event Ledger, all data-generating modules.

#### 11.7 Admin Configuration Center

**Function:** Non-technical admin surface for parameter management.

**Data model owned:** Offers, pricing, success fees, templates, playbooks, authority levels, state rules, lender profiles, partner rules, risk thresholds, KPI targets, notification rules, escalation rules.

**Key features:** Per-domain configuration UIs; audit trail on every change; staged rollout for high-risk changes; rollback capability.

**Village ownership:** Founder / senior operators.

**Dependencies:** Identity & Access, Event Ledger, Playbook Builder.

#### 11.8 System Health & Observability

**Function:** Production-grade monitoring.

**Data model owned:** Uptime metrics, job queue health, failed workflow alerts, API latency, OCR failures, VoiceForge call failures, CapitalForge data sync failures, document parsing errors, payment processing failures, security alerts, agent execution failures, **Plaid API health, bureau provider API health**.

**Key features:** Real-time dashboards; alerting thresholds; incident response integration; SLA tracking; performance regression detection.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Event Ledger, all operational modules.

#### 11.9 Cost & Performance Governance

**Function:** AI infrastructure cost tracking and model performance monitoring.

**Data model owned:** Per-agent API call costs (Anthropic and other model providers), CapitalForge → VoiceForge minute usage, CapitalForge → VisionAudioForge document processing costs, **Plaid subscription and per-connection costs, bureau data pull costs per pull, personal credit provider costs per pull**, per-client unit cost, model performance regression detection, prompt cost optimization tracking.

**Change from v1:** Now explicitly tracks vendor costs from Decisions A and B — Plaid subscription plus per-connection or per-account fees, business bureau API costs, personal credit provider costs — as per-client COGS. Feeds Unit Economics Dashboard directly.

**Key features:** Per-client unit economics feed; cost anomaly detection; model version A/B testing; prompt cost optimization workflow; vendor cost trending.

**Village ownership:** CapitalForge Ops.

**Dependencies:** Village Agent Orchestration, Integration Layer, Data Warehouse, Event Ledger.

*Build in V1.5 (not V1).*

#### 11.10 Client Portal (Secure Client Delivery Room)

**Function:** Client-facing secure interface. Not a SaaS dashboard.

**Data model owned:** Client-facing views: document upload, engagement status view, deliverables view, application approval workflow, disclosure signing, **Plaid Link connection interface (per Decision A)**, Capital Command Brief delivery, secure messaging with Concierge Desk.

**Change from v1:** Now hosts the Plaid Link connection experience per Decision A. Client authorizes bank connection through Plaid Link embedded in the Portal; Portal captures the authorization and hands to Consent & Authorization Center.

**Key features:** Deliberately minimal scope; branded as "your secure client file and approval room"; e-signature capture; document upload with automatic Document Intelligence Pipeline processing; Plaid Link integration; message routing to Concierge Desk.

**Village ownership:** Concierge Desk.

**Dependencies:** Secure Document Vault, Consent & Authorization Center, Communications Hub, Document Intelligence Pipeline, Plaid (via Integration Layer), Identity & Access.

#### 11.11 Founder / Executive Workbench

**Function:** Founder and senior team surface.

**Data model owned:** Executive dashboard views, alert stream, decision queue, cross-department status.

**Key features:** Curated view across operations for executive decision-making; alerts requiring founder attention; approval queue for founder-level decisions; cross-portfolio status roll-up.

**Village ownership:** Founder / Executive.

**Dependencies:** All operational modules, Executive KPI Dashboard, Human Approval Console.

#### 11.12 Disaster Recovery & Business Continuity

**Function:** Backup, recovery, and continuity planning.

**Data model owned:** Backup schedules, RTO / RPO targets, runbooks (ransomware, major Forge platform outage, data loss, security incident, **Plaid outage, bureau provider outage**), Argus integration for incident response.

**Key features:** Automated backup verification; regular DR drills; runbook execution tracking; Argus-integrated incident response.

**Village ownership:** CapitalForge Ops, Argus (cybersecurity partner venture).

**Dependencies:** Event Ledger, Argus integration.

*V1 ships foundational backup; full runbooks including vendor outage scenarios build in V1.5.*

---

## 4. Cross-Forge orchestration patterns (revised)

Four institutional patterns updated to reflect V2 decisions.

### 4.1 The Authority-Tier Content Cascade

Insight (state-law change, lender appetite shift, new product release, credit union research completion) produced once → cascades through Forges:

```
Source insight → Marketing Ops (governance)
              → SelfPublisherForge (long-form report)
              → AnimaForge (animation)
              → VideoEditForge (founder explainer)
              → FunnelForge (gated funnel + Ring 1 distribution)
              → Marketing Claim Library update
              → Partner Training curriculum update
```

### 4.2 The Diagnostic-to-Deliverable Pipeline (revised for Plaid)

Client onboarding triggers full pipeline:

```
Client Portal → Plaid Link connection
              → Consent & Authorization Center (Plaid + bureau + application authorizations captured)
              → Plaid (24 months transaction data + balances + accounts)
              → Document Intelligence Pipeline (enrichment)
              → Nav for Partners or equivalent (business bureau pull with per-pull consent)
              → Array or equivalent (personal credit pull with per-pull consent)
              → CapitalForge Issuer Rules Engine
              → Funding Recommendation Engine (with provenance)
              → SelfPublisherForge (deliverable template)
              → optional AnimaForge (animated walkthrough)
              → optional VideoEditForge (founder narration layer)
              → optional CapitalForge → VoiceForge (voice delivery)
              → Deliverable Approval Workflow (Communication Compliance Scanner + human review)
              → Client Portal (delivery)
              → Event Ledger (audit)
```

### 4.3 The Referrer Activation Loop

Closed loop from identification to attribution:

```
FunnelForge → TrafficForge (Dream 100)
            → FunnelForge (referrer onboarding)
            → SelfPublisherForge (referrer briefing document — decline-flow / advisor / transaction variant)
            → AnimaForge (partner deck)
            → Partner & Referrer Portal (engagement tracking)
            → CapitalForge attribution
            → FunnelForge (CAC analysis feed)
            → Unit Economics Dashboard
```

### 4.4 The Crisis Response Pattern

Red Alert triggers coordinated response:

```
Risk & Defense (Red Alert) → Workflow Engine (response playbook)
                          → CapitalForge → VoiceForge (Concierge call)
                          → VideoEditForge (founder-recorded message if warranted)
                          → SelfPublisherForge (response packet)
                          → Compliance Evidence Vault (audit log)
                          → Argus notification (if security / fraud component)
                          → Do Not Fund Governance (if compliance state → Fail)
```

---

## 5. Data flow patterns (revised)

### 5.1 Client onboarding flow (revised)

```
Sales Motion & Engagement Tracking (Blueprint purchased)
    → Consent & Authorization Center (initial authorizations)
    → Client Lifecycle & CRM (client record created, compliance state = "Pending Assessment")
    → Client Portal (Plaid Link connection prompt)
    → Plaid (bank connection established, 24mo history pulled)
    → Consent & Authorization Center (bureau pull authorizations)
    → Nav for Partners or equivalent (business bureau pull)
    → Array or equivalent (personal credit pull)
    → Client Household / Entity Graph (initial entity discovery)
    → Workflow Engine (Phase 0 playbook initiated)
    → Document Intelligence Pipeline (enrichment)
    → Funding Readiness Score generated (provenance on each component)
    → Compliance categorical state assessed
    → Deliverable Approval Workflow (Blueprint report reviewed)
    → Client Portal (Blueprint delivered)
    → Sales Motion (Blueprint Review Call scheduled)
```

### 5.2 Application submission flow (revised)

```
Funding Recommendation Engine (generates recommendation with provenance)
    → Firewall check (Funding Ethics Firewall + Do Not Fund Governance)
    → Compliance state check (must be Pass or Pass with Findings per Decision E)
    → Regulatory Engine (state compliance check)
    → Consent & Authorization Center (per-application authorization)
    → Client Portal (client signs authorization)
    → Human Approval Console (compliance officer approves)
    → CapitalForge (submission execution)
    → Funding Outcome Ledger (outcome captured with `approvedCreditLimit`)
    → Pricing / Billing (success fee triggered on approval, computed from `approvedCreditLimit`)
    → Compliance Evidence Vault (full artifact set stored)
    → Event Ledger (every step logged)
```

### 5.3 Monthly Capital Command Brief flow (revised)

```
Workflow Engine (monthly scheduled trigger per Stack Management client)
    → Plaid (fresh transaction data pulled)
    → Capital Stack & Monitoring (current state computed)
    → Capital Stack Health Score computed
    → Cost of Capital Calculator (blended cost updated)
    → Document & Deliverable Management (Brief template populated with provenance)
    → Optional AnimaForge (animated walkthrough for higher tiers)
    → Communication Compliance Scanner (final check)
    → Deliverable Approval Workflow
    → Client Portal (Brief delivered)
    → Event Ledger (audit)
```

---

## 6. V1 build phasing (revised timeline)

### V1 (months 0–5 revised to months 0–6) — Minimum viable operating platform

Goal: launch with MedLink Pro as anchor customer #1; execute Phases 0–2 end-to-end; national footprint at priority states only.

**Timeline revision:** 150–180 days (up from 120–150 in v1). Reflects Workflow Engine as load-bearing infrastructure, Plaid integration as first-class V1 capability, bureau integration workflow, and provenance discipline throughout.

**Categories 1–4 build in full for V1.**

**Category 5 — Capital Operations (4 of 6):** Capital Stack & Monitoring, Funding Recommendation Engine, Capital Product Governance Board, Cost of Capital Calculator. Deferred: Lender Intelligence Database (V1.5), Funding Outcome Ledger (V1.5).

**Category 6 — Risk & Defense (3 of 5):** Funding Ethics Firewall, Do Not Fund Governance, Risk Event Timeline. Deferred: Risk & Defense Alerts full three-tier (V1.5), Client Conduct Monitoring (V1.5).

**Category 7 — Compliance & Governance (4 of 5):** Compliance Evidence Vault, State-by-State Regulatory Engine (priority states only), Contract & Disclosure Builder, Marketing Claim Library. Deferred: Legal Hold & Record Retention (V1.5).

**Category 8 — Partner & Referrer Portal (2 of 4):** Partner & Referrer Portal, Partner Training & Certification. Deferred: Partner Agreement & Payout Center (V1.5), Partner Risk Score (V1.5).

**Category 9 — KPI Dashboards & Reporting (2 of 4):** Executive KPI Dashboard, Unit Economics Dashboard. Deferred: Agent Productivity Dashboard (V1.5), Lender Performance Dashboard (V1.5).

**Category 10 — Inter-Venture Commerce (1 of 2):** Inter-Venture Commerce Hooks. Deferred: Cross-Portfolio Opportunity Engine (V1.5).

**Category 11 — Technical Platform (10 of 12):** Identity & Access, Tenant / Organization Model, Event Ledger, Notification & Task Queue, Integration Layer, Data Warehouse, Admin Configuration Center, System Health & Observability, Client Portal, Founder / Executive Workbench. Deferred: Cost & Performance Governance (V1.5), Disaster Recovery & Business Continuity full runbooks (V1.5).

**V1 module count: 46 modules.**

### V1.5 (months 6–12) — Full service catalog

Adds 12 modules per deferral list above, plus Phases 3–5 playbooks in Workflow Engine, plus additional states in Regulatory Engine, plus V1.5 credit union research workstream completion (Alliant, PenFed, BECU, First Tech, Lake Michigan CU per Decision D).

### V2 (months 12–24) — Full national + native parsing

Completes: full 50-state Regulatory Engine, complete Cross-Portfolio Opportunity Engine, ChamberForge handoff integration, ROBS at full volume, crowdfunding orchestration, **native statement parsing capability in Console (per Decision A future roadmap)**, optional generic ConsoleForge framework extraction.

---

## Appendix A — Module dependency matrix (revised)

**Foundation dependencies (nearly universal):** Identity & Access, Tenant / Organization Model, Event Ledger, Notification & Task Queue, Integration Layer.

**High-fan-out modules:** Client Lifecycle & CRM, Workflow Engine, Compliance Evidence Vault, Regulatory Engine, Human Approval Console, Consent & Authorization Center.

**Terminal modules:** All KPI Dashboards, Data Warehouse.

**Firewall-precedent modules:** Funding Ethics Firewall, Do Not Fund Governance, Regulatory Engine, Consent & Authorization Center.

**Vendor integration dependencies:** Plaid (Document Intelligence Pipeline, Capital Stack & Monitoring, Risk & Defense System, Client Portal), Nav for Partners or equivalent (Document Intelligence Pipeline, Consent & Authorization Center), Array or equivalent (Document Intelligence Pipeline, Consent & Authorization Center).

---

## Appendix B — Village department to module ownership map (revised)

| Department | Primary modules owned |
|---|---|
| Capital Readiness | Phase 0 workflow, Client Household / Entity Graph (creation), Document Intelligence Pipeline (Phase 0 intake) |
| Funding Strategy | Funding Recommendation Engine, Lender Intelligence Database, Capital Product Governance Board, Lender Performance Dashboard, **CU research workstream V1.5** |
| Capital Operations | Capital Stack & Monitoring, monthly deliverables generation, Funding Outcome Ledger (capture) |
| Risk & Defense | Risk & Defense System, Risk Event Timeline, Client Conduct Monitoring |
| CFO Advisory | Phase 4 workflows, Cost of Capital Calculator, Debt Service Capacity Score, Capital Policy Manual generation |
| Lifecycle & Exit | Phase 5 workflows, Founder Liquidity / De-Risking Plan generation |
| Compliance & Evidence | Compliance Evidence Vault, Regulatory Engine, Contract & Disclosure Builder, Marketing Claim Library, Communication Compliance Scanner, Deliverable Approval Workflow, Legal Hold & Record Retention, Funding Ethics Firewall (co-owned), Do Not Fund Governance (co-owned), **compliance categorical state governance per Decision E**, **Consent & Authorization Center including per-pull bureau auth per Decision B** |
| Channel Partnerships | Partner & Referrer Portal, Partner Agreement & Payout Center, Partner Training & Certification, Partner Risk Score, **Marketing Ops** |
| Concierge Desk | Communications Hub, Call Recording / Summaries / Promise Tracking, Client Portal, Sales Motion & Engagement Tracking |
| CapitalForge Ops | Technical Platform category (all 12 modules), Agent Workbench, Village Agent Orchestration (technical) |

---

## Appendix C — Where this blueprint differs from v1

| Area | v1 | v2 |
|---|---|---|
| Workflow Engine (2.2) | Orchestration backbone (ambiguous depth) | Full execution engine with scheduler, task queue, wait-state manager, retry engine, event listener (per Decision C) |
| Document Intelligence Pipeline (3.3) | Called CapitalForge → VisionAudioForge | Primary integration point for Plaid (per Decision A) and bureau data (per Decision B); enriches and normalizes before handing to CapitalForge |
| Client Portal (11.10) | Nine functions, minimal | Now hosts Plaid Link connection interface per Decision A |
| Consent & Authorization Center (1.5) | Application, disclosure, referral consents | Now owns per-pull bureau authorization (Decision B) and Plaid connection authorization (Decision A) |
| Lender Intelligence Database (5.2) | Universal issuer catalog | V1 restricted to Navy Federal among CUs per Decision D; portfolio-wide provenance discipline; explicit V1.5 research workstream |
| Funding Recommendation Engine (5.3) | Multi-factor recommendation with firewall integration | Now surfaces provenance visibly on every recommendation (Decision D portfolio-wide); refuses on Needs Review or Fail compliance state (Decision E) |
| Compliance state modeling | Numeric score in Client Lifecycle & CRM | Categorical state (Pass / Pass with Findings / Needs Review / Fail) with workflow implications (Decision E) |
| Marketing Ops (4.5) | Not present | Net new module in v2 |
| Integration Layer (11.5) | Generic integration surface | Now explicitly hosts Plaid, Nav for Partners or equivalent, Array or equivalent per Decisions A and B |
| V1 timeline | 120–150 days | 150–180 days reflecting scope revisions |

---

*End of blueprint v2.*
