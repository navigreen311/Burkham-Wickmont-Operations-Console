# ADR-0010 — An issued contract is frozen; "auto-update" means the next one

**Status:** Accepted · **Date:** 2026-08-10
**Modules:** 7.3 Contract & Disclosure Builder, 7.2 State-by-State Regulatory Engine

## Context

Blueprint 7.3 lists among its key features:

> "auto-updates when Regulatory Engine flags rule changes"

Read literally, that is a feature which reaches into documents a client has already signed and
changes their terms when a state amends its law. It would be easy to build — every generated
document records the module version it was built against, so recomputing them is a loop — and it
would be the single most destructive thing in this system.

The same sentence also has a reading that is genuinely useful, and the two are close enough that
choosing between them deserves a record.

## Decision

**1. A `GeneratedContract` row is never updated.** Nothing in `@bwc/contracts` writes to one after
insert. The content model and its hash are fixed at issue.

**2. "Auto-update" is implemented as two things that are not rewriting:**

- the content of documents generated **next**, which pick up the current module and template
  automatically;
- a **derived staleness report** over documents already issued.

**3. Staleness reports against any later module version**, and says whether the change since was
material or editorial.

**4. The content hash is over the canonical JSON of the content model**, and `verifyStoredHash`
recomputes it without trusting the row.

## Consequences

### Why rewriting is not a lesser option

A signed agreement is the only evidence of what was agreed. A system that rewrites one does not
merely lose information — it produces a document that _looks_ like the agreement while stating
different terms, with no marker that anything changed.

The damage is also worst where the stakes are highest. The documents most likely to be caught by a
rule change are the ones in the most heavily regulated states, which are the ones most likely to be
read by a regulator.

Freezing costs something real: reissuing is a manual decision, and someone has to make it for each
affected client. That is the correct place for the cost to sit.

### Why staleness is stricter than the activation gate

7.2 lets a state stay online through an **editorial** module change, because the obligations did not
move. This report flags a document generated against **any** superseded version, editorial included
— and says which kind it was.

The asymmetry is deliberate and follows from what each decision costs. Keeping a state online
through a typo fix avoids halting a business over nothing. Reissuing a document over a corrected
citation costs one regeneration, while a wrong citation in a signed agreement costs whatever it
costs when someone relies on it.

The report distinguishes the two so an operator can triage. A staleness report that cannot tell
"the law changed" from "we fixed a typo" gets ignored wholesale, which is the failure mode of every
alert that cries wolf.

### Why derived rather than stored

Third time this reasoning appears (ADR-0007, ADR-0009): a stored flag needs a job to keep it true,
and a job that stops leaves stale documents reading as current — silently, because nothing changed.

## Alternatives rejected

**Regenerate and supersede: keep the old row, write a new version, mark the old superseded.**
Genuinely tempting, and it preserves history. Rejected because it makes reissue automatic while
leaving the client's _signature_ attached to the superseded version — so the system holds a current
document nobody signed and a signed document it considers obsolete. The reissue decision belongs to
a human who will also arrange for the new one to be signed.

**Store a `stale` boolean, updated by a nightly job.** See above, and ADR-0007.

**Flag only material changes as stale.** Symmetrical with the activation gate and wrong for the
reason given above: the costs are not symmetrical.

**Hash the rendered PDF rather than the content model.** A font substitution or a library upgrade
changes the bytes without changing a word of the agreement, so the hash would report tampering on
an unchanged document — and, worse, would be trusted less each time it did. ADR-0005 settled this
for deliverables; a contract is the case where it matters most.
