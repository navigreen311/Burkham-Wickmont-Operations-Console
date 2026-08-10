# ADR-0020 — A warehouse answers about the past; a portal decides nothing; a queue states the cost of inaction

**Status:** Accepted · **Date:** 2026-08-11 · **Modules:** 11.6 Data Warehouse, 11.10 Client Portal, 11.11 Founder / Executive Workbench

The last three V1 modules, and one decision each.

---

## Decision 1 — the warehouse answers about the past, not faster about the present

ADR-0017 decided the dashboards read live and store nothing: a snapshot needs a job, and a job that
stops leaves a dashboard showing last month under this month's date.

11.6 does not overturn that. **It answers a different question.** A live read tells you where
clients stand today; it cannot tell you where they stood in March, because those clients have moved
and the operational store keeps only the current value. The past is not slow to compute — it is
gone.

So the warehouse stores immutable timestamped snapshots, and:

- **Every read requires a historical period.** There is no `current()`, `latest()` or `today()`.
  That is what stops anything quietly using this as a faster read of what 9.1 already answers live,
  and it is asserted structurally — the test greps the module's exports.
- **9.1 and 9.2 do not read from it.** They keep reading live, exactly as ADR-0017 says.
- **A snapshot is never updated.** Re-capturing a date is refused, not overwritten: an overwritten
  snapshot is a rewritten history, and a trend over rewritten points is not a trend.
- **A future `asOf` is refused.** Capture records the state as it is when called; labelling that
  with a future date puts facts in the series before they happened.
- **Gaps travel with every point.** A day where an input could not be read is a caveat, not a lower
  number, and a reader cannot tell the difference from the value alone.

**Retention outlives the operational record**, which is what blueprint 11.6 means by "historical
retention independent of operational data retention". Subject rows therefore carry a **pseudonymous
key** — a keyed hash of tenant and client id — rather than a client id.

That is pseudonymisation, **not anonymisation**, and `PSEUDONYMISATION_NOTE` says so in exportable
form. Anybody holding both the operational client list and the derivation key can re-identify every
row. What it prevents is the casual join and the extract that carries identifiers. Claiming more
would be worse than not doing it, because the claim is what somebody would rely on when deciding
where an extract may go.

## Decision 2 — the portal decides nothing

11.10 is the first surface where the **client** acts rather than us. The tempting build is a
portal-specific permission model: a list of what clients may see and do.

That list would drift from 3.2's document classes, 11.1's access model and 1.5's consent records —
and **the drifted copy is the one that would actually be enforced.**

So the portal is a projection. Every view asks the module that owns the fact; every action calls
the module that owns the gate:

- **Upload → 3.2**, which encrypts and holds the document unreadable until its scan completes. The
  test proves this by asking the _vault_ to read the document, not by checking a portal flag.
- **Signing → 1.5.** A signature _is_ a consent record. A portal-local signature plus a 1.5 consent
  would be two records of one act, and a revocation would reach only one.
- **Messaging → 4.1's inbound path**, deliberately ungated. There is **no outbound path** here: a
  portal reply would skip the preference gate, the middleware chain and the scanner, and would be
  the one piece of client-facing text nobody checked.
- **Plaid Link → `not_built`**, per Decision A. A half-built version that captured the
  authorization and asked the security question afterwards is the exact sequence that decision
  exists to prevent.

The one rule the portal enforces itself is the one no other module can: **a client acts on their own
file**, checked against the resolved principal rather than an id the caller supplied. A missing
document and someone else's document return the same answer — distinguishing them would confirm
that an id belongs to somebody.

The room carries a `withheld` list, for 7.1's reason applied to a client-facing surface: a room that
silently omits something asserts there is nothing there.

## Decision 3 — a decision queue states the cost of inaction

A workbench that listed everything becomes a second inbox, and two inboxes means both get ignored.
11.4 already has a task queue; the failure of adding another is not that the second is wrong but
that the first stops being read.

So an item reaches the founder queue only if it (a) requires a Level 3 human, (b) is blocking
something, and (c) carries **what happens if nobody acts**.

The third is what makes it a queue rather than a feed. _"Three items need your attention"_ is a
notification. _"The listing keeps blocking, which is the safe direction — but it blocks on a
determination nobody has revisited"_ is a decision.

Each item also carries `resolveIn`, naming the module to act in. A decision with no route is an
anxiety.

## Consequences

**Nothing here stores anything except the warehouse.** Portal and workbench have no schema, and the
test asserts that no `portal` or `workbench` schema exists in the database.

**The workbench reuses 9.1's Gardner rollup** rather than building a second executive view. It is
already PII-stripped by construction, and a richer founder-only version would be a second thing to
keep honest — the founder can open a client file and does not need the numbers to carry one.

**A mutation test found a real gap.** Emptying the Do Not Fund branch's `costOfInaction` changed no
test, because the fixture had no overdue listing and the branch never ran. The fixture now creates
one. A mutation that survives is either a missing assertion or a missing case, and this was the
second.

## Alternatives considered

**Let the dashboards read the warehouse for speed.** Rejected — that is precisely the stale cache
ADR-0017 ruled out, and the absence of a `current()` is what makes the rejection structural rather
than a convention.

**Store snapshots keyed by client id and delete them with the client.** Rejected: it defeats
"retention independent of operational retention", which is the module's stated purpose.

**A portal permission model.** Rejected — see Decision 2.

**A workbench feed of everything notable.** Rejected: the second inbox problem, and the first
inbox is 11.4's, which is the one that dispatches work.
