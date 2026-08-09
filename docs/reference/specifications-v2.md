# Burkham Wickmont Operations Console — Specifications v2

**Document version:** v2
**Supersedes:** Specifications v1
**Status:** Working specification, revised post CapitalForge audit and five cross-platform decisions
**Companion documents:** Burkham Wickmont Company Specifications v2, Burkham Wickmont Operations Console Blueprint v2, CapitalForge Specification (commit 45b2513)
**Scope:** Architectural, technical, and operational cross-cutting specification of the Burkham Wickmont Operations Console.

---

## Preface — what changed in v2

Five cross-platform decisions and one CapitalForge audit reframe the technical foundation this document rests on:

- **Decision A (Statement parsing):** Plaid for V1, native Console build later
- **Decision B (Bureau data source):** B2B aggregator API + separate personal credit provider (Model B)
- **Decision C (Workflow execution):** Console owns workflow execution
- **Decision D (Credit union velocity rules):** Navy Federal only for V1 + provenance discipline portfolio-wide
- **Decision E (Compliance score meaning):** Categorical replaces numeric

CapitalForge audit at commit 45b2513 documents actual capability vs. planned: ships JSON-only statement ingest, no bureau pull, no workflow execution, ten endpoints refuse (501). The Console must design around real limits, not assumed capabilities.

The v1 module topology and design principles largely hold. What changes is: platform technical foundation (Workflow Engine is real execution infrastructure), integration surface (Plaid, bureau, personal credit as V1 vendors), data-model discipline (categorical compliance, provenance on outputs, `approvedCreditLimit` vs `creditLimit`), and V1 timeline (150–180 days revised up from 120–150).

---

## Executive summary

The Burkham Wickmont Operations Console is the dedicated operating environment for the Burkham Wickmont Village. It is the surface through which an AI agent workforce delivers a private-CFO-style capital operations service at national scale, with human oversight concentrated at high-leverage decision points.

The Console is a service-company platform, not a customer-facing SaaS product. Clients experience the Burkham Wickmont brand, deliverables, and outcomes; they interact with the Console only through the narrowly scoped Client Portal (module 11.10) serving as a secure delivery and approval surface. The Village works inside the Console; the Console orchestrates the underlying Forge platforms and third-party integrations as services.

Architecturally, the Console consists of 58 modules across 11 functional categories. Technical foundation: an immutable Event Ledger as canonical state source; versioned module APIs; middleware-enforced Authority Levels; strict multi-tenant data isolation; a first-class state-by-state Regulatory Engine; a Funding Ethics Firewall with precedence over placement workflows; a real workflow execution engine (Decision C); provenance discipline on every output (portfolio-wide, inherited from CapitalForge audit); categorical compliance state driving workflow (Decision E); and honest empty states / honest refusals throughout.

V1 build estimated at 150–180 days delivering 46 modules. V1.5 adds 12 modules over 90 days. V2 completes full national footprint, cross-portfolio integration, and native statement parsing capability over the following year.

---

## 1. Purpose and non-purpose

### 1.1 Purpose

The Console exists to serve three constituencies:

1. **The Village.** A coherent workspace for AI agents to perform capital operations work at scale, safely, with clear authority scope, well-defined workflows, and auditable outputs.

2. **The client.** Consistent, compliant, high-quality service across the full lifecycle regardless of which Village agent handles their engagement at any moment.

3. **The company.** Defensible operating infrastructure producing auditable evidence for regulators, actionable intelligence for the founder team, unit economics visibility, and cross-portfolio commercial capability under Gardner governance.

### 1.2 Non-purpose

- Not a customer-facing SaaS product
- Not a generalized workflow platform (purpose-built for capital operations)
- Not a replacement for human judgment on high-stakes decisions
- Not a substitute for underlying Forge platforms (it orchestrates them)
- Not a cross-venture shared platform (Burkham Wickmont-specific)

---

## 2. Positioning in the architecture

### 2.1 The architectural stack

```
Gardner (parent-level governance, all five ventures)
    ↓
Burkham Wickmont (customer-facing operating brand)
    ↓
Burkham Wickmont Village (10 purpose-built departments, AI agent workforce)
    ↓
Burkham Wickmont Operations Console (58 modules, this specification)
    ↓
Shared Forge platforms (CapitalForge, FunnelForge, SelfPublisherForge, AnimaForge, VideoEditForge, ChamberForge)
    ↓
Village OS framework (shared orchestration foundation)
```

### 2.2 Console module clusters

