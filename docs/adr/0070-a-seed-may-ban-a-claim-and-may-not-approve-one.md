# ADR-0070 - A seed may ban a claim and may not approve one

**Status:** Accepted - **Date:** 2026-08-12 - **Modules:** 7.4 Marketing Claim Library, 4.5 Marketing
Operations, 4.2 Communication Compliance Scanner

## Context

The Marketing Claim Library was empty for every tenant, and `scanForTenant` refuses on an empty
library:

> The Marketing Claim Library is empty for this tenant, so a scan would report clean without having
> checked anything.

That refusal is correct and it was load-bearing in a way nobody had had to confront. Because
middleware step 7, contract generation (7.3), deliverable approval (3.4), campaign asset review
(4.5) and partner brand material (8.1) all route through the same scan, an empty library did not
mean lax scanning. It meant **no client-facing content could be sent, generated or approved at
all.** The system was not permissive; it was inert.

Seeding it is therefore not optional work, and the question is only what may be seeded.

The obvious answer - "seed the library, both halves, banned and approved" - is wrong, and the
reason is not caution.

## Decision

**The seed publishes banned and requires-disclaimer entries only. It publishes no approved claim.
The claims worth approving are submitted to 4.5's proposal queue and decided by a named human at
Authority Level 3.**

## Why the two halves are not symmetric

The asymmetry is about **who finds out when the entry is wrong.**

A wrong ban surfaces immediately and cheaply. Somebody tries to write the phrase, the scanner blocks
it, and they arrive at the Compliance Review Board holding the exact sentence they wanted and a
reason they want it. The complaint *is* the correction path, and it arrives with better information
than the original decision had. Over-banning costs a conversation.

A wrong approval surfaces never. The phrase is permitted, so nothing blocks it, so nobody queries
it. It propagates into deliverables, email templates, partner decks and the training curriculum
8.3 syncs from this library - and the party who eventually notices is a regulator, a plaintiff, or a
client who relied on it. There is no internal feedback loop at all, because a permitted phrase
produces no signal.

So the two acts have opposite error profiles: banning fails loudly and cheaply, approving fails
silently and expensively. A mechanism that cannot tell a good decision from a bad one - which is
what a seed is - may only be trusted with the half that fails loudly.

The second reason is about authority rather than feedback. An approved phrase is not a
configuration value. It is **an assertion this firm makes in writing about what it can do**, and
principle 1 says the thing that must never happen is a communication that recharacterizes the
company. `approveProposal` already reads the reviewer's level from the Actor record and refuses
anything below Level 3, precisely because that decision belongs to a person who can be asked why.
A seed file that wrote approved rows would route around a control the codebase already has.

## What this looks like in practice

`packages/claims/src/seed.ts` holds 108 entries, all `banned` or `requires_disclaimer`.
`packages/claims/src/proposed.ts` holds 10 phrases with an `intendedUse` each, submitted through
`proposeClaim`.

The seed is generous, because generosity is cheap on the safe side. It carries the paraphrases the
scanner needs as separate entries - "guaranteed approval", "approval is guaranteed", "approval
guaranteed", "we guarantee approval", "guaranteed to be approved" are five rows for one idea,
because matching is exact-phrase and the sentence order is what a person actually writes.

The proposals are deliberately not generous. Ten questions a Board can answer in one sitting beats
fifty it will defer.

## A rejection is not the only "no"

`approveProposal` accepts `banned` as a disposition, and several of the ten are expected to come
back that way. "no upfront fees" most of all - it is proposed anyway, because the question is real
and the answer belongs in the Library where the next person will find it rather than in a rejected
proposal nobody reads. Somebody asked whether we may say this; the useful record is that nobody
may, and why.

## Consequences

- Nothing client-facing is blocked while the queue is pending. The seeded message templates in
  `@bwc/comms` are written to scan clean **without** any proposed phrase, so the proposals buy
  better wording rather than the ability to communicate.
- The Board inherits a real queue on day one rather than an empty one, which is the difference
  between a governance process that exists and one that is described.
- If a future slice wants an approved claim, the path is `proposeClaim` then `approveProposal`.
  There is no other, and `tests/integration/claim-library-seed.test.ts` asserts the seeded library
  contains no approved entry at all.

## Alternatives considered

**Seed approved claims and mark them provisional.** Rejected. "Provisional" is a field the scanner
does not read - `scanText` skips every `approved` entry regardless. A provisional approval is an
approval with a comment on it.

**Seed nothing and require a human to enter all 108 bans.** Rejected, and it is the failure mode
this ADR is most concerned to avoid. The bans are the safe half; making them expensive means the
library stays empty, which means nothing can be sent, which means the refusal gets weakened by
whoever needs to ship. The way to protect a refusal is to remove the reason to route around it.

**Put the proposal seed in `@bwc/marketing`, next to `proposeClaim`.** Not available - that package
is outside this slice's ownership. The data lives in `@bwc/claims` and the intake is injected as a
parameter, which also avoids closing a package cycle (`@bwc/marketing` already depends on
`@bwc/claims`, so the reverse import would break `tsc -b`). The injection says something true about
the split: 7.4 declares which claims it wants considered, and 4.5 owns what happens to them.
