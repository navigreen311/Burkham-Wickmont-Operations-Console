# 0078 - A chase does not move the instance

- Status: accepted
- Date: 2026-08-12
- Context: `packages/workflow/src/playbook.ts`, `engine.ts`, `queue.ts`, `prisma/schema.prisma`

## Context

ADR-0077 left three message templates unreachable, each blocked on a named capability rather than
on nobody having got round to it. Two of them wanted the same thing the graph language could not
say:

- `document-request-reminder-sms` — chase a client who has not sent their documents.
- `appointment-reminder-sms` — remind a client the day before a call they booked.

`WaitNode.until` was a duration **or** an event and never both. An event wait carried no timeout.
`slaMinutes` recorded `slaDueAt` and nothing acted on a breach. So a playbook could wait for a
client and could not chase them, and could not wait until a date somebody had written down.

## Decision

### A wait may chase, and chasing does not advance the instance

`remindAfterMinutes`, `remindQueue`, `remindSummary` and `maxReminders` on a wait node. When an
event wait has been parked that long, the engine raises an 11.4 task to the named queue — the same
mechanism a human checkpoint already uses — and schedules the next one, up to the cap.

**The obvious design is wrong and worth writing down.** Routing the timeout to a reminder _node_
and looping back to the wait reads naturally and is expressible in the existing graph: `await` →
`remind` → `await`. It opens a race. While the instance sits on the reminder node there is no
`waiting` task, so `resolveWaits` cannot match the awaited event; the listener moves its cursor
past it, the wait re-parks, and the instance waits forever for something that already happened.
The client who answered promptly is the one it strands.

Keeping the wait parked closes it by construction. The moment the event lands the task stops being
`waiting`, and `dueReminders` only ever returns `waiting` rows — so **a chase cannot outlive the
thing it was chasing.** A nudge sent to somebody who has already answered is worse than no nudge,
and this is a property of the query rather than of anyone's timing.

The cost is two columns, `remindDueAt` and `remindersSent`. `remindDueAt` is set to null at the cap
so the row leaves the query for good rather than being re-counted on every pass.

A chase is only meaningful on an event wait. A duration wait and a context-time wait both resolve
on a clock nobody needs reminding about, so declaring a reminder on one is refused at validation
rather than accepted as a policy that would never fire.

### A wait may resolve to a moment held in the context

`until: { atContextField, offsetMinutes }`. A duration is measured from when the wait starts, which
cannot express "the day before the appointment" — the gap between booking a call and holding it is
exactly what varies. An earlier task writes the moment through `contextPatch`, the same way
`compute_stack_position` writes `stackHealth`, and the wait reads it.

Implemented by deferring the task with a later `runAt` rather than parking it. "A wait state is a
row with `runAt` in the future" is how this queue already works; the only new thing is that the
date could not be computed until the instance context was in hand.

**A missing or unparseable moment FAILS the task**, naming the key. A wait with nothing to resolve
to is a workflow that has stopped without saying so, and stopping quietly is what a durable queue
exists to make impossible. A moment already past resolves immediately — the call is tomorrow and
this ran late, and sending the reminder now beats never sending it.

## Consequences

**The third template needs none of this.** `post-funding-checkin` fires some months after a
facility funds, which is an event plus a delay — and `upsertTrigger` already starts a playbook from
an event with a condition on its payload. It wants a small playbook whose first node is a duration
wait, not an engine change. Two of three blockers were real; the third was a shape nobody had
looked for.

**Verified by mutation.** Chasing regardless of whether the wait is still waiting, dropping
`offsetMinutes`, and never stopping at the cap each fail on the intended assertion. The first of
those is the safety property and the one worth re-checking if this code is ever touched: it is the
difference between a reminder system and a system that nags clients who have already complied.

**`workflow.reminder_raised` is a new ledger event.** ADR-0069 recorded that publishing a playbook
wrote nothing to the ledger because no event type existed and that slice did not own
`packages/core/src/events.ts`. This one does, so the chase is recorded — with which reminder of how
many, so a client asking "how many times did you contact me" has an answer.
