# Plan — 11.6 Data Warehouse, 11.10 Client Portal, 11.11 Founder / Executive Workbench

**Blueprint:** 11.6, 11.10, 11.11 · **Branch:** `ai-feature/m11-warehouse-portal-workbench`
**Follows:** 11.7 / 11.8 Admin & Observability (merged, `a39702e`)

**The last three V1 modules.** After this, all 46 modules in the blueprint's V1 phasing are built.

---

## Mini-PRD

### Problem

**11.6.** Every dashboard reads live, which answers "what is true now" and cannot answer "what was
true in March" — the operational store has been overwritten by then. Cohort and trend analysis need
a record of the past that survives the present changing.

**11.10.** Four modules already assume a client-facing surface exists: 4.4's preference centre,
8.1's partner visibility, 3.2's document upload, and Decision A's Plaid Link experience. Nothing
lets a client see or do anything.

**11.11.** A founder has no single place showing what needs them. 9.1 has the numbers, 11.4 has
tasks, 6.4/6.5 have risk, 11.8 has health — and reading five surfaces is how things get missed.

### Success metrics

- The warehouse answers questions about the **past** and cannot be asked about the present.
- A client sees exactly what they are entitled to see, decided by the modules that own it.
- Nothing the client does bypasses a gate — upload goes through 3.2, signing through 1.5.
- The founder's queue contains only things **the founder** must decide.

### Risks

| Risk                                                          | Mitigation                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **The warehouse becoming a stale cache the dashboards trust** | No read serves "current"; every read requires a historical period                                     |
| A second permission model in the portal                       | Entitlement is derived from the owning modules; the portal decides nothing                            |
| A client action skipping a gate                               | Every write is a call into the owning module, not a direct one                                        |
| **The workbench becoming a second ignored inbox**             | Only items requiring a Level 3 human that are actually blocked; each says what happens if nobody acts |
| Warehouse retention re-identifying deleted clients            | Snapshots carry a pseudonymous subject key, and the limits of that are stated rather than overclaimed |

---

## Key decision — a warehouse answers about the past, not faster about the present

ADR-0017 decided the dashboards read live and store nothing, because a snapshot needs a job and a
job that stops leaves a dashboard showing last month under this month's date.

11.6 does not overturn that. It answers a **different question**. A live read of the compliance
distribution tells you where clients stand today; it cannot tell you where they stood in March,
because those clients have moved. The operational store keeps the current value, and the past is
gone.

So the warehouse stores **immutable, timestamped snapshots**, and:

- Every read **requires a historical period**. There is no `current()`.
- Nothing in 9.1 or 9.2 reads from it. The dashboards keep reading live, exactly as ADR-0017 says.
- A snapshot is never updated. Re-running for a date already captured is refused, not overwritten —
  an overwritten snapshot is a rewritten history, and the whole point is having one.

**Retention outlives the operational record**, which is what blueprint 11.6 means by "historical
retention independent of operational data retention". So a snapshot carries a **pseudonymous
subject key** rather than a client id. That is a pseudonym, not anonymisation: somebody holding the
operational client list can still re-identify it. Stating the limit is the honest version; claiming
anonymity would be worse than not doing it.

## Key decision — the portal decides nothing

The portal is the first surface where the **client** acts rather than us. The temptation is a
portal-specific permission model — a list of what clients may see.

That list would drift from 3.2's document classes, 11.1's access model and 1.5's consent records,
and the drifted copy would be the one actually enforced.

So the portal is a **projection**: entitlement is asked of the module that owns the fact, and every
write is a call into the module that owns the gate. Uploading goes through 3.2 (which scans, and
holds the document unreadable until it does). Signing goes through 1.5. Messaging goes through 4.1,
whose inbound path is deliberately ungated. Plaid Link is `not_built` per Decision A.

A client viewing their own document is still a vault **access event**. It is not a special case; it
is a read, and 3.2 logs reads.

## Key decision — the founder's queue is only what the founder must decide

A workbench that lists everything becomes a second inbox, and two inboxes means both get ignored.

So the decision queue contains items that (a) require a Level 3 human, (b) are actually blocking
something, and (c) carry **what happens if nobody acts**. That last part is what makes it a queue
rather than a feed.

Like 7.1 and 9.1, it stores nothing.

---

## Architecture

```
packages/warehouse/
  subjects.ts    pseudonymous subject keys, and the honest limits of them
  snapshot.ts    capture an immutable point-in-time fact set
  trends.ts      cohort and trend reads - period required, no current()
packages/portal/
  views.ts       what a client may see, asked of the owning modules
  actions.ts     upload, sign, message - each through the owning gate
packages/workbench/
  workbench.ts   the decision queue, and the surface over 9.1, 6.4, 4.3, 11.7, 11.8
```

Schema `warehouse`: `AnalyticsSnapshot` (immutable), `SubjectSnapshot` (per-subject, pseudonymous).
No schema for portal or workbench — both are projections.

## Test strategy

- A snapshot is captured, and re-capturing the same date is refused rather than overwriting.
- A trend read over a period works; there is no API to ask the warehouse about now.
- Snapshots survive the client record being removed, and carry no client id.
- The portal shows a client their own documents and never another client's.
- An upload through the portal is unreadable until scanned — 3.2's gate, not a portal check.
- Signing through the portal creates a real 1.5 consent.
- Plaid Link reports `not_built` naming Decision A.
- The founder queue contains only Level-3-human items, each with a stated consequence.
- The workbench reports health, risk and staged config together and stores nothing.

## Out of scope

The UI. Real ETL scheduling — `captureSnapshot` is called by 2.2's scheduler, which exists.
Authentication of client users: 11.1 owns identity, and the portal takes a resolved client
identity rather than inventing a second login.

## Deviations from this plan

**No `entitlement.ts`.** The plan gave the portal a file for deciding what a client may see. Writing
it made the point of the module concrete: there was nothing for it to decide. Every answer came
from the module that owns the fact, so an entitlement layer would have been a pass-through whose
only possible contribution was disagreeing with its sources. What remained - a client acts on their
own file - is one check, and it lives next to the reads it guards.

**No `queue.ts`.** The decision queue is one function over five sources and shares its types with
the surface that renders it. Splitting them would have separated the queue from the only thing that
consumes it.
