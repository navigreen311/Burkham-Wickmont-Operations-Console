# ADR-0011 — Money is integer cents, rounding goes to the client, and refund entitlement is derived

**Status:** Accepted · **Date:** 2026-08-10
**Modules:** 1.4 Pricing, Billing & Offer Management

## Context

1.4 is the first module whose outputs are amounts a client is asked to pay or is owed back. Three
decisions had to be made before any of it could be written, and each has an obvious answer that is
wrong in a way that only shows up later.

## Decision

**1. Every amount is an integer number of cents.** Dollars exist at one boundary — building 7.3's
fee-exhibit input, which takes them.

**2. One rounding rule, in one place: fees we charge round down, refunds we owe round up.**

**3. Refund entitlement is derived from the record.** `RefundRecord` records what was _done_ about
an entitlement, not that one exists. Granting a triggered refund needs no approval; **declining one
needs a Level 3 human and a recorded reason.**

## Consequences

### Cents

The concrete failures, not the abstract objection:

- 8.5% of $1,040.11 is $88.40935 exactly; floating point computes `88.40934999999999`.
- A value that looks like an exact half-cent is often slightly _below_ it in binary, so the
  language's own rounding sends it the wrong way: `(0.615).toFixed(2)` is `'0.61'`.
- `paid - earned` in floating point can produce `0.004`, or `-0.001`. **A sub-cent refund is
  unpayable and a negative refund is nonsense**; both are unreachable when the operands are
  integers.
- Credit across an upgrade is repeated subtraction, which is where drift compounds.

Rates are stored as **basis points** rather than percentages, because 8.5% is `850` exactly while
`8.5` is not — which moves the multiplication entirely into integers and leaves exactly one
rounding, the one that gets named.

The cost is a conversion boundary and a small vocabulary (`fromDollars`, `formatMoney`) that every
caller has to learn. `fromDollars` **throws** on a value carrying a fraction of a cent rather than
truncating: quietly making $19.999 into $19.99 decides on the caller's behalf which cent they lose.

### Rounding

It costs at most one cent per line item, which across a portfolio is negligible. The alternative —
rounding in our own favour on a figure the client signs — would be true of _every_ invoice rather
than a one-off, and is the kind of detail that reads badly when somebody goes looking.

Being a single named parameter (`toward_client` / `away_from_client`) rather than a convention
means the direction is visible at every call site instead of being a property of whichever helper
happened to be used.

### Refunds

**Objective** is the load-bearing word in blueprint 1.4's "refund logic driven by objective
triggers". Objective means computable, so entitlement is derived rather than requested — and the
asymmetry follows directly:

|                                 | Requires                              |
| ------------------------------- | ------------------------------------- |
| **Granting** a triggered refund | nothing beyond being able to act      |
| **Declining** one               | a Level 3 human and a recorded reason |

A system where refunds are discretionary is a system where refunds do not happen, and the client
owed one is by construction the client least happy about chasing it. Requiring a sign-off to hand
back something the record says is not ours would be the friction that stops it.

The reason for a decline goes into the Ledger as well as the refund record, because a declined
entitlement is exactly the decision that gets questioned later by somebody without access to the
billing schema.

`payRefund` **refuses** to record a payment the record cannot explain. That is not a refusal to be
generous: an ex-gratia payment is a legitimate business decision and belongs in a path that says
so, rather than appearing in the Ledger as an objective refund it is not.

### "Engagement quality failure" is not objective as written

The blueprint names it as a trigger. Implementing a judgement call as though it were a fact would
be the worst of both — a refund that looks automatic and depends on an opinion nobody recorded.

So it is given a measurable definition (**the committed window ended with no funding approval
obtained**) and flagged for review. What it deliberately does not attempt is assessing whether the
work was _good_: that is a judgement, it belongs on the Compliance Review Board's weekly agenda,
and dressing it up as a computation would make it less reviewable rather than more.

## Alternatives rejected

**`Decimal` for money in application code.** Prisma returns one, and it is correct. Rejected
because it is correct _and_ unfamiliar: every arithmetic site becomes a method call, and the one a
developer forgets silently falls back to float. Integers are the representation everybody already
knows how to add.

**Round half-up, symmetrically.** Defensible, standard, and it overcharges some clients by a cent.
Since the asymmetric rule costs nothing that matters, there is no reason to take the version that
sometimes takes money from the person who did not choose the rounding.

**A `refundOwed` boolean maintained by a job.** Fourth appearance of this reasoning (ADR-0007,
0009, 0010). A job that stops leaves a client owed money that nothing in the system mentions again
— and unlike a stale approval, nobody outside the company is watching for it.

**Filtering resolved entitlements out of `refundsDue`.** Would make a decline invisible to everyone
except whoever made it. They come back with `resolved` set instead.
