# 4.3 Call Recording, Summaries & Promise Tracking · 4.5 Marketing Ops

Packages: `@bwc/calls`, `@bwc/marketing` · Schemas: `calls`, `marketing`
ADRs: [0015](adr/0015-an-after-the-fact-control-produces-an-obligation.md), [0016](adr/0016-every-ab-variant-must-scan-clean-before-the-test-runs.md)

**Completes Category 4, and with it every V1 module in the blueprint's phasing.**

---

## 4.3 — a control that runs after the fact

### The decision — ADR-0015

4.2 scans outbound content and returns `blocked`, which works because it runs _before_ sending.

A call has already happened. The client heard the sentence. A verdict of `blocked` would describe a
state of affairs that does not exist. So a detected promise becomes a **correction obligation**:
what was said, who owes the correction, by when, and — to close it — the correction itself.

| Rule                                           | Why                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Cannot close without the correction text       | A tick records that a client was corrected when nobody told them anything — worse than an open obligation, because it stops anyone looking |
| Dismissal takes a Level 3 human and a reason   | False positives are deliberate; without the human, dismissal is the cheapest way to clear a queue                                          |
| Windows scale with severity (24h / 72h / 168h) | A misstated amount is corrected the next business day — the client is planning on it now                                                   |

`calls.promise.detected` is a `serious` risk event in 6.5. A promise is the earliest point at which
a client forms an expectation we may not meet, which is what most complaints are about.

### Detection is not the scanner, and cannot be

The Claim Library is exact-phrase, and the promise varies by amount: "$100K", "a hundred grand",
"six figures" are one promise and would need three entries.

So `PROMISE_DETECTORS` matches the **shape** of a statement — a capability assertion near a
quantity, an approval prediction, a timeline commitment, a rate quote — as a reviewable table, and
lives in its own file so loosening one mechanism cannot silently loosen the other.

> The first version of the money pattern matched digits only, and missed _"we should be able to
> secure a hundred grand for you."_ A detector that catches only the written form of a spoken
> promise catches the promises nobody makes. Spelled-out amounts are now matched, and the reason is
> recorded in the code.

False positives are accepted: a flagged sentence that turns out fine costs a reviewer thirty
seconds; a missed one costs a client a promise nobody corrected.

### Recording consent is a jurisdiction question

Blueprint 4.3 says "recorded (with consent)". Whose consent is state law, and it differs.

About eleven states require **all parties** to consent. Recording a client there without their
consent is a crime **in the state where the client is sitting** — not where we are. So the rule is
computed from the client's jurisdiction, exactly as 7.2 computes a disclosure obligation:

- **All-party state** → requires a live `call_recording` consent (new kind in 1.5).
- **Confirmed one-party state** → our own participation suffices.
- **Unclassified state** → requires consent. An unclassified state is not a one-party state; it is
  a state nobody looked at, and the difference is a criminal exposure. The cost of asking for
  consent we did not strictly need is a mildly awkward sentence at the top of a call.

The all-party list carries **citations** and an `openQuestion` where the position is genuinely
unsettled (IL after its statute was rewritten; MA, which turns on secrecy rather than consent; OR,
which distinguishes telephone from in-person). 7.2's rule again — an invented rule is worse than a
missing one, because it looks reviewed.

**A refused recording is still a call record**, with `consent_refused` and a ledger event. "We
wanted to record this and the client's state would not let us" is evidence, the same way a blocked
send is in 4.1.

### What is `not_built`

VoiceForge is not gated in, so `captureCall` and summary generation report `not_built`. Everything
that operates on a transcript is fully built — the 3.3 split.

Two details that matter:

- `analyseCall` on a transcript-less call returns `not_built` **naming the seam**, not a clean
  analysis. A clean-looking result here would mean a promise nobody corrected.
- The AI summary is carried **inside** the analysis result as its own `not_built` value rather than
  omitted. A caller who received an analysis with no summary field would reasonably conclude the
  call did not need one.

---

## 4.5 — governance over content nobody read

### Every A/B variant scans clean first — ADR-0016

An A/B test optimises for a metric. If one arm may say something banned and the other may not, the
test measures whether non-compliant language converts better. **It does.** And while the test runs,
real clients read every arm — a "losing arm" is not hypothetical.

So variants are scanned at registration and refused if they fail: `blocked` outright, and
`requires_disclosure` unless the disclosure is _in the variant body_. An experiment needs two
variants to start, and none may be added mid-flight.

**Declaring a winner adopts nothing.** A conversion number is a reason to consider a claim, not a
review of it; adoption goes through `proposeClaim`.

`staleVariants` reports arms whose admitting scan no longer matches the Library, derived at read
time — nothing mutates a running experiment underneath it.

### Claim proposals are the intake 7.4 never had

Until now a claim reached the Library by somebody calling `publish`. Blueprint 4.5 requires new
claims to "route through Compliance Review Board before Marketing Claim Library additions".

- `intendedUse` is required. The same sentence is fine on a landing page and a problem in a
  mid-application email, and the Board cannot tell which is being asked without being told.
- Approval **publishes into 7.4 in the same call**, so there is no window where a proposal reads
  approved and the Library does not have it.
- Approving as `banned` is a legitimate outcome — somebody asked whether we may say this and the
  answer is that nobody may. That belongs in the Library, which is more useful than a rejected
  proposal nobody will find.
- A rejected proposal **keeps its phrase**. "We considered saying this and decided not to" is the
  more useful half of the record.
- A proposal never becomes a second place approved wording lives — the same argument 8.1 makes
  about per-partner claim libraries.

### Campaigns and assets

- A campaign **cannot activate into a state 7.2 has not activated**. Marketing into a state is the
  same exposure as serving a client there — arguably earlier, since the marketing is what brings
  them. The refusal names which states.
- `sourceChannel` is **fixed at creation**. Renaming it would orphan every lead already attributed
  to the old value and split one campaign in two in a channel report.
- **This module does not write attribution.** `channelFor` hands out the value; 1.3 writes it once,
  because a referral fee is owed on it.
- Assets are scanned on the way **into** review, because blueprint 4.5 governs "content produced
  via SelfPublisherForge / AnimaForge / VideoEditForge cascades" — content nobody read before it
  arrived. A blocked asset goes to `rejected` with the reason, **not back to draft**: draft is where
  somebody is still writing, and losing that distinction means the same banned phrase gets
  resubmitted by whoever picks the file up next.
- Approval runs only from `in_review`, so nothing reaches the library unscanned.

---

## Tested

47 tests: `tests/integration/calls-and-marketing.test.ts` (27) and
`tests/invariants/call-promise-detection.test.ts` (20). Suite total **745**.

Mutation-verified:

| Mutation                                 | Failures |
| ---------------------------------------- | -------- |
| Close an obligation with a tick          | 2        |
| Register a banned A/B variant            | 1        |
| Ignore the all-party consent requirement | 3        |
