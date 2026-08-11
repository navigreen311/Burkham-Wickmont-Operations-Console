# ADR-0051 — A surface with no declared action gets no write

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 1.2 Client Household / Entity Graph, 1.3 Sales Motion, 8.1 Partner Portal, 8.3
Certification, on the internal Console
**Extends:** ADR-0032

## Context

ADR-0032 recorded the defect this Console shipped on top of: the write routes called their modules
directly, so no Authority Level was checked on any of them, and a Level 0 observer with a session
could move a client to `pass`. The fix was that every write goes through `chain()` with a declared
action, and `ACTION_MINIMUM_LEVEL` grew four governance actions to make that possible — each with a
paragraph of reasoning about the level it was given.

This slice surfaces five more modules. Three of them have working, tested write functions:

- **1.2** — `upsertEntity`, `upsertOwner`, `addEdge`, `endEdge`, `recordStatedRevenue`,
  `setPrimaryEntity`, `revealSsn`, `revealEin`
- **1.3** — `createLead`, `qualifyLead`, `recordBlueprintDelivered`, `scheduleReviewCall`,
  `convertLead`, `closeLead`, `recordActivity`, `recordReadiness`, `correctAttribution`
- **8.1 / 8.3** — `registerPartner`, `recordQualification`, `completeOnboarding`, `suspendPartner`,
  `terminatePartner`, `publishModule`, `recordCompletion`, `approveClaim`, `withdrawClaim`,
  `approveBrandArrangement`

Every one of them emits a Ledger event. **`ACTION_MINIMUM_LEVEL` declares an action for none of
them.** Its fifteen entries cover reading and analysing a file, drafting and sending client
communications, submitting applications, and the four governance determinations. Nothing covers
recording a structural fact about a household, moving a lead through a pipeline, administering a
partner relationship, or disclosing a government identifier.

## Decision

**No write route is built, and the gap is reported in the product.**

Declaring an action means editing `packages/core`, which this branch does not own — and more to the
point, it is a judgement about Authority Levels that belongs with the fifteen already there, each of
which carries its reasoning next to its number.

### Why not borrow the nearest action

Every near-miss is worse than the absence, and the reveal is the clearest case.

`revealSsn` discloses a government identifier and writes `graph.ssn.revealed`. The nearest declared
actions are `read_document` and `analyze_file`, both **Level 0**. Using either would mean the Ledger
records `authority.action_authorised` with `action: 'read_document'` against an SSN disclosure.

**A wrong label on a true event is harder to catch than a missing feature, because it looks like
evidence.** A missing button gets reported by the first operator who wants it. A misfiled audit
record gets found by whoever is reconstructing who saw what, at the point when that matters most.

The others are the same shape in lower stakes. `create_client_record` (Level 2) is about a client,
and converting a lead produces one — which is exactly why borrowing it for `createLead` would
authorise the wrong end of the motion. `send_partner_followup` (Level 2) means communicating _with_
a partner, which is a different act from terminating one.

### What is reported instead

Each surface carries `writes: { available: [], blocked: [...] }`, and each blocked entry names the
capability, the module functions that implement it, the missing action, and why. The pages render
it under "Writes this Console cannot offer".

**In the product rather than only in this file**, because the operator looking at a pipeline with no
buttons is the person who needs the reason. Without it they file a bug, somebody investigates, and
the answer — "the functions work, one line is missing in a file, and the line is a decision nobody
has taken" — is reconstructed from scratch each time.

Each entry is self-contained. An earlier draft had the second entry on a surface say "Same reason",
which reads fine in a diff and tells an operator who scrolled to it nothing at all; a test now
asserts every entry names the chain and the missing action for itself.

### `/api/console/capital/model` is a POST that is not a write

One route takes a body and changes nothing: it computes 5.1's and 5.6's analyses over positions the
operator states, persists no row and emits no event. It does not go through `chain()`.

That is not a loophole in the rule. **The rule is that every write is authorised**, and a function
with no I/O writes nothing. Routing it through the chain would put an
`authority.action_authorised` event in an append-only store every time somebody totalled a column,
which is noise that makes the real entries harder to find. The rule would be weakened by pretending
a calculator is an act so that the shape looks uniform.

## Consequences

**Five read-only surfaces.** 5.1/5.6 and 9.1/9.2 have nothing to write in the first place — every
export of `@bwc/capital` and `@bwc/dashboards` is a computation or a read — so for those two the
absence costs nothing. For 1.2, 1.3 and 8.1/8.3 it is a real limitation and it is stated as one.

**The next slice on any of these three starts in `packages/core`.** Whoever takes it should expect to
argue about levels, not about routes: the routes are a morning's work once the actions exist, and
the actions are the decision.

**A candidate list, offered without recommending it.** Recording a graph fact and moving a lead look
like Level 1 or 2 work; administering a partner looks like Level 2 with termination at 3, matching
`TERMINATION_AUTHORITY_LEVEL` which 8.1 already declares for itself; a reveal is its own thing and
plausibly the first action that should require a stated purpose in the chain rather than only in the
module. None of that is decided here.

## Alternatives considered

**Declare the actions in this branch.** It would ship the writes. It also puts fifteen carefully
reasoned Authority Levels next to nine chosen in a hurry by somebody building a page, in a file
whose whole design is that a reviewer can argue with each number.

**Build the routes and have them refuse with `not_built`.** The 501 pattern, and it fits principle 9.
Rejected because a write endpoint that exists and does nothing reads as nearly-done: it invites a
caller, and the honest state is that nobody has decided what level the act requires. The refusal is
better placed on the surface that would have offered the button.

**Say nothing and ship read-only surfaces.** The smallest change and the one that guarantees the
question gets asked again from scratch. An absence with no explanation is indistinguishable from an
oversight, which is the failure principle 9 is about.
