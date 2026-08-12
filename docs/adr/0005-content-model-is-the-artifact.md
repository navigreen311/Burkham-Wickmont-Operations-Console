# ADR-0005 — The deliverable content model is the artifact; the PDF is a rendering

**Status:** Accepted
**Date:** 2026-08-10
**Context documents:** Blueprint 3.1, 3.4, 7.1; Specification v2 §3.8 (Decision D), Decision E

## Context

Blueprint 3.1 requires every deliverable to be "version-controlled and audit-logged; signed and
dated", with "PDF generation with Burkham Wickmont stationery". Blueprint 7.1 generates
regulator-ready files from these deliverables.

The obvious implementation is: render a PDF, store the bytes, hash the bytes, done.

## The problem with hashing bytes

That makes the _rendering_ the artifact of record, and renderings are fragile in ways that have
nothing to do with what a client was told. A font substitution, a `pdfkit` upgrade, a change in
how a library writes its trailer — each changes the hash while every word on the page is
identical. Conversely, two renderings that differ only in whitespace hash differently, so
"is this the document we sent?" becomes unanswerable in exactly the situation where it matters.

Two v2 decisions push in the same direction:

- **Decision D / principle 8** — provenance must be _visible in client-facing output_. If
  provenance is added during rendering, it is a presentation flourish that a second renderer will
  implement differently or omit.
- **Decision E** — compliance state is categorical. If a renderer receives a number and formats it
  as a category, the number is still in the system and something will eventually print it.

## Decision

A deliverable is a **structured content document**: sections of typed blocks, where every figure
is a `Sourced<T>` and the compliance block holds a category plus findings and has no numeric
field. That document is versioned, hashed (`sha256` over canonical JSON), and anchored in the
Event Ledger.

Renderers implement `Renderer<T>` and consume the model. Two ship: text and PDF. Both flatten
figures through the same `renderFigure`, so provenance surfacing exists once rather than per
format.

**Consequences that follow directly:**

- The Compliance Scanner scans the _content model_, so banned language cannot enter during
  rendering, and a phrase interpolated from client data is checked as thoroughly as the template.
- Provenance cannot be omitted, because a figure cannot be constructed without it.
- No renderer can print a compliance score, because no score exists to print.
- The evidence trail survives a rendering-library change.

## PDF library

| Option                  | Assessment                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Puppeteer / Playwright  | Best fidelity, but bundles Chromium into a process handling SSNs and bank data — a large attack surface for headed sections and labelled figures. Output varies by browser version. |
| `@react-pdf/renderer`   | Pleasant authoring, but pulls React into a backend package that has none, and has the least mature layout engine.                                                                   |
| **`pdfkit`** _(chosen)_ | Pure JS, no browser, no native dependency, mature. Programmatic layout suits structured business documents.                                                                         |

Fidelity risk is muted by the architecture above: a design-heavy deliverable can get a second
renderer without touching the content model or the audit trail.

## Consequences

**Good.** The evidence is stable under rendering changes. Provenance and categorical compliance
are enforced by types rather than by renderer discipline. The Scanner sees everything a client
would read.

**Bad.** Layout is programmatic, so a heavily designed document is more work here than in an HTML
pipeline. Accepted: these are financial and compliance documents, where consistency matters more
than visual range.

**A bug this exposed.** `Provenance` originally carried `Date` objects. Deliverable content is
stored as JSON, so those came back as strings and `describeProvenance` threw on
`.toISOString()` — meaning **any stored deliverable would fail to render**. Invisible in unit
tests, which never persist. Provenance timestamps are now `IsoTimestamp` (ISO strings), because a
type that crosses a JSON boundary should be JSON-native. Guarded by a test that re-reads a
deliverable from the database before rendering it.

**Revisit when:** a deliverable needs design fidelity that programmatic layout cannot reach. The
answer then is a second renderer, not a change to the content model.
