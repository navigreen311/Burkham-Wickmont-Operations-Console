# ADR-0052 — An absent field cannot be rendered as zeros

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 8.1 Partner & Referrer Portal, on the internal Console
**Extends:** ADR-0014

## Context

ADR-0014 established that anonymity is a property of a cohort. `aggregateStatus` withholds a
partner's stage breakdown below five referrals, because a partner who referred one client and is
shown "1 client in underwriting" knows exactly whose status that is — they supplied the client.
Removing the name removes nothing.

Below the threshold the module returns:

```
{ released: false, countsByStage: {}, totalReferrals, detail }
```

`detail` is a full sentence: the breakdown is withheld, below what number, and why.

**Putting a transport and a page in front of that is where it gets undone**, and the dangerous shape
is the empty object. `countsByStage: {}` is not a suppression a page can see — it is an iterable
that yields nothing, and the natural rendering of "iterate the stages and show each count" over a
partner's known stage list produces a row of zeros. **A row of zeros is a false statement about the
partner's book**, and it is worse than the breakdown it replaced: it looks like an answer.

## Decision

**The route omits `countsByStage` entirely when the aggregate is suppressed.**

```
released: aggregate.released,
totalReferrals: aggregate.totalReferrals,
minimumCohort: MINIMUM_COHORT,
detail: aggregate.detail,
...(aggregate.released ? { countsByStage: aggregate.countsByStage } : {}),
```

An absent field cannot be iterated into zeros. There is nothing for a page to be helpful with.

Three things travel either way, and each is deliberate.

**`totalReferrals`, at any size.** The partner already knows how many clients they sent us, so
withholding it protects nobody — and it makes the suppression look like a fault rather than a rule.
ADR-0014 made this call in the module; the transport does not second-guess it.

**`minimumCohort`.** A page that says "withheld" without saying "below five" teaches its reader that
the system is arbitrary, which is how a rule gets argued away.

**`detail`, the module's own sentence.** Not a shorter one written here. A second copy of a reason
is a second thing to drift, and this one has to be right.

### Why not a band

"Fewer than five referrals" is the obvious middle ground and it still leaks. The partner knows their
own referral count: "fewer than five, some in underwriting" plus "I referred two" is most of the way
to an answer. ADR-0014 rejected it in the module for that reason and the transport does not
reintroduce it.

### `identifiedStatus` is not routed on the internal Console

The named-client read exists, on the client's own consent, and it writes
`partner.client_status.viewed`. It is reachable from the **partner** portal.

Exposing it here would let a staff member generate "your partner looked at your file" without a
partner having looked — corrupting the one record that exists to tell a client who saw their status.
The event is only worth anything if it means what it says.

## Consequences

**Asserted on both sides of the threshold.** A suite that only proved the suppression would pass
against a module that released nothing ever, which is a different and equally useless surface. The
transport test seeds one partner at four referrals and one at six.

**Mutation-tested, and the first attempt found a real gap in the tests rather than in the code.**
Forwarding `countsByStage` unconditionally fails the transport test. Rendering a suppressed cohort
as zeros in the view **passed all eleven browser tests** — because the Console e2e harness seeds no
partners, so the partner detail renderer never runs in a browser, and this branch does not own the
harness.

That gap is now covered by source assertions in `console-capital.test.ts`, in the style
`portal-ui.test.ts` already uses for view files. **This is weaker than driving the DOM and is
recorded as such**: it catches a rendering rule being deleted and would not catch one kept and
computed wrongly. There is no DOM environment in this runner — vitest is `environment: 'node'` and
no jsdom is installed — and adding one is a dependency decision for a branch that owns the
dependency manifest.

The honest closure is a partner in the e2e seed. That is one line in `tests/e2e/console-server.ts`,
which this branch does not own, and it is the first thing to do when somebody does.

## Alternatives considered

**Forward the module's object unchanged, empty `countsByStage` included, and trust the page.** One
fewer moving part in the transport, and it relies on every current and future renderer checking
`released` before iterating. The renderer that forgets produces zeros, and zeros do not look like a
bug.

**Have the module return `countsByStage: null` when suppressed.** Better than `{}` and it would need
a change in `packages/partners`, which this branch does not own. Worth considering next time that
module is open: `null` is harder to iterate by accident than `{}`, though an absent key is harder
still.
