# ADR-0087 — An unclassified state is not a one-party state

**Status:** accepted
**Date:** 2026-09-16
**Modules:** 4.3 Call Recording & Promise Tracking
**Decided by:** Ivan Green
**Extends:** ADR-0013 (staleness moves toward the safe answer)

## Context

`packages/calls/src/consent.ts` computes whether a call may be recorded from the state the CLIENT
is in. It held two lists. `ALL_PARTY_CONSENT_STATES` is data with citations: every entry names a
statute, and three carry an `openQuestion` where the position is genuinely unsettled.
`CONFIRMED_ONE_PARTY_STATES` was five string literals.

Three things were true about that second list, and none of them was written down.

**Nothing had confirmed any state on it.** No citation, no comment, no ADR, no doc, no commit
message. `git log -L` traces the whole line to one commit, whose message explains the all-party
citations at length and says nothing about where the five came from. The word "confirmed" in the
name was the only evidence of review that existed, and a name is not evidence.

**A state on that list skipped the consent ledger entirely.** `ruleFor` returned
`clientConsentRequired: false`, and `mayRecord` returned permitted at that branch — one line above
its first query against the ledger. Not a consent that was found and accepted: a consent that was
never looked for.

**A state on NEITHER list reported `regime: 'one_party'`.** Its behaviour was right — consent
required, ledger read, refused without it — and its LABEL was wrong. `beginCall` writes that
regime into the append-only Event Ledger, so a state nobody had looked at went onto the permanent
record as one somebody had cleared.

The module header also claimed a constant named `UNCLASSIFIED_STATES` existed "so a state nobody
has looked at is not silently one-party". No such symbol existed anywhere in the repository. The
behaviour it described was real; the named thing was not. 7.2's rule is that an invented rule is
worse than a missing one because it looks reviewed, and a comment naming a constant that does not
exist is that failure applied to the explanation rather than the rule.

## Decision

Three rulings, all of them **cautious settings rather than legal conclusions**. None of them is
counsel's opinion, and none should be cited as one.

**Nevada is treated as an all-party consent state until a lawyer confirms otherwise.** It moves
from the one-party list to the all-party list, and its `citation` field says what it actually is —
`Founder ruling, 2026-09-16 - pending counsel review. No statute has been confirmed for Nevada.`
It is on the all-party list rather than removed from both because a state on neither would be
recorded as unclassified, and that would put Nevada on record as a state nobody had looked at.
Somebody looked at it. The ruling is the record.

**A state on neither list is recorded as `unclassified`, never `one_party`.** `ConsentRegime`
gains a third member, and `UNCLASSIFIED_STATE_RULE` is the named constant the header claimed —
under a name that describes what it can be. `UNCLASSIFIED_STATES` described a list, which is the
one form this cannot take: the unclassified states are exactly the ones nobody has enumerated. The
rule they get can be named; the set cannot.

`ruleFor` answers from that constant rather than restating its fields, so the label and the
behaviour cannot drift apart. The behaviour is unchanged — consent required, ledger read. What
changes is what the ledger is told, and a refusal recorded under the wrong reason is evidence of
the wrong thing.

**New York, Texas, Arizona and Utah stay on the one-party list, marked pending counsel review.**
No source exists for any of them. The mark is an `openQuestion` on the requirement rather than a
comment in the file, because a comment is read by whoever opens the file and a field is read by
the call that relies on it. A null `openQuestion` would have stated that there is nothing
outstanding about an unsourced classification.

The four are not reclassified. The founder ruled on one state, and a change that quietly moved
four more would be a different decision than the one that was made.

## Consequences

Recording in Nevada now requires the client's consent and will refuse without it. That is a
behaviour change in a live-ish path: nothing routes to `beginCall` over HTTP yet, but it writes a
call record and a ledger entry, and the refusal is evidence in the same way a blocked send is.

An unclassified state's ledger entries now say `unclassified`. Entries written before this ADR say
`one_party` and cannot be corrected — the ledger is append-only, which is the point of it. The
record of what the system believed on the day is therefore accurate and wrong in the same file,
and reading a jurisdiction's history across this date needs that known.

`CONFIRMED_ONE_PARTY_STATES` keeps a name that asserts something no evidence supports. Renaming it
was not part of the ruling and is not done here. The claim is now contradicted in three places
that travel further than the name does — the constant's own comment, every requirement's
`openQuestion`, and this ADR.

**None of this is legal advice and none of it closes the question.** What counsel is being asked
is unchanged: classify NV, NY, TX, AZ and UT, with a source. Until then the code is cautious in
one state by ruling and unsourced in four by inheritance, and it says which is which.
