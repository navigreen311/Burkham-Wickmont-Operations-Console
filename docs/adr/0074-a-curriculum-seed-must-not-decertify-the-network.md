# ADR-0074 - A curriculum seed must not decertify the network, and it does not assert a sensitivity

**Status:** Accepted · **Date:** 2026-08-12 · **Modules:** 8.3 Partner Training & Certification

## Context

8.3 is built and empty. `standingFor` returns `no_curriculum`, which is deliberately **not**
certified - "nothing to complete" and "completed everything" both produce an empty outstanding list,
and treating them alike would certify the whole network the moment a tenant forgot to publish.
`requireCertification` then refuses the referral gate.

So today **no partner can be certified, and therefore no partner can refer at all.** 8.1 tracks
referrals that cannot lawfully happen.

Blueprint 8.3 names the topics - approved claims, prohibited claims, client suitability, data
privacy, referral disclosure - so the subject matter is not invented. What a partner must be able to
DO about each is.

## Decision 1 - the seed skips existing modules, and the default matters more than usual

`publishModule` records completion against a module **VERSION**, so a material republish decertifies
everyone who completed the previous one. That is the mechanism behind 8.3's "annual recertification
with change delta training", and it is correct.

It also means **a seed that republished on every run would decertify the entire partner network the
second time somebody ran it** - a worse outcome than the empty curriculum this exists to fix.
`seedCurriculum` reads `currentCurriculum` and skips any key already on record. `republishExisting`
exists but is off, and is documented as decertifying.

Nothing here publishes editorially. Version 1 cannot be editorial anyway, and an editorial republish
carries prior completions forward keeping their **original dates** - which is right for a typo fix
and would be a way to quietly extend everyone's recertification clock if used for anything else.

## Decision 2 - `requiredForTracks` is left empty for the universal modules

Empty means every track. The five blueprint topics are published with an empty list rather than with
all seven track names enumerated, because **enumerating them means a track added later silently
escapes the requirement**, and the empty list means it does not.

## Decision 3 - the seed does not assert a `disclosureSensitivity`, because it has nothing to cite

`PublishModuleInput` has no such field. Sensitivity is a property of the **track**, already recorded
in `TRACK_REQUIREMENTS` with a cited basis - AICPA independence rules, Model Rule 7.2, SEC
solicitation rules.

The one track-scoped module, `professional_independence`, is scoped by **reading** the tracks that
already carry `disclosureSensitivity: 'high'` rather than by listing them. It therefore inherits
their citations, a track whose sensitivity is corrected later moves in or out without this file
being edited, and no second uncited source is created for a fact that already has a cited one.

Whether a separate module is the right response to those citations is a policy call, and it is on
the list of things for the owner to confirm.

## Consequences

**No partner can actually complete any of this yet.** Blueprint 8.3 names SelfPublisherForge as the
curriculum source and this module deliberately holds no training text. Every `materialReference`
points at a key marked `(NOT YET AUTHORED)`. The seed makes certification **possible**; it does not
make it achievable until somebody writes the material, and the requirements list says so first.

**Certification remains categorical.** A partner is certified or is not; `standingFor` names the
outstanding module rather than a percentage. There is no score, no ranking and no average anywhere
in this - a partner two modules from certified and one module from certified are both not certified,
and a number in between would invite a threshold.

**Six modules, not five.** The sixth is scoped and is the one most likely to be wrong.

## Alternatives considered

**Publish nothing until the material exists.** Rejected - it leaves the referral gate shut for every
partner, and the gate being shut is currently indistinguishable from the system working.

**Enumerate all seven tracks on the universal modules.** Rejected - see Decision 2.

**Assert a `disclosureSensitivity` per module.** Rejected - see Decision 3. It would be a fact with
no citation sitting beside the same fact with one.

**Make the seed idempotent by publishing editorially on re-runs.** Rejected, and it is the
attractive wrong answer: editorial carries completions forward, so re-running would appear harmless
while silently republishing content nobody re-read.