Modules cluster into three categories based on relationship to Forge platforms and third-party integrations:

- **Console-native modules** — built entirely inside the Console (approximately 40 modules)
- **Forge-orchestrating modules** — Console-native surfaces that call one or more Forge platforms (approximately 12 modules)
- **Cross-cutting technical platform modules** — foundational infrastructure (approximately 6 modules)

### 2.3 What the Console owns vs. what it calls

**Console owns (per V2 decisions):**
- All workflow execution (Decision C)
- Per-application authorization workflow
- Per-pull bureau authorization workflow (Decision B)
- Plaid connection authorization (Decision A)
- Compliance categorical state management (Decision E)
- Provenance metadata on all recommendations (Decision D portfolio-wide)
- Multi-tenant client data isolation
- Cross-portfolio handoff to Collingswood (Founder Personal Layer)

**Console calls (does not reimplement):**
- Capital operations engine functions → CapitalForge
- Voice telephony and voice AI → CapitalForge → VoiceForge
- Vision and audio AI → CapitalForge → VisionAudioForge
- Marketing automation and top-of-funnel → FunnelForge
- Dream 100 / referrer activation → TrafficForge (inside FunnelForge)
- Long-form content generation → SelfPublisherForge
- Animated content → AnimaForge
- Video post-production → VideoEditForge
- UHNW wealth handoff → ChamberForge
- Founder personal financial life → Collingswood via Gardner-governed handoff
- Bank statement data → Plaid (V1 per Decision A)
- Business bureau data → Nav for Partners or equivalent (V1 per Decision B)
- Personal credit data → Array or equivalent (V1 per Decision B)

---

## 3. Design principles

Nine principles govern every module decision. When they conflict, earlier wins. Principles 1–7 are Console-native; principles 8–9 are inherited from the CapitalForge audit and now apply portfolio-wide.

### 3.1 Compliance shape first, dollars second

No module design, feature, workflow, or configuration survives if it recharacterizes Burkham Wickmont as a lender, investment advisor, credit repair organization, or debt settlement firm. Every architectural decision passes a Seek Capital test.

### 3.2 Structure rewards stewardship, not transactions

The platform is optimized for retention, not for transaction throughput. Recurring artifacts (Capital Command Brief, Quarterly Capital Review, Lender Intelligence Report) and ongoing state tracking (Capital Stack & Monitoring, Risk Event Timeline) are the most valuable long-term assets.

### 3.3 Every state change is an event

The Event Ledger is canonical. Modules do not directly modify shared state; they emit events. Other modules project their own optimized read stores from those events.

### 3.4 Authority Levels are enforced by middleware

Village agent action scope (Levels 0–4) is enforced by a single middleware layer every agent action passes through. It is not reimplemented per module.

### 3.5 Multi-tenant isolation is strict

Burkham Wickmont client data lives in the Burkham Wickmont tenant. Data flowing to Gardner goes through an aggregation layer that strips PII. Data flowing to Collingswood requires explicit per-handoff consent. No back doors.

### 3.6 State compliance is a workflow gate

The Regulatory Engine is not a post-hoc check. No client-facing action fires without state compliance checks having passed. State activation itself is gated.

### 3.7 Firewall precedence

The Funding Ethics Firewall and Do Not Fund Governance have precedence over all placement-related modules. Compliance categorical state Needs Review or Fail auto-triggers firewall (Decision E). When triggered, downstream placement workflows freeze.

### 3.8 Provenance on output (portfolio-wide, inherited from CapitalForge audit)

Every derived figure ships how it was derived. Applies to lender recommendations (Decision D), bureau data (Decision B — source, pull timestamp, consent reference), workflow inputs, compliance categorizations, and deliverable content. The audit's Section 5 principle applied everywhere.

### 3.9 Honest empty states and honest refusals (inherited from CapitalForge audit)

