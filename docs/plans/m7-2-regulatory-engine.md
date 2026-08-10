# Plan — 7.2 State-by-State Regulatory Engine

**Blueprint:** 7.2 · **Branch:** `ai-feature/m7-regulatory-engine`
**Follows:** the PII redactor fix (merged, `a8a11fa`)

---

## Why this module next

The middleware chain has a `regulatory` step, wired since the walking skeleton, that returns
`not_built` for every client-facing action. It is the **last `not_built` in the fixed seven-step
chain** — the same shape of gap 5.2 and 1.2 were.

It is also the one the specification is most emphatic about:

> "The Regulatory Engine is not a post-hoc check. No client-facing action fires without state
> compliance checks having passed. State activation itself is gated."

And 5.4 already builds the pull side of the propagation this module consumes — `stateRestrictions()`
and `providersPermittedIn()` exist in `@bwc/governance` waiting for a reader.

## Mini-PRD

### Problem

The Console can produce a client-facing deliverable, scan it for banned language, and place a
client with an approved provider — with no knowledge of whether it is permitted to do any of that
in the client's state. Commercial financing disclosure law is not uniform: California's SB 1235 and
New York's regime require specific disclosures on specific products, and Utah, Virginia, Georgia,
Connecticut and Florida each have their own. Getting this wrong is not a compliance finding; it is
the company operating unlicensed.

### Success metrics

- No client-facing action fires for a client in a state that has not been activated.
- **No state activates without a recorded counsel review naming a human and a document.**
- A material change to an activated state's module returns it to review.
- Required disclosures arrive with the law they come from, not as bare strings.

### Risks

| Risk                                                               | Mitigation                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **An agent activates a state**                                     | Activation requires a human actor at Level 3 and a counsel-review record; there is no code path an agent can reach      |
| A material rule change ships without review                        | `changeKind` is a required argument, not a default; editorial changes require a rationale; version 1 is always material |
| The seeded state content is mistaken for legal advice              | Seeds are `draft`, cite their statute, and are unusable until counsel reviews them — the gate enforces this by itself   |
| A refusal reads as a bug                                           | Every refusal names the state, its status, and what would activate it                                                   |
| The engine silently passes when it cannot determine a jurisdiction | It refuses. "We could not tell which state" is not the same as "no state rule applies"                                  |

---

## Key decision — the activation gate is the module

Everything else here is a lookup table. The gate is the thing the specification calls out twice,
and the thing that makes the table trustworthy.

**A state with no activation record is not active.** Same structural default as governance standing
in 5.4: absence resolves to the safe answer, rather than a default value somebody can edit.

**Activation requires a human at Level 3 and a `CounselReview` row** naming the reviewer, the date,
and a document reference. An agent cannot activate a state — not by policy, but because
`activateState` refuses any actor that is not a Level 3 human, and the review record has no
constructor that omits its document.

The cost is real and worth stating: **a client in a state we have not activated cannot be served**,
and the refusal will block work. That is the intended behaviour. The alternative — serving them
while the module sits unreviewed — is the failure the gate exists to prevent.

## Key decision — a material change returns an active state to review

Specification §"versioned": _"State modules — versioned in Regulatory Engine, counsel review
required for material changes."_

So `publishStateModule` takes a required `changeKind: 'material' | 'editorial'`. Material publishes
move an active state to `needs_counsel_review`, which is not active. Editorial ones need a stated
rationale and leave activation intact.

This deliberately differs from 5.4, where a complaint **flags** a provider rather than suspending
it. The difference is who is acting and on what evidence. There, a third party's complaint is weak
evidence and auto-suspension would let one unhappy client remove a provider. Here, _we_ changed the
rules, deliberately, and the specification says counsel must see material changes. Nobody is
surprised by a consequence they chose.

Version 1 is always material: there is no prior version for it to be editorially different from.

## Key decision — the engine refuses when it cannot determine a jurisdiction

A client-facing action with no resolvable state is not the same as one with no state rules. The
chain resolves jurisdiction from the client's Entity Graph (1.2), and refuses if it cannot — naming
what would fix it.

---

## Architecture

```
packages/regulatory/
  states.ts       state modules, versioned; the material/editorial rule
  activation.ts   the gate: counsel review -> active; status derived at read time
  disclosures.ts  required disclosures per state per product, each with its citation
  check.ts        the check the middleware and application submission call
  seed.ts         the seven V1 priority states, as drafts, with citations
```

### Data model — schema `regulatory`

- `StateModule` — state, version, summary, per-product disclosure requirements, marketing rules,
  `changeKind`, supersession
- `CounselReview` — state, module version, reviewer, review date, document reference, outcome
- `StateActivation` — one per state: status, the module version reviewed, when

Activation status is **derived** from the activation row against the current module version, for
the same reason standing is in 5.4: a stored "active" flag and a newer module version drift, and
the stored one is the one that would silently be wrong.

### Middleware

Step 5 becomes real. `chain()` gains an optional `jurisdiction`; when absent and a `clientId` is
present, it resolves from the Entity Graph.

> **Deviation from plan, recorded after the fact:** the chain does **not** resolve the jurisdiction
> from the Entity Graph. It takes it as a value and refuses without one.
>
> `@bwc/graph` depends on `@bwc/lenders`, so importing it into `@bwc/middleware` would put the
> compliance gate — the module that decides whether anything may happen at all — downstream of the
> lender catalogue. That is the wrong direction for a dependency, and the convenience it buys is
> one line at each call site.
>
> Forgetting to pass a jurisdiction is safe: it produces a refusal naming what to pass, not a
> silent pass. See the "Alternatives rejected" section of ADR-0009.

---

## Test strategy

- A state with no module is not active; a drafted state is not active.
- An agent cannot activate a state, at any authority level below 3 and as a non-human.
- Activation without a document reference is refused.
- A material republish deactivates; an editorial one does not; an editorial one with no rationale
  is refused.
- Version 1 cannot be editorial.
- Disclosures come back with citations, per state and per product.
- A product with no state-specific requirement returns the federal baseline, not an empty list.
- The chain refuses client-facing content for a client in an unactivated state.
- The chain refuses when jurisdiction cannot be determined.
- The chain passes for a client in an activated state, and attaches the disclosures.
- The seven V1 priority states seed as drafts and none is active.

---

## Out of scope

7.3 Contract & Disclosure Builder (generates documents _from_ these rules; own slice). The
remaining 43 states — V1 covers the priority seven per the blueprint. Automatic ingestion of
state-law changes from an external feed; the tracker records changes that a human enters.

> **Note on the seeded content.** The state modules seeded here cite the statutes the specification
> names and are written as a starting scaffold for counsel, not as legal advice. They ship as
> `draft` and are unusable until reviewed, which is precisely what the activation gate is for.
