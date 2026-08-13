# V1.5 engines, batch 1

Four V1.5 modules built as pure engines — no routes, no pages — plus the ordering key ADR-0034 named
and left open.

Run everything with `pnpm verify`.

**All four have surfaces now, and this paragraph used to say otherwise.** It read "the engines have
no HTTP surface yet, so there are no URLs to demo". 5.5 and 7.5 got theirs when the last two modules
without panels were built; 8.4 got its own in a later slice (ADR-0084). The ordering key is not a
module and never needed one.

The tests remain the demonstration of each property, and each file's header still says which
property it exists to prove.

| Slice                             | Package                       | ADR      | Tests                                                                                                  |
| --------------------------------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| The ordering key                  | `prisma`, four existing reads | ADR-0040 | `tests/invariants/ordering-key.test.ts`                                                                |
| 5.5 Funding Outcome Ledger        | `@bwc/outcomes` (new)         | ADR-0041 | `tests/integration/funding-outcome-ledger.test.ts`, `tests/invariants/funding-outcomes.test.ts`        |
| 7.5 Legal Hold & Record Retention | `@bwc/retention` (new)        | ADR-0042 | `tests/integration/legal-hold-and-retention.test.ts`, `tests/invariants/retention-constraints.test.ts` |
| 8.4 Partner Risk Score            | `@bwc/partners` (`risk.ts`)   | ADR-0043 | `tests/integration/partner-risk.test.ts`                                                               |
| 6.3 Client Conduct Monitoring     | `@bwc/risk` (`conduct.ts`)    | ADR-0044 | `tests/integration/client-conduct-monitoring.test.ts`                                                  |

## The one thread running through all five

**A control a caller can skip is not a control** — ADR-0034, which this batch closes three more
instances of.

| Where it was open                                        | What consults it now                                |
| -------------------------------------------------------- | --------------------------------------------------- |
| 5.2's `recordOutcome` had no production caller, ever     | 5.5 writes it from inside every decision            |
| 8.4's assessment would have gated nothing                | `canRefer` checks the standing                      |
| 6.3's service pause would have gated nothing             | The middleware chain checks it at step 4            |
| A 7.5 hold would not have covered documents in the vault | `vault.remove` and `vault.read` ask `holdsCovering` |

In each case the check sits **inside** the function that must not be bypassed, not beside it. The
alternative — compose the two calls at a route, a job, or a wrapper — leaves the plain function
reachable and better-named, which is the shape ADR-0034 found `autoListForComplianceFail` in.

## What each module refuses to do

**5.5** refuses to publish a rate below ten decided attempts, and refuses to let an approved amount
exist on anything that is not an approval (a CHECK constraint, not a code path).

**7.5** refuses to invent a retention period. No schedule recorded means not permitted to delete —
a fallback would be indistinguishable from a researched one at the moment somebody destroys a
record.

**8.4** refuses to produce a score. Blueprint 8.4 asks for one; a single figure over these
dimensions lets revenue contribution offset an unauthorized promise.

**6.3** refuses to write a compliance state. A client can sit at `pass` with paused service; the two
facts are about different things.

## Migrations

Five, in order, each verified by deploying onto an empty database and running the whole suite
against it:

```
20260902000000_ordering_key
20260903000000_funding_outcome_ledger
20260904000000_legal_hold_and_retention
20260905000000_partner_risk
20260906000000_client_conduct_monitoring
```

The ordering-key migration is hand-edited after generation. `ADD COLUMN ... BIGSERIAL` numbers
existing rows in heap order, which is roughly insertion order and not guaranteed to be, so each
table is re-numbered in exactly the order its read already returned. See ADR-0040 for what that does
and does not buy.

Twenty-five CHECK constraints across the four new tables — seven on 5.5's attempts, ten across
7.5's three, three on 8.4's findings, five on 6.3's breaches. Prisma cannot express one, so they are
appended to the generated SQL by hand — and asserted by going around the engine with raw SQL,
because a suite that only exercised the engine would pass identically against a table with no
constraints on it.

## Two new Postgres schemas

`outcomes` and `retention`, per ADR-0001's schema-per-module. Both are added to the datasource's
`schemas` list; a module that owns no schema of its own (8.4 in `partners`, 6.3 in `risk`) is one
that belongs to an existing category's package.

## Environment

No new variables. The engines read the same `DATABASE_URL` and `LEDGER_SIGNING_KEY` everything else
does.
