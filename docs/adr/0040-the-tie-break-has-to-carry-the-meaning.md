# ADR-0040 — The tie-break has to carry the meaning the caller is relying on

**Status:** accepted
**Date:** 2026-08-11
**Supersedes the open finding in:** ADR-0034

## Context

ADR-0034 fixed a sort and recorded that it had not:

> The underlying limitation is real and is not fixed here: ties at millisecond granularity have no
> defined resolution, so any surface that displays a strict sequence can show two same-millisecond
> rows in either order. A monotonic sequence column would fix it properly, and that is a migration
> on several tables — a slice of its own, named rather than smuggled into this one.

This is that slice.

The shape of the defect, restated once because it is the part that keeps being got wrong: `createdAt`
and `occurredAt` are `timestamp(3)`. Two rows written in the same millisecond hold the same value,
and Postgres then returns them in whatever order it likes. The sweep in ADR-0034 put `{ id: 'asc' }`
behind all 59 of them, which makes a result **stable for a given set of rows** — the same query
returns the same order every time, which is what stops a page reshuffling under a reload — and
leaves it **unrelated to the order the rows arrived in**, because `id` is a random UUID.

Two tests were weakened to match. A client with two security keys was owed both keys under the names
they chose, and not a ruling on which came first; the sales trail asserted that every step was
present and that the two it dated explicitly were in order. Both are tightened back here.

## Decision

**Four tables get `seq BigInt @unique @default(autoincrement())` — a Postgres sequence — and their
ordered reads use it as the tie-break instead of `id`.**

### Which four, and why each one

The instruction was to add the column where insertion order is _actually relied on_, and to justify
each table rather than sweep. The test is three-part: rows are genuinely appended in sequence, two of
them can land in the same millisecond in ordinary operation, and a reader depends on the order rather
than merely on the result being stable.

| Table                         | Read                           | Why it qualifies                                                                                                                                                                       |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales.lead_activities`       | `activityFor`                  | A pipeline trail is read as a sequence. `created` and `qualification` are stamped from one fixture value and tie on **every** run, which is what made the ADR-0034 test flap           |
| `identity.client_mfa_factors` | `registeredKeys`, and two more | The list a client picks from to revoke a key. Two keys registered back to back share a millisecond often enough that the settings test failed about one run in ten                     |
| `vault.vault_access_log`      | `accessLog`                    | The strongest case. One request writes several entries, and "refused, then admitted" versus "admitted, then refused" are different findings a regulator will ask about                 |
| `risk.risk_observations`      | `observationsFor`              | 6.5 calls itself a _chronological_ timeline, and 6.3 — in this same PR — writes several observations per detection pass, all sharing one `occurredAt` because they describe one moment |

The other 55 sites from ADR-0034's sweep keep `{ id: 'asc' }`, deliberately. Most sort by a name, a
version or a key, where insertion order is not what is being asked for. The rest sort by a business
date on a table that gets one row per client per decision — a Do Not Fund listing, a state
activation — where a same-millisecond tie is not a thing that happens. **Each added column is a
migration on a live table**, and the rule this repository already follows for cadenced records
(ADR-0013) applies here too: decide per record, do not generalise from what a neighbour did.

`identity.client_mfa_factors` earned a third fix on the way. `mfa.ts` looks up "the most recent
pending factor" with `orderBy: { createdAt: 'desc' }`; under a random tie-break, two enrolments
started in the same millisecond resolved to whichever UUID sorted higher, so the confirmation could
be applied to the older of the two against a code generated from the newer. Note that the tie-break
there descends **with** `createdAt` — a `seq: 'asc'` behind a `createdAt: 'desc'` picks the _oldest_
of a tied group and is wrong in exactly the same silent way as what it replaced.

### Why a database sequence, and not the alternatives

**A higher-precision timestamp** (`timestamp(6)`) narrows the window and does not close it, and
Prisma's `DateTime` is a JS `Date` — millisecond resolution — so the extra digits would arrive as
zeros for every row this application writes. It would move the failure from "sometimes" to "rarely",
which is worse: the same defect, harder to reproduce.

**A per-tenant counter, like the Ledger's `seq`.** The Ledger needs contiguity, because its chain
verifies over consecutive entries — and it pays for it with a per-tenant advisory lock and a
`ReadCommitted` transaction, which is subtle enough to have its own paragraph in CLAUDE.md. Nothing
here needs contiguity. It needs order. A shared sequence with gaps in it is the cheaper correct
answer, and it takes no lock.

**An application-assigned value** (a ULID, a timestamp-prefixed id). Attractive because it needs no
migration, and rejected because it puts the ordering authority in whichever process happened to
write the row. Two workers with skewed clocks produce an order that is wrong and looks fine.

### What the column does not promise

**It is assignment order, not commit order.** Two concurrent transactions can take 5 and 6 and commit
in the other order, so a reader running between the two commits can see 6 before 5 exists. That is
invisible to all six reads changed here, every one of which reads settled rows after the fact. It
would matter to a change feed paginating on `seq > lastSeen`, which would skip the row that had not
landed yet. **There is no such feed today, and this is the note for whoever writes one.**

**It does not recover the past.** `ADD COLUMN ... BIGSERIAL` numbers existing rows in heap order,
which is roughly insertion order and is not guaranteed to be. Taking that would invent an ordering
for history and present it with the same confidence as one actually recorded. The migration instead
re-numbers each table in exactly the order its read already returned — business timestamp, then id —
so that it does not _change_ any order the system had already shown. **Pre-existing rows that tie on
the timestamp still have no recorded order.** That information was never written down, and no
migration can recover it.

## Consequences

**Four indexes were widened rather than added** — `(tenantId, leadId, occurredAt)` becomes
`(tenantId, leadId, occurredAt, seq)` and so on. The old leading prefix still serves the queries that
filtered on it, so nothing loses an index; the ordered read now walks one instead of sorting.

**The two weakened tests assert order again**, and one of them is a deterministic regression guard
rather than a probabilistic one. `sales-motion.test.ts` stamps `created` and `qualification` with the
same fixture instant, so the tie is present on every run, not on one run in ten. Under the old
tie-break that assertion fails essentially always; it was reverted to `id` to check, and it does.
`client-webauthn.test.ts` gains a case that forces the tie by writing one `createdAt` across three
factors, for the same reason: a guard that only fires when a race goes the wrong way passes most of
the time whether or not the bug is there, which is the lesson the PII detector taught twice.

**`tests/invariants/ordering-key.test.ts` asserts the mechanism as well as the behaviour.** Read
order can in principle be satisfied by luck; `seq` strictly increasing in insertion order cannot be,
because there is no arrangement of random UUIDs that passes it.

**A fifth table will want this eventually.** `notifications.task_notifications` is raised in loops —
`escalateStaleLeads` writes one per stale lead — so ties there are routine. It is left out because
the queue read is `openFor`, and nothing today claims that queue is ordered by arrival. When
something does, the column is a two-line change and this table is the first place to look.

## Alternatives considered

**Do nothing and keep the weakened tests.** What ADR-0034 chose, correctly, for a slice that was
about something else. The cost of leaving it is not the flapping tests — those were already
neutralised — it is that the access log, the one place in this system whose order is _evidence_, had
no defined order at millisecond resolution and nothing said so at the call site.

**Sweep all 59 sites.** Rejected. Most of them do not want insertion order, several sort by a column
where a tie cannot occur, and a sweep would spend a migration on every table in the schema to fix
four. It would also make the column mean less: a `seq` on a table sorted by name is decoration, and
the next reader would have to work out which ones were load-bearing.
