# Plan — 7.1 Compliance Evidence Vault

**Blueprint:** 7.1 · **Branch:** `ai-feature/m7-1-compliance-evidence-vault`
**Follows:** 1.3 Sales Motion & Engagement Tracking (merged, `fa4fb0d`)

---

## Why this module is different from the others

Read blueprint 7.1's data model and every line names something another module already owns:

> "Signed authorizations … client-submitted documents … application versions … human approval logs
> … communication records … funding outcome records … complaint history … refund analyses …
> compliance categorical state transitions with reasoning per Decision E."

Consent owns authorizations. The Vault owns documents. 1.1 owns state transitions. 5.4 owns
complaints. 1.4 owns refunds. **7.1 owns almost nothing.** It assembles.

That is the design decision, and getting it wrong is the obvious failure: a module that _copied_
this data into its own tables would produce a second version of every fact, drifting from the first,
and the copy is the one a regulator would be shown.

## Mini-PRD

### Problem

The blueprint asks for "regulator-ready file generation in minutes". Today that means somebody
opening nine modules and hoping they remembered all nine. Nothing tells them what they missed, and
a file with a silent gap is worse than no file — it asserts completeness it does not have.

### Success metrics

- A file assembles from live sources, never from a copy.
- **The file names what it could not include**, per source, with the reason.
- The file carries a Ledger integrity result, so its claims can be checked rather than trusted.
- An export is itself recorded: who, when, why, and the hash of what they took.

### Risks

| Risk                                                      | Mitigation                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **A silent gap presents as completeness**                 | Every source reports coverage; `not_built` and `failed` are carried into the file, not filtered out           |
| The vault becomes a second copy of the truth              | It holds no client facts — only the record of exports                                                         |
| One failing source empties the whole file                 | Sources are independent; a failure is a coverage entry, and the rest of the file still assembles              |
| An export record leaks PII                                | The record carries ids, a purpose and a hash. The file carries the data; the record of it does not            |
| A legal hold is bypassed by exporting through this module | The file carries document **metadata**; the bytes still go through 3.2's gate, which blocks export under hold |

---

## Key decision — the file reports its own coverage

Every source returns items **and** a coverage verdict:

| Verdict     | Meaning                                  |
| ----------- | ---------------------------------------- |
| `complete`  | consulted, returned everything it holds  |
| `empty`     | consulted, holds nothing for this client |
| `not_built` | the module does not exist yet            |
| `failed`    | consulted and errored                    |

`empty` and `not_built` are different claims and the file says which. "This client has no
complaints" and "we have no complaints module" both produce zero rows, and a regulator reading the
first when the second is true has been misled by an omission nobody intended.

This is design principle 9 applied at the level of a whole document rather than a function.

## Key decision — one source failing does not empty the file

Sources run independently and a failure becomes a coverage entry. The alternative — abandoning the
assembly — would mean the file is unavailable exactly when something is already wrong, which is
when it is most likely to be wanted.

## Key decision — the integrity result travels with the file

The Ledger is hash-chained and signed. Without `verifyIntegrity`'s result attached, the file is a
set of claims with no evidence they were not edited afterwards; with it, a reader can check rather
than trust. A broken chain is reported in the file rather than blocking it, for the same reason as
above.

---

## Architecture

```
packages/evidence/
  sources.ts   the registry: each source, its module, and how it reports coverage
  assemble.ts  per-client and per-engagement assembly
  export.ts    the export record, its hash, and re-verification
```

### Data model — schema `evidence`

- `EvidenceExport` — scope, who, why, when, content hash, and the coverage map at the time

Only one table, deliberately. Everything else is read live.

### Dependency direction

Everything flows **into** this package and nothing flows out. No other module imports it, so a wide
dependency list cannot create a cycle — and the width is honest, because the module's whole job is
to reach every source of audit evidence.

---

## Test strategy

- The file names a `not_built` source rather than omitting it.
- `empty` and `not_built` are distinguishable in the output.
- One failing source does not prevent the rest assembling.
- The compliance state transition history and the findings that produced it both appear.
- The Ledger integrity result is present and reports the number checked.
- An export is recorded with a hash that re-verifies.
- The export record carries no PII.
- A per-engagement file is scoped to that engagement, not the whole client.

---

## Out of scope

Rendering the file as a PDF or a zip — the content model is the artifact, per ADR-0005. The
Compliance Review Board interface (a UI). Document **bytes**: the file carries metadata and the
bytes still go through 3.2's access gate, which is what enforces legal hold.
