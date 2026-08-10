# 6.4 Do Not Fund Governance · 6.5 Risk Event Timeline

Package: `@bwc/risk` · Schema: `risk` · ADRs: [0012](adr/0012-do-not-fund-override-permits-one-action.md), [0013](adr/0013-staleness-moves-toward-the-safe-answer.md)

Completes Category 6's V1 scope. 6.2 Funding Ethics Firewall shipped with the walking skeleton;
6.1 Risk & Defense Alerts and 6.3 Client Conduct Monitoring are V1.5.

---

## 6.4 Do Not Fund Governance

Blueprint 6.4 opens with "not just a flag", and the module takes that literally: a determination
with a reason, an author, a review cadence, and an exception mechanism that does not undo it.

### Listing

```ts
await listClient({
  tenantId,
  clientId,
  trigger: 'material_misrepresentation',
  justification: 'Stated revenue of $2.1m is not supported by any statement in the file.',
  listedBy: complianceOfficerId, // must be a Level 3 HUMAN
});
```

Requires a **Level 3 human**, checked as two separate things. `kind === 'human'` is not implied by
authority level — a Level 3 Village agent would pass a numeric comparison, and blueprint 6.4 asks
for human override because the point is that a person is answerable.

A second listing on an already-listed client is **refused**, not merged. Two live listings would
mean two review clocks and two removal decisions for one determination.

### Automatic listing (Decision E)

Compliance state `fail` lists automatically:

```ts
await autoListForComplianceFail({
  tenantId,
  clientId,
  complianceState: 'fail',
  reason,
  triggeredBy,
});
```

Two properties worth knowing:

- **`listedBy` is `null`.** No human decided it, and naming one would put a fiction in the field a
  reviewer reads to find out who decided — indistinguishable from a real approval. The Ledger event
  carries the actor whose action produced the transition.
- **Automatic in, human out.** Removing an automatic listing still takes a Level 3 human. An
  automatic listing is not a lesser listing.

It takes no approver on the way in, which is the file's one asymmetry and is deliberate: requiring
a human to _start_ blocking would leave a client whose compliance failed on a Friday fundable until
Monday.

### The gate

```ts
const clearance = await checkDoNotFund(tenantId, clientId, 'submit_application');
```

**Fail-closed.** `DO_NOT_FUND_PERMITTED_ACTIONS` is an allow-list, not a block-list, so an action
added next year cannot move capital toward a listed client because nobody remembered to block it.
Over-blocking produces a visible complaint from an operator; under-blocking produces a funded
client the company decided should not be funded, and nobody notices until later.

What stays available while listed: `read_document`, `analyze_file`, `generate_internal_report`,
`draft_communication`, `send_client_communication`, `send_document_request`. Reviewing the file is
how somebody decides whether to lift the listing, and blocking communications would make the
determination unsayable.

`send_partner_followup` is deliberately absent — it is sometimes "we are not proceeding" and
sometimes "here is the file", and the gate cannot tell which from the action name.

### Overrides — ADR-0012

**An override permits one action; it does not delist.**

```ts
const granted = await grantOverride({
  tenantId,
  clientId,
  action: 'submit_application',
  justification,
  approvedBy,
});
// ... the action proceeds ...
await consumeOverride({ tenantId, clientId, overrideId: granted.value.id, usedFor, actorId });
// the SAME action is blocked again; the listing never moved
```

`checkDoNotFund` finds an unspent override but does **not** spend it. A caller that checks and then
abandons the action for an unrelated reason would otherwise have burned an exception a Level 3
human granted, and the next attempt would need a second approval for work that never happened.

The middleware chain follows the same rule: `ChainResult.doNotFundOverrideId` carries it out for
the caller to consume.

### Review cadence — ADR-0013

Derived at read time from `lastReviewedAt ?? listedAt` plus `reviewCadenceDays`. A stored flag
would need a job, and a job that stops leaves every listing reading as freshly reviewed — the most
reassuring possible failure.

**An overdue review keeps blocking.** 5.4 makes a stale provider approval stop being usable; this
does the opposite, from the same rule. See ADR-0013 before making the two agree.

`listingsDueForReview(tenantId)` produces the queue.

---

## 6.5 Risk Event Timeline

Chronological, per client, risk-classified, **assembled at read time**. A stored timeline would be
a second record of events that already have one, and the two would disagree the first time a
projection job failed — with no way to tell which was right.

```ts
const timeline = await timelineFor(tenantId, clientId, { minimumSeverity: 'serious' });
```

### Classification is a table

`RISK_EVENT_CLASSIFICATION` maps ledger event types to a severity and a meaning. An event type
absent from it is **not** a risk event — a deliberate default, since the Ledger carries every state
change and a timeline that included all of them would bury the four events that matter under four
hundred that do not.

It is a table rather than a switch because what counts as a risk event is a judgement the
Compliance Review Board should be able to read and argue with.

### Severity is categorical, and there is no score

Four levels, worst first: `critical`, `serious`, `notable`, `context`. `worstSeverity` takes the
worst and **never the average** — the average of a fraud indicator and a late document describes
neither. The module produces counts, not a number: a "risk score" would become the thing people
read instead of the events.

### Observations

`recordObservation` holds a risk fact no other module produces — a fraud alert taken over the
phone, an NSF read off a statement. `source` is required, because a risk fact with no provenance is
a rumour and the timeline cannot tell the two apart once it is written down. `occurredAt` and
`recordedAt` are both kept: a March alert written down in August belongs in March on the timeline
and in August in the audit trail.

### What it does not watch

`UNPRODUCED_RISK_SOURCES` names the risk facts blueprint 6.5 lists that nothing produces yet —
missed payments, NSF events, utilisation changes, credit-line decreases, adverse actions, disputes,
complaints — each with the integration that would fill it.

Carried on **every** timeline, including an empty one. A timeline with no entries and no caveat
reads as a client with no risk history, when what it means is that the integrations that would find
one are not connected.

### Into the Evidence Vault

7.1 carries the timeline as the `risk_timeline` source, as one item rather than flattened rows —
its value is the things _around_ the entries, and flattened, an empty timeline would read as a
clean client.

---

## Precedence inside step 4

**Do Not Fund → Firewall → compliance state.**

All three sit in step 4 of the fixed seven-step chain; design principle 7 pairs the Firewall and
Do Not Fund Governance, so this is not an eighth step. The order is about which true statement to
lead with: a triggered Firewall is a condition somebody expects to clear, while a Do Not Fund
listing is a standing determination — and telling an operator "the Firewall is triggered" when the
real answer is "we decided in March not to fund this client" sends them to resolve the wrong thing.

The trace detail says which of the two fired.

---

## Tested

34 tests: `tests/integration/do-not-fund.test.ts` (28) and
`tests/invariants/risk-classification.test.ts` (6). Suite total **658**.

Mutation-verified. Making an override delist produces **6** failures; letting an overdue review
unblock produces **1**, the one written for it.
