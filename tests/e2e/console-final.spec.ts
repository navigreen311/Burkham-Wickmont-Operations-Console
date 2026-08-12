/**
 * The last five module panels, in a browser: 11.7, 3.1, 3.3, 10.1, 11.6.
 *
 * **What only a browser can check is that an invariant has no control beside it.**
 *
 * The transport test proves the route sends invariants in their own shape and the source test
 * proves the view constructs no input. Neither proves what a person actually meets, which is a list
 * of fixed settings with their reasons and nothing to type into. That is asserted here by counting
 * the controls inside the panel: an invariant that grew an input would be found by a query for one,
 * whatever the code that produced it looked like.
 *
 * The other assertions are the refusals that have to survive to the screen - the warehouse saying
 * it has no notion of "now", and the inter-venture panel saying an acknowledgement cannot be
 * recorded here.
 *
 * One sign-in for the file, on a shared page: a TOTP code is spent when accepted, and eleven
 * sign-ins inside a suite that runs in seconds is the replay guard doing its job.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_PASSWORD,
  nextStepCode,
  openConsole,
  type ConsoleHandoff,
} from './fixture.js';

const ACCOUNT = 'e2e-operator-final@example.com';

test.describe.configure({ mode: 'serial' });

let page: Page;
let seed: ConsoleHandoff;

test.beforeAll(async ({ browser }) => {
  seed = JSON.parse(await readFile(E2E_CONSOLE_HANDOFF, 'utf8')) as ConsoleHandoff;
  const secret = seed.secrets[ACCOUNT];
  if (secret === undefined) throw new Error(`the harness seeded no account for ${ACCOUNT}`);

  page = await browser.newPage();
  await openConsole(page);

  const form = page.locator('#form-sign-in');
  await form.getByLabel('Email').fill(ACCOUNT);
  await form.getByLabel('Password').fill(E2E_CONSOLE_PASSWORD);
  await form.getByLabel('Authenticator code').fill(nextStepCode(secret));
  await form.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});

test.afterAll(async () => {
  await page.close();
});

const PANELS = ['admin', 'warehouse', 'interventure', 'intelligence', 'deliverables'];

/** Open one panel and close the others, so one test's panel is not visible to the next. */
const openPanel = async (id: string): Promise<void> => {
  for (const other of PANELS) {
    const panel = page.locator(`#panel-${other}`);
    if (`panel-${other}` !== id && (await panel.getAttribute('open')) !== null) {
      await panel.locator('> summary').click();
    }
  }
  const target = page.locator(`#${id}`);
  if ((await target.getAttribute('open')) === null) {
    await target.locator('> summary').click();
  }
  await expect(target).toHaveAttribute('open', '');
};

test.describe('11.7 on the page', () => {
  test('shows an invariant as fixed, with the reason, and nothing to type into', async () => {
    await openPanel('panel-admin');

    const invariants = page.locator('#admin-invariants');
    await expect(invariants.locator('li').first()).toBeVisible();

    // Fixed, in words. Not greyed out, not disabled - absent.
    await expect(invariants).toContainText('FIXED');
    // The reason, which is what stops somebody looking for a workaround.
    await expect(invariants).toContainText('TCPA');
    await expect(invariants).toContainText('no authority level');

    // **The assertion only a browser can make.** Whatever produced this list, there is no control
    // in it. An input, a select or a button inside the invariants list would be found here.
    await expect(invariants.locator('input')).toHaveCount(0);
    await expect(invariants.locator('select')).toHaveCount(0);
    await expect(invariants.locator('button')).toHaveCount(0);
    await expect(invariants.locator('textarea')).toHaveCount(0);
  });

  test('separates what is configurable from what is fixed, and totals both', async () => {
    await openPanel('panel-admin');

    // Parameters carry a range and its reasoning; invariants carry neither.
    await expect(page.locator('#admin-parameters')).toContainText('Range');
    await expect(page.locator('#admin-invariants')).not.toContainText('Range');

    await expect(page.locator('#admin-status')).toContainText('configurable');
    await expect(page.locator('#admin-status')).toContainText('fixed and not configurable');
  });

  test('shows a staged change apart from the value in force', async () => {
    await openPanel('panel-admin');
    // Nothing is staged in the seeded tenant, and the panel says so rather than showing a blank.
    await expect(page.locator('#admin-staged')).toContainText('No change is staged');
  });

  test('no longer lists the parameter change as blocked, and still hides no invariant', async () => {
    await openPanel('panel-admin');

    // `change_system_parameter` is declared, so this is not a write the surface cannot offer.
    await expect(page.locator('#admin-blocked')).not.toContainText('Change a parameter');

    // The rule that has not moved: an invariant is ABSENT, not permission-gated. It is counted and
    // rendered as its own collection - "fixed and not configurable" - never as a parameter row
    // wearing a false flag.
    await expect(page.locator('#panel-admin')).toContainText('fixed and not configurable');
  });
});

