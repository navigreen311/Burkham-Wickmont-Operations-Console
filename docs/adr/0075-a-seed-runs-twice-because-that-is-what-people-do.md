# 0075 - A seed runs twice, because that is what people do

- Status: accepted
- Date: 2026-08-12
- Context: `packages/regulatory/src/seed.ts`, `packages/comms/src/seed.ts`, `scripts/seed-tenant.mjs`

## Context

Seven packages grew a `seed.ts` in one wave, written by three people who never saw each other's
files. Each one declines to run itself, on the rule the regulatory seed set first: content that
appears because a module was imported is content nobody chose. `scripts/seed-tenant.mjs` is the
something that calls them, and it was written last.

The second thing that script did was run twice. That is not a stress test — it is the ordinary
case. A first run dies half way. A state is added to the list. An operator is not sure whether it
took. Nothing about a seed suggests you only get one attempt.

Two of the eight steps did not survive it.

**`seedMessageTemplates` walked every template to a new version.** Nine keys, eighteen rows, bodies
identical. Version 1 superseded by version 2 saying exactly the same thing.

**`seedV1PriorityStates` did the same to all seven states, with `changeKind: 'material'`.** That is
the severe one. `standingFor` sends an ACTIVATED state back to `needs_counsel_review` with
`permitsClientFacingAction: false` on exactly this signal — a material change published since the
version counsel reviewed. So re-running the seed script would have taken the firm dark in seven
states and required a lawyer to look at New York again, because somebody ran a script whose own
header called it safe.

Nobody was careless. Each half is defensible alone:

- The comms seed had a test asserting the republish, named `supersedes rather than edits when
seeded again`, reasoning that a message sent in March has to stay explicable. That reasoning is
  correct — about **versioning**. It answers "overwrite or supersede?", which is not the question
  seeding asks. Seeding asks "publish or leave alone?"
- The regulatory seed predates the wave. It was the precedent every other seed copied, and it had
  the defect the whole time. It never mattered, because until this script existed nothing called it
  twice.

The offer ladder got it right, and got it right first: `republishExisting` defaults off, because
"a seed that always published would walk the whole ladder to version 2 on its second run and leave
the owner's corrections superseded by these drafts." The partner curriculum reached the same
conclusion from a different direction — a material republish decertifies every partner who
completed the previous version. Two of six authors found this rule independently. Two did not, and
one of those two was the file the others were copying.

## Decision

**A seed leaves an existing row alone unless it is explicitly told otherwise.**

`seedMessageTemplates` and `seedV1PriorityStates` gain `republishExisting`, defaulting to `false`,
matching `seedOfferLadder` and `seedCurriculum`. Both now return what they skipped as well as what
they published: a count alone cannot distinguish "seeded seven" from "found seven already there",
and those are different facts about the tenant in front of you.

Superseding rather than overwriting stays correct **when a republish is what was meant**, which is
why this is a flag and not a deletion. The comms test that asserted it is kept, under the flag, and
a second test now asserts the default.

## Consequences

**Re-running `scripts/seed-tenant.mjs` is safe, and now it is safe by construction rather than by
the coincidence that four of the seeds were written by people who thought about it.** Verified on a
fresh tenant: after two runs, nine message templates and seven state modules, not eighteen and
fourteen.

**The regression test is the harm, not the mechanism.** `does not send an activated state back to
counsel when the seed is re-run` seeds New York, has counsel review it, activates it, re-runs the
seed and asserts the state is still live. A test asserting "skipped: 7" would pass against a future
version that skipped for the wrong reason.

**This is an argument for integration being a step with its own work in it.** Nothing was wrong
with any package. The defect existed only in the sentence "and then you run them", which no package
owned and which nobody was assigned. The three-way split by file ownership is what made the wave
possible and is also what left this to be found afterwards — by running the thing, twice, and
counting rows.

**A seed that has never been run twice should be assumed not to be idempotent**, whatever its
header says. Both of these had headers.
