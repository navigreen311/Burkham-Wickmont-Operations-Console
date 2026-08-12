#!/usr/bin/env node
/**
 * Seed one tenant with the authored content the modules were built to hold.
 *
 * Seven packages grew a `seed.ts` in one wave, written by three people who never saw each other's
 * files. **Every one of them deliberately declines to run itself**, on the rule the regulatory seed
 * set first: content that appears because a module was imported is content nobody chose. So each
 * one is a function nothing calls, and this is the something that calls them.
 *
 * ## The order is not arbitrary, and it is the reason this file exists
 *
 * Two dependencies run between seeds, and neither is visible from inside either half:
 *
 * **The claim library must exist before a message template can be stored.** `seedMessageTemplates`
 * scans every subject and body against the tenant's library before publishing any of them
 * (ADR-0072), and the scanner refuses for a tenant whose library is empty. Run comms first and it
 * refuses wholesale - correctly, and with a reason that reads like a bug. Claims first, then comms.
 *
 * **Deliverable templates must exist before the playbooks that produce them.** A playbook step
 * names a template key; registering the playbook first leaves steps pointing at nothing.
 *
 * Neither agent could have enforced these, because each owns one side. Ordering is an integration
 * concern, which is why it is stated here in one place rather than assumed in seven.
 *
 * ## What this does not do
 *
 * **It activates no state.** The regulatory seed writes states in their pre-activation state
 * pending documented counsel review, and has no argument that would change that. A state going
 * live is a decision a lawyer records, not a flag a script sets.
 *
 * **It approves no claim.** `seedFoundingClaims` publishes the bans and the phrases already
 * settled; `seedProposedClaims` submits the rest for the Board to decide (ADR-0070). A seed that
 * approved marketing language would be a script granting itself the authority to speak for the
 * firm.
 *
 * **It supersedes nothing.** Every seed is idempotent and every one defaults to leaving an existing
 * row alone. That default carries real weight in two of them: republishing the offer ladder would
 * bury the owner's corrections under these drafts, and republishing a curriculum module as a
 * material change would decertify every partner who completed the previous version. Re-running this
 * script is safe; that is by construction and not by luck.
 *
 * ## Usage
 *
 *   pnpm build                                          # the seeds are imported from dist/
 *   node scripts/seed-tenant.mjs --tenant <id> --actor <id>
 *
 * Both arguments are required and neither has a default. A seed script that guessed which tenant to
 * write to would be answering a question nobody asked, and the answer would be a database write.
 *
 * `--actor` must be an existing Actor id: it becomes `publishedBy` on published content and the
 * actor on every Ledger event this produces. Content published by "the system" is content with
 * nobody accountable for it.
 *
 * Exit code is 1 if any step refused, so a runner does not read a wall of green text and a refusal
 * in the middle as success.
 */

import 'dotenv/config';

import { seedFoundingClaims, seedProposedClaims } from '../packages/claims/dist/index.js';
import { proposeClaim } from '../packages/marketing/dist/index.js';
import { seedV1DeliverableTemplates } from '../packages/deliverables/dist/index.js';
import {
  POST_FUNDING_TRIGGER,
  seedV1Playbooks,
  upsertTrigger,
} from '../packages/workflow/dist/index.js';
import { seedMessageTemplates } from '../packages/comms/dist/index.js';
import { seedOfferLadder } from '../packages/billing/dist/index.js';
import { seedCurriculum } from '../packages/partners/dist/index.js';
import { seedV1PriorityStates } from '../packages/regulatory/dist/index.js';

const flag = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const tenantId = flag('tenant');
const actorId = flag('actor');

if (!tenantId || !actorId) {
  console.error(
    'Usage: node scripts/seed-tenant.mjs --tenant <tenantId> --actor <actorId>\n\n' +
      'Both are required. --actor must be an existing Actor id; it becomes publishedBy on\n' +
      'everything this writes and the actor on every Ledger event it produces.',
  );
  process.exit(2);
}

const actor = { id: actorId, kind: 'human' };

/** Collected rather than thrown, so one refusal does not hide the six results after it. */
const refusals = [];

/**
 * What the seeds say an owner still has to decide.
 *
 * Two of them return a list of the figures and requirements they invented - prices, fee rates,
 * which curriculum modules are required of whom - because a draft that does not say it is guessing
 * reads as a decision the firm made. Printed at the end rather than inline, where it would scroll
 * past.
 */
const toConfirm = [];

