# 0084 - A surface must refuse the score as hard as the module

- Status: accepted
- Date: 2026-08-12
- Context: `apps/api/src/routes/partnerRisk.ts`, `apps/api/public/views/partnerRisk.js`

## Context

8.4 Partner Risk was the last V1.5 engine without a surface. The module refuses to produce the score
the blueprint asks for, and says why at length: the dimensions 8.4 lists are two different kinds of
thing wearing one name.

_Claim compliance_ and _unauthorized promises_ are **conduct** — a partner either promised a client
an approval or they did not. _Conversion rate_ and _complaint rate_ are **performance** — numeric,
and meaningless below a sample. Combining them produces a figure in which **revenue contribution
offsets an unauthorized promise**, which is the trade design principle 1 forbids, made invisibly
because the arithmetic gives no sign that one of its inputs was a compliance breach.

## Decision

**The surface refuses the combination as hard as the module does**, because a transport undoes it in
one line and three of the ways are things a page does by instinct:

| Instinct                   | Why it is the same trade                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| A headline number          | The arithmetic nobody may perform                                                    |
| A badge derived from both  | The same figure wearing a colour                                                     |
| A queue sorted worst-first | **An ordering is a ranking**, and ranking conduct against revenue is the combination |

So `standing` and `measures` travel as separate fields, the queue is forwarded in the module's own
order — by name — and the review count is broken down **by standing** rather than totalled, because
"4 partners need review" hides that one of them made an unauthorized promise.

The payload also carries `combinationRule` as a sentence. A reader who sees a good conversion rate
beside a serious finding will average them in their head unless something says not to, and that
something should not be a comment in a file they will never open.

**A null measure is forwarded as null with its denominator**, alongside
`minimumReferralsForRate`. `0%` would be a complaint rate invented out of nothing, about somebody
whose livelihood partly depends on it — the same withholding 5.5, 9.1, 1.3 and 5.2 all make.

### Recording a finding is Level 1; resolving one is Level 3

The asymmetry `trigger_firewall` established. A conduct finding **stops** things: one nobody
recorded is a partner promising clients an approval, while one recorded in error is visible at once
and takes a person to resolve. Over-recording produces a conversation; under-recording produces a
client who was promised something.

A `critical` finding suspends the partner from inside `recordFinding` — automatic in, human out.
That is not a reason to raise the level; it is the reason the level is **low**, because the act that
fires it must not be gated behind whoever is senior enough to be busy on a Friday.

Resolving is the direction that **restores**, so it sits at 3 for the same reason
`release_legal_hold` is separate from placing one.

### Reinstatement is not on this panel, ever

`not applicable`, not a roadmap item. Reinstatement on the same panel as the finding that caused the
suspension would let one person undo their own suspension in two clicks. It belongs with the partner
lifecycle, where a different person is looking.

## Consequences

**Verified by mutation.** Adding `score: 87` to the payload fails the assertion immediately — the
test names the fields a combined figure would naturally be called (`score`, `riskScore`, `overall`,
`rating`, `total`) rather than checking that the ones present are correct.

**A stale doc was corrected rather than left.** `docs/v15-engines-batch-1.md` said all four engines
had no HTTP surface. Two had gained one when the last modules without panels were built, and this
slice gave the third its own; the fourth item was the ordering key, which is not a module.
