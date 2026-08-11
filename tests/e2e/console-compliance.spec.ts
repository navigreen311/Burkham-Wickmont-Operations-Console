/**
 * The compliance and governance surfaces in a browser, and above all **a state actually coming
 * online**.
 *
 * The transport test proves the gate refuses and permits the right actors. What only a browser
 * proves is the thing this batch is for: that a person with a counsel memo in front of them can
 * open the Console, find the state, type what the review says, and watch the firm become able to
 * serve clients there. Middleware step 5 refuses every client-facing action until that happens, so
 * this journey is the difference between a system that runs and a system that operates.
 *
 * **Each spec claims its own account and its own state.** Accounts because a TOTP code is spent when
 * accepted and a suite runs faster than thirty seconds; states because activation is permanent, so
 * a spec sharing one with another would assert against a standing it did not create — and the
 * failure would look like a flake rather than like two specs fighting.
 *
 * The states used here are deliberately outside `V1_PRIORITY_STATES`, so seeding them cannot change
 * what the coverage map says about the priority states the other assertions read.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createActor } from '@bwc/identity';
import { publishStateModule } from '@bwc/regulatory';
import { seedFoundingClaims } from '@bwc/claims';
import {
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_PASSWORD,
  nextStepCode,
  openConsole,
  type ConsoleHandoff,
} from './fixture.js';

/**
 * One state per spec that changes one.
 *
 * `ME` is activated by the journey below. `VT` is only ever read, so the coverage assertions have a
 * state whose standing nothing moves. Neither is a V1 priority state.
 */
const ACTIVATED_STATE = 'ME';
const READ_ONLY_STATE = 'VT';

const handoff = async (): Promise<ConsoleHandoff> =>
  JSON.parse(await readFile(E2E_CONSOLE_HANDOFF, 'utf8')) as ConsoleHandoff;

const signIn = async (page: Page, email: string): Promise<ConsoleHandoff> => {
  const seed = await handoff();
  const secret = seed.secrets[email];
  if (secret === undefined) throw new Error(`the harness seeded no account for ${email}`);
  await openConsole(page);

  const form = page.locator('#form-sign-in');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(E2E_CONSOLE_PASSWORD);
  await form.getByLabel('Authenticator code').fill(nextStepCode(secret));
  await form.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  return seed;
};

/**
 * Publish the two modules this spec reads, from the spec process.
 *
 * Written here rather than in `console-server.ts` so this slice adds nothing to a harness file it
 * does not own. The spec and the server share a database; the tenant comes from the handoff the
 * server already writes, and the publishing actor is created here because the handoff carries no
 * Level 3 actor id.
 */
test.beforeAll(async () => {
  const seed = await handoff();

  const publisher = await createActor({
    tenantId: seed.tenantId,
    kind: 'human',
    label: 'E2E compliance publisher',
    authorityLevel: 3,
    department: 'compliance_and_evidence',
  });

  for (const state of [ACTIVATED_STATE, READ_ONLY_STATE]) {
    const published = await publishStateModule({
      tenantId: seed.tenantId,
      state,
      summary: `${state} module for the compliance browser journey.`,
      citations: [`${state} commercial financing provisions`],
      disclosures: [
        {
          key: `${state.toLowerCase()}_cost_basis`,
          text: `Any cost figure shown to a ${state} client states the basis on which it was computed.`,
          citation: `${state} commercial financing provisions §1`,
        },
      ],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: { id: publisher.id, kind: 'human' },
    });
    if (published.status !== 'ok') {
      throw new Error(`seed: ${state} module (${published.status})`);
    }
  }

  // The founding claim library. The harness does not seed it, and 7.4's whole assertion is about
  // how a `banned` entry is presented - which needs one to exist.
  await seedFoundingClaims(seed.tenantId, 'compliance@burkhamwickmont.test', {
    id: publisher.id,
    kind: 'human',
  });
});

