# 4.1 Communications Hub, with 4.4 Client Notification Preference Center

**Package:** `@bwc/comms` · **Schema:** `comms`

---

## Why both modules in one slice

4.1's dependency list names the Preference Center, and the dependency is the **gate**. You cannot
honestly send anything without knowing whether the client permits that channel, what timezone they
are in, and whether they are on a do-not-call list.

Taking permission as a parameter — the way the Regulatory Engine takes a jurisdiction — would be
materially worse. A jurisdiction is a _fact about the client_ that another module owns, and passing
it wrongly is a mistake. Permission is a _decision by the client_, and a send path accepting
`smsAllowed: true` from its caller would let code assert consent the client never gave.

---

## Urgency overrides preference, never prohibition

Blueprint 4.4 asks for "urgent alert override rules". The obvious build is a flag that sends anyway,
and it conflates two kinds of "no":

|                           | Overridable by urgency | Why                                      |
| ------------------------- | ---------------------- | ---------------------------------------- |
| "I prefer email over SMS" | **yes**                | a convenience                            |
| "Do not call me"          | **no**                 | a standing instruction with legal force  |
| Quiet hours (SMS/voice)   | **no**                 | TCPA restricts the hours, not the reason |
| Channel not permitted     | **no**                 | the client did not agree to that channel |

A flag reaching the second group would be a **documented mechanism for breaking the law**, which is
worse than not having the feature.

`routeUrgent` is the whole of the override: it moves a message between channels the client
**permits**, consulting `mayContact` for each candidate and treating its verdict as final. It
returns `null` rather than falling back to a channel the send gate would refuse a moment later.

**Absence of permission is not permission.** Every channel defaults to `false`, so a client who has
said nothing is contactable on nothing. The opposite default would make the preference centre a
formality — every client would start contactable, and the record could only ever narrow from a
state nobody agreed to.

**Do-not-call covers calls and texts, not email.** Treating it as a blanket communications ban would
also stop the statements and disclosures a client is entitled to receive.

---

## Quiet hours are computed in the recipient's timezone

TCPA restricts calls and texts to 8am–9pm **local to the recipient**. Local means the client's zone,
not the server's.

- The local hour comes from `Intl.DateTimeFormat` with the IANA zone, so daylight saving is the
  platform's problem. A stored offset would be correct half the year and quietly wrong the other
  half — and the wrong half is where an 8am send becomes 7am.
- **A missing timezone refuses.** Defaulting would send at the wrong hour for exactly the clients
  furthest away, and the failure is invisible from the sending side because there it looks like a
  normal afternoon.
- `nextWindowOpening` steps forward an hour at a time rather than adding a day, because a day is
  not always 24 hours in a zone that observes DST.

---

## The send path

```
preference gate ──▶ middleware chain ──▶ the log ──▶ provider seam
may we contact     authority, firewall,   what was      not_built:
this client?       state gate, scanner    approved or   nothing is
                                          blocked       gated in
```

The preference gate runs **first** because its refusals are about the client rather than the
message: "this client is on do-not-call" is true whatever the text says.

**A blocked send is still logged.** "We tried to contact this client and could not" is evidence, and
a log holding only what went out would answer a regulator's question with the half that flatters us.

The send returns **`not_built`** once every gate has passed, not `ok`. The message was approved and
nothing delivered it — reporting success would put "the client was told" in a compliance log when
they were not.

**Inbound messages are not gated.** A client contacting us is not something to permit or refuse, and
a system that dropped inbound messages from a do-not-call client would lose the one asking to be
called.

---

## Two defects this slice surfaced elsewhere

### Step 7 of the middleware chain was a no-op

Its comment said the Communication Compliance Scanner "is not built" and the step was "unreachable
while step 5 refuses every client-facing action". Both were true when written. **Both stopped being
true when 7.2 made step 5 pass** — and nothing failed, because the step reported `skipped` with the
detail _"no client-facing content in scope"_ even when there was content.

That is precisely the shape of a guard that looks fine. It was found by a test that sent a banned
phrase to a client and watched it go.

Step 7 now runs the scanner, blocks on banned language, and blocks when a `requires_disclosure`
phrase appears without the disclosure it obliges — matched exactly, because the library's wording is
what discharges the obligation.

**Consequence worth knowing:** the scanner refuses rather than certifying content clean against an
**empty** library. Any tenant sending client-facing content must have the claim library seeded;
"we checked nothing and found nothing" is not a pass.

### The claim library banned one word order and not the other

`Your approval is guaranteed once you sign` passed cleanly. The library held **"guaranteed
approval"** — the noun phrase — and not the inversion a person actually writes in a sentence.

The scanner is exact-phrase by design; loose matching would flag _"no guarantee of approval"_. So
covering a paraphrase means adding it, which is what the Compliance Review Board owns the list for.
Two variants added, with the discovery recorded in their rationale.

---

## The Evidence Vault gap is closed

7.1's `communications` source was `not_built`, and every client file carried a note saying a reader
"should not treat its absence as evidence that nothing was said." It now reports real coverage.

The file carries **metadata only** — an evidence package should not contain every message a client
was sent by default. A reader who needs the wording asks the log, which is the audit record and
does hold the body.

The Ledger never carries a body, only a hash. A **block reason legitimately quotes the banned
phrase**: naming which phrase tripped is what makes the block actionable, and the phrase comes from
our own library rather than from the client.

---

## Known gaps

- **No delivery.** No email or SMS provider is gated in; the seam reports `not_built`.
- **Voice** routes through CapitalForge → VoiceForge, which is external.
- **Sequences are 2.2 playbooks.** Blueprint 4.1 lists onboarding sequences, document chase and
  check-in cadence; all three are sequencing, and a second scheduler here would drift from the
  Workflow Engine and give the operator two inboxes.
- **No client-facing preference UI** — that is the Client Portal.
- **Do-not-call is per-client, not synchronised with a national registry.** Blueprint 4.4 mentions
  "do-not-call list synchronization"; the external registry is an ungated vendor.
