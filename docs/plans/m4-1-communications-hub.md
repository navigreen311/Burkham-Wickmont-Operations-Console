# Plan — 4.1 Communications Hub, with 4.4 Client Notification Preference Center

**Blueprint:** 4.1, 4.4 · **Branch:** `ai-feature/m4-1-communications-hub`
**Follows:** 7.1 Compliance Evidence Vault (merged, `72b36d3`)

---

## Why both modules, not just 4.1

4.1's dependency list names the Preference Center, and the dependency is not a convenience — it is
the gate. **You cannot honestly send anything without knowing whether the client permits that
channel, what timezone they are in, and whether they are on a do-not-call list.**

The alternative would be to take permission as a parameter, the way the Regulatory Engine takes a
jurisdiction. That works for a jurisdiction because it is a _fact about the client_ that another
module owns, and passing it wrongly is a mistake. Permission is a _decision by the client_, and a
send path that accepts `smsAllowed: true` from its caller would let code assert consent the client
never gave. That is a materially worse failure, and it is the one TCPA exists about.

So both, in one slice — the same call made for 5.2 with 5.4, and for the same reason.

This also closes a gap the Evidence Vault reports today: 7.1's `communications` source is
`not_built`, and every client file currently carries a note saying a reader "should not treat its
absence as evidence that nothing was said."

## Mini-PRD

### Problem

The Console can produce a deliverable, generate a contract and refuse a placement — and has no
record of anything ever said to a client. Blueprint 4.1 asks for a "full client comms log preserved
for compliance audit", which is also the only way to answer what a client was told and when.

### Success metrics

- Nothing sends without a live permission check on the actual channel.
- SMS and voice never send outside the client's local quiet hours.
- Do-not-call cannot be overridden by anything.
- Every outbound message passes the compliance scanner and the state gate before it leaves.
- 7.1's `communications` source stops being a gap.

### Risks

| Risk                                                        | Mitigation                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **An urgent flag becomes a way past a legal prohibition**   | Urgency overrides _preference_, never _prohibition_. Do-not-call and quiet hours are unreachable by any flag      |
| A timezone is wrong and a client is texted at 5am           | The window is computed in the client's IANA zone; a missing timezone is a refusal, never a default                |
| Message bodies reach the Ledger                             | The log holds the body; the Ledger carries ids, channel and a hash                                                |
| A second scheduler drifts from the Workflow Engine          | Sequences are playbooks in 2.2. This module sends one message; it does not own cadence                            |
| Consent for marketing is confused with authorization to act | Preference governs contactability; 1.5 governs authorization to do things. Different questions, different modules |

---

## Key decision — urgency overrides preference, never prohibition

Blueprint 4.4 asks for "urgent alert override rules with escalation paths". The obvious build is a
flag that sends anyway.

Two kinds of "no" are being conflated there, and the module separates them:

|                           | Overridable by urgency | Why                                      |
| ------------------------- | ---------------------- | ---------------------------------------- |
| "I prefer email over SMS" | **yes**                | A preference about convenience           |
| "Do not call me"          | **no**                 | A standing instruction with legal force  |
| Quiet hours (SMS/voice)   | **no**                 | TCPA restricts the hours, not the reason |
| Channel not permitted     | **no**                 | The client did not agree to that channel |

An urgent flag that reached the second group would be a documented mechanism for breaking the law,
which is worse than not having the feature.

## Key decision — quiet hours are computed in the client's timezone, and a missing one refuses

TCPA restricts calls and texts to 8am–9pm **local to the recipient**. Local means the client's
zone, not the server's and not the company's.

A missing timezone is a **refusal**, not a default. Defaulting to the company's zone would send at
the wrong hour for exactly the clients furthest away — and the failure is invisible, because from
the sender's side it looks like a normal afternoon.

## Key decision — this module sends one message; the Workflow Engine owns cadence

Blueprint 4.1 lists "onboarding sequences", "document chase workflows" and "post-funding check-in
cadence". All three are sequencing, and 2.2 already has playbooks, scheduling, wait states and
escalation.

A second scheduler here would drift from it and give the operator two places to look. The same call
was made for 5.1's promo alerts and 1.3's inactivity escalation.

---

## Architecture

```
packages/comms/
  preferences.ts  4.4 - channel permissions, timezone, do-not-call, urgent routing
  windows.ts      pure - TCPA quiet hours and timezone-aware delivery windows
  templates.ts    message templates, versioned
  send.ts         the send path: preference gate -> middleware chain -> log
  log.ts          the communication log, and the read 7.1 consumes
```

### Data model — schema `comms`

- `NotificationPreference` — one per client: per-channel permission, timezone, do-not-call
- `MessageTemplate` — versioned, per channel
- `Communication` — the log: direction, channel, body, status, and why it was or was not sent

### Integration

Sending is a client-facing action, so it runs through the **middleware chain** — which means the
Regulatory Engine's state gate at step 5 and the Communication Compliance Scanner at step 7. A
message to a client in an unactivated state is refused, which is the intended cost stated in 7.2.

---

## Test strategy

- A channel the client has not permitted is refused, urgent or not.
- Do-not-call is refused, urgent or not, on every channel it covers.
- An SMS at 7am local is refused and at 10am local is sent, computed across two timezones.
- Email is not quiet-hours restricted; SMS and voice are.
- A missing timezone refuses rather than defaulting.
- Urgency reroutes from a preferred channel to a permitted one.
- A message containing banned language is refused by the scanner before it is logged as sent.
- A refused send is still logged, with the reason.
- The Ledger carries no message body.
- 7.1's `communications` source reports `complete` or `empty`, never `not_built`.

---

## Out of scope

Actual delivery — no email or SMS provider is gated in, so the module records what was approved to
send and reports the send itself as `not_built` at the provider seam. Voice, which routes through
CapitalForge → VoiceForge. Sequence definitions, which are 2.2 playbooks. The client-facing
preference UI (Client Portal).
