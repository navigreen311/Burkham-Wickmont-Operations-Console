# 1.4 Pricing, Billing & Offer Management

**Package:** `@bwc/billing` · **Schema:** `billing`
**ADR:** [ADR-0011](decisions/ADR-0011-money-is-cents-and-refunds-are-derived.md)

---

## What this closes

7.3 generated a fee exhibit from figures a caller supplied, with nothing checking that the tier
passed matched the engagement actually sold — the last row of its own Fact Check List. 1.4 owns
those facts, and `exhibitInputFor` builds the exhibit from the engagement record.

It is also where the Seek Capital lesson has a home on both sides: 7.3 makes it impossible to
_state_ a success fee on a requested limit, and 1.4 makes it impossible to _charge_ one. The
`RecordChargeInput` type has one field for an approved limit and none for a requested one.

---

## Money is integer cents

Full reasoning in [ADR-0011](decisions/ADR-0011-money-is-cents-and-refunds-are-derived.md). The
short version is four failures that integer cents makes unreachable:

|                                        | Floating point             | Cents                                        |
| -------------------------------------- | -------------------------- | -------------------------------------------- |
| 8.5% of $1,040.11                      | `88.40934999999999`        | exact, one named rounding                    |
| `(0.615).toFixed(2)`                   | `'0.61'` — rounds **down** | no half-cent to misread                      |
| `paid - earned`                        | can be `0.004` or `-0.001` | a sub-cent or negative refund is unreachable |
| 100 subtractions of $24.95 from $2,495 | not zero                   | zero                                         |

Rates are **basis points**, because 8.5% is `850` exactly while `8.5` is not. `fromDollars`
**throws** on a value carrying a fraction of a cent rather than truncating — quietly making $19.999
into $19.99 decides on the caller's behalf which cent they lose.

### Rounding goes to the client

One rule: **fees round down, refunds round up.** It costs at most a cent per line item. The
alternative would be true of every invoice rather than a one-off, and is the kind of detail that
reads badly when somebody goes looking.

The direction is a named parameter at every call site rather than a convention, so it is visible
rather than a property of whichever helper happened to be reached for.

---

## Refunds: the system's default is to pay

**Objective** is the load-bearing word in the blueprint's "refund logic driven by objective
triggers". Objective means computable, so `refundsDue` derives entitlement from the record rather
than waiting for a client to ask.

|                                 | Requires                              |
| ------------------------------- | ------------------------------------- |
| **Granting** a triggered refund | nothing beyond being able to act      |
| **Declining** one               | a Level 3 human and a recorded reason |

A system where refunds are discretionary is a system where refunds do not happen, and the client
owed one is by construction the least happy about chasing it.

`payRefund` **refuses** to record a payment the record cannot explain — not a refusal to be
generous. An ex-gratia payment is a legitimate business decision and belongs in a path that says
so, rather than appearing in the Ledger as an objective refund it is not.

Resolved entitlements come back with `resolved` set rather than being filtered out: a list that
silently dropped a decline would make it invisible to everyone except whoever made it.

### The three triggers

**`approved_not_funded_60_days`** — fires on day **61**, because "within 60 days" includes the
sixtieth. The refund is of the success fee charged against that approval: a fee charged on approval
where the capital never funded delivered the client nothing, whatever work went into obtaining it.
Matched to the fee line by its **approved credit limit**, which is the figure the fee was computed
from — matching on amount or date breaks the moment two approvals land in one engagement.

**`unearned_prepay_on_cancellation`** — prorated by **elapsed days, not whole months**. A client
who cancels on the second of the month has not consumed that month, and rounding a part-month up
would take a month's fee for a day's service.

**`engagement_quality_failure`** — **the blueprint's phrase is not objective as written.** Given a
measurable definition here (the committed window ended with no funding approval obtained) and
flagged for review rather than quietly implementing a judgement as though it were a fact. It
deliberately does not assess whether the work was _good_: that belongs on the Compliance Review
Board's agenda, and dressing it up as a computation would make it less reviewable rather than more.

---

## The credit chain

A credit **draws on a specific billing record**, not on an engagement total. The available balance
of a payment is that payment minus what has already been drawn from it, which makes
double-crediting arithmetically impossible rather than procedurally discouraged. A chain built on
totals would let two upgrades each see the same unspent balance and each take it.

**Refunded money is not available as credit.** Money handed back is not ours to carry forward, and
refunds reduce the oldest payments first — any order is defensible, but leaving it implicit would
not be, because it decides how much a partially-refunded engagement can still carry.

`applyCredit` **refuses rather than clamping** when the request exceeds what is available. Applying
a smaller credit and reporting success leaves an unexplained difference on an invoice a client is
reading.

`quoteUpgrade` floors `netToPay` at zero: credit exceeding the new retainer stays as credit rather
than becoming a payment out. A negative here would read as "we owe them", which is a different
claim with different consequences.

---

## Smaller decisions

**The sign of a billing line is carried by its `kind`, not by the number.** A negative charge is
refused. A query summing signed amounts would net a refund against a charge and report a balance
that is arithmetically true and answers nobody's question.

**The balance names its components** — charged, paid, refunded, credited. "You owe $4,200" answers
less than the four numbers that produced it, and a client disputing an invoice is asking about one
of the four. `outstanding` never goes negative: an overpayment is a credit, not a debt.

**The committed window is fixed at the offer version in force when the engagement started.**
Deriving it from the current offer would let a repricing move a client's commitment under them —
and the window is what the quality trigger and prepay proration run against.

**The engagement minimum is reported, not enforced.** `meetsMinimum` is a fact an operator acts on.

---

## Correction the tests forced

The module header and plan doc both illustrated the floating-point hazard with "8.5% of $47,300 is
`4020.4999999999995`". Writing the assertion showed that expression is **exact**, and two further
attempts asserted inexactness on expressions that were also exact — `1040.11 * 8.5` is exact; it is
the division by 100 that loses it.

Corrected in the test, the module header and the plan. The lesson is narrow and worth keeping: **an
illustrative example in a comment is a claim, and a claim in a comment is not checked by anything.**
Writing the test is what caught it, which is an argument for asserting the motivating example
rather than only the fixed behaviour.

---

## Observed once, unreproduced

A single full-suite run showed one failure that four subsequent runs did not. It occurred in a
command that restored two source files from backups **and** ran the formatter **and** ran the tests
in one invocation — and tests resolve `@bwc/*` to source, so prettier was rewriting files vitest was
reading. The leading explanation is that command's sequencing rather than the code. Recorded rather
than passed over, because a green re-run proves nothing on its own.

---

## Known gaps

- **No payment processing.** `BillingRecord` records what was agreed and what was received; a
  processor is a gated vendor.
- **No offers seeded.** The ladder's structure is built and empty — what to charge is the company's
  decision, not something to infer from a specification.
- **1.3 Sales Motion** owns how a client arrives at a rung.
- **`FundingOutcome` is a minimal stand-in for 5.5** Funding Outcome Ledger (V1.5), which will
  subsume it — the same arrangement 5.2's `LenderOutcome` has.
- **7.3's `buildFeeExhibit` still takes dollars.** It renders rather than accumulates, so the
  exposure is display-only; retrofitting a signature four tests depend on belongs in its own change.
