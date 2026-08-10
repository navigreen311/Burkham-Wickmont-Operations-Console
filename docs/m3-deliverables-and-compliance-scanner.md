# Deliverables, Approval, and the Compliance Scanner

Category 3 slice A. Four modules: **3.1** Document & Deliverable Management, **3.4** Deliverable
Approval Workflow, **4.2** Communication Compliance Scanner, **7.4** Marketing Claim Library.

This is the first slice that produces something a client receives.

## Why 4.2 and 7.4 are here

Blueprint 3.4 orders the pipeline as _agent draft → QA check → **Communication Compliance
Scanner** → human review → final PDF → client delivery log_. The Scanner is module 4.2 and did not
exist.

Building 3.4 without it would have left a second permanently-blocked path, on top of middleware
step 5 already refusing every client-facing action until the Regulatory Engine (7.2) lands. One
honest blockage is discipline; two, arranged so nothing client-facing can ever complete, is a
system that cannot be demonstrated. Both extra modules are V1 scope and small.

## The content model is the artifact (ADR-0005)

A deliverable is a structured document — sections of typed blocks — that is versioned, hashed and
anchored in the Ledger. The PDF is a _rendering_ of it.

Hashing rendered bytes would make a font substitution or a `pdfkit` upgrade change the evidence
while every word stayed the same. Hashing the content means "was this what we sent?" survives a
rendering change.

Three consequences follow from the types, not from discipline:

| Requirement                                             | How the type enforces it                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provenance visible in client-facing output (Decision D) | `KeyFigure.value` is `Sourced<T>` — a figure **cannot be constructed** without provenance                                                                               |
| Compliance state categorical (Decision E)               | `ComplianceStateBlock` has a state and findings and **no numeric field**, so no renderer can print a score                                                              |
| Banned language never reaches a client                  | The Scanner scans the **content model**, so language cannot enter during rendering, and a phrase interpolated from client data is checked as thoroughly as the template |

An unresearched default is labelled `[Unverified assumption]` at the figure and triggers a
document-level notice, because a reader who skims the figures still has to be told.

## The approval pipeline (3.4)

```
draft ──▶ qa_checked ──▶ scanned ──▶ awaiting_human ──▶ approved ──▶ delivered
                            │                              │
                         blocked                        rejected
```

**Ordering is enforced by state, not by call order.** `deliver()` does not ask "did you remember
to scan"; it requires `approved`, which is only reachable from `scanned`, which is only reachable
from `qa_checked`. A caller cannot skip a step by calling the last function first, and a caller
added next year inherits the ordering for free.

- **QA** is structural — empty sections, missing client name, a date that is not an ISO date. Not
  a compliance judgement; it stops broken documents from consuming a human reviewer.
- **Scan** blocks terminally. The remedy for banned language is a new draft, not a retry of the
  same content, so `blocked` has no edge back.
- **Approval requires a human actor.** An agent approving its own draft would make the step
  ceremonial — the same reasoning that stops an agent clearing the Firewall it triggered.
- **Delivery re-checks the content hash** against the stored content, so a row edited outside the
  pipeline is caught before anything reaches a client.

Every transition writes a ledger event, and the delivery event carries the content hash and
approver — so blueprint 7.1 can answer "what exactly did we send, and who approved it" from the
Ledger alone, without a document archive.

## The Scanner (4.2)

Blocking, not advisory. A scanner that warns is a scanner whose warnings get dismissed under
deadline, and "guaranteed approval" in writing is not recoverable once sent.

**Word-boundary matching, never substrings.** That is the whole difficulty of the module:

| Must block                          | Must pass                                                   |
| ----------------------------------- | ----------------------------------------------------------- |
| `You have guaranteed approval.`     | `No guarantee of approval is expressed or implied.`         |
| `This is a no risk opportunity.`    | `Risk factors are described in the accompanying schedule.`  |
| `We can remove negative items.`     | `Negative items cannot be removed by anyone, including us.` |
| `guaranteed\napproval` (line break) | `The unguaranteed approvals list is attached.`              |

A scanner with false positives gets routed around, and then it protects nothing — so the
false-positive cases are tested as heavily as the false negatives.

**An empty library refuses rather than reporting clean.** A scan that checked nothing returning
"clean" is the most dangerous possible result, because it looks like a pass. Same discipline as
`verifyIntegrity` reporting how many entries it checked.

Blocks write a ledger event naming the phrase and rationale — **not** the offending client text,
which does not belong in an append-only store retained indefinitely.

## The Claim Library (7.4)

Twelve founding entries, each drawn from language the blueprint or specification names, and each
carrying a **rationale**. Blueprint 7.4 requires documented ban rationale for training; the
practical reason is sharper — a banned phrase with no stated reason cannot be taught to a partner,
argued with when an agent thinks it is wrong, or safely revisited when the law changes. It
calcifies into folklore.

Entries are **deprecated, never deleted**: a phrase banned in March and permitted in June must
still explain a March deliverable.

Jurisdiction uses the sentinel `*` rather than NULL. Postgres treats `NULL != NULL`, so a unique
constraint containing a nullable column would have permitted two "global" entries for the same
phrase — precisely the duplicate the constraint exists to prevent. A state-scoped ban _adds_ to
the national list rather than replacing it.

## Templates

Two ship: **Capital Command Brief** and **Funding Suitability Memo**. Both carry the not-a-lender
and no-guarantee disclosures and both require human review.

Blueprint 3.1 calls for "15+ required templates". The template _system_ is what this slice builds;
these two exercise every part that matters. Shipping thirteen stubs would make the count look
complete while the content was invented — the failure principle 9 exists to prevent. The rest is
authoring work.

## Running it

```bash
pnpm test                  # 165 tests
pnpm test:invariants
```

```ts
await seedFoundingClaims(tenantId, 'compliance_review_board', actor);
for (const template of SHIPPED_TEMPLATES) await registerTemplate(template);

const doc = buildCapitalCommandBrief({/* ... */});
const d = await draft({ tenantId, clientId, document: doc, actor: agent });
await runQaCheck(tenantId, d.value.id, agent);
await runComplianceScan(tenantId, d.value.id, agent);
await requestHumanReview(tenantId, d.value.id, agent);
await approve(tenantId, d.value.id, human); // human actor required
await deliver(tenantId, d.value.id, human);
```

## Known gaps

- **Delivery does not pass the middleware chain.** Blueprint 3.4 specifies its own pipeline and
  that is what is implemented; the middleware chain governs _agent actions_. When the Regulatory
  Engine (7.2) lands, delivery should additionally clear a state-compliance check — flagged rather
  than assumed away, because principle 6 gates client-facing action on exactly that.
- **Middleware step 7 remains a skip.** The Scanner now exists, but step 5 refuses every
  client-facing action before step 7 is reached, so wiring it would add an unreachable path.
  Deliverables call the Scanner directly, which is the real client-facing route today.
- **Novel-language escalation is a seam, not a detector.** Judging whether a claim is _new_ is a
  human judgement, so `escalateNovelLanguage` records a reviewer's decision rather than a
  heuristic pretending to make it.
- **No delivery channel.** `deliver()` records delivery; the Client Portal (11.10) is where a
  client actually collects it.
- **3.2 Secure Document Vault and 3.3 Document Intelligence Pipeline** are the remaining Category
  3 modules, in that order — 3.3 needs 3.2 for storage and is the most vendor-blocked module in V1.
