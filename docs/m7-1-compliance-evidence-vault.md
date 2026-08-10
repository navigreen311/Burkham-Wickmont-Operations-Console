# 7.1 Compliance Evidence Vault

**Package:** `@bwc/evidence` · **Schema:** `evidence`

---

## This module owns almost nothing

Read blueprint 7.1's data model and every line names something another module already holds —
authorizations, documents, approval logs, complaints, refunds, state transitions. **7.1 assembles.**

That is the design, and getting it wrong is the obvious failure: a module that copied these facts
into its own tables would produce a second version of each, drifting from the first, and **the copy
is the one a regulator would be shown.**

One table exists: the record that an export happened. _"Who took a copy of this client's file, when,
and why"_ exists nowhere else, and it is precisely the question asked when a file turns up somewhere
it should not have.

---

## The file names what it could not include

Every source reports items **and** a coverage verdict:

| Verdict     | Meaning                                  |
| ----------- | ---------------------------------------- |
| `complete`  | consulted, returned everything it holds  |
| `empty`     | consulted, holds nothing for this client |
| `not_built` | the module does not exist yet            |
| `failed`    | consulted and errored                    |

**`empty` and `not_built` are different claims and the file says which.** "This client has no
complaints" and "we have no complaints module" both produce zero rows, and a regulator reading the
first when the second is true has been misled by an omission nobody intended.

Design principle 9, applied to a whole document rather than a function.

Three sources are deliberately `not_built` and stay in the registry:

- **Communications Hub (4.1)** — with a note that a reader "should not treat its absence as
  evidence that nothing was said".
- **Client complaints** — with an explicit warning that 5.4 holds complaints about **providers**,
  which is a different record and not a substitute.
- **Adverse-action notices (5.5)** — deferred to V1.5.

`gaps` restates them at the top level, so a reader does not have to scan the coverage map.

---

## One failing source does not empty the file

Sources run independently; a failure becomes a coverage entry. The alternative — abandoning the
assembly — would make the file unavailable at exactly the moment something is already wrong, which
is when it is most likely to be wanted.

---

## The integrity result travels with the file

`verifyIntegrity` runs over the tenant's hash-chained Ledger and its result is attached. Without it
the file is a set of claims with no evidence they were not edited afterwards; with it, a reader can
check rather than trust. A broken chain is **reported** rather than blocking, for the same reason
as above.

---

## The hash covers evidence, not the assembly

The reconciliation test found a real flaw. The hash originally covered the whole file — including
the Ledger integrity count, **which the act of exporting increments**, because the export writes an
event of its own. A file therefore could not match itself a second after it was written, and
reconciliation was useless.

Two fields are now excluded, and the reason is what the hash is _for_: it identifies the client's
evidence so a held copy can be compared against the current picture.

- **`assembledAt`** — when somebody pressed the button. Including it means no two files compare.
- **`ledgerIntegrity`** — a statement about the whole tenant's chain, moving whenever anything
  happens for _any_ client.

**Coverage is included.** If a `not_built` module gets built, the file a regulator holds is out of
date in a way that matters, and the comparison should say so.

A mismatch is reported as a **fact, not a verdict**: the file is assembled live, so new evidence
legitimately changes it. What reconciliation establishes is whether the holder has the current
picture.

---

## What the export record carries

Ids, a purpose, a requester, a hash and the coverage map at the time — and **not the file**. The
file contains a client's compliance history by necessity; the record of it does not need to, and
the Ledger is retained indefinitely.

Coverage is stored rather than recomputed, because coverage **at the time** is the fact a reader
needs: what is not built today may be built tomorrow, and the file that went out said what it said.

---

## Reads added to other modules

Three owning modules gained a client-scoped read rather than this one reaching into their schemas
(specification 5.1): `consent.forClient`, `contracts.contractsForClient`,
`billing.engagementsForClient`. Each includes revoked, superseded and cancelled records — **a
client's file is the history, not the current state of it.**

---

## Known gaps

- **No rendering.** The content model is the artifact (ADR-0005); a PDF or zip is a presentation.
- **Document bytes are not included.** The file carries metadata; the bytes go through 3.2's access
  gate, **which is what enforces legal hold**. Exporting an evidence file therefore cannot be used
  to bypass a hold.
- **No Compliance Review Board interface** — that is a UI.
- **Human approvals are matched heuristically** from ledger event types written by a human actor.
  A dedicated approval log (6.4) would be exact.
