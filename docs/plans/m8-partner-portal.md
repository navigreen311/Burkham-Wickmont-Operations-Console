# Plan — 8.1 Partner & Referrer Portal (Core), 8.3 Partner Training & Certification

**Blueprint:** 8.1, 8.3 · **Branch:** `ai-feature/m8-partner-portal`
**Follows:** 6.4 / 6.5 Risk & Defense (merged, `8ef0a35`)

Category 8's V1 scope is two of four. 8.2 Partner Agreement & Payout Center and 8.4 Partner Risk
Score are both marked V1.5 in the blueprint's phasing.

---

## Why these two together

8.3's headline requirement is a gate on 8.1: _"required completion before partner can refer /
co-brand / white-label."_ Built separately, 8.1 would ship with a referral path that nothing gates,
and the gate would arrive later as a change to code that already works — the shape of change that
gets deferred.

## Mini-PRD

### Problem

Seven partner tracks refer clients today with no record of who they are, what they were trained on,
what claims they may make, or what they are allowed to see about the clients they referred.

1.3 already records _that_ a lead came from a referrer, as a name. A name is enough to attribute a
fee and not enough to ask whether that person is certified.

### Success metrics

- An uncertified partner cannot refer, co-brand, or white-label.
- A partner sees the status of clients they referred **only** within what the client permitted.
- Every claim a partner is approved to make resolves to the Marketing Claim Library (7.4).
- Certification lapses on cadence without a job running.

### Risks

| Risk                                             | Mitigation                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **"Anonymized" status that identifies a client** | Aggregates suppressed below a cohort threshold; identified status requires the client's own consent |
| A second claim library per partner               | Partner approvals **reference** 7.4 claim ids; no claim text is stored here                         |
| Duplicating 1.3's attribution                    | 8.1 owns the partner **record**; 1.3 keeps owning who a lead is attributed to                       |
| Co-brand material bypassing the scanner          | Brand-usage checks run partner-facing text through 4.2, same as any client-facing content           |
| A stored certification flag going stale          | Derived at read time from completions and cadence                                                   |

---

## Key decision — "anonymized" is not a property of a record, it is a property of a cohort

Blueprint 8.1 lists "anonymized client status sharing". Taken as written, the build is: strip the
client's name from a status row and show it to the partner.

That is not anonymous. **A partner who referred one client and is shown "1 client in underwriting"
knows exactly whose status that is.** Removing the name removes nothing, because the partner
supplied the client. The same holds at two and three; anonymity only starts to mean something once
the cohort is large enough that a row could be several people.

So the portal has two separate surfaces:

- **Aggregate** — counts by stage across the partner's referrals, **suppressed entirely** below a
  minimum cohort size, with the suppression stated rather than shown as a zero.
- **Identified** — one named client's status, which requires that client's **own consent**, of a
  new kind recorded in 1.5.

A suppressed aggregate says so. Rendering it as zeros would be a false statement about the
partner's book, and rendering it as "fewer than N" still leaks when the partner knows their own
referral count — which they always do.

## Key decision — certification gates referring, and staleness stops the capability

ADR-0013 said staleness moves toward whichever answer is safe if the stale record is wrong. Applied
here it points the same way as 5.4 and the opposite way from 6.4:

If a partner's training is a year stale and they are wrong about what they may claim, the harm is a
false statement made to a prospective client in our name. Stopping is safe. So an expired
certification **removes the capability** rather than flagging it.

Derived at read time from completions plus the recertification cadence — the seventh time this
codebase has made that choice, and for the same reason each time.

---

## Architecture

```
packages/partners/
  tracks.ts         the seven tracks and their qualification requirements, as data
  partners.ts       partner records, onboarding status, termination
  curriculum.ts     8.3 - modules, completion, recertification cadence
  certification.ts  8.3 - derived standing, and the gate 8.1 calls
  claims.ts         which 7.4 claims a partner is approved to use
  visibility.ts     aggregate vs identified client status
  branding.ts       co-brand / white-label configuration and brand-usage rules
```

### Data model — schema `partners`

`Partner`, `PartnerCurriculumModule`, `PartnerModuleCompletion`, `PartnerClaimApproval`,
`PartnerBrandConfig`.

`Lead` gains `referrerPartnerId`, written **once** at creation alongside the other attribution
columns and moved only through 1.3's existing correction path. A typed identity for a field group
that already exists, not a second attribution record.

---

## Test strategy

- An uncertified partner is refused at referral, co-brand and white-label.
- Certification is derived: completing the modules certifies; passing the cadence decertifies with
  nothing running.
- A partial curriculum does not certify, and the refusal names the outstanding modules.
- Aggregate status is suppressed below the cohort threshold, and the suppression is stated.
- Identified status requires that client's consent and is refused without it.
- Revoking the consent removes the access on the next read.
- A partner claim approval that names a claim outside 7.4 is refused.
- A partner approved for a claim that 7.4 later bans loses it.
- Co-brand text containing banned language is refused by the scanner.
- Lead attribution carries a partner id, and correcting it moves both name and id together.

---

## Out of scope

8.2 and 8.4 (V1.5). Actual workspace provisioning for co-brand / white-label — the configuration is
recorded and the provisioning is a `not_built` seam, since no hosting surface exists. Curriculum
**content**: the blueprint names SelfPublisherForge as its source, so modules are recorded with
their requirements and their material is referenced, not authored here.

Referral fee **terms and payouts** belong to 8.2. 8.1 tracks that a referral happened and who it is
attributed to; it deliberately computes no money, because the state-by-state referral fee rules
that would make a number lawful live in the module that is deferred.