Three states distinguishable at a glance: `not_built`, `no_data`, `failed`. Endpoints that cannot fulfill their contract refuse with explicit reason (following CapitalForge's 501 pattern). No silent no-ops. Categorical compliance state (Decision E) is an application of this discipline — Pass, Pass with Findings, Needs Review, and Fail are distinguishable states rather than points on a continuum that hide their differences.

---

## 4. Module topology summary

58 modules across 11 categories.

| # | Category | Modules | V1 build |
|---|---|---|---|
| 1 | Client & Engagement | 5 | 5 |
| 2 | Operations | 6 | 6 |
| 3 | Document & Deliverable Management | 4 | 4 |
| 4 | Communications Hub | 5 | 5 |
| 5 | Capital Operations & Intelligence | 6 | 4 |
| 6 | Risk & Defense | 5 | 3 |
| 7 | Compliance & Governance | 5 | 4 |
| 8 | Partner & Referrer Portal | 4 | 2 |
| 9 | KPI Dashboards & Reporting | 4 | 2 |
| 10 | Inter-Venture Commerce | 2 | 1 |
| 11 | Technical Platform | 12 | 10 |
| | **Total** | **58** | **46** |

Full module-by-module specifications in Operations Console Blueprint v2.

---

## 5. Technical architecture

### 5.1 Runtime model

The Console runs as a multi-service architecture. Each functional category (or subcategory) is a distinct service with its own optimized data store. Services communicate through:

- The Event Ledger — for authoritative state changes
- Versioned APIs — for direct queries and commands
- The Notification & Task Queue — for asynchronous work

No service reaches directly into another service's database. All cross-service reads go through APIs; all cross-service writes go through events.

### 5.2 Event Ledger design

Foundational cross-cutting infrastructure. Every state change generates an event with:

- Cryptographic signature (immutability and non-repudiation)
- Full context (client, tenant, agent or human actor, timestamp, correlation ID)
- Structured event type from a versioned event schema
- Complete payload sufficient to reconstruct state

Retention is indefinite for compliance-relevant events. Query patterns support both per-client audit reconstruction and cross-client analytics.

Append-only. Corrections happen as new events (compensating events) rather than mutations. This preserves the audit trail even for mistakes.

**V2 additions:** The Event Ledger now emits and consumes workflow execution events per Decision C. Workflow Engine both writes to the Ledger (task started, task completed, workflow triggered) and listens to it (state changes that trigger workflows). Compliance categorical state transitions (Decision E) are ledger events. Cross-portfolio handoff to Collingswood is a ledger event.

### 5.3 Workflow Engine architecture (per Decision C)

Module 2.2 is a real execution engine, not just a state machine. Required components:

**Scheduler component.** Cron-like capability for recurring workflows — monthly Capital Command Briefs, 60/90-day promo expiration alerts, quarterly reviews, staleness reviews on lender research, annual partner recertification.

**Task queue.** Reliable dispatch to Village Agent Orchestration. Runs on top of Notification & Task Queue (module 11.4). Supports priority, retry configuration, and dead-letter handling.

**Wait-state manager.** Workflows that sleep for weeks or months waiting for real-world events (promo period expiration, re-stack windows, retention triggers at month 10 of 12-month engagement).

**Retry and failure policy engine.** Per-task retry logic with exponential backoff, configurable retry limits, dead-letter routing on exhaustion, distinguished failure modes.

**Event listener.** Triggers on Event Ledger emissions. Enables event-driven workflow initiation (e.g., document upload triggers Phase 0 workflow).

**Decision point evaluation.** Branching logic within playbook trees. Evaluates against client state, compliance state, and workflow context.

**Escalation routing.** SLA breaches route to Human Approval Console. Failure paths route per playbook definition. Timeouts route per SLA configuration.

CapitalForge's saved-but-never-executed workflow store is treated as legacy artifact per Decision C. The Console does not read from it. Future CapitalForge cleanup removes it.

### 5.4 API contract discipline

Every module exposes a versioned API. Version tracking follows semver:

- Major version for breaking changes
- Minor version for backward-compatible additions
- Patch version for bug fixes and non-behavioral changes

Breaking changes require a deprecation window of at least one major version, migration paths documented, and consumer sign-off. A module compatibility matrix is maintained by CapitalForge Ops and reviewed weekly.

### 5.5 Middleware stack

Every agent action and every API call passes through a middleware stack in defined order:

1. **Authentication** — verify caller identity (Identity & Access)
2. **Tenant scope** — verify caller belongs to the tenant they're operating on (Tenant / Organization Model)
3. **Authority Level check** — verify agent action is within allowed level, or verify human role has permission
4. **Firewall check** — for placement-related operations, verify Funding Ethics Firewall is clear AND compliance categorical state is Pass or Pass with Findings (per Decision E)
5. **Regulatory check** — verify state-specific compliance requirements
6. **Event emission** — log the action to the Event Ledger
7. **Compliance scan** — for client-facing content, run the Communication Compliance Scanner

Failure at any step blocks the action and logs the failure. Uniform across all modules.

### 5.6 Data isolation model

**Client data** — lives in the Burkham Wickmont tenant. Never leaves without explicit consent flow.

**Aggregated reporting** — flows to Gardner through the aggregation layer, PII stripped, statistical rollups only.

**Cross-portfolio handoff data** — Collingswood handoffs (Founder Personal Layer per Decision B) require explicit per-handoff consent. Client signs a specific handoff authorization that names Collingswood by name and scopes the data flowing.

**Intercompany client data** — when MedLink Pro / Greenstone / Argus / Collingswood are Burkham Wickmont clients, their engagement data lives in the Burkham Wickmont tenant. Cross-portfolio visibility follows Gardner governance rules.

**Third-party integration data** — Plaid, bureau providers, personal credit providers store client data on their side per their DPAs; Console consumes via API and stores in its own encrypted stores. Console retains authority over data flow, retention, and deletion via Consent & Authorization Center and Legal Hold & Record Retention.

### 5.7 Storage model

Three storage tiers:

- **Operational database** — active read/write store for each service, optimized for OLTP
- **Event Ledger store** — append-only, cryptographically signed, optimized for immutability and audit query
- **Data warehouse** — analytical store, populated by ETL from operational databases and Event Ledger, optimized for reporting queries

The Secure Document Vault (module 3.2) uses a separate encrypted object store with role-based access, watermarking, and access logging. Plaid-sourced JSON is stored here alongside any PDF originals from Plaid Assets fallback.

### 5.8 Integration layer (V2 additions)

The Integration Layer / API Gateway (module 11.5) provides a consolidated integration surface. V2 additions per Decisions A and B:

- **Plaid integration** — Plaid Link for direct bank connection, Plaid Assets for PDF fallback. Consumed by Document Intelligence Pipeline (3.3), Capital Stack & Monitoring (5.1), Risk & Defense System (6.1), and Client Portal (11.10).
- **Business bureau integration** — Nav for Partners, Experian Business API, or D&B Direct+ (final vendor selection pending). Consumed by Document Intelligence Pipeline (3.3) and Consent & Authorization Center (1.5).
- **Personal credit integration** — Array or equivalent. Consumed by Document Intelligence Pipeline (3.3) and Consent & Authorization Center (1.5).

All three vendors require Argus vendor security review + DPA before V1 activation. Costs feed Cost & Performance Governance (11.9) as COGS lines.

Direct module-to-external-service integrations are prohibited. All external integrations route through Integration Layer.

---

## 6. Security posture

### 6.1 Threat model

The Console handles the most sensitive data class in the Green Companies portfolio: SSNs, EINs, full bank statements (via Plaid), tax returns, government IDs, credit reports (personal and business bureau), and business financial records for clients across all 50 states.

**V2 additions to threat model:**

- Compromised Plaid connection (attacker gains read access to client's bank data through Plaid impersonation or session hijack)
- Compromised bureau provider API credentials (attacker pulls bureau data on clients)
- Data exfiltration via Plaid or bureau API responses (client data leaves our systems in transit)
- Vendor compromise (Plaid, Nav, or personal credit provider suffers breach)

### 6.2 Security controls

**Identity & Access** — MFA required for all human access. Attribute-based access control combining role, department, tenant, and client-file permissions. Session logs and access reviews. Break-glass emergency access with mandatory audit trail.

**Encryption** — at-rest and in-transit encryption for all client data. Field-level encryption for highest-sensitivity fields (SSN, EIN, bank account numbers, tax ID). Key management with hardware security modules.

**Watermarking** — every document viewed or exported from the Secure Document Vault is watermarked with viewer identity and timestamp.

**Argus integration** — Argus is the internal cybersecurity partner. Console operations are within Argus's monitoring scope. Incident response runbooks integrate with Argus workflows. V2 addition: Argus reviews all third-party vendor integrations (Plaid, bureau, personal credit) before V1 activation.

**Least privilege** — Village agents get the minimum authority level required for their department's tasks. Level 4 restrictions are enforced by middleware.

**Vendor security posture verified** — Plaid, bureau provider, and personal credit provider must meet minimum bar (SOC 2 Type II, ISO 27001, or equivalent), documented in Compliance Evidence Vault.

**Data retention discipline** — Legal Hold & Record Retention module enforces state-specific retention rules. Retention beyond required periods is a liability, not an asset.

**Continuous monitoring** — System Health & Observability module includes security event monitoring, anomaly detection, and integration with Argus for alerting. V2 addition: Plaid API health, bureau provider API health monitored.

### 6.3 Regulatory compliance surface

The Console operates in a heavily regulated space:

- **FTC Act** — small-business financing facilitation; compliance embedded in Communication Compliance Scanner, Marketing Claim Library, and Deliverable Approval Workflow
- **CFPB Regulation Z** — business-purpose credit exemption from most TILA, but card issuance and unauthorized-use rules apply
- **CFPB Section 1071** — small business lending data collection tiers apply from 2026–2027 at the issuer level
- **State commercial financing disclosure laws** — CA SB 1235 + Oct 2023 UDAAP, NY commercial financing disclosure + AG MCA enforcement, UT / VA / GA / CT / FL disclosure regimes; Regulatory Engine holds per-state modules
- **18 USC §1014 and §1344** — false statements on credit applications; per-application written client authorization required before submission
- **Visa / Mastercard rules** — lawful-use language, cash-advance fee disclosure, AML / sanctions
- **State privacy laws** — CCPA, VCDPA, and other state privacy regimes
- **Referral fee regulations** — vary by state and product
- **FCRA (indirect)** — bureau data pulls carry FCRA-adjacent obligations; per-pull authorization required per Decision B
- **GLBA (indirect)** — Plaid connections carry Gramm-Leach-Bliley obligations; per-connection authorization required per Decision A

The Compliance Review Board reviews new marketing claims, client complaints, refund requests, edge-case funding recommendations, partner issues, state-law concerns, agent mistakes, adverse outcomes, and (V2 addition) categorical compliance state transitions on a weekly cadence.

---

## 7. Operational governance

### 7.1 Village authority model

Five Authority Levels:

| Level | Scope | Enforcement |
|---|---|---|
| 0 — Observe | Read documents, analyze files, generate internal reports | Middleware read-only mode |
| 1 — Prepare | Draft applications, emails, scripts, lender packets, recommendations — all draft state | Middleware blocks non-draft writes |
| 2 — Communicate with approval | Send client updates, document requests, partner follow-ups after human approval | Human approval required before dispatch |
| 3 — Submit with human approval | Submit applications or lender packets after human approval and client authorization | Human approval + client authorization required |
| 4 — Never allowed | Sign for client, fabricate revenue, change documents, submit without consent, guarantee approval, promise credit repair, mislabel cards as loans, hide fees, give legal/tax advice without professional review | Middleware hard block |

The Level 4 list is the non-negotiable perimeter.

### 7.2 Human oversight model

Human involvement concentrates at:

- **Founder-led sales conversion calls** — Readiness Blueprint Review Call at Comprehensive tier
- **Compliance Review Board** — weekly review of high-signal issues, including categorical compliance state transitions (V2 addition per Decision E)
- **Human Approval Console** — real-time approval queue for regulated actions, including Needs Review compliance state resolution (V2 addition per Decision E)
- **Escalation handling** — Concierge Desk humans handle escalated client relationships
- **Partner qualification** — Channel Partnerships humans qualify Ring 1 partners
- **Founder / Executive Workbench** — strategic decisions and cross-portfolio governance
- **V2 addition:** Credit union research workstream — Funding Strategy humans lead the V1.5 research on Alliant, PenFed, BECU, First Tech, Lake Michigan CU per Decision D

Small human team (estimated 8–15 people at V1.5 scale) supports thousands of client relationships through this model.

### 7.3 Agent quality control

The Agent QA & Evaluation Studio (module 2.6) provides:

- Random sampling of agent outputs
- Automated test suites against every deployed agent prompt change
- Degradation detection (agents that get worse over time)
- Human correction tracking (patterns feed back into prompt improvements)
- Compliance phrase scanning
- Incident postmortems

V2 addition: agent outputs are now checked for provenance discipline per Decision D and Section 3.8. Agents that produce recommendations without provenance metadata are flagged.

### 7.4 Change management

The Console changes constantly. Discipline:

- **Playbooks** — versioned in Playbook Builder, draft → review → active lifecycle
- **Marketing claims** — versioned in Marketing Claim Library, Compliance Review Board approval required
- **Agent prompts** — versioned in Village Agent Orchestration, tested by Agent QA before deployment
- **State modules** — versioned in Regulatory Engine, counsel review required for material changes
- **Contract templates** — versioned in Contract & Disclosure Builder, counsel review required for material changes
- **V2 addition: Lender rule provenance updates** — every rule change in Lender Intelligence Database logged with source, verification method, `lastVerified` timestamp

Every material change is logged to Event Ledger. Every material change has a rollback path.

---

## 8. Cross-Forge orchestration (revised for V2)

The Console's leverage comes from orchestrating multiple Forge platforms and integrations in coordinated patterns. Four institutional patterns:

### 8.1 The Authority-Tier Content Cascade

One source insight → multiple output formats via Marketing Ops governance. State-law change, lender appetite shift, credit union research completion, or new product release cascades through SelfPublisherForge, AnimaForge, VideoEditForge, FunnelForge, Marketing Claim Library, Partner Training curriculum. Governed by Marketing Ops (module 4.5, net new in V2).

### 8.2 The Diagnostic-to-Deliverable Pipeline (revised)

Client onboarding triggers full pipeline. Now anchored on Plaid and bureau data per Decisions A and B rather than assumed feeds:

Client Portal → Plaid Link → Consent & Authorization Center → Plaid → bureau providers → Document Intelligence Pipeline → CapitalForge Issuer Rules Engine → Funding Recommendation Engine (with provenance) → SelfPublisherForge → optional AnimaForge / VideoEditForge / VoiceForge → Deliverable Approval Workflow → Client Portal delivery → Event Ledger audit.

### 8.3 The Referrer Activation Loop

Closed loop from identification to attribution: TrafficForge (inside FunnelForge) → FunnelForge → SelfPublisherForge (referrer briefing document, three variants) → AnimaForge → Partner & Referrer Portal → CapitalForge attribution → FunnelForge CAC feed → Unit Economics Dashboard.

### 8.4 The Crisis Response Pattern (revised)

Red Alert triggers coordinated response. Now includes compliance categorical state Fail auto-triggering Firewall per Decision E:

Risk & Defense (Red Alert) → Workflow Engine (response playbook) → CapitalForge → VoiceForge (Concierge call) → VideoEditForge (founder message if warranted) → SelfPublisherForge (response packet) → Compliance Evidence Vault → Argus notification if security/fraud → Do Not Fund Governance if compliance state → Fail.

---

## 9. Data model overview

### 9.1 Core entities

Center on these entities:

- **Client** — the operator organization we serve
- **Entity** — legal entities within a Client's household graph
- **Owner** — individuals with ownership or guarantor relationships
- **Engagement** — a scoped commercial relationship with a Client
- **Application** — a specific funding application to a specific lender or provider
- **Funding Event** — an outcome record — approved, declined, funded, failed to fund
- **Deliverable** — an artifact produced for a Client
- **Communication** — an inbound or outbound message
- **Partner** — a Ring 1 referrer, co-brand, or white-label partner
- **Lender / Provider** — a capital source we work with
- **Village Agent** — an AI actor
- **Human Actor** — a founder, staff member, or compliance officer
- **V2 addition: Bureau Pull** — a per-authorization record of a business or personal credit pull
- **V2 addition: Plaid Connection** — a per-authorization record of a Plaid bank connection
- **V2 addition: Compliance Finding** — a specific finding that contributes to compliance categorical state per Decision E

### 9.2 Key relationships

- Clients have one or more Entities
- Clients have one or more Owners (with ownership percentages and PG status)
- Clients have zero or more Engagements
- Engagements produce zero or more Applications
- Applications produce zero or one Funding Event
- **V2:** Funding Event captures both `creditLimit` (requested) and `approvedCreditLimit` (granted, CHECK-constraint enforced in CapitalForge)
- Engagements produce many Deliverables
- Clients have many Communications
- Clients may be attributed to a Partner
- Applications target Lenders / Providers
- Every action has an actor (Village Agent or Human Actor)
- **V2:** Clients have zero or more Bureau Pulls and Plaid Connections, each with its own authorization record
- **V2:** Clients carry a compliance categorical state (Pass / Pass with Findings / Needs Review / Fail); compliance state transitions are events; Compliance Findings are related entities

### 9.3 Immutable audit records

The Event Ledger holds immutable records for:

- Client and Entity creation, modification, deletion
- Engagement start, milestone, completion, cancellation, refund
- Application preparation, authorization, submission, outcome (with `approvedCreditLimit` on approval)
- Deliverable draft, approval, delivery
- Communication send, receive, scan result
- Consent granted, revoked, expired (per-application, per-bureau-pull, per-Plaid-connection)
- Human approval granted, rejected, changed
- Payment charged, refunded, disputed
- Risk state change (Yellow / Orange / Red / Do Not Fund transitions)
- Firewall trigger and clear events
- **V2:** Compliance categorical state transitions with finding lists
- **V2:** Bureau pull events
- **V2:** Plaid Connection events
- **V2:** Workflow execution events (task started, task completed, workflow triggered, workflow completed)
- **V2:** Cross-portfolio handoff to Collingswood events
- Every agent action attempt (successful or blocked)

---

## 10. Success criteria (revised)

### 10.1 Operational

- Village agent throughput at 90–100% of scoped tasks without human intervention
- Human Approval Console SLA maintained
- Communication Compliance Scanner effectiveness (zero banned-language incidents reaching clients)
- Event Ledger integrity (verified quarterly)
- Regulatory Engine coverage (all 50 states operational by V2)
- **V2:** Workflow Engine SLA maintained (scheduled workflows fire on time, retries respect policy, wait-states resolve correctly)

### 10.2 Client outcomes

- Funding Readiness Score improvement (Phase 0 clients)
- Placement approval rate by product type (Phase 1 clients)
- Client retention by offer tier (Phase 2 clients)
- Complaint rate under target
- NPS above threshold
- Cost of capital achieved vs cost of capital targeted

### 10.3 Regulatory posture

- Zero adverse regulatory actions
- Zero material findings from any regulator inquiry
- Complete evidence vault coverage on every engagement
- Marketing Claim Library maintained under Compliance Review Board oversight
- State activation gate maintained
- **V2:** 90%+ of clients in Pass or Pass with Findings categorical state (per Decision E)
- **V2:** Every recommendation carries visible provenance (per Decision D portfolio-wide)

### 10.4 Unit economics

- CAC by channel within target
- LTV by client type within target
- Gross margin per offer within target (after V2 vendor COGS — Plaid, bureau, personal credit)
- Refund rate under target
- Agent cost per engagement declining over time
- **V2:** Vendor cost per client (Plaid subscription, bureau pulls, personal credit pulls) tracked and trending

### 10.5 Platform health

- API uptime target maintained
- Zero data breaches
- Zero cross-tenant data leaks
- Zero Level 4 agent actions succeeded (only blocked and logged)
- **V2:** Zero silent workflow failures (all failures logged and routed per retry policy)
- **V2:** Cost & Performance Governance identifying and correcting drift including vendor cost trends

### 10.6 Non-goals as success

- NOT feature velocity (velocity without discipline is scope drift)
- NOT user engagement time in Client Portal
- NOT Client Portal daily active users
- NOT time-in-app metrics
- NOT Product-Hunt-style vanity metrics

---

## 11. Deployment and rollout (revised timeline)

### 11.1 Build phasing (revised)

**V1 (months 0–6 revised from 0–5):** 46 modules covering Phases 0–2 workflows with priority state Regulatory Engine coverage. Anchor customer: MedLink Pro. Timeline revised upward to 150–180 days reflecting Workflow Engine load-bearing infrastructure, Plaid integration, bureau integration, categorical compliance state, and provenance discipline.

**V1.5 (months 6–12):** 12 modules covering Phases 3–5, expanded Regulatory Engine, credit union research workstream completion per Decision D. Anchor customers 2–4: Greenstone, Argus, Collingswood.

**V2 (months 12–24):** Full 50-state Regulatory Engine, complete Cross-Portfolio Opportunity Engine, ChamberForge bridge, ROBS at full volume, **native statement parsing capability in Console** per Decision A future roadmap. Optional generic ConsoleForge framework extraction.

### 11.2 State activation gate

No state comes online without documented counsel review of the state's Regulatory Engine module. Priority states (NV, CA, NY, TX, FL, AZ, UT) activate in V1; remaining states activate progressively through V1.5 and V2.

### 11.3 Anchor customer onboarding

Each anchor customer (MedLink Pro, Greenstone, Argus, Collingswood) serves as (a) a real client we serve at production quality, (b) a case study we can cite, and (c) a stress test for the platform.

### 11.4 Vendor activation gate (V2 addition)

Before V1 launch:

- **Plaid** — Argus vendor security review complete, DPA signed, SOC 2 Type II verified, integration tested
- **Business bureau provider** (Nav for Partners, Experian Business, or D&B — final selection pending) — same gate
- **Personal credit provider** (Array or equivalent) — same gate

No client onboards without all three vendor integrations tested and Argus-reviewed.

### 11.5 Backup and disaster recovery

Disaster Recovery & Business Continuity module (11.12) establishes:

- Automated daily backups verified quarterly
- RTO / RPO targets by data class
- Runbooks for ransomware, major Forge platform outage, data loss, security incident
- **V2:** Runbooks for Plaid outage, bureau provider outage
- Argus integration for incident response
- Quarterly DR drill

---

## 12. Open decisions (revised)

The five cross-platform decisions from v1 Section 12.1 are now resolved (see Preface). Remaining open decisions:

### 12.1 Console architectural decisions (all recommended, formal lock pending)

- **Authority Levels enforcement mechanism** — middleware layer (recommended, confirmed by architecture)
- **Multi-tenant isolation model** — strict separation with aggregation layer to Gardner and per-handoff consent to Collingswood (recommended, confirmed)
- **Event Ledger as canonical state source** — yes (recommended, confirmed)
- **Module API contract pattern** — semver with one-major-version deprecation window (recommended, confirmed)

### 12.2 Stack gaps

- **Accounting Forge** — recommendation: integrate with existing (QuickBooks / NetSuite) via Integration Layer for V1
- **Legal Ops Forge** — recommendation: integrate with existing contract management SaaS via Integration Layer for V1

### 12.3 Vendor selection

- **Business bureau provider** — Nav for Partners, Experian Business API, or D&B Direct+ (final selection pending vendor negotiations and Argus review)
- **Personal credit provider** — Array or equivalent (final selection pending)

### 12.4 Deferred to V2

- **Native statement parsing in Console** — build in V2 per Decision A future roadmap, at which point Plaid dependency reduces for the parsing use case (Plaid retained for direct bank connection)

---

## 13. Appendix — glossary

- **The Console** — the Burkham Wickmont Operations Console
- **The Village** — the AI agent workforce running Burkham Wickmont operations
- **The Ledger** — the Event Ledger (immutable state history)
- **Authority Levels** — the 0–4 framework governing Village agent action scope
- **The Firewall** — the Funding Ethics Firewall
- **The Vault** — the Compliance Evidence Vault or Secure Document Vault
- **The Scanner** — the Communication Compliance Scanner
- **The Engine** — the Funding Recommendation Engine
- **The Database** — the Lender Intelligence Database
- **The Portal** — the Client Portal (secure delivery room)
- **The Workbench** — either Agent Workbench (Village) or Founder / Executive Workbench (humans)
- **The Board** — the Compliance Review Board or Capital Product Governance Board
- **`issuer_rule` vs `unresearched_default`** — provenance tags in Lender Intelligence Database per Decision D
- **`approvedCreditLimit` vs `creditLimit`** — CapitalForge field distinction; success fees compute against `approvedCreditLimit` only
- **Compliance categorical state** — Pass / Pass with Findings / Needs Review / Fail per Decision E
- **Plaid Link** — Plaid's embedded connection widget used in Client Portal
- **Plaid Assets** — Plaid's PDF fallback service for statement parsing

---

## 14. Appendix — reference documents

- **Burkham Wickmont Company Specifications v2** — venture business specification
- **Burkham Wickmont Operations Console Blueprint v2** — module-by-module technical specification
- **This document** — architectural, technical, and operational cross-cutting specification (v2)
- **CapitalForge Specification** (2026-08-08, commit 45b2513) — source of audit findings and portfolio-wide architectural standards

---

## 15. Appendix — where this specification differs from v1

| Area | v1 | v2 |
|---|---|---|
| Design principles | 9 principles | 9 principles, with Section 3.8 and 3.9 now explicitly attributed to CapitalForge audit and applied portfolio-wide |
| Workflow Engine | Orchestration backbone (ambiguous depth) | Full execution engine with scheduler, task queue, wait-state manager, retry engine, event listener; largest single V1 build item |
| Data isolation | Strict tenant separation | Same + explicit Plaid, bureau, personal credit third-party data flow discipline |
| Third-party integrations | Not detailed | Plaid, business bureau, personal credit as V1 vendors with Argus security review + DPA gate |
| Threat model | Six threats | Nine threats (added: Plaid compromise, bureau credential compromise, vendor breach) |
| Compliance modeling | Numeric compliance score | Categorical state (Pass / Pass with Findings / Needs Review / Fail) driving workflow |
| Provenance discipline | Not explicit | Section 3.8 principle applied portfolio-wide per Decision D |
| V1 timeline | 120–150 days | 150–180 days |
| Success criteria | Non-goals section | Same + Vendor cost tracking, provenance visibility, workflow SLA |
| Open decisions | Five cross-platform + four architectural | Five cross-platform now resolved; four architectural pending formal lock; two vendor selection decisions added |

---

*End of specification v2.*
