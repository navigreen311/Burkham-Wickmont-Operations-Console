# ADR-0071 - A phrase that begins with a symbol is a rule that never fires

**Status:** Accepted - **Date:** 2026-08-12 - **Modules:** 7.4 Marketing Claim Library, 4.2
Communication Compliance Scanner, 4.3 Call Intelligence

## Context

The brief for the founding claim library asked for the money forms, and named three: `$100K`, `a
hundred grand`, `six figures`. Two of the three are seeded. The first cannot be, and finding out
why produced the more useful half of this slice.

`phrasePattern` in `packages/scanner/src/index.ts` binds every library phrase at word boundaries:

```ts
return new RegExp(`\\b${escaped}\\b`, 'gi');
```

`\b` is a transition between a word character and a non-word character. A phrase beginning with `$`
therefore requires a **word character immediately before the `$`** for the boundary to exist. In
"you qualify for $100K" the character before `$` is a space, so there is no transition, and the
pattern does not match. The same is true at the other end for a phrase ending in `%` or `+`.

This was established by running the scanner, not by reading it:

```
FAIL phrase="$100K"                 matched=false  text="You qualify for $100K today."
FAIL phrase="$50k+"                 matched=false  text="Get $50k+ fast."
FAIL phrase="approval rate of 100%" matched=false  text="An approval rate of 100% is normal."
ok   phrase="100K"                  matched=true   text="You qualify for 100K today."
ok   phrase="100% approval"         matched=true   text="We have 100% approval rates."
```

The last two lines are what make it a property of the boundary rather than of numerals or symbols
generally: `100% approval` matches because it begins and ends with word characters, with the `%`
safely in the middle.

## Why this is worse than an ordinary bug

An entry like `$100K` is not rejected. It passes `publish`, which validates only that a rationale is
present. It appears in `activeLibrary`. It is returned to the Compliance Review Board as part of the
library. It **counts toward `libraryEntriesChecked`**, the field the scanner reports specifically so
that a pass says how much it checked.

So a scan against a library containing it returns:

```
verdict: 'clean', findings: [], libraryEntriesChecked: 1
```

A clean verdict, from a scanner that checked one entry, where the one entry was a rule that cannot
match anything. This is the exact failure `scanForTenant` refuses an empty library to prevent - "a
check that examined nothing must not report a pass" - reproduced one level down, where the refusal
cannot see it. An empty library is visible. A library of inert rules looks thorough.

## Decision

**Every seeded phrase begins and ends with a word character, and that property is computed and
asserted rather than reviewed.**

`inertPhrases()` in `packages/claims/src/seed.ts` returns every entry failing the rule.
`tests/integration/claim-library-seed.test.ts` asserts it is empty for the founding library, and a
second test *demonstrates* the failure - constructing a `$100K` entry, scanning text containing
`$100K`, and asserting the result is `clean` with `libraryEntriesChecked: 1`.

The demonstration matters more than the assertion. A test that says "no phrase starts with a symbol"
reads as style. A test that shows a plausible rule silently matching nothing explains why the first
test exists, and survives the reviewer who thinks the rule is fussy.

## The consequence for money promises

Dropping the `$` does not rescue the approach. An exact-phrase library needs an entry per amount -
`100k`, `100,000`, `250k`, `a quarter million` - which is a list, not a control, and the gap between
entries is invisible.

**4.3 already solved this, and its own header says why 7.4 cannot:**

> It also cannot use the Library, and not for want of trying: the promise varies by amount. "$100K",
> "a hundred grand", "six figures" and "about eighty" are the same promise, and an exact-phrase
> library would need an entry for each. So this matches the SHAPE of a statement.

So the division stands: the Library holds the colloquial forms that are fixed strings in marketing
register - "six figures", "six figure", "hundred grand" - plus the promise verbs a numeral only
quantifies - "get you funded", "get you the money", "get you approved". The numerals belong to
`PROMISE_DETECTORS` in `packages/calls/src/detect.ts` and stay there.

Seeding a numeral would have looked like coverage and produced a second, weaker implementation of a
control that already exists - which is what ADR-0034 means by a control a caller can skip.

## Consequences

- The library is honest about its own reach. Its header states what it does not cover and names the
  module that does.
- A future author who adds `$100K` gets a failing test naming the boundary rule, rather than a rule
  that quietly never fires.
- The scanner is unchanged. Fixing `phrasePattern` to use explicit lookarounds
  (`(?<![A-Za-z0-9_-])`) - the fix CLAUDE.md already records for the PII detector, which hit the
  mirror image of this bug from the other side - would let symbol-prefixed phrases work. That is a
  change to `packages/scanner`, which this slice does not own, and it is recorded here as the
  follow-up rather than performed.

## Alternatives considered

**Normalise phrases at publish time by stripping leading and trailing punctuation.** Rejected. It
silently changes the rule the Board approved: an entry submitted as `$100K` would become `100K` and
match "we did 100K in revenue last year", which is a fact about the client and not a promise. A
control that rewrites its own inputs is harder to reason about than one that refuses them.

**Refuse symbol-edged phrases in `publish`.** The right long-term answer, and out of scope -
`publish` is in `packages/claims/src/index.ts`, which this slice does own, but the refusal would
also reject entries a jurisdiction-specific rule might legitimately need once the scanner is fixed.
Asserting the property for the seed keeps the guard where the knowledge is until the scanner
question is decided.