test.describe('7.2 bringing a state online', () => {
  test('an operator with a counsel memo can activate a state, and the map says so', async ({
    page,
  }) => {
    await signIn(page, 'e2e-operator-activation@example.com');

    await page.getByRole('button', { name: 'Load state coverage' }).click();

    // The sentence the page leads with, written on the server. Before anything is activated it is
    // the actual condition of the system.
    await expect(page.locator('#regulatory-headline')).toContainText('No state is active');
    await expect(page.locator('#regulatory-headline')).toContainText('middleware step 5');

    // States are written out as words. Three of the four statuses block, and they are cleared by
    // different work, so nothing here is a colour.
    await expect(page.locator('#regulatory-states')).toContainText('draft');
    await expect(page.locator('#regulatory-states')).toContainText('blocks client-facing action');

    // V1 priority states with no module are named rather than omitted.
    await expect(page.locator('#regulatory-priority-gap')).toContainText('priority state');

    await page.getByRole('button', { name: ACTIVATED_STATE, exact: true }).click();

    await expect(page.locator('#regulatory-state-name')).toHaveText(ACTIVATED_STATE);
    await expect(page.locator('#regulatory-state-standing')).toContainText('draft');

    // The requirement is on screen before the form, from the module rather than from the markup.
    await expect(page.locator('#regulatory-state-requires')).toContainText(
      'human actor at Authority Level 3',
    );
    await expect(page.locator('#regulatory-state-requires')).toContainText(
      'village agent at Level 3 is refused',
    );

    // The federal layer and the state layer are both on the page, each naming which obliges it.
    await expect(page.locator('#regulatory-state-disclosures')).toContainText('federal');
    await expect(page.locator('#regulatory-state-disclosures')).toContainText(ACTIVATED_STATE);

    // --- an incomplete memo does not leave the page ---
    const activation = page.locator('#form-activate');
    await activation.getByLabel('Reviewing counsel').fill('Outside counsel, Fig & Rowe LLP');
    // The date is left empty on purpose. The page supplies no default (ADR-0035), and the field is
    // `required`, so the browser will not submit an incomplete counsel memo at all.
    await activation.getByLabel('Document reference').fill('Memo BW-REG-2026-060');
    await page.locator('#activate-submit').click();

    // Nothing was sent and nothing changed: still the coverage headline, still no gate.
    //
    // The server-side refusal for each missing field is asserted in the transport test, where it
    // can be reached. Here the useful assertion is that the operator cannot get an incomplete memo
    // as far as the gate - which is a different control from the gate itself, and worth its own
    // check because it is the one a person actually meets.
    await expect(page.locator('#regulatory-headline')).toContainText('No state is active');
    await expect(page.locator('#regulatory-gate')).toContainText('No checks recorded.');
    await expect(page.locator('#regulatory-state-standing')).toContainText('draft');

    // --- then the whole memo, and the state comes online ---
    await activation.getByLabel('Date counsel reviewed it').fill('2026-08-01');
    await page.locator('#activate-submit').click();

    // **THE ASSERTION THIS SPEC EXISTS FOR.**
    await expect(page.locator('#regulatory-headline')).toContainText(
      `${ACTIVATED_STATE} is now active`,
    );
    await expect(page.locator('#regulatory-state-standing')).toContainText(
      'permits client-facing action',
    );
    await expect(page.locator('#regulatory-gate')).toContainText('module_gate: passed');

    // The coverage map reloaded with it, and the headline changed from "nobody" to a number.
    await expect(page.locator('#regulatory-headline')).not.toContainText('No state is active');
    await expect(page.locator('#regulatory-summary')).toContainText('active');

    // The form is cleared. A counsel memo left in a field looks like one still being submitted.
    await expect(page.locator('#activate-counsel')).toHaveValue('');
    await expect(page.locator('#activate-document')).toHaveValue('');
  });
});

test.describe('7.1 the evidence file', () => {
  test('shows empty and not_built as different answers, never as one count', async ({ page }) => {
    const seed = await signIn(page, 'e2e-operator-evidence@example.com');

    /**
     * The client id, asked for through the session the page already holds.
     *
     * The evidence block lives on the overview and takes an id; the client list is a different
     * view. Navigating there and back would mean leaving the overview, and on this base
     * `view-client` offers only "Back to clients" - so the journey would depend on a button that
     * is not there. Nothing in this spec writes to the client it reads.
     */
    const clientId = await page.evaluate(async (name) => {
      const response = await fetch('/api/console/clients?limit=50&offset=0', {
        credentials: 'same-origin',
      });
      const payload = await response.json();
      const match = payload.data.clients.find((entry) => entry.legalName === name);
      return match === undefined ? '' : match.id;
    }, seed.clientName);

    expect(String(clientId), 'the harness should have seeded a client to read').not.toBe('');

    await page.locator('#evidence-client').fill(String(clientId));
    await page.getByRole('button', { name: 'Assemble the file' }).click();

    await expect(page.locator('#evidence-summary')).toContainText('client scope');
    await expect(page.locator('#evidence-integrity')).toContainText('Ledger chain verified');

    // **THE ASSERTION.** The two zeroes are named separately, each with what it means.
    const summary = page.locator('#evidence-coverage-summary');
    await expect(summary).toContainText('empty (consulted; holds nothing for this client)');
    await expect(summary).toContainText('not built (the module does not exist yet');

    // And on every row: the verdict beside the count, never the count alone.
    await expect(page.locator('#evidence-coverage')).toContainText('not_built');
    await expect(page.locator('#evidence-coverage')).toContainText('this is not an empty section');
    await expect(page.locator('#evidence-coverage')).toContainText('item(s)');

    // The gaps a file exported now would carry.
    await expect(page.locator('#evidence-gaps-summary')).toContainText('could not contribute');

    // The evidence itself is not on the page, and the page says so.
    await expect(page.locator('#evidence-sections-note')).toContainText('coverage map travels');

    // The export control is absent and the reason is named, not left to be inferred.
    await expect(page.locator('#evidence-export-unavailable')).toContainText(
      'ACTION_MINIMUM_LEVEL',
    );
  });
});

test.describe('7.4 the claim library', () => {
  test('counts banned beside approved, and never as a problem', async ({ page }) => {
    await signIn(page, 'e2e-operator-claims@example.com');

    await page.getByRole('button', { name: 'Load the library' }).click();

    // Three peers in one sentence. There is no "problems" figure anywhere for a reader to find.
    const summary = page.locator('#marketing-claims-summary');
    await expect(summary).toContainText('approved,');
    await expect(summary).toContainText('banned,');
    await expect(summary).toContainText('requires a disclaimer');
    await expect(summary).not.toContainText('problem');
    await expect(summary).not.toContainText('error');

    // **THE ASSERTION.** Said on the page, not left to styling.
    await expect(page.locator('#marketing-banned-note')).toContainText('Board working');

    // Each entry says what the library DOES with it, rather than grading it.
    await expect(page.locator('#marketing-claims')).toContainText(
      'the Scanner blocks any message containing it',
    );

    // The proposal queue has three outcomes, not two.
    await expect(page.locator('#marketing-outcomes-note')).toContainText('approved as banned');
    await expect(page.locator('#marketing-decision-unavailable')).toContainText(
      'ACTION_MINIMUM_LEVEL',
    );

    // 4.5's assets, every state counted including the empty ones.
    await expect(page.locator('#marketing-assets-summary')).toContainText('draft,');
    await expect(page.locator('#marketing-assets-summary')).toContainText('rejected,');
  });
});
