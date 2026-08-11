# ADR-0048 — Two zeroes that mean opposite things

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 7.1 Compliance Evidence Vault, 7.4 Marketing Claim Library

## Context

Two surfaces in this batch carry a value that a page will flatten unless something stops it, and in
both cases the flattening produces a **confident, readable, wrong** answer rather than a visible
failure.

**7.1.** An evidence file consults eighteen sources and each returns a coverage verdict:
`complete`, `empty`, `not_built`, `failed`. Two of those produce a section with no rows.

> "This client has no complaints" and "we have no complaints module" both produce zero rows, and a
> regulator reading the first when the second is true has been misled by an omission nobody
> intended.

**7.4.** A claim library entry carries a disposition: `approved`, `banned`, `requires_disclaimer`.
The natural page reflex is to treat `banned` as the bad one and count it against `approved`.

Both flattenings are one line of rendering code away, and neither would fail a test that only
checked the route returned `ok`.

## Decision

**Neither distinction may be collapsible by the page, so the server does not send a shape that
collapses.**

### 7.1: four counts, never a total

`byCoverage` seeds all four verdicts to zero and counts them separately. There is no
"sections with no rows" figure on the response and no way to compute one that reads as meaningful —
a page that wanted it would have to add `empty` and `not_built` together deliberately, which is a
thing a reviewer can see in a diff.

Every coverage row carries `coverage` and `note` beside `itemCount`, and the view writes the verdict
and its meaning before the number. **`itemCount: 0` never appears on the page on its own.**

The `gaps` list is carried separately as well, phrased as what an export taken now would carry —
because the file is the artefact that leaves the building, and its gaps travel with it.

### 7.1: the coverage map travels, the evidence does not

Assembling the file puts a client's whole compliance history in one object. The page needs to know
what is in the file and what is missing from it; it does not need the file. So the route sends
coverage and counts and `sectionsCarried: false` with a sentence saying why — the same reasoning
ADR-0038 applied to the Vault, arriving at a different module.

### 7.4: `banned` is a peer, and the response says so

`byDisposition` seeds all three to zero and counts them the same way. There is no "problems" figure.
`bannedIsAnOutcome: true` and `bannedNote` travel on the response rather than living in the page's
styling, and the view prints what the library *does* with each disposition rather than grading it:
_"the Scanner blocks any message containing it"_.

The proposal queue carries `outcomesNote` naming **three** outcomes — approved, approved as banned,
rejected — because a queue offering approve-or-reject loses the one that produces the most useful
library entry. Approving as banned records that the firm asked and the Board said no. Rejecting
records only that the Board declined to rule.

## Consequences

**A banned entry is the Board's best work and the page has to look like it means that.** A library
headed "4 approved, 14 problems" would teach an operator to try to clear the banned list, which is
the exact opposite of what 7.4 is for.

**The e2e spec asserts the absence of words.** `#marketing-claims-summary` must not contain
"problem" or "error". An assertion about what is *not* on a page is weaker than one about what is,
and it is the only kind available for a framing.

**A verdict this system does not recognise renders as `unrecognised verdict` rather than as
nothing.** Both views look their vocabulary up in a map; a missing key produces a visible string. A
`?? ''` there would make a new coverage verdict silently invisible, which is this ADR's failure mode
arriving through the back door.

**The `not_built` rows are the ones most worth reading and they are the ones a summary would hide.**
Six of the eighteen sources report `not_built` today. That is a true and useful statement about how
much of the firm exists, and it is only visible because nothing adds it to `empty`.

## Alternatives considered

**A single "coverage percentage".** Every argument against a compliance score, one module along.
9.1 refuses a numeric readiness score for the same reason and Decision E refuses a numeric
compliance state.

**Rendering `not_built` in a warning colour and `empty` in a neutral one.** Colour alone is not a
distinction — it fails on a monochrome print, in the export a regulator receives, and for a reader
who does not know the convention. The words carry it; the class, where there is one, follows the
words.

**Sorting `not_built` sources to the top.** Tempting and wrong: the coverage map's order is the
registry order, which is stable across exports and is what makes two exports comparable. Reordering
by verdict would make the same file look different every time a module was built.

**Filtering `not_built` sources out of the map, since they hold nothing.** This is the failure
stated as a feature. The registry entry is the evidence that the source was considered.
