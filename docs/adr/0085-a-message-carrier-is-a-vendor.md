# 0085 - A message carrier is a vendor

- Status: accepted
- Date: 2026-08-13
- Context: `packages/integration/src/{index,activation}.ts`, `packages/comms/src/send.ts`, `packages/calls/src/capture.ts`

## Context

Assembling the vendor readiness pack turned up a hole that five separate completeness assessments
had missed, because every one of them counted stubs rather than asking what governed them.

**Email, SMS and voice were not in `VENDOR_IDS`.** No `VendorGate`, no entry in
`REQUIRED_EVIDENCE`, no activation path, no reserved environment variable, and no row on the vendor
health board. Neither `comms/send.ts` nor `calls/capture.ts` imported `@bwc/integration` or
consulted `isActivated`.

Each returned `not_built` from a hardcoded sentence. **Going live meant editing that sentence and
deploying** — which is precisely the mechanism ADR-0065 removed for the other four, described there
as what "let client bank statements and credit reports leave the firm — no actor, no evidence, no
date, no record."

The reason it survived is worth naming: nobody had counted a message carrier as a vendor. Plaid
holds bank data and obviously needs a DPA. An email provider carries client names, application
status and document requests — personal data under the same regimes — and reads like plumbing.

## Decision

**Email, SMS and voice are vendors, with no lighter treatment.**

- Added to `VENDOR_IDS`, to `VENDOR_GATES` at the fail-closed floor, and to `REQUIRED_EVIDENCE` at
  **the same four evidence items** a data vendor needs: vendor selection, Argus security review,
  signed DPA, security attestation.
- `comms/send.ts` and `calls/capture.ts` now consult `activationStanding` **at the moment of each
  call**, so a withdrawn DPA stops the next message rather than the next deploy — the property the
  other four already had.
- The refusal names what is outstanding instead of a constant. An operator reading it learns which
  evidence is missing, not merely that something is.
- All three appear on the vendor health board. It previously omitted the category while looking
  complete, which is the failure mode a health board exists to prevent.

**Voice is the sharpest case and got the same rule, not a stricter one.** Several states require
all-party recording consent, and that rule is an _invariant_ rather than a parameter — it binds
regardless of what this gate says. The gate governs whether a provider may be called at all; the
consent rule governs whether a call may be recorded. Two controls, neither substituting for the
other.

## Consequences

**The seven seams are one set under one rule**, and the readiness pack's central finding is closed.
That pack was updated in place rather than left to go stale — the section is kept, marked resolved,
so the reasoning survives with the fix.

**Verified by mutation.** Replacing the gate consultation in `comms/send.ts` with the hardcoded
sentence it used to return fails the assertion immediately: the test requires the refusal to name
outstanding evidence, which a constant cannot do.

**Three existing tests failed and all three were right to.** Each asserted the old hardcoded
wording, or — in the health board's case — that every gated vendor cites "Decision A" or
"Decision B". That held while every gated vendor was a data source; the delivery processors are
gated for a different reason and cite no such decision. The assertion now requires each row to
explain itself, and separately checks that the data vendors still cite their decision.

**Six vendor selections now stand between this system and its first live seam**, not three. That is
not a regression — the other three were always required and were simply not being counted.
