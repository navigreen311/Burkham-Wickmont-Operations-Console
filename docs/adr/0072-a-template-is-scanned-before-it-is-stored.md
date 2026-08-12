# ADR-0072 - A template is scanned before it is stored, and carries its own disclosure

**Status:** Accepted - **Date:** 2026-08-12 - **Modules:** 4.1 Communications Hub, 4.2 Communication
Compliance Scanner, 7.4 Marketing Claim Library

## Context

Message templates (4.1) were empty. Seeding them is straightforward; the question is when the
compliance scan happens.

The default answer is "at send". `packages/middleware/src/index.ts` step 7 already scans
client-facing content, so every message produced from a template is scanned before it goes out, and
a banned phrase in a template would be caught.

Caught **every time**, which is the problem. A template is not a message. It is a message that will
be sent many times, so a banned phrase in one template is a banned phrase in every send it produces

- a defect that reproduces at the rate the business communicates, discovered by an operator who
  cannot fix it because the template is stored and the send is blocked.

There is a second-order failure too. Step 7 blocking a send is indistinguishable from a
misconfiguration at the moment it happens, and the pressure at that moment is to get the message
out.

## Decision

**`seedMessageTemplates` scans every template body against 7.4 before publishing any of them, and
publishes nothing unless all of them pass.**

Three consequences follow, and all three are intended.

### 1. Seeding templates into a tenant with no claim library refuses

`scanForTenant` refuses on an empty library, and that refusal is propagated verbatim rather than
swallowed. So the ordering is explicit: the Marketing Claim Library exists first, or there are no
templates.

This is the correct answer rather than an inconvenience. "This template is sendable" is a statement
about the library it was checked against; with no library it is a statement about nothing. Making
the ordering a runtime refusal rather than a convention means it cannot be got wrong quietly.

It also serves as this slice's proof that it did not weaken what it was fixing. The obvious wrong
version of "the library is empty and nothing can be sent" is to soften the empty-library refusal.
`tests/integration/message-template-seed.test.ts` asserts that refusal still fires, first, before
anything else.

### 2. One bad template blocks the batch

Not the offending template - the batch. A partial publish leaves some send paths built and some
absent, with nothing on the record saying which, and "the welcome email exists but the document
request does not" is discovered by a client not receiving one. The refusal names every offending
template and phrase, so the report is actionable in one pass.

### 3. A requires-disclosure phrase is only usable when the disclosure is in the body

8.1 says why, and says it about a partner:

> we do not control what the partner adds after we approve it, so "they will attach it" is a hope
> rather than a control.

For a template the argument is stronger, because there is no later step that _could_ add one. The
seed applies the same `text.includes(disclosure)` check 8.1 and 4.5 apply, and treats a missing
disclosure as a finding that blocks the batch.

`offer-received` is the template that demonstrates the rule rather than avoiding it. It says "up
to", which is a `requires_disclaimer` entry, and it carries `DISCLOSURE_MAXIMUM` in its own body.
A template set that passed by never using disclosure-gated language would prove nothing.

The disclosure is **imported from `@bwc/claims`, not retyped.** The check is exact string inclusion,
so a hand-copied disclosure fails on a changed comma - and the failure would read as the template
being wrong rather than as two copies of one sentence having drifted.

## What is not here

**No sequencing.** Blueprint 4.1 also lists onboarding sequences, document-chase workflows and
check-in cadence. All three are sequencing, and 2.2 owns playbooks, waits, escalation and
scheduling. A second scheduler here would drift from it and give the operator two places to look -
the same reasoning `templates.ts` already gives for staying thin.

**No voice templates.** 4.1 routes voice through CapitalForge to VoiceForge, and 4.3 treats a call
as something that has already happened - it detects promises in a transcript rather than approving
a script. A voice template seeded here would be a script for a system that does not read it.

## Consequences

- Nine templates cover the moments a file actually generates: welcome, document request, SMS
  reminder, authorization request, submission notice, offer, decline, appointment reminder,
  post-funding check-in.
- Every one of them scans clean against a 108-entry library, and the assertion is per template
  rather than in aggregate.
- The templates promise process and never outcome. A test asserts no body contains "guarantee",
  "no risk", "pre-approved" or "fastest" - the sentence-level version of the whole library.
- `@bwc/comms` now depends on `@bwc/scanner` and `@bwc/claims`. Neither closes a cycle; both are
  declared in `package.json` **and** in the tsconfig `references`, because CI type-checks with
  `tsc -b` and a missing reference fails there rather than locally.

## Alternatives considered

**Scan at send only, and let step 7 catch it.** Rejected above: it converts a one-time authoring
error into a permanent per-send failure, discovered under deadline by somebody who cannot fix it.

**Scan each template and publish the ones that pass.** Rejected. A half-published template set is
worse than none, because it looks complete.

**Have `publishTemplate` itself scan, so every template ever published is checked.** Genuinely
better, and deliberately not done here. `publishTemplate` is called by existing tests and code
paths outside this slice, and adding a scan to it would make an empty claim library break template
publishing everywhere - a change with a much wider blast radius than a seed. It is the right
follow-up and is recorded as one.
