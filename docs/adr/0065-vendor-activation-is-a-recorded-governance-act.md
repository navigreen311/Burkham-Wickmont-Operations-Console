# ADR-0065 - Vendor activation is a recorded governance act, not a constant

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 11.5 Integration Layer, 11.7 Admin
Configuration Center

## Context

CLAUDE.md carries a standing constraint: **no client onboards before Plaid, the business bureaus
and personal credit each clear Argus security review, a signed DPA and SOC 2 Type II.**

The question this slice exists for is how that constraint is enforced today. The answer is
`VENDOR_GATES` in `packages/integration/src/index.ts`:

```ts
plaid: { argusReviewed: false, dpaSigned: false, securityAttestationVerified: false, ... }
```

**Four booleans in a TypeScript literal.** To let client bank statements, credit reports, SSNs and
EINs leave this firm, somebody edits that file and deploys. There is no actor, no authority level,
no evidence, no date, and no record of who accepted what. The most consequential control in the
system - whether client financial data reaches a third party - is a source edit reviewed as code
by whoever happened to be on the pull request.

It is marginally better than an environment variable, in that git retains a diff and an author.
That is not a governance record. A code reviewer approving a diff is not a Level 3 human accepting
a SOC 2 report, and `git log` does not contain the report number.

The constant also asserts something nobody authorised: **CapitalForge is marked cleared on all
four preconditions.** No document backs that. A sibling venture holding client financial data is
still a third party holding client financial data.

## Decision - the same shape ADR-0009 already chose for states

ADR-0009 is exact and it is the precedent. A state does not go live without a Level 3 human plus a
counsel review carrying a **document reference**, and the level is read from the recorded actor
rather than from the caller who claims it. A vendor clearing Argus review, a DPA and SOC 2 Type II
is the same kind of fact: pieces of evidence, a human who accepted them, a date.

So activation is **derived from `VendorEvidence` rows**. Four kinds are required of every vendor -
vendor selection, Argus security review, signed DPA, security attestation - and each row carries:

| Field                       | Why                                              |
| --------------------------- | ------------------------------------------------ |
| `documentReference`         | **Required.** The thing an auditor can pull      |
| `issuedBy`                  | For three of the four kinds the issuer is not us |
| `issuedOn` / `validUntil`   | A SOC 2 Type II covers a stated period           |
| `acceptedBy` / `acceptedAt` | The Level 3 human, read from the actor record    |

There is no boolean anywhere that a person can set.

### The document reference has no empty representation, and is checked FIRST

`recordEvidence` refuses a blank or placeholder reference **before** it checks authority. The
ordering is deliberate: a Level 3 human is not a licence to record nothing, and if the checks ran
the other way round the refusal a blank reference got would read "you are not senior enough" -
teaching an operator that a more senior person could wave it through.

This is the line this slice was told not to cross. **A screen where somebody ticks "SOC 2 cleared"
with no document reference is worse than the environment variable**, because the constant at least
left a commit with an author against it, and the tick looks reviewed.

Placeholder shapes (`n/a`, `TBD`, `xxx`, `-`) are rejected explicitly. That is the cheap half of
the defence and is not meant to be complete; the expensive half is that a named Level 3 human has
their name against the row.

### Staleness de-activates

ADR-0013 says staleness moves toward the safe answer and ADR-0044 established the direction differs
per module. Here it is not close. A SOC 2 Type II covers a stated period and says nothing about the
vendor afterwards, so evidence past `validUntil` stops counting and **the gate closes on its own**.
An attestation is refused if it is recorded without an expiry, because one with no end date is a
document somebody has misread.

The standing is derived on read, so expiry needs no scheduled job to notice - which matters,
because a job that stops leaves every vendor reading as activated.

### The gate is read at the moment of the call

`gatedAdapter.call` reads `activationStanding` per call rather than caching at module load. Same
argument ADR-0058 makes about consent: a withdrawn DPA has to take effect now, not at the next
deploy. Withdrawal is a compensating write - the row stays, so "what did we rely on in March"
survives.

## Consequences

**No vendor is activated today, including CapitalForge**, whose compiled `true` this slice removed.
That is a behaviour change and it is the correct one: nothing on record supported it. Someone has
to accept four documents for CapitalForge before its adapter works again.

**The synchronous `isActivated` stays and is now the fail-closed floor.** Three consumers outside
this package read it - `@bwc/intelligence`, `apps/api/src/app.ts` and
`tests/invariants/isolation-provenance-pii.test.ts` - and this slice does not own them. It now
answers "activated with no evidence considered", which is always `false`. **The two answers can
disagree, and the disagreement is safe in exactly one direction:** the sync one can only
over-refuse, never over-permit. The follow-up is to move those three onto `activationStanding`,
and until that happens `@bwc/intelligence` will keep refusing even for a vendor whose evidence is
complete. That is a real functional gap and it is named here rather than discovered.

**No Ledger event is emitted.** `EVENT_TYPES` lives in `packages/core/src/events.ts`, which this
slice does not own. The `VendorEvidence` row is itself the governance record - actor, document,
date - so the act is not unrecorded, but it is absent from the Ledger, which is where an audit
looks first. It wants `integration.vendor.evidence_accepted` and `.withdrawn` in a slice that can
edit that file.

**The surface is read-only, and that is a refusal rather than an omission.** See ADR-0066.

## Alternatives considered

**Leave it a constant and require a code review.** Rejected. A code reviewer approves a diff; they
do not read a SOC 2 report, and the report number is nowhere in the repository.

**An 11.7 Admin parameter.** Rejected by ADR-0019's own rule: this is a control, and configuration
must not be able to turn a control off. It is also the wrong shape - a parameter carries a value,
and what is needed here is evidence.

**Booleans in the database instead of evidence rows.** Rejected. That is the checkbox with extra
steps: it moves where the tick lives without adding anything an auditor can pull.

**Trust `git blame` as the record.** Rejected. History can be rewritten, it names a code author
rather than an accepting officer, and it contains no expiry - so an attestation that lapsed would
keep the gate open indefinitely.
