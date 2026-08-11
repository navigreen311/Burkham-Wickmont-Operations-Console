# ADR-0044 — The safe answer is not always "stop"

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 6.3 Client Conduct Monitoring, with 6.4 Do Not Fund Governance, 6.5 Risk Event
Timeline, 2.1 the middleware chain
**Extends:** ADR-0013

## Context

ADR-0013 established the rule for a record with a review cadence:

> when a record outruns its review cadence, the system moves toward the answer that is safe if the
> stale record is wrong

and closed with an instruction: **"A third cadenced record must decide explicitly. The question to
ask is not 'what did the other modules do' but 'if this record is stale and wrong, which way is
safe.'"**

6.3 is the third — and it is the first place where the honest answer is not the same for every row
in the table.

Both previous applications happened to agree with intuition. A stale provider approval stops being
usable (5.4); a stale Do Not Fund listing keeps blocking (6.4). Different directions, but each
module had one direction, and in both cases "the cautious thing" and "the safe thing" coincided.

## Decision

**The staleness direction is a property of the breach kind, declared beside it, and the kinds
disagree.**

`KIND_POLICY` gives each of blueprint 6.3's nine kinds a response, a review cadence, a staleness
direction of `hardens` or `softens`, and the rationale for the direction — all in one table, so a
tenth kind cannot be added without making the decision.

### The two directions, and why

**Hardens.** A client who applied for capital elsewhere while placement was frozen, unreviewed for
ninety days, is still a client who did that. Nothing about elapsed time resolves it — and the
capital stack the company is advising on has changed without them. Same for undisclosed debt: every
figure was computed without it and stays wrong until somebody redoes the analysis. Same for abuse
toward staff, which is about the relationship rather than the capital and does not expire.

**Softens.** A client who stopped answering the phone after funding, unreviewed for ninety days, may
be in difficulty. **Freezing service to somebody in distress is the harm, not the remedy.** The
stale record is most likely wrong in the direction of "this person needs a call", so the safe
direction is a human reaching out — the response steps _down_, toward outreach, rather than up
toward a gate.

Payment-alert non-response is the same shape in miniature: a missed alert is most often a missed
email, and hardening on silence would pause service to a client whose only offence is not reading
their inbox. An unfounded fee dispute is usually somebody who did not understand an invoice, and
escalating on silence turns a billing conversation into a conduct file.

### Why this is ADR-0013 rather than an exception to it

The rule has not changed. What changes is that "safe" is a claim about **the direction of harm**,
and for four of these nine kinds the direction of harm points at the client rather than at the
company. ADR-0013's own table makes exactly this argument for 5.4 versus 6.4; 6.3 just contains both
cases at once.

A module that applied one rule to the whole table would have been defensible-looking and wrong for
four kinds, in the direction that hurts the person least able to complain about it.

### Severity shifts, it does not sum

Severity moves a kind's baseline one step in each direction. **It is not a weighting and nothing is
added.** Two `notable` breaches are two notable breaches, not one `serious` one — counting them
would be the averaging Decision E's reasoning forbids, arriving through addition rather than
division, which is the form it usually takes in a risk module.

The standing is **worst-of** over open breaches. A client with one abuse incident and nine months of
perfect payments is a client with an abuse incident.

### 6.3 detects; 6.4 decides

Nothing here lists a client on Do Not Fund. 6.4's listing takes a Level 3 human and a written
justification, with exactly one automatic path — compliance `fail`, per Decision E. A second
automatic path onto the most serious determination this system makes would be the second door
ADR-0034 is about.

What 6.3 does automatically is **pause service**, which is the reversible restriction, and that is
6.4's own reasoning applied to a lesser control: a client who applied behind our back on a Friday
should not be placed on Saturday. Lifting the pause takes a human. Automatic in, human out.

`termination_recommended` is the strongest thing this module can say, and the name is the point —
8.1 already recorded why a trigger must not end a relationship on its own.

### A conduct breach is not a compliance state

Decision E's four values describe whether a client's _file_ passes review. They belong to 1.1, they
are categorical, and nothing in 6.3 writes one. **A client can sit at `pass` and have paused
service**, and the two facts are about different things. Merging them would push conduct into a
field the Firewall reads as an assessment, and a Firewall that fires on conduct would be
indistinguishable from one that fired on findings.

### The pause is consulted, so it is a control

`checkConduct` is called by the middleware chain at step 4, beside `checkDoNotFund`. Do Not Fund is
checked first, on the same "which true statement to lead with" reasoning ADR-0034's gate uses: a
standing determination not to fund somebody outranks "their service is paused while we look into
something", and reporting the second when the first is true sends the operator to resolve the
smaller thing.

**This is the third instance of ADR-0034's defect closed in this batch** — after 5.2's `recordOutcome`
having no production caller (ADR-0041) and 8.4's assessment gating nothing (ADR-0043). An assessment
nothing consults is a report.

The permitted-action list while paused is an **allow-list**, copied deliberately from 6.4's, for the
reason 6.4 gives: a block-list lets an action added next year move capital toward a paused client
because nobody remembered to add it. Communication is on the list, and that is the difference
between a pause and a freeze — the reason a client is paused is usually a conversation somebody
needs to have with them, and a control that made the conversation impossible would make the pause
permanent by accident.

## Consequences

**Detection writes the 6.5 timeline entry, from inside `detectBreach`.** 6.5 calls itself the
chronological record of every risk-relevant event per client; a conduct breach that never reached it
would leave the timeline claiming a completeness it does not have, which is worse than an obviously
partial one because nobody would know to look elsewhere. If the observation cannot be written the
function returns `failed` and says the timeline is short one entry.

**The overdue queue carries which way each entry moved.** Half of them hardened and half softened,
and a queue that presented them alike would teach its reader that overdue means stricter — true of
most of this system and false here.

**A dismissed breach is resolved, not deleted.** A run of dismissed detections against one client is
a signal about the _detector_, and it is invisible if dismissal erases the row.

**The middleware chain has a new gate and no new step.** Step 4 already means "Do Not Fund clear,
Firewall clear, and compliance state passing"; conduct joins that list rather than becoming step 8.
The seven steps are fixed and the specification names them.

**Mutation-tested, and one mutation had to be run twice.** The first attempt at "staleness always
hardens" did not apply — the replacement string had the wrong indentation — and the suite passed,
which briefly read as a gap in the tests. It was a false negative in the mutation, not in the code.
_A mutation that did not apply proves nothing, exactly as a green re-run proves nothing._ With the
mutation actually in place the softening test fails. The other two — counting breaches instead of
worst-of, and removing the middleware's conduct check — each fail their own test.

## Alternatives considered

**One direction for the whole table.** Shorter, defensible-looking, and wrong for four of nine
kinds in the direction that hurts the client. It is also the failure ADR-0013 predicted: "the
question to ask is not what did the other modules do".

**Make the direction configurable per tenant.** Rejected on ADR-0019's rule — a control that
configuration can turn off is not a control. The direction here is a judgement about the direction
of harm, which is a property of the kind of thing that happened, not of who is running the system.

**Let 6.3 list critical breaches on Do Not Fund automatically.** Tempting, because
`DoNotFundTrigger` already has a `client_conduct` value waiting for it. Rejected: 6.4's automatic
path exists for compliance `fail` and is narrow on purpose, and a detection layer that could
unilaterally make the company's most serious determination would put a Level 3 decision behind a
Plaid feed. The pause is automatic; the listing is a task for a person.
