# Plan — Category 3 slice A: deliverables, approval, and the Compliance Scanner

**Blueprint:** 3.1 Document & Deliverable Management · 3.4 Deliverable Approval Workflow ·
4.2 Communication Compliance Scanner · 7.4 Marketing Claim Library
**Branch:** `ai-feature/m3-deliverables-and-compliance-scanner`
**Follows:** module 2.2 complete (merged, `48698e6`)

---

## Why these four together

Category 3 has four modules. They do not slice evenly by category, because 3.4 is blocked by a
module in a different category:

> Every deliverable passes: agent draft → QA check → **Communication Compliance Scanner** → human
> review (if required) → final PDF generation → client delivery log — _blueprint 3.4_

The Scanner is module **4.2**, and it does not exist. Building 3.4 without it would leave the
approval pipeline unable to complete — the same shape as middleware step 5, which today refuses
every client-facing action because the Regulatory Engine is absent.

One such honest blockage is discipline. Two, stacked so that _nothing client-facing can ever
complete_, is a system that cannot be demonstrated or trusted. So this slice includes 4.2 and the
Marketing Claim Library (7.4) it reads from. Both are V1 scope, both are small, and together they
unblock 3.4 **and** middleware step 7.

Deferred to later Category 3 slices, in dependency order:

- **3.2 Secure Document Vault** — encryption at rest, watermarking, access logs, retention hooks,
  legal hold. Security-heavy; deserves its own review rather than riding along.
- **3.3 Document Intelligence Pipeline** — needs 3.2 for storage and is the most vendor-blocked
  module in V1 (Plaid, bureau and personal credit are all ungated).

---

## Mini-PRD

### Problem

A workflow can now run to completion, and the result is nothing a client can receive. The
Diagnostic-to-Deliverable pipeline (blueprint §4.2) ends in "Client Portal (delivery)", and every
step before it exists while the deliverable itself does not.

Two v2 changes make this more than a templating exercise:

- **Decision D / principle 8** — every deliverable carrying lender recommendations, bureau data or
  compliance state must surface **provenance visibly**, and unresearched defaults must be labelled
  as such _in client-facing output_.
- **Decision E** — compliance state appears as a category with its finding list, never a number.

Those are the reasons this module cannot be a wrapper around a PDF library.

### Users

- **Village agents** draft deliverables from templates.
- **Compliance & Evidence** review and approve before anything reaches a client.
- **Clients** receive versioned, dated, brand-consistent documents.
- **Regulators** receive the evidence trail, which is the same artifact plus its history.

### Success metrics

- No deliverable reaches a client without passing the Scanner.
- Every figure derived from a lender rule or vendor feed carries visible provenance.
- Compliance state renders as a category with findings, and there is no code path that renders it
  as a number.
- A delivered deliverable is reproducible from the Ledger: content hash, version, approver, time.

### Risks

| Risk                                                            | Mitigation                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provenance becomes a rendering flourish rather than data        | The content model requires `Sourced<T>`; the renderer reads it, and a test renders a document with an `unresearched_default` and asserts the label appears |
| Banned language reaches a client                                | Scanner runs on the assembled content, not on the template; delivery is refused, not warned                                                                |
| The Scanner becomes a substring toy that blocks legitimate text | Word-boundary matching, a documented rationale per phrase, and tests for both directions — false negatives _and_ false positives                           |
| PDF rendering becomes the audit artifact                        | The audit anchor is the **content hash**, not the bytes. See below                                                                                         |

---

## Key decision — what is the audit artifact

A deliverable is evidence. Blueprint 7.1 generates regulator-ready files from it, and 3.1 requires
every deliverable "version-controlled and audit-logged; signed and dated".

The tempting design is to render a PDF and hash the PDF. That makes the _bytes_ the artifact, and
bytes are fragile: a font substitution, a library upgrade, or a timestamp in the PDF trailer
changes the hash without changing a word of what the client was told.

