# ADR-0068 — One new template, because the playbooks produce one

**Status:** accepted
**Date:** 2026-08-12
**Modules:** 3.1 Document & Deliverable Management

## Context

Blueprint 3.1 owns a "template library (15+ required templates)". Two exist: the Capital Command
Brief and the Funding Suitability Memo, shipped with the template system, and `templates.ts` explains
why it stopped at two:

> Shipping thirteen stubs would make the count look complete while the content was invented, which
> is the failure mode principle 9 exists to prevent.

This slice seeds playbooks, and a playbook that drafts a template nobody registered fails at the
moment a person is waiting for the document. So the question is not "how many templates should
exist" but "which templates do these three playbooks actually name".

The answer is three, and two of them are already here.

## Decision

**Add the Readiness Blueprint. Register the three the playbooks draw on. Leave the count at three.**

Phase 0 delivers a Readiness Blueprint — 1.3 tracks "Readiness Blueprint status", flow 5.1 ends at
"Client Portal (Blueprint delivered)" — and nothing in the repository could draft one. Phase 1 draws
on the Funding Suitability Memo and Phase 2 on the Capital Command Brief, both of which exist.

Adding twelve more to reach fifteen would be inventing what this firm says to clients in order to
make a number in a blueprint look satisfied. The count is not the deliverable; the documents are.

### The contents of the Readiness Blueprint are an inference and the header says so

The blueprint names the artifact and never describes it. Its sections are read off what Phase 0
computes: a readiness figure set with provenance on each component, a compliance state, an entity
picture, and the gaps that would have to close before a placement is worth attempting.

`requiresHumanReview` is true, and not by inheriting the default: this document carries a categorical
compliance state and figures a client will plan around.

### An empty gap list is a sentence, not an empty block

`gapsToClose` renders as "Nothing is outstanding from this assessment." when empty. An empty table
under a heading reads as an unfinished document, and a client receiving one cannot tell whether the
firm found nothing or stopped looking — the same distinction 7.1 draws between `empty` and
`not_built`, arriving in a document rather than in a coverage map.

### `TEMPLATES_BY_PLAYBOOK` ties the two seeds together

A map from playbook key to the templates it draws on, walked by an invariant test that asserts every
named template is registered and every mapped playbook is seeded. Two seeds in two packages that
each look correct alone is how a playbook ends up drafting `readiness-blueprint` in an environment
where only the other two were registered.

## Consequences

**The library is three of "15+", and that is now a visible number rather than a hidden one.** A
reviewer asking what the other twelve are gets the honest answer: authoring work for somebody who
knows what this firm says, not engineering.

**The builder lives in `seed.ts` rather than `templates.ts`.** `templates.ts` holds the two that came
with the template system and exercise every part of it; this slice's additions — a document and the
registration of it — sit in one file a reviewer reads end to end. A later slice adding templates for
their own sake should put them in `templates.ts`.

**Registration is idempotent and does not bump a version.** `registerTemplate` upserts on
(key, version), so re-seeding rewrites the same row. Bumping instead would move the version a
generated document pins itself to, and every issued Blueprint would start reading as stale because
somebody ran a seed twice.

**Templates are firm-wide.** The row has no tenant column, so `seedV1DeliverableTemplates` takes no
tenant — the wording of a Burkham Wickmont deliverable is the firm's rather than a client's.

## Alternatives considered

**Ship thirteen more templates to reach fifteen.** The failure `templates.ts` already refused, and
the one principle 9 is about: a complete-looking library whose contents nobody wrote.

**Ship the twelve as titles with empty bodies.** Worse than not shipping them. A registered template
with no content is one a playbook can draft, and the first client to receive the result is the person
who discovers it.

**Put the Readiness Blueprint in `templates.ts` beside the other two.** Defensible, and it separates
this slice's additions across two files for a reader trying to review one change. Revisit when the
library grows past a handful.

**Let the playbook name a template key freely, with no map.** Cheaper, and it removes the only check
that the two seeds agree. The failure it permits — a playbook drafting an unregistered template — is
one that surfaces in front of a client rather than in CI.
