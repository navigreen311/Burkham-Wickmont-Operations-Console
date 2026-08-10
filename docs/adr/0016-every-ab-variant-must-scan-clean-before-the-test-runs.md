# ADR-0016 — Every A/B variant must scan clean before the test runs

**Status:** Accepted · **Date:** 2026-08-10 · **Module:** 4.5 Marketing Ops

## Context

Blueprint 4.5 asks for "A/B test configurations within compliance constraints". The question is
where the constraint sits, and there are two plausible places: at registration, or at adoption.

Adoption-time checking is the more natural-sounding design — run the test, see which wins, then
check the winner before rolling it out. It is also wrong, for two independent reasons.

**An A/B test optimises for a metric.** If one arm may say something the Marketing Claim Library
bans and the other may not, the test is measuring whether non-compliant language converts better.
It will usually find that it does — "guaranteed approval" converts extremely well — and the result
is a number that argues for saying it. Producing that number is itself the harm; it becomes the
evidence in a later conversation about whether the rule is worth keeping.

**While the test runs, real clients read every arm.** A "losing arm" is not a hypothetical. It is
copy shown to half the traffic for the length of the window. There is no compliant way to hold one
that says something we may not say.

## Decision

**Every variant is scanned at registration, and a variant that fails is refused.** Not registered
as the arm we expect to lose; not held pending review. Refused, to the person writing it, while
they are writing it.

- `blocked` → refused.
- `requires_disclosure` → refused unless the disclosure is **in the variant body**. Nobody attaches
  a disclosure to an advertisement afterwards. (The same stricter rule 8.1 applies to partner
  material, and stricter than 4.1's send path, where the caller can still attach it.)
- The admitting scan is **stored with the variant**, at the time.
- An experiment cannot start with fewer than two variants — a one-armed test is a piece of copy
  with a hypothesis attached, and its conversion rate will be reported as a result.
- No variants may be added mid-flight: the arm that ran for half the window is not comparable with
  the one that ran for all of it.

**Declaring a winner adopts nothing.** It records which arm won and on what basis. Adopting the
copy is a separate decision, and if it introduces wording the Library does not have, it goes
through `proposeClaim` like anything else. **A conversion number is a reason to consider a claim;
it is not a review of it.**

## Consequences

**Some tests cannot be run**, and that is the intended effect. "Does a stronger promise convert
better" is not a question this company gets to answer experimentally.

**`staleVariants` exists rather than auto-updating.** Nothing rewrites a running experiment's arms
when the Library changes — mutating them mid-flight would make the result meaningless. Instead the
divergence is reported, derived at read time, so somebody can stop the test. This is 7.3's
staleness argument applied to live copy.

**The scan is per-jurisdiction**, so a variant admissible in one state may be refused in another —
which is correct, and means a multi-state campaign may need per-state variants.

## Alternatives considered

**Check at adoption.** Rejected: the number has already been produced and the copy has already run.

**Allow a non-compliant arm with reduced traffic allocation.** Rejected. "A small number of clients
were shown language we may not use" is not a better sentence than the alternative.

**Warn rather than refuse.** Rejected. A warning at registration is dismissed by the person most
motivated to dismiss it.