test.describe('11.6 on the page', () => {
  test('will not fetch without a period, and says it has no notion of now', async () => {
    await openPanel('panel-warehouse');

    await page.locator('#warehouse-load').click();
    await expect(page.locator('#warehouse-status')).toContainText('no notion of "now"');
  });

  test('reports an empty period as an absence of captures, not as zero', async () => {
    await openPanel('panel-warehouse');

    await page.locator('#warehouse-from').fill('2020-01-01');
    await page.locator('#warehouse-to').fill('2020-02-01');
    await page.locator('#warehouse-load').click();

    const status = page.locator('#warehouse-status');
    await expect(status).toContainText('no_data');
    // The sentence that stops somebody rendering a flat line.
    await expect(status).toContainText('not a period in which nothing happened');
    await expect(page.locator('#warehouse-snapshots')).not.toContainText('0 client');
  });

  test('lists cohorts and names the missing ETL', async () => {
    await openPanel('panel-warehouse');

    await page.locator('#warehouse-cohort').fill('');
    await page.locator('#warehouse-cohort-load').click();

    await expect(page.locator('#warehouse-cohorts')).toContainText(
      'No cohort exists, because no snapshot has been captured',
    );
  });
});

test.describe('10.1 on the page', () => {
  test('offers no acknowledgement control, and says why it never will', async () => {
    await openPanel('panel-interventure');

    // The distinction the panel exists to make: one blocked write is waiting on a decision, the
    // other on a counterparty who is not us.
    const blocked = page.locator('#interventure-blocked');
    await expect(blocked).toContainText('Acknowledge a conflict disclosure');
    await expect(blocked).toContainText('unblocked by nothing on this surface');
    await expect(blocked).toContainText('NOT us');

    // No control anywhere in the panel that could record one.
    await expect(page.getByRole('button', { name: /acknowledge/i })).toHaveCount(0);
  });

  test('lists relationships with a total', async () => {
    await openPanel('panel-interventure');
    await expect(page.locator('#interventure-status')).toContainText('tagged relationship(s)');
    await expect(page.locator('#interventure-ventures').locator('li').first()).toBeVisible();
  });
});

test.describe('3.3 and 3.1 on the page', () => {
  test('renders a finding panel that asks for a phase before answering', async () => {
    await openPanel('panel-intelligence');

    await page.locator('#intelligence-client-id').fill('');
    await page.locator('#intelligence-load').click();
    await expect(page.locator('#intelligence-status')).toContainText('Enter a client id');
  });

  test('lists the template library and the deliverable write it cannot offer', async () => {
    await openPanel('panel-deliverables');

    await expect(page.locator('#deliverables-status')).toContainText('shipped template(s)');
    await expect(page.locator('#deliverables-templates').locator('li').first()).toBeVisible();
    await expect(page.locator('#deliverables-blocked')).toContainText('approve');
  });
});
