# Seeded claims and message templates

**Modules:** 7.4 Marketing Claim Library, 4.1 Communications Hub, with 4.2 Communication Compliance
Scanner and 4.5 Marketing Operations.

## The problem this fixes

The Marketing Claim Library was empty for every tenant. `scanForTenant` refuses on an empty library,
and because middleware step 7, contract generation (7.3), deliverable approval (3.4), campaign asset
review (4.5) and partner brand material (8.1) all route through that scan, the effect was not lax
scanning - it was that **no client-facing content could be sent, generated or approved at all.**

Message templates (4.1) were empty too, so there was nothing to send even if sending had worked.

## What is here

|                                                   |                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/claims/src/seed.ts`                     | 108 banned and requires-disclaimer entries, each with its rationale, plus the ten named disclosure constants |
| `packages/claims/src/proposed.ts`                 | 10 claims worth approving, submitted to 4.5's queue. **None is published.**                                  |
| `packages/comms/src/seed.ts`                      | 9 message templates for the ordinary sends, scanned before they are stored                                   |
| `tests/integration/claim-library-seed.test.ts`    | 33 tests                                                                                                     |
| `tests/integration/message-template-seed.test.ts` | 18 tests                                                                                                     |

## Three rules that govern the whole slice

**A seed may ban a claim and may not approve one** (ADR-0070). Over-banning produces a visible
complaint from somebody holding the exact phrase they wanted. Over-approving produces nothing, ever,
until a regulator notices. So the seed publishes the half that fails loudly, and the half that fails
silently goes to a named human at Authority Level 3.

**A phrase that begins with a symbol is a rule that never fires** (ADR-0071). The scanner binds `\b`
at both ends, so an entry of `$100K` matches nothing in "you qualify for $100K" while still counting
toward `libraryEntriesChecked`. `inertPhrases()` computes the property and a test asserts it is
empty.

**A template is scanned before it is stored** (ADR-0072). A template is a message that will be sent
many times, so a banned phrase in one is a defect that reproduces at the rate the business
communicates. Seeding templates into a tenant with no library refuses, which makes the ordering
explicit rather than conventional.

## Running the seeds

Neither seed runs on import. Both are exported functions.

```ts
import { seedFoundingClaims, seedProposedClaims } from '@bwc/claims';
import { proposeClaim } from '@bwc/marketing';
import { seedMessageTemplates } from '@bwc/comms';

// 1. The library first. Nothing is sendable until this exists.
await seedFoundingClaims(tenantId, 'compliance_review_board', actor);

// 2. The templates, which are scanned against it and refuse if it is absent.
const templates = await seedMessageTemplates(tenantId, 'concierge_desk', actor);
if (templates.status !== 'ok') throw new Error(templates.reason);

// 3. The proposals. `submittedBy` is an Actor id - it is a UUID column.
//    The intake is injected: @bwc/marketing depends on @bwc/claims, so the reverse
//    import would close a package cycle and break `tsc -b`.
await seedProposedClaims(tenantId, humanActorId, actor, proposeClaim);
```

Both seeds are idempotent. `seedFoundingClaims` upserts on (tenant, phrase, jurisdiction) and bumps
each entry's version, which is correct - a re-seed is a restatement of the rules of record.
`seedMessageTemplates` supersedes the previous version rather than editing it, so a message sent in
March stays explicable. `seedProposedClaims` returns the existing row for a pending phrase and is
refused for one already decided.

## Verifying

```bash
pnpm verify                      # lint, typecheck, 1672 tests
pnpm exec vitest run tests/integration/claim-library-seed.test.ts \
                     tests/integration/message-template-seed.test.ts
pnpm build && pnpm test:e2e      # 56 browser tests
```

CI's build from clean, which is what catches a missing tsconfig reference:

```bash
find packages apps -maxdepth 2 -name dist -type d -not -path "*/node_modules/*" -exec rm -rf {} +
pnpm exec tsc -b apps/api
```

## Two things a future author should know

**Do not ban a word that appears in the firm's own compliance prose.** Bare "credit repair" is
absent from the library on purpose: `NOT_A_LENDER_DISCLOSURE` reads "is not a lender, investment
adviser, or credit repair organization", and an entry blocking it would block the sentence written
to satisfy the rule. Same for "legal advice", "tax advice", "guarantee" and "average". The offending
uses are banned instead - "credit repair services", "as your attorney". A scanner that blocks the
disclaimer is a scanner that gets routed around, and then it protects nothing.

**Numeric money promises are 4.3's job, not 7.4's.** `packages/calls/src/detect.ts` matches the
shape of a money promise, and its header says why the Library cannot: the promise varies by amount,
and an exact-phrase library would need an entry for each. The Library holds the colloquial forms
("six figures", "hundred grand") and the promise verbs a numeral only quantifies ("get you funded").

## Follow-ups this slice did not take

- **`phrasePattern` cannot match a symbol-edged phrase.** Explicit lookarounds
  (`(?<![A-Za-z0-9_-])`) would fix it - the same fix CLAUDE.md records for the PII detector, which
  hit the mirror image of this bug. `packages/scanner` is outside this slice's ownership.
- **`publishTemplate` does not scan.** Only the seed does, so a template published by any other
  path is unchecked until send. Moving the scan into `publishTemplate` is the right answer and has a
  much wider blast radius than a seed.
