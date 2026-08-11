# Console surfaces, batch 1 — 2.4, 7.3, 3.2, 1.4, 11.11

Five modules that were built, tested and unreachable from a browser now have routes and views in the
internal Console.

**All five ship as reads.** Every write these modules expose needs an action that is not in
`ACTION_MINIMUM_LEVEL`, and `decideAuthority` refuses an action absent from the catalogue — so the
writes are reported in [ADR-0037](adr/0037-a-surface-with-no-verb-is-still-a-surface.md) rather than
built. 3.2 would be read-only regardless
([ADR-0038](adr/0038-the-vault-surfaces-what-happened-to-a-document.md)).

## Routes

All behind the staff session. All `GET`. All lists carry a total.

| Route                                            | Module | What it answers                                                       |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------- |
| `/api/console/approvals?queue=<name>`             | 2.4    | Open human checkpoints in a queue, plus every checkpoint past its SLA  |
| `/api/console/approvals/:taskId`                  | 2.4    | One checkpoint, its workflow, its assignments, and why it cannot be resolved here |
| `/api/console/clients/:clientId/contracts`        | 7.3    | What was issued to a client — a table of contents, not the text       |
| `/api/console/contracts/:contractId`              | 7.3    | One document, its integrity, its placeholders, its provenance         |
| `/api/console/contract-staleness`                 | 7.3    | Firm-wide: documents behind a state module, and on superseded templates |
| `/api/console/clients/:clientId/documents`        | 3.2    | Document metadata. **Never content**                                  |
| `/api/console/documents/:documentId/access-log`   | 3.2    | Who looked, who was refused, and why                                  |
| `/api/console/offers`                             | 1.4    | The offer ladder                                                      |
| `/api/console/clients/:clientId/billing`          | 1.4    | Engagements and unspent credit                                        |
| `/api/console/engagements/:engagementId`          | 1.4    | Balance as components, billing records, refund entitlements, fee exhibit |
| `/api/console/workbench`                          | 11.11  | The founder decision queue, the rollup, health, cross-department      |

## Views

`apps/api/public/index.html` gained five `<main>` elements and one shared `<nav>`. The navigation
used to be copied into each view with a suffixed id per copy; that worked at three views and does not
at nine, where every new surface would need a button added to every existing one.

Three of the five are client-scoped and hang off an open client file: **Contracts & disclosures**,
**Documents**, **Billing**. Two are firm-wide and sit in the top navigation: **Approvals**,
**Workbench**.

Still one document switched by a `hidden` attribute, no router, no build step (ADR-0031).

## Rules this slice was checked against

- **Every value reaches the page through `textContent`.** Now enforced: `console.js` has claimed
  since it was written that "a test asserts that the markup-assigning properties appear nowhere in
  this directory", and **no such test existed** until this slice. The portal had one; the Console's
  page was written to the same rule with nothing watching it.
- **Nothing is rendered as a colour alone.** Scan status, compliance state, health state and
  integrity are words. `unmonitored` is counted out loud on the workbench.
- **`null` is never `0`.** A contingent fee line carries no amount and reads "contingent, not yet
  determinable"; a withheld metric reads "not measured".
- **Lists carry their total**, and where a count would mislead there are two — granted and refused
  access attempts, stale state modules and superseded templates.
- **Closed vocabularies come from the server.** With one stated exception: the approval queue name is
  a text field, because queue names are authored inside playbook definitions and nothing enumerates
  them. A select filled from a list this page invented is the failure the rule exists to prevent,
  pointed the other way.

## Money

Two conventions live one field apart on `/api/console/engagements/:engagementId`, so both are named:

- Balances, billing records and offers are **integer cents**, with a `…Display` string rendered by
  `@bwc/billing`'s own `formatMoney`. The page never does arithmetic on money.
- The fee exhibit's amounts are **dollars** — 7.3's convention, converted once at 1.4's edge by
  `exhibitInputFor`. The page label says "dollars, not cents".

No approved credit limit is passed to the exhibit, so the success fee is presented as contingent
rather than estimated. There is no field anywhere in 1.4 for a *requested* limit.

## Run it

```bash
pnpm install
pnpm db:generate
pnpm dev:api           # then open http://localhost:3000/console/
```

## Test it

```bash
pnpm verify                       # lint + typecheck + vitest
pnpm build && pnpm test:e2e       # browser, Chromium

pnpm vitest run tests/integration/console-surfaces.test.ts
pnpm exec playwright test tests/e2e/console-surfaces.spec.ts
```

`tests/integration/console-surfaces.test.ts` asserts **the exact key set of every list row**, not a
sample. The DOM layer has no type checking and a browser renders a missing field as nothing at all —
so a renamed field produces a blank in the middle of a sentence and no error anywhere. Mutation
testing confirmed the shape of that risk: renaming `creditedDisplay` to `creditDisplay` fails the
transport test and **passes the browser spec**, which goes on rendering `credited undefined`.

`tests/e2e/console-surfaces.spec.ts` uses one account per test — a TOTP code is spent when accepted,
so two tests sharing an authenticator inside one thirty-second step is a replay rather than a test.
None of the five surfaces mutates anything, so there is no one-client-per-test rule to follow; they
all read `Console Surfaces Subject LLC`, seeded by `tests/e2e/console-surfaces-seed.ts`.
