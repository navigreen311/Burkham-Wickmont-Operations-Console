# Plan — 1.4 Pricing, Billing & Offer Management

**Blueprint:** 1.4 · **Branch:** `ai-feature/m1-4-pricing-billing-offers`
**Follows:** 7.3 Contract & Disclosure Builder (merged, `f5e1108`)

---

## Why this module next

7.3 generates a fee exhibit from figures the caller supplies. Nothing validates that the tier
passed matches the engagement actually sold, or that the retainer quoted is the retainer agreed —
which was the last row of its own Fact Check List. 1.4 owns those facts.

It is also where the Seek Capital lesson finally has a home on both sides: 7.3 makes it impossible
to _state_ a fee on a requested limit, and 1.4 makes it impossible to _charge_ one.

## Mini-PRD

### Problem

Every client-facing economic operation currently lives in a caller's arguments. There is no record
of what a client agreed to pay, what they have paid, what they are owed back, or what carries
forward when they move up the ladder. A refund the blueprint says is triggered by an objective fact
is presently triggered by somebody remembering.

### Success metrics

- A fee exhibit is built **from the engagement**, not from figures a caller asserts.
- A refund the record entitles a client to is computed from the record, not requested by them.
- Credit carried across an upgrade can never exceed what was actually paid, and no payment can be
  credited twice.
- No client is overcharged by rounding.

### Risks

| Risk                                                        | Mitigation                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Floating-point money**                                    | Everything is integer cents; dollars exist only at the rendering boundary                                       |
| A refund is owed and nobody notices                         | `refundsDue` derives entitlement from records; declining one needs a Level 3 human and a recorded reason        |
| A payment is credited twice across an upgrade               | Credits reference the billing record they draw on, and the available balance is derived from what is unconsumed |
| "Engagement quality failure" is not objective as written    | Given a concrete, measurable definition here, and flagged for review rather than left as a judgement call       |
| Fee figures diverge between the exhibit and what is charged | The exhibit is built from the same engagement record the charges are raised against                             |

---

## Key decision — money is integer cents

Every figure in this module is money owed by or to a client, and floating point is the wrong
representation for that. The concrete failures, not the abstract objection:

- 8.5% of $1,040.11 is $88.40935 exactly; floating point computes 88.40934999999999. And a value
  that looks like an exact half-cent is often slightly below it in binary, so the language's own
  rounding sends it the wrong way — `(0.615).toFixed(2)` is `'0.61'`. (The first draft of this
  plan illustrated the point with $47,300, which happens to be exact. Writing the test caught it.)
- A refund computed as `paid - earned` can come out as `0.004` or `-0.001`. **A negative refund is
  nonsense and a sub-cent refund is unpayable**, and both are unreachable in integer cents.
- Credits across an upgrade are repeated subtraction, which is where float drift compounds.

Dollars exist at exactly one boundary: building 7.3's `FeeExhibitInput`, which takes them.

> **Deviation, recorded up front:** 7.3's `buildFeeExhibit` is not retrofitted to cents in this
> slice. It renders rather than accumulates — every value it receives is already final — so the
> exposure is display-only, and changing a signature that four tests and a document generator
> depend on belongs in its own change rather than bundled into this one.

## Key decision — rounding goes to the client

One rule, applied in one place: **fees we charge round down, refunds we owe round up.**

It costs at most a cent per line item, which across the portfolio is negligible. The alternative —
rounding in our own favour on a figure the client signs — is the kind of detail that reads badly in
an enforcement action, and it would be true of every invoice rather than a one-off.

## Key decision — the system's default is to pay the refund

Blueprint 1.4: _"refund logic driven by objective triggers (60-day approved-but-unfunded,
engagement quality failure)."_

Objective means computable from the record, so `refundsDue` derives entitlement rather than waiting
for a request. The asymmetry that follows is the design:

- **granting** an objectively-triggered refund needs nobody's approval — it is already owed;
- **declining** one needs a Level 3 human and a recorded reason.

A system where refunds are discretionary is a system where refunds do not happen, and the client
who is owed one is by definition the client who is least happy to be chasing it.

"Engagement quality failure" is not objective as the blueprint writes it. This slice gives it a
measurable definition — no qualifying deliverable within the committed window — and flags that
definition for review rather than quietly implementing a judgement call as though it were a fact.

---

## Architecture

```
packages/billing/
  money.ts        integer cents, the rounding rule, formatting
  offers.ts       the ladder: offer definitions and tiers, versioned
  engagements.ts  an engagement at a tier; charges and payments
  credit.ts       the credit chain across an upgrade
  refunds.ts      objective triggers, derived; the decline path
  exhibit.ts      builds 7.3's fee-exhibit input from the engagement record
```

### Data model — schema `billing`

- `OfferDefinition` — the ladder rung: key, version, retainer, monthly, success-fee rate, minimum
- `Engagement` — a client on a rung, with its committed window and prepay terms
- `BillingRecord` — a charge or a payment, in cents, against an engagement
- `CreditApplication` — credit drawn from a specific billing record onto a later engagement
- `RefundRecord` — a refund paid, or an entitlement declined with its reason

Entitlement is **derived**; `RefundRecord` records what was done about it. Fourth appearance of
that reasoning (ADR-0007, 0009, 0010): a stored "owed" flag needs a job to keep it true.

---

## Test strategy

- Cents arithmetic: no float appears; a fee rounds down and a refund rounds up on the same figure.
- A success fee is charged from the approved limit; there is no path from a requested one.
- The 60-day trigger fires on day 61 and not on day 60.
- Unearned prepay on cancellation is proportional to the unelapsed term, to the cent.
- Declining an entitled refund without a Level 3 human is refused; declining without a reason is
  refused.
- Credit across an upgrade cannot exceed what was paid, and the same payment cannot be credited
  twice.
- The engagement minimum is tracked and reported, not enforced silently.
- The fee exhibit built from an engagement matches what was charged against it.

---

## Out of scope

Payment processing — no card is charged here; `BillingRecord` records what was agreed and what was
received, and a processor integration is a gated vendor. 1.3 Sales Motion, which owns how a client
arrives at a rung. The specific commercial terms of the five offers: the ladder's _structure_ is
built and seeded empty, because what to charge is the company's decision and not something to infer
from a specification.
