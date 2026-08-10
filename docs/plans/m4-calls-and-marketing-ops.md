# Plan — 4.3 Call Recording, Summaries & Promise Tracking, 4.5 Marketing Ops

**Blueprint:** 4.3, 4.5 · **Branch:** `ai-feature/m4-calls-and-marketing-ops`
**Follows:** 8.1 / 8.3 Partner Portal (merged, `d927aa2`)

The blueprint's phasing says "Categories 1–4 build in full for V1", so both are V1. With 4.1, 4.2
and 4.4 already shipped, this completes Category 4 and the last untouched V1 ground.

---

## Mini-PRD

### Problem

**4.3.** Founder-led and Concierge calls are where the riskiest sentences in this business get
said. "We can probably get you a hundred grand" is not in any document, passes no scanner, and is
the exact statement the Funding Ethics Firewall exists downstream of. Nothing captures it.

**4.5.** New marketing claims currently reach 7.4's Marketing Claim Library by somebody publishing
them. There is no intake, no review queue, and nothing stopping an A/B test from discovering that
non-compliant language converts better.

### Success metrics

- A promise made on a call produces a **correction obligation** with a deadline and an owner.
- No call is recorded without the consent its jurisdiction requires.
- Every A/B variant scans clean **before** the test runs.
- A new claim reaches the Library only through review.

### Risks

| Risk                                                                     | Mitigation                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Recording in an all-party-consent state without the client's consent** | Consent requirement is per-jurisdiction; recording refuses without it                               |
| Promise detection reported as a scanner verdict                          | 4.3 produces obligations, not blocks — see the key decision                                         |
| A/B testing optimising toward non-compliant language                     | Every variant must scan clean to be registered; a failing variant is rejected, not "the losing arm" |
| 4.5 growing a second claim library                                       | Proposals carry text; **approval publishes into 7.4** and 4.5 stores no approved wording            |
| 4.5 writing attribution                                                  | 1.3 owns it, write-once; 4.5 supplies the campaign value at lead creation and nothing else          |

---

## Key decision — a control that runs after the fact produces an obligation, not a verdict

4.2 scans outbound content **before** it is sent. It returns `blocked`, and blocking works because
nothing has happened yet.

A call has already happened. There is nothing to block. A promise-tracking module that returned
`blocked` would be describing a state of affairs that does not exist — the client has already heard
"we can probably get you a hundred grand", and the only real question is what we do about it.

So 4.3 produces a **correction obligation**: a record of what was said, who must correct it, by
when, and whether they did. Open obligations are visible; a closed one carries the correction that
closed it.

This also settles the detection mechanism. 4.2 is exact-phrase against the Claim Library, by design.
"We can probably get you $100K" cannot be a library entry, because the number varies — the library
would need an entry per amount. So promise detection matches the **shape** of a statement (a
capability assertion plus an amount; a timeline commitment; an approval prediction) rather than its
wording, and it is deliberately kept separate from the scanner so that a change to one does not
silently loosen the other.

## Key decision — recording consent is a jurisdiction question

Roughly eleven US states require **all parties** to consent to a call recording; the rest require
one. In a one-party state our own consent suffices. In an all-party state, recording a client
without their consent is a crime in the state where the client is sitting.

So the requirement is computed from the jurisdiction, and `beginRecording` refuses in an all-party
state without a live `call_recording` consent from the client. The list of all-party states is data
with citations, seeded as counsel-reviewable rather than asserted.

## What is `not_built`

Blueprint 4.3 routes through **CapitalForge → VoiceForge**, which is not gated in. So audio capture,
transcription and AI summary generation report `not_built`.

What is fully built is everything that operates on a transcript once it exists: promise detection,
disclosure completeness, objection and buying-signal extraction. Same split as 3.3 — the vendor seam
is honest about itself, and the analysis is pure, tested, and ready the day a transcript arrives.

---

## Architecture

```
packages/calls/
  consent.ts        per-jurisdiction recording consent, all-party state list
  capture.ts        the VoiceForge seam - begin/complete, reported as not_built
  detect.ts         promise / disclosure / objection / signal detection over a transcript
  obligations.ts    correction obligations: raise, list, close
packages/marketing/
  campaigns.ts      campaign records and channel values for 1.3
  content.ts        content workflow states and the asset library
  proposals.ts      claim proposals -> Compliance Review Board -> 7.4
  experiments.ts    A/B variants, constrained by the scanner
```

---

## Test strategy

- Recording refuses in an all-party state without client consent, and permits in a one-party state.
- Revoking recording consent stops the next recording.
- A capability claim with an amount is detected; the same sentence without an amount is not.
- A detected promise raises an obligation with a deadline and an owner.
- An obligation cannot be closed without the correction that closed it.
- Disclosure completeness names what was missing, not merely that something was.
- A/B variant registration refuses a variant the scanner blocks.
- A claim proposal cannot reach 7.4 without review; approving publishes it.
- 4.5 exposes no path that writes lead attribution.

## Out of scope

VoiceForge itself. Actual A/B traffic splitting — 4.5 records the configuration and constrains it;
serving is FunnelForge's. Unit Economics (9.2) consumes the channel feed and is Category 9.
