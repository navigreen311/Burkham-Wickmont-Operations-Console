# 8.1 Partner & Referrer Portal (Core) · 8.3 Partner Training & Certification

Package: `@bwc/partners` · Schema: `partners` · ADR: [0014](adr/0014-anonymity-is-a-property-of-a-cohort.md)

Category 8's V1 scope. **8.2 Partner Agreement & Payout Center** and **8.4 Partner Risk Score** are
V1.5, and their absence is visible rather than papered over.

---

## 8.3 first, because it gates 8.1

Blueprint 8.3: _"required completion before partner can refer / co-brand / white-label."_ That is a
gate, not a report, so it is computed in one place and called by all three capabilities.

```ts
const result = await canRefer(tenantId, partnerId);
// refused: "This partner is not certified and cannot refer a client. Outstanding module(s): privacy."
```

### Derived, and staleness stops the capability

Standing is computed at read time from completions plus the recertification cadence. A stored
`certified` flag would need a job, and a job that stops leaves every partner reading as certified.

A lapsed certification **removes** the capability. [ADR-0013](adr/0013-staleness-moves-toward-the-safe-answer.md)'s
rule applied a third time: staleness moves toward whichever answer is safe if the stale record is
wrong. Here the stale record is _"this partner knows what they may claim"_, and if it is wrong the
harm is a false statement made to a prospective client in our name — so it points the same way as
5.4 and the opposite way from 6.4, which is what the rule predicts.

### An empty curriculum does not certify

`no_curriculum` is a distinct state and it is **not certified**. "Nothing to complete" and
"completed everything" both produce an empty outstanding list, and treating them alike would
certify the whole network the moment a tenant forgot to publish a curriculum. The Compliance
Scanner makes the same call about an empty claim library.

### Completion is recorded against a module VERSION

This is the mechanism behind _"annual recertification with change delta training"_. A partner who
completed v1 has not completed v2, so a material republish decertifies everyone who only saw the
old one — with nothing running.

Which means a typo fix would decertify the network, so `publishModule` takes a **required**
`changeKind`, exactly as 7.2 does:

- `material` — prior completions no longer count.
- `editorial` — completions are copied forward, **keeping their original dates**. Stamping today
  would quietly extend every partner's certification by a year because somebody fixed a link.
- Version 1 cannot be editorial.

Publishing a new module with no `requiredForTracks` decertifies every track until it is completed.
That is intended, and asserted.

---

## 8.1 Partner records

Seven tracks, with per-track qualification requirements as data in `tracks.ts`. Qualifications are
matched by **exact string** — a qualification satisfied by something close enough is a judgement,
and the record should show a person made it rather than that a matcher accepted it.

Each track carries a `disclosureSensitivity` and, more importantly, a **stated basis** for it. Four
tracks are `high` because the partner's own regulator has rules about referral compensation: a CPA
has an AICPA independence problem, an attorney has Model Rule 7.2 and a fee-sharing prohibition, a
wealth advisor has their firm's outside-business rules and the SEC solicitation requirements, and
whether an M&A advisor needs registration is contested. The basis is there so the Compliance Review
Board can disagree with the reasoning rather than only with the label.

Onboarding refuses while anything is outstanding and names what. **Termination takes a Level 3
human** — blueprint 8.1 lists "termination triggers", and a trigger that fired on its own would end
a commercial relationship, and cut off referred clients' visibility, with nobody answerable.

---

## Approved claims resolve to 7.4

Blueprint 8.1 says "approved-claims library per partner". Read literally that is a second claim
store, and it would drift from 7.4 the first time the Board changed a claim — **and the drifted
copy is the one the partner would say out loud.**

So `PartnerClaimApproval` holds a **claim id**. Text, jurisdiction and disposition resolve from 7.4
on every read. A partner approved for a claim that 7.4 later bans loses it with nobody coming here
to update anything, and the approval row survives — a complaint about something said in March needs
to show the approval existed.

Approving a `banned` claim is refused: the record would say a partner may say something the scanner
blocks every time they say it.

---

## Co-brand and white label

The configuration is recorded; `provisionWorkspace` returns **`not_built`**, because no hosting
surface exists.

White label carries two rules co-brand does not. Under a co-brand the client sees both names and
can ask either party what is going on. Under a white label the client may not know we exist — so
the disclosures that attach to the service still attach, and the only party the client can see is
the partner.

`reviewBrandMaterial` runs partner text through **4.2's scanner**. A partner is the most likely
party in this system to promise something we never would: paid per referral, not employed by us,
and under a white label invisible to the client as us. Exempting their material would exempt the
highest-risk text in the system.

The disclosure check here is **stricter than the send path's**: a required disclosure must be
present in the material itself, not merely required. We do not control what a partner adds after we
approve, so "they will attach it" is a hope rather than a control.

---

## Visibility — ADR-0014

**Anonymity is a property of a cohort, not of a record.** A partner who referred one client and is
shown "1 client in underwriting" knows exactly whose status that is.

| Surface            | Rule                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `aggregateStatus`  | Stage breakdown **suppressed entirely** below `MINIMUM_COHORT` (5), suppression stated; `totalReferrals` still released                      |
| `identifiedStatus` | Requires the client's own `partner_status_visibility` consent, checked live; returns legal name and compliance state only; **logs the view** |

Read [ADR-0014](adr/0014-anonymity-is-a-property-of-a-cohort.md) before changing either.

---

## Attribution: current, not original

`Lead.referrerPartnerId` is written once at creation, like every other 1.3 attribution column, and
never updated — that is 1.3's design and a good one, because a payout dispute asks what was
originally recorded.

Which means **querying that column is wrong** for anything partner-facing. A referral corrected from
one partner to another still carries the first partner's id, so a portal reading it would show a
partner a client that is no longer theirs and hide one that now is. Both are bad, in opposite
directions.

`leadsAttributedTo` resolves **current** attribution the way 1.3 does — latest correction wins,
original otherwise — in bulk. `correctAttribution` now moves the name and the partner id **together**;
a correction that moved one without the other would leave the two disagreeing, and the portal reads
the id while a person reads the name.

---

## What is deliberately absent

`payableToPartner` returns **`not_built`**, naming 8.2. Blueprint 8.2 owns fee terms, the
state-by-state restrictions on referral fees, payout approval and clawback — and a fee computed
without the state restriction is a figure that looks payable and may be unlawful to pay. Half of
8.2 is not a smaller version of it.

`referralSummary` returns counts and **no conversion rate**. 1.3 already refuses a rate below a
minimum denominator, and a partner-facing rate is a performance judgement — which is 8.4's, and 8.4
is V1.5.

---

## Tested

40 tests: `tests/integration/partner-portal.test.ts` (29) and
`tests/invariants/partner-certification.test.ts` (11). Suite total **698**.

Mutation-verified:

| Mutation                                                       | Failures |
| -------------------------------------------------------------- | -------- |
| Release the stage breakdown at any cohort size                 | 1        |
| An empty curriculum certifies                                  | 1        |
| Read the lead's original attribution column instead of current | 2        |