**Decision:** the deliverable is a **structured content document** — sections, fields, each
figure carrying its provenance — which is versioned, hashed and anchored in the Ledger. The PDF is
a _rendering_ of it. Two renderers implement one interface, so the rendering choice is swappable
and never load-bearing for the audit trail.

This also makes the Scanner meaningful: it scans the content model, so it cannot be defeated by
text that only appears after rendering.

## Key decision — PDF library

| Option                                | Assessment                                                                                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Puppeteer / Playwright (HTML→PDF)** | Best fidelity and easiest brand styling, but bundles Chromium — a large attack surface and a heavy image for a worker that also touches SSNs and bank data. Rendering varies by browser version.                                                |
| **`@react-pdf/renderer`**             | Pleasant authoring model, but pulls React into a backend package that otherwise has none, and its layout engine is the least mature of the three.                                                                                               |
| **`pdfkit`** _(recommended)_          | Pure JS, no browser, no native deps, mature. Programmatic layout suits structured business documents (headed sections, labelled figures, footnotes) far better than free-form design. Deterministic enough that a rendering diff is meaningful. |

**Recommendation: `pdfkit`**, declared on the package that imports it. ADR-0005.

Fidelity concerns are muted by the architecture above: if a future deliverable needs
design-heavy layout, a second renderer implements the same interface without touching the content
model or the audit trail.

---

## Architecture

```
packages/
  claims/         7.4 Marketing Claim Library - approved + banned phrases, versioned
  scanner/        4.2 Communication Compliance Scanner - scans content, blocks or escalates
  deliverables/   3.1 content model, templates, versioning, hashing, renderers
                  3.4 approval workflow: draft -> QA -> scan -> human review -> deliver
```

### The content model

```ts
DeliverableDocument {
  templateKey, templateVersion
  title, client, generatedAt
  sections: Section[]
}
Section  = { heading, blocks: Block[] }
Block    = Paragraph | KeyFigures | ComplianceStateBlock | FindingList | Disclosure | Table
```

`KeyFigures` holds `Sourced<T>` values, so a figure **cannot be added without provenance** — the
same structural requirement `@bwc/placement` already uses. `ComplianceStateBlock` takes the
categorical state and its findings; there is no numeric field to render.

### Content hash

`sha256` over the canonical JSON of the content document (same stable-stringify discipline as the
Ledger signature). Recorded on the deliverable row and in the ledger event, so "was this the
document we sent?" is answerable without keeping the bytes.

### Approval pipeline (3.4)

```
draft -> qa_checked -> scanned -> awaiting_human -> approved -> delivered
                          |                            |
                       blocked                      rejected
```

Each transition is a ledger event. `deliver()` refuses unless the document reached `approved`, and
`approve()` refuses unless it passed the scan. Ordering is enforced by state, not by call order.

### Scanner (4.2)

Word-boundary matching against the banned library, plus requires-disclaimer detection. Returns
`clean | findings | blocked`. Novel-language escalation (blueprint 4.2) records a
`scanner.novel_language` event for Compliance Review Board attention rather than guessing.

---

## Test strategy

- A document cannot be assembled with a figure lacking provenance.
- An `unresearched_default` is **visibly labelled** in rendered output — asserted on the rendered
  text, not on the model.
- Compliance state renders as a category with findings; no renderer path emits a number.
- Banned phrases are caught with word boundaries: "guaranteed approval" blocks, "no guarantee of
  approval" does not.
- Delivery is refused for an unscanned document, a blocked document, and an unapproved document.
- The content hash changes when content changes and is stable across re-renders.
- Every state transition writes a ledger event.
- A template renders identically twice (deterministic content, stable hash).

---

## Out of scope

3.2, 3.3, the Client Portal delivery surface itself (11.10), SelfPublisherForge long-form
generation, and the remaining 12+ of the "15+ required templates" — the template _system_ is built
and two real templates ship with it; the rest is authoring work, not engineering.
