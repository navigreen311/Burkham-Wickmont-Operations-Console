# Vendor readiness pack

What each external seam needs before it can go live, derived from the code rather than from
recollection. Every claim here is checkable against a named file.

**Nothing in this document contains a credential.** Variable _names_ appear; values never do, and
they belong in a secret manager rather than in a repository, a ticket, or an email.

---

## 1. What "activated" means, and what it used to mean

Activation is **not** a configuration flag. ADR-0065 moved it, and the reason is written into
`packages/integration/src/index.ts`:

> Activation used to be these booleans: editing four literals and deploying was what let client bank
> statements and credit reports leave the firm — no actor, no evidence, no date, no record.

A vendor is activated now only when a **Level 3 human** has recorded four pieces of evidence, each
carrying a document reference the system checks is not a placeholder (`n/a`, `tbd`, `pending` and
similar are rejected — `isUsableDocumentReference`).

The four, from `VENDOR_EVIDENCE_KINDS`:

| Evidence                    | Label the system uses      |
| --------------------------- | -------------------------- |
| `vendor_selection`          | vendor selection           |
| `argus_security_review`     | Argus security review      |
| `data_processing_agreement` | signed DPA                 |
| `security_attestation`      | SOC 2 Type II verification |

`REQUIRED_EVIDENCE` requires **all four of all four vendors**, including CapitalForge — a sibling
venture rather than an outside supplier. The module states why: _"a sibling company holding client
financial data is still a third party holding client financial data."_

`VENDOR_GATES` remains as a fail-closed floor whose every flag is `false`, so any caller reading it
synchronously always gets the safe answer. It can only over-refuse, never over-permit.

---

## 2. The four gated vendors

All four are at **zero of four** evidence items. None is partially cleared.

### Plaid — bank connection and transaction feed

- **Outstanding:** Argus security review · signed DPA · SOC 2 Type II. _Vendor selection is
  settled_ — Plaid is named in Decision A.
- **Blocks 3 stubs directly** — `portal/actions.ts` (the Client Portal bank connection) and
  `dashboards/costs.ts` (two, shared with the bureau) — but the stub count understates it badly.
- **The largest single capability gap in the system does not appear as a stub at all:** every
  signal blueprint 6.1 names as the **primary** alert source is a Plaid feed, declared in
  `UNAVAILABLE_ALERT_SOURCES` (utilization change, NSF events and the rest). Risk alerting today
  runs on conduct breaches and hand-recorded observations only — _"a fraction of what it is supposed
  to watch"_, in the module's own words.
