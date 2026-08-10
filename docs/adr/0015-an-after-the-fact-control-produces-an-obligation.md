# ADR-0015 — A control that runs after the fact produces an obligation, not a verdict

**Status:** Accepted · **Date:** 2026-08-10 · **Module:** 4.3 Call Recording, Summaries & Promise Tracking

## Context

4.2 Communication Compliance Scanner reads outbound content and returns `clean`,
`requires_disclosure` or `blocked`. `blocked` works because the scan runs **before** the message is
sent: there is something to stop.

Blueprint 4.3 asks for promise tracking on calls — flagging when somebody says "we can probably get
you $100K". The obvious implementation reuses the scanner's shape: scan the transcript, return a
verdict.

**But the call already happened.** The client heard the sentence. A function returning `blocked`
would be describing a state of affairs that does not exist, and — worse — a queue of "blocked"
calls invites the reading that the system stopped something.

## Decision

**A detected promise becomes a correction obligation**: what was said, who owes the correction, by
when, and — to close it — the correction itself.

Three properties follow and are enforced:

1. **An obligation cannot be closed without the correction text.** Closing with a tick would
   produce a record saying a client was corrected when nobody had told them anything — worse than
   an open obligation, because it stops anyone looking.
2. **Dismissal takes a Level 3 human and a reason.** Shape-matching produces false positives by
   design, so a dismissal path must exist; without the human it becomes the cheapest way to clear a
   queue.
3. **Windows scale with severity** — 24h critical, 72h serious, 168h notable. A misstated amount is
   corrected the next business day, not next week: the client is making plans on it now.

### The detection mechanism follows from the same reasoning

The scanner is exact-phrase against the Marketing Claim Library, and that is right for outbound
copy. It cannot work here, because the promise varies by amount: "$100K", "a hundred grand", "six
figures" and "about eighty" are one promise and would need four library entries.

So promise detection matches the **shape** of a statement — a capability assertion near a quantity,
an approval prediction, a timeline commitment, a rate quote — and lives in its own file, so
loosening one mechanism cannot silently loosen the other.

## Consequences

**False positives are accepted deliberately.** A flagged sentence that turns out to be fine costs a
reviewer thirty seconds; a missed one costs a client a promise nobody corrected. The dismissal path
exists for exactly this and is deliberately not frictionless.

**The obligation queue is work.** Every critical promise creates a task with a 24-hour SLA. If the
queue is large, that is information about how calls are being run, not a reason to weaken the
detector.

**`calls.promise.detected` is a risk event.** 6.5 classifies it `serious`, because a promise is the
earliest point at which a client forms an expectation we may not meet — which is what most
complaints are about.

**Detection is only as good as its patterns**, and they will need maintenance. The first version
matched digits only and missed _"we should be able to secure a hundred grand"_ — the form the
sentence most often takes when spoken. The lesson is recorded in the code: a detector that catches
only the written form of a spoken promise catches the promises nobody makes.

## Alternatives considered

**Return a scanner-style verdict.** Rejected: describes a state that does not exist, and produces
no owner, no deadline and no record of remediation.

**Auto-send a correction.** Rejected. A correction is a conversation — "I said a hundred grand and
I should not have" — and an automated email asserting it would be both strange and, in some cases,
worse than the original.

**Route through the Claim Library.** Rejected: an entry per amount, and the library would fill with
noise that degrades the scanner it exists for.
