# Plan — 7.3 Contract & Disclosure Builder

**Blueprint:** 7.3 · **Branch:** `ai-feature/m7-3-contract-disclosure-builder`
**Follows:** 7.2 State-by-State Regulatory Engine (merged, `b87e56a`)

---

## Why this module next

7.2 now holds what each state requires. 7.3 is what turns that into the documents a client actually
signs — and it is the natural successor because every input it needs exists: the activation gate,
the disclosure library with citations, the Marketing Claim Library, and the compliance scanner.

## Mini-PRD

### Problem

The Console can refuse to act in an unreviewed state and can tell you what California obliges. It
cannot produce the service agreement, fee exhibit or authorization form that obligation attaches
to. Those documents are currently written by hand, which means the disclosure a client receives and
the rule the Regulatory Engine holds are two texts maintained separately — and they will diverge,
silently, in the direction of whichever one somebody edited last.

### Success metrics

- A contract cannot be generated for a state the Regulatory Engine has not activated.
- Required disclosures are **inserted from 7.2**, not retyped — one text, one source.
- A success fee on a card is computed from `approvedCreditLimit` and cannot be computed from
  anything else.
- Every generated document pins the template version, state module version and clause set that
  produced it, and hashes its content model.

### Risks

| Risk                                                                | Mitigation                                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **An issued contract silently changes**                             | Generated documents are frozen. Staleness is reported against them; nothing rewrites one                   |
| A contract generates from an unreviewed template                    | Templates carry the same counsel-review discipline as state modules; an unreviewed version cannot generate |
| Disclosure text drifts from the rule it implements                  | Disclosures are inserted from 7.2 by key. There is no second copy of the words to drift                    |
| A success fee is taken on a requested rather than an approved limit | `successFeeBasis` takes one numeric argument, so there is no second figure to pass by mistake              |
| Banned language reaches a signed document                           | Generation runs the Communication Compliance Scanner and refuses on a block                                |

---

## Key decision — a generated contract is frozen; only the next one changes

Blueprint 7.3 lists "auto-updates when Regulatory Engine flags rule changes", and the careless
reading of that sentence is the most dangerous thing in this module. **A document a client signed
must never change afterwards.** A system that quietly rewrites an issued agreement is not a
convenience feature; it destroys the only evidence of what was agreed.

So what auto-updates is the **staleness of already-issued documents** — a derived report saying
"these twelve agreements were generated against California module version 3, which is now version
4; consider reissuing" — and the content of documents generated **next**. Nothing rewrites an
issued one.

Staleness is derived rather than stored, for the reason established in ADR-0007 and ADR-0009: a
stored flag needs a job to keep it true, and a job that stops leaves stale documents reading as
current.

## Key decision — disclosures are inserted from 7.2, never retyped

Blueprint 7.3's list of documents includes "not-a-lender disclosure" and "no-guarantee
disclosure". Both already exist as clauses in 7.2's federal baseline.

Generating them from their own template would create two texts saying the same thing, maintained
separately, and the failure mode is not that one becomes wrong — it is that nobody can tell which
one governs. The builder inserts by **key** from the Regulatory Engine, so there is one wording and
it lives with the citation that obliges it.

## Key decision — template review mirrors 7.2's discipline rather than sharing its code

Specification versioning: _"Contract templates — versioned in Contract & Disclosure Builder,
counsel review required for material changes."_ The same sentence it applies to state modules.

The obvious move is to extract a shared "reviewable versioned artifact". Not yet, deliberately:

- the **subject** differs — a jurisdiction versus a document
- the **blocking effect** differs — an unreviewed state module stops _all_ client action in that
  state; an unreviewed template stops one document type
- sharing would couple state activation to template publishing, so a change to how contracts are
  reviewed could alter when a state goes offline

Two similar things are not yet a pattern. **The trigger to extract is a third reviewable artifact
type**, and this note is here so whoever meets it knows the decision was made rather than missed.

---

## Architecture

```
packages/contracts/
  templates.ts   versioned templates; counsel review; material/editorial
  clauses.ts     the jurisdiction-aware clause library, scoped by state, tier and channel
  generate.ts    assembly: regulatory gate -> template -> clauses -> disclosures -> hash
  fee.ts         the fee exhibit, and the Seek Capital invariant
  staleness.ts   which issued documents are behind a module version, derived
```

### Data model — schema `contracts`

- `ContractTemplate` — key, version, kind, title, sections, `changeKind`, supersession
- `TemplateReview` — the counsel review that permits a version to generate
- `Clause` — key, version, text, jurisdiction (`*` or state code), tiers, channels, citation
- `GeneratedContract` — client, kind, template version, **state module version**, content, hash,
  the clause and disclosure keys inserted, who generated it, when

The content model is the artifact and the hash is over its canonical JSON — ADR-0005, applied to a
document that creates legal obligations rather than one that merely informs.

---

## Test strategy

- Generation refuses for an unactivated state, and names the state.
- Generation refuses from a template version counsel has not reviewed.
- A material template republish stops generation until re-reviewed; an editorial one does not.
- The federal baseline and the state layer both appear in the generated content, by key.
- A clause scoped to another state does not appear; one scoped to this state does.
- A partner-channel document carries the partner disclosure; a direct one does not.
- The success fee comes from the approved limit; there is no path to compute it from the requested.
- Generation refuses when the assembled text trips the Communication Compliance Scanner.
- An issued document is unchanged by a later module version, and appears in the staleness report.
- The audit trail pins template version, module version, clause keys and disclosure keys.
- Re-hashing a stored content model reproduces its recorded hash.

---

## Out of scope

Rendering to PDF (3.1 already owns rendering; the content model is the artifact either way).
E-signature capture — 1.5 Consent & Authorization Center owns authorizations, and a signature is
its own module. 1.4's offer ladder: tier and fee figures arrive with the request, as the
underwriting profile did before 1.2 existed.

> **Note on the template content.** Like 7.2's state modules, the seeded contract language is a
> scaffold for counsel, not legal advice. It ships unreviewed and cannot generate until a named
> human at Level 3 records a review.
