# 1.3 Sales Motion & Engagement Tracking

**Package:** `@bwc/sales` · **Schema:** `sales`

---

## What this owns

The last Category 1 V1 module: how a client arrives at a rung, and who introduced them — the input
1.4 was taking on trust.

**Category 1's V1 modules are now complete** (1.1, 1.2, 1.3, 1.4, 1.5).

---

## Attribution is a financial fact

A referral fee is owed to whoever introduced a client. That makes attribution a financial fact, and
**a financial fact that can be edited after the money is at stake is not a record — it is an
opinion with a timestamp.**

So the attribution columns are written once at creation, and this package exposes **no path that
updates them**. A correction is a separate row carrying who changed it, when and why, with the
original left intact on the Lead. Two functions, because a payout dispute asks two different
questions:

- `currentAttribution` — what a payout process should read
- `originalAttribution` — what was believed at first contact

**First touch, not last.** Whoever caused the lead to exist is who the referral relationship is
with; a partner who happened to send the most recent email did not introduce anybody. The two
produce different payouts, and picking one silently would mean nobody knew which was in force.

Correcting requires a **Level 3 human and a reason** — it moves money between partners, and an
agent able to do it would make the record unreliable in exactly the place it needs to be trusted.

`sourceChannel` is **required, not defaulted**: a default such as "unknown" is indistinguishable
from a real answer the moment anyone runs a channel report, and the point of recording attribution
is that the report means something.

---

## Conversion cannot outrun compliance

Converting a lead creates a client through 1.1's `create`, which starts every client in
`pending_assessment` — the state the Funding Ethics Firewall gate already refuses. **A sales motion
must not be a way around the compliance one.**

That holds because conversion has no other path to a client record, not because a check remembered
to run — so it is **tested** rather than asserted in a comment. The day somebody adds a second path
is the day the comment stops being true and nothing else notices.

Converting twice is refused: two client records for one business would make every downstream figure
— exposure, fees, compliance state — compute over half a picture, with nothing indicating the split.

### A defect the tests caught

The first implementation created the client, _then_ refused if the engagement could not start —
leaving an orphan client and, since no outcome was recorded, allowing a retry to create a second
one.

**A function whose refusal path leaves a partial write is not refusing.** The offer is now validated
before anything is created, and the test asserts the retry works, which is the part that proves
nothing was left behind.

---

## 45-day inactivity, derived

Blueprint 1.3 asks for "automatic escalation on 45-day inactivity". Fifth appearance of the
reasoning in ADR-0007/0009/0010/0011: a stored countdown needs a job to maintain it, and a job that
stops leaves stale leads looking fresh — silently, because nothing changed.

A lead is stale on **day 46**: "45 days" includes the 45th.

`lastActivityAt` **moves only forward.** A back-dated note about a call three weeks ago is worth
recording and is not evidence the lead is fresh; letting it reset the clock backwards would make an
escalation disappear because somebody tidied up their notes.

The escalation **raises a Notification & Task Queue task** rather than scheduling its own alarm —
2.4 already routes human work, and a second mechanism would give the operator two inboxes. It is
**idempotent**: this runs on a schedule, and a version that raised a fresh task every pass would
queue the same lead daily until somebody either acted or stopped reading the queue. The second is
the likely one.

Ended leads are excluded. A lead that closed is not idle, it is finished, and a queue that filled
with completed work would be abandoned within a week.

---

## Expansion is a prompt, not an instruction

Every signal carries **what moved and by how much**, so the operator has something to open with. A
trigger that fired without saying why produces a call beginning "the system suggested I reach out",
which is worse than no call.

- **`readiness_improved`** — a later reading exceeds the Blueprint's by 10+ points. Smaller
  movements are noise, and a trigger that fired on those would train an operator to ignore the
  queue.
- **`blueprint_aged`** — 90 days since delivery. Long enough that the recommendations have been
  acted on or abandoned; short enough that the client remembers the conversation.

Reported **separately** rather than collapsed: they call for different conversations, and merging
them would force the operator to work out which they were being handed.

Only converted leads. Prompting an expansion for a prospect who never signed would put the sales
motion and the expansion motion in the same queue saying different things about the same person.

Readiness readings live in **their own table** rather than a "latest" column, because a comparison
across time against an overwritten column is a comparison with itself.

### Renewal and the save motion

`at_risk` (window closed, nothing replaced it) is reported separately from `lapsed` — the
difference is whether anybody is still in time to have the conversation. A **cancelled** engagement
is `lapsed` regardless of dates: presenting a client who left at the top of a retention queue helps
nobody.

---

## Outcomes are countable

A lost lead takes a **categorical** reason plus optional detail. "Why do we lose leads" is a
question somebody will want counted, and a thousand free-text sentences cannot be counted — while a
category with no detail loses the specifics that make a pattern actionable.

Conversion rate by channel returns **`null` below 10 decided leads**, the same judgement as 5.2's
approval rate: a channel report ranking partners on three leads each would send a marketing budget
somewhere on noise.

---

## Known gaps

- **No calendar integration.** The module records that a call is scheduled and when, not the
  booking — a calendar is a gated vendor, and claiming to have booked a call it had not would be
  worse than plainly recording an intention.
- **Partner payout arithmetic** belongs with 8.x Partner & Referrer Portal. This module records who
  is owed; it does not compute what.
- **No lead capture from a funnel.** FunnelForge is external.
- **Readiness is supplied, not computed.** The Funding Readiness Score is produced by the Phase 0
  flow; 1.3 records readings and compares them.
