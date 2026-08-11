# ADR-0035 — A defaulted input is a confident answer to a question nobody asked

**Status:** accepted
**Date:** 2026-08-11

## Context

The Console got a placement button. The route it drives has existed since the walking skeleton and
already ran the whole middleware chain, so the work looked like a form and a renderer.

It was not, because of what the route takes: **`applicationRef` and nothing else.**

`requestRecommendation` accepts `need` and `requestedAmount` and defaults them to `working_capital`
and **zero**. Two things follow, and neither is visible from the route:

**Eligibility compares the requested amount against each offering's minimum.** With the default, a
request rejects every offering that has one — with the reason _"Requested $0 is below the $25,000
minimum"_. True, useless, and produced entirely by nobody having been asked. A button wired to that
route would have been decorative: it would have returned "nothing survived" for every client in the
firm, and the rejection list would have explained why in a way that looked like a catalogue problem.

**Suitability is assessed against the need.** This is the worse of the two. A client borrowing to
buy equipment, silently assessed as needing working capital, does not get an error — they get a
confident recommendation for the wrong product, with a rationale explaining why it suits a purpose
they never stated. 5.2 separates suitability from eligibility precisely because _the easiest product
to qualify for is often the worst fit_; a defaulted need feeds that machinery a fiction.

## Decision

**`need` and `requestedAmount` are required on the placement route, and the Console asks for both.**

A refusal names the reason rather than the field:

- no amount → _"Eligibility compares it against each offering's minimum, so an absent amount rejects
  every provider that has one."_
- no need → _"Suitability is assessed against it, so a default would be a confident recommendation
  for a purpose nobody stated."_

The `need` select on the page **starts on an empty "Choose…" option**. A pre-selected first entry is
a default wearing a different hat: it is the value most requests would carry, chosen by whoever
ordered the list.

### The general shape

A default is safe when the caller's silence means "I do not care". It is unsafe when the silence
means "I do not know" or "nobody asked me", and an input to a **recommendation** is almost always the
second — because the output is a claim about what suits somebody.

This is the same instinct as several decisions already here, arriving at an input rather than an
output: 9.1's `null` is never `0` because a missing measurement is not a measurement of zero;
ADR-0019's `unmonitored` is not green because nobody looking is not evidence of health; 5.2's
eligibility has three verdicts because `unknown` is not `ineligible`. **This one says the same thing
about what goes in.**

### Closed vocabularies are served, not written into the page

`need` and the consent `kind` are both closed sets. Hard-coding them in the HTML means the page
offers a value the server will refuse the moment somebody adds one — and the refusal reads as a bug
in the Console rather than as a mistake anybody can correct. `GET /api/console/vocabulary` serves
both from the constants the server validates against.

The consent form gained the same treatment on the way past: it took a free-text `kind`, so a typo
produced _"unrecognised kind"_ on a page that had invited the typo.

## Consequences

**Amounts on this route are whole dollars**, which is what `@bwc/lenders` stores. 5.2 predates
ADR-0011's integer-cents rule, and its boxes are round numbers a lender publishes rather than sums
anybody adds up. Stated in the form label and in the route, because the two conventions living in
one system is exactly the kind of thing that gets got wrong once, silently.

**The refusal is the ordinary outcome, and the page treats it as an answer.** A placement runs the
chain's gate, then the client's per-application authorisation, then the Entity Graph, then the
catalogue — and for a client who has not been assessed, or has not authorised _this_ application, or
has no designated applicant entity, it stops with a different reason each time. The page renders the
reason and the middleware trace rather than an error, because the operator's next move differs in
every case.

**A shared fixture, `tests/helpers/placeable.ts`.** Making a placement succeed takes five modules to
agree, and the transport test and the browser harness now build that world from one recipe. Two
hand-built worlds drift, and the one that drifts is the one nobody is looking at.

## Alternatives considered

**Keep the defaults and let the Console pass them explicitly.** Same values, same wrong answers, and
now written down in two places.

**Default the amount but require the need.** The amount's failure is loud — every provider rejected,
with a reason naming the amount — so it is the one somebody would eventually notice. That is an
argument for requiring the need, not for defaulting the amount.

**Ask for the amount in cents, per ADR-0011.** Correct for money that is added up, wrong here: these
figures are compared against published lender minimums stored as dollars, and converting at the
Console boundary would put the two conventions one function call apart.

**A "recommend anything" mode with no amount.** What the defaults amounted to. If a client genuinely
does not know how much they need, that is a conversation, not a query parameter.
