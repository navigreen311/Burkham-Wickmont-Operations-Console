# 11.6 Data Warehouse · 11.10 Client Portal · 11.11 Founder / Executive Workbench

Packages: `@bwc/warehouse`, `@bwc/portal`, `@bwc/workbench` · Schema: `warehouse` only
ADR: [0020](adr/0020-a-warehouse-answers-about-the-past.md)

**The last three V1 modules.** With these merged, all 46 modules in the blueprint's V1 phasing are
built.

---

## 11.6 — the warehouse answers about the past

ADR-0017 decided the dashboards read live. 11.6 does not overturn that; it answers a **different
question**. A live read tells you where clients stand today. It cannot tell you where they stood in
March, because those clients have moved and the operational store keeps only the current value.

| Rule                         | Why                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every read requires a period | There is no `current()`. That is what stops this becoming the stale cache ADR-0017 ruled out — asserted structurally, by grepping the module's exports |
| A snapshot is never updated  | An overwritten snapshot is a rewritten history, and a trend over rewritten points is not a trend                                                       |
| A future `asOf` is refused   | Capture records the state _as it is when called_; a future label puts facts in the series before they happened                                         |
| Gaps travel with every point | A day where an input could not be read is a caveat, not a lower number                                                                                 |
| An empty period is `no_data` | An empty chart reads as a flat line at zero                                                                                                            |

**Retention outlives the operational record.** Subject rows carry a keyed-hash **pseudonym**, not a
client id — so cohorts can be followed after the client record is gone.

`PSEUDONYMISATION_NOTE` states the limit in exportable form: anybody holding both the client list
and the derivation key can re-identify every row. It prevents the casual join and the
identifier-carrying extract. **Claiming anonymity would be worse than not doing it**, because the
claim is what somebody would rely on when deciding where an extract may go.

---

## 11.10 — the portal decides nothing

The first surface where the **client** acts. The tempting build is a portal permission model, and
that list would drift from 3.2's document classes, 11.1's access model and 1.5's consent records —
and the drifted copy is the one that would be enforced.

| Action       | Goes to     | What that means                                                                                                                  |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Upload       | 3.2 Vault   | Encrypted, and **unreadable until scanned** — the test proves it by asking the _vault_ to read it, not by checking a portal flag |
| Sign         | 1.5 Consent | A signature _is_ a consent record. Two records of one act would mean a revocation reaches only one                               |
| Message      | 4.1 inbound | Deliberately ungated. **No outbound path exists**: a portal reply would skip the preference gate, the chain and the scanner      |
| Connect bank | `not_built` | Decision A. Capturing the authorization and asking the security question afterwards is the sequence that decision prevents       |

The one rule the portal enforces itself: **a client acts on their own file**, checked against the
resolved principal rather than an id the caller supplied. A missing document and someone else's
document return the **same** answer — distinguishing them would confirm an id belongs to somebody.

Only **delivered** deliverables appear, so what a client reads is what 3.4 approved. **Blocked
outbound messages do not appear** — the client never received them, and showing "we tried to text
you and your own do-not-call instruction stopped us" would be arguing with a client about a
preference they set.

The room carries a `withheld` list. A room that silently omits something asserts there is nothing
there.

---

## 11.11 — a queue states the cost of inaction

A workbench listing everything becomes a second inbox, and two inboxes means both get ignored.
11.4 already dispatches work; the risk is not that a second queue is wrong but that the first stops
being read.

An item appears only if it **requires a Level 3 human**, is **blocking something**, and carries
**what happens if nobody acts** — plus `resolveIn`, the module to act in, because a decision with
no route is an anxiety.

Five sources, each already gated on a human by the module that owns it: overdue Do Not Fund
reviews, critical call-promise corrections, staged configuration changes, clients at Fail, and
unresolved refund entitlements.

Stores nothing. Reuses 9.1's Gardner rollup rather than building a second executive view — it is
already PII-stripped by construction, and the founder can open a client file.

---

## Tested

20 tests in `tests/integration/warehouse-portal-workbench.test.ts`. Suite total **877**.

Mutation-verified:

| Mutation                                                      | Failures |
| ------------------------------------------------------------- | -------- |
| Allow a snapshot to overwrite an existing date                | 1        |
| Portal serves a document by id without checking the principal | 1        |
| Empty a decision's cost of inaction                           | 2        |

> **A mutation found a real gap.** The third mutation initially changed nothing: the fixture had no
> overdue Do Not Fund listing, so that branch of the queue never ran. The fixture now creates one,
> and the mutation bites. A surviving mutation is either a missing assertion or a missing case —
> this was the second.