const step = async (label, run) => {
  process.stdout.write(`${label} ... `);
  try {
    console.log(await run());
  } catch (error) {
    console.log('FAILED');
    refusals.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

console.log(`Seeding tenant ${tenantId}\n`);

// 1. The claim library, FIRST - the message templates below are scanned against it, and an empty
//    library refuses every one of them.
await step('1/9 claim library (bans and settled phrases)', async () => {
  const published = await seedFoundingClaims(tenantId, actorId, actor);
  return `${published} entr(ies) published`;
});

// 2. The rest of the library as proposals. A seed may ban a claim and may not approve one.
await step('2/9 claims proposed for the Board', async () => {
  const result = await seedProposedClaims(tenantId, actorId, actor, proposeClaim);
  if (result.refused.length > 0) {
    refusals.push(`proposed claims: ${result.refused.length} refused`);
  }
  return `${result.submitted} submitted, ${result.refused.length} refused`;
});

// 3. Deliverable templates BEFORE the playbooks whose steps name them. Firm-wide, not per-tenant:
//    the wording of a Burkham Wickmont deliverable belongs to the firm.
await step('3/9 deliverable templates (firm-wide)', async () => {
  const keys = await seedV1DeliverableTemplates();
  return `${keys.length} registered: ${keys.join(', ')}`;
});

// 4. The Phase 0-2 playbooks, which name the templates registered above.
await step('4/9 phase 0-2 playbooks (firm-wide)', async () => {
  const result = await seedV1Playbooks();
  if (result.refused.length > 0) {
    refusals.push(
      `playbooks: ${result.refused.map((entry) => `${entry.key} (${entry.reason})`).join('; ')}`,
    );
  }
  return `${result.published.length} published, ${result.refused.length} refused`;
});

// 5. Message templates - scanned against the library seeded in step 1 before any is stored.
await step('5/9 message templates (scanned before stored)', async () => {
  const result = await seedMessageTemplates(tenantId, actorId, actor);
  if (result.status !== 'ok') {
    refusals.push(`message templates: ${result.reason}`);
    return `REFUSED - ${result.reason}`;
  }
  return `${result.value.published.length} published, ${result.value.skipped.length} already present, checked against ${result.value.libraryEntriesChecked} library entr(ies)`;
});

// 6. The offer ladder, as drafts. Existing rungs are left alone: republishing would supersede the
//    owner's corrections with these.
await step('6/9 offer ladder (drafts)', async () => {
  const result = await seedOfferLadder({ tenantId, publishedBy: actorId, actor });
  if (result.status !== 'ok') {
    refusals.push(`offer ladder: ${result.reason}`);
    return `REFUSED - ${result.reason}`;
  }
  toConfirm.push([
    'offer ladder',
    result.value.figuresToConfirm,
  ]);
  return `${result.value.published.length} rung(s) published, ${result.value.skipped.length} already present`;
});

// 7. The partner curriculum. Existing modules are left alone: a material republish would decertify
//    every partner who completed the previous version.
await step('7/9 partner curriculum', async () => {
  const result = await seedCurriculum({ tenantId, publishedBy: actorId, actor });
  if (result.status !== 'ok') {
    refusals.push(`curriculum: ${result.reason}`);
    return `REFUSED - ${result.reason}`;
  }
  toConfirm.push(['partner curriculum', result.value.requirementsToConfirm]);
  return `${result.value.published.length} module(s) published, ${result.value.skipped.length} already present`;
});

// 8. The regulatory register. These are drafts pending documented counsel review, and nothing here
//    activates a state.
await step('8/9 regulatory states (pending counsel review)', async () => {
  const result = await seedV1PriorityStates(tenantId, actorId, actor);
  return `${result.published.length} state(s) recorded, ${result.skipped.length} already present, none activated`;
});

// 9. The trigger that starts the post-funding follow-up.
//
//    Per tenant, because a trigger row is, while a playbook is firm-wide. Registered here rather
//    than by the workflow seed for the same reason nothing else in this run happens by itself: a
//    playbook that began running because a package was imported is a workflow nobody chose.
await step('9/9 post-funding follow-up trigger', async () => {
  const trigger = await upsertTrigger({
    tenantId,
    eventType: POST_FUNDING_TRIGGER.eventType,
    playbookKey: POST_FUNDING_TRIGGER.playbookKey,
  });
  const state = trigger.enabled ? 'enabled' : 'disabled';
  return `${POST_FUNDING_TRIGGER.eventType} starts ${POST_FUNDING_TRIGGER.playbookKey} (${state})`;
});

console.log('');
if (refusals.length > 0) {
  console.error(`${refusals.length} step(s) did not complete cleanly:`);
  for (const refusal of refusals) console.error(`  - ${refusal}`);
  console.error(
    '\nA refusal here is usually the system being right about something. Read it before re-running.',
  );
  process.exit(1);
}

console.log('Every seed completed. Nothing was activated and no claim was approved:');
console.log('  - states are pending documented counsel review');
console.log('  - proposed claims are waiting on the Board');
console.log('  - the offer ladder is drafts');

for (const [label, items] of toConfirm) {
  if (items.length === 0) continue;
  console.log(`\nThe ${label} seed invented these and an owner has to confirm them:`);
  for (const item of items) console.log(`  - ${item}`);
}
