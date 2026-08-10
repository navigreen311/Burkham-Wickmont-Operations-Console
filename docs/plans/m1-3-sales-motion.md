# Plan — 1.3 Sales Motion & Engagement Tracking

**Blueprint:** 1.3 · **Branch:** `ai-feature/m1-3-sales-motion`
**Follows:** 1.4 Pricing, Billing & Offer Management (merged, `8a31f0e`)

---

## Why this module next

It is the last Category 1 V1 module, and it owns the input 1.4 currently takes on trust: how a
client arrived at a rung, and who introduced them. Referral attribution has money attached to it,
and money attached to an unrecorded fact is the shape of a dispute.

## Mini-PRD

### Problem

A lead exists in somebody's inbox until it becomes a client. Nothing records where it came from,
whether anybody qualified it, when it last moved, or what happened when it closed. The blueprint
asks for automatic escalation on 45-day inactivity, which cannot be automatic if nothing knows when
the last activity was.

### Success metrics

- Attribution is recorded once, at first contact, and cannot be rewritten later.
- A lead that has not moved in 45 days raises a task without anybody watching a calendar.
- Converting a lead cannot route around the compliance gate.
- A closed lead records **why**, in a form that can be counted.

### Risks

| Risk                                               | Mitigation                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Attribution is rewritten after the fact**        | Recorded at creation and immutable; a correction is a new record with the old one intact                         |
| Conversion creates a client that skips compliance  | Conversion goes through 1.1's `create`, which starts at `pending_assessment` — the state the gate already blocks |
| A second timer drifts from the Workflow Engine's   | Inactivity is **derived** at read time; the escalation raises a 2.4 task rather than scheduling its own alarm    |
| "Readiness score delta" becomes an opaque number   | Only the delta and its components are stored; the trigger names which component moved                            |
| A lost lead's reason is free text nobody can count | Closed-lost takes a categorical reason plus optional detail                                                      |

---

## Key decision — attribution is written once and never rewritten

A referral fee is owed to whoever introduced a client. That makes attribution a financial fact, and
a financial fact that can be edited after the money is at stake is not a record — it is an opinion
with a timestamp.

So `sourceAttribution` is set when the lead is created and there is no update path. A correction is
a new `AttributionCorrection` row carrying who changed it, when, and why, with the original
untouched. The question "who was this attributed to when the fee was calculated" stays answerable.

**First touch, not last touch.** Whoever caused the lead to exist is the person the referral
relationship is with; a partner who happened to send the most recent email did not introduce
anybody. The choice matters because the two produce different payouts, and picking one silently
would mean nobody knew which was in force.

## Key decision — inactivity is derived, not scheduled

Blueprint 1.3 asks for "automatic escalation on 45-day inactivity". The obvious implementation is a
per-lead timer.

Fifth appearance of this reasoning (ADR-0007, 0009, 0010, 0011): a stored countdown needs a job to
maintain it, and a job that stops leaves stale leads looking fresh. `staleLeads` computes it from
`lastActivityAt` and today, so a lead untouched for 46 days is stale the moment anybody asks, on
any machine.

The escalation itself raises a **Notification & Task Queue** task rather than scheduling its own
alarm. Module 2.4 already routes and tracks human work; a second mechanism would drift from it, and
the operator would have two inboxes.

## Key decision — conversion cannot outrun compliance

Converting a lead creates a client through 1.1's `create`, which starts every client in
`pending_assessment`. That is the state the Funding Ethics Firewall gate already refuses, so a
converted client cannot be placed until somebody assesses them.

This is worth a test rather than a comment: it is the property that stops a sales motion from being
a way around the compliance one, and it holds today only because conversion has no other path to a
client record.

---

## Architecture

```
packages/sales/
  leads.ts        lead records, attribution, qualification, stage transitions
  activity.ts     activity recording; inactivity derived; escalation to 2.4
  attribution.ts  corrections, with the original intact
  conversion.ts   lead -> client -> engagement, through the existing gates
  expansion.ts    expansion signals and renewal / save-motion status
```

> **Deviation from plan, recorded after the fact:** there is no separate `stages.ts`. Stage
> transitions turned out to be a property of the operations that cause them — qualifying moves a
> lead to `qualified`, delivering a Blueprint moves it on — and a separate module would have been a
> second place where the order of the pipeline was written down. `attribution.ts` was not in the
> original list and earned its own file once corrections needed the Level 3 check.

### Data model — schema `sales`

- `Lead` — source attribution, stage, qualification, blueprint status, last activity
- `LeadActivity` — an append-only trail of what happened and when
- `AttributionCorrection` — a correction with the original intact
- `LeadOutcome` — conversion or loss, with a categorical reason

---

## Test strategy

- Attribution cannot be updated; a correction leaves the original readable.
- A lead is stale on day 46 and not on day 45.
- Escalation raises exactly one open task per stale lead, and not a second on re-run.
- Conversion produces a client in `pending_assessment`, and the placement gate refuses it.
- Converting an already-converted lead is refused rather than creating a second client.
- Closing a lead requires a categorical reason; the reasons are countable.
- Stage transitions that skip a required step are refused, and the refusal names the step.
- An expansion trigger fires on elapsed time since the Blueprint and names what moved.

---

## Out of scope

Founder-led-call **scheduling** — a calendar integration is a gated vendor; the module records that
a call is scheduled and when, not the booking itself. Partner payout arithmetic, which belongs with
8.x Partner & Referrer Portal. Lead capture from a marketing funnel (FunnelForge is external).