- Also gates Phase 0's `await_bank_authorization` wait, which is where a client file stops today.
- **Config reserved:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`.

### Business bureau — commercial credit data

- **Outstanding: all four.** No vendor has been selected; Specification 12.3 leaves this open.
- Blocks entity enrichment and the bureau half of cost reporting.
- **Config reserved:** `BUSINESS_BUREAU_API_KEY`.

### Personal credit — principal credit data

- **Outstanding: all four.** No vendor selected.
- Carries the most sensitive data of any seam. Note the standing constraint: **no client onboards
  until Plaid, business-bureau and personal-credit have each cleared review, DPA and SOC 2.**
- **Config reserved:** `PERSONAL_CREDIT_API_KEY`.

### CapitalForge — application submission

- **Outstanding: all four**, deliberately, despite being a sibling venture.
- Blocks `submit_application` reaching a real provider. Phase 1 runs to the submission step and
  stops there.
- **Config reserved:** `CAPITALFORGE_BASE_URL`, `CAPITALFORGE_API_KEY`.

---

## 3. The finding: three seams have no gate at all

**Email, SMS and voice are not in `VENDOR_IDS`.** They have no `VendorGate`, no entry in
`REQUIRED_EVIDENCE`, no activation path, and **no reserved environment variable**. Verified
directly: neither `packages/comms/src/send.ts` nor `packages/calls/src/capture.ts` imports
`@bwc/integration` or consults `isActivated`.

Each returns `not_built` from a hardcoded line in its own module. **Going live means editing that
line and deploying** — which is precisely the mechanism ADR-0065 removed for the other four,
described there as what "let client bank statements and credit reports leave the firm."

This matters most for **email**, the single most-blocking seam in the system:

| Seam               | Stubs                                           | What it blocks                                                                |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Email provider     | 6 in `@bwc/identity`, plus the shared send path | Every client send; password-reset delivery; email-address change confirmation |
| SMS                | shares `comms/send.ts` with email               | The two reminder templates (document chase, appointment)                      |
| Voice / VoiceForge | 3                                               | Call capture, transcript, and the whole 4.3 analysis chain                    |

Counts are `notBuilt` call sites, verified per file. `comms/send.ts` is a single stub covering both
email and SMS, which is why it is named rather than double-counted.

Email carries client names, application status and document requests — personal data under any DPA
regime. It is currently the only category of external processor that could be switched on without a
security review, a signed agreement, an accountable person, or a Ledger event.

**Recommendation, and it is code rather than paperwork:** add `email`, `sms` and `voice` to
`VENDOR_IDS` and `REQUIRED_EVIDENCE`, and route `comms/send.ts` and `calls/capture.ts` through
`gatedAdapter`. That is a small change — the model already exists — and it puts all seven seams
under one rule. Until it is made, this pack is the only place the asymmetry is written down.

`@bwc/comms` already refuses honestly today (_"the message passed every gate and was logged as
approved to send, but no delivery provider is gated in, so it has not been delivered"_), so the
risk is not that it lies. The risk is that switching it on requires nobody's signature.

---

## 4. The remaining stubs

Two of the eighteen are not vendor seams and will not clear with a contract:

- `interventure/invoicing.ts` — a **Gardner-level intercompany ledger** that does not exist. An
  internal decision, not a purchase.
- `partners/branding.ts` — **co-brand / white-label workspace provisioning** (8.1). Unbuilt scope.

The other two in `integration/index.ts` are the gate itself reporting refusals, which is correct
behaviour rather than a gap.

---

## 5. How to activate one, once the paperwork exists

1. A **Level 3 human** records each of the four evidence kinds through
   `recordEvidence`, each with a real document reference. Placeholders are rejected.
2. `activationStanding(vendor)` reports what is still outstanding, by name, until all four land.
3. Set `INTEGRATION_MODE` to `sandbox`, then `live`. It defaults to `stub`, and an unrecognised
   value throws at startup rather than falling back.
4. Supply the credentials from a secret manager. **Never commit them**; the repository has a Secret
   Hygiene CI job that will fail the build.

Order matters: the evidence gate is checked **before** `INTEGRATION_MODE` and independently of it,
so setting the mode without the evidence changes nothing except what a misconfiguration would have
cost.

### Revocation takes effect immediately, not at the next deploy

The question a security reviewer will ask: _what happens when a DPA is withdrawn?_

`activationStanding` is read **at the moment of each call**, never cached at module load — the code
says why: _"a withdrawn DPA has to take effect now rather than at the next deploy."_ Withdrawing an
evidence item through `withdrawEvidence` stops the next outbound call, with no restart, no cache
expiry and no deployment window in between.

That is worth putting in front of a reviewer unprompted. It is the difference between a control and
a configuration setting.

---

## 6. Summary

| Seam            | Gate exists | Evidence complete | Vendor chosen | Config reserved |
| --------------- | ----------- | ----------------- | ------------- | --------------- |
| Plaid           | yes         | 0 / 4             | yes           | yes             |
| Business bureau | yes         | 0 / 4             | **no**        | yes             |
| Personal credit | yes         | 0 / 4             | **no**        | yes             |
| CapitalForge    | yes         | 0 / 4             | **no**        | yes             |
| Email           | **no**      | —                 | **no**        | **no**          |
| SMS             | **no**      | —                 | **no**        | **no**          |
| Voice           | **no**      | —                 | **no**        | **no**          |

Three vendor selections and one governance change stand between this system and its first live
seam. None of them is engineering work on the modules themselves — every one of the eighteen stubs
sits behind a working engine that has been built and tested.
