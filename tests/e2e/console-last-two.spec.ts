/**
 * The last two panels, in a browser: 5.5 Funding Outcome Ledger and 7.5 Legal Hold & Retention.
 *
 * Each asserts the one thing its module exists to get right, rendered rather than merely returned:
 *
 *   5.5 shows the counts and **withholds the rate**, with the sentence saying what would produce
 *       one. A page that printed `0%` here would undo the module.
 *   7.5 says an overdue hold **keeps holding**. Records destroyed because a date passed is the
 *       failure ADR-0013 points away from.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  E2E_CONSOLE_ACCOUNTS,
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_PASSWORD,
  nextStepCode,
  openConsole,
  type ConsoleHandoff,
} from './fixture.js';

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

test.describe('5.5 on the page', () => {
  test('shows the counts and withholds the rate, never a zero', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[28]);

    await page.locator('#outcomes-from').fill('2026-01-01');
    await page.locator('#outcomes-to').fill('2027-01-01');
    await page.getByRole('button', { name: 'Load the approval rate' }).click();

    // The counts are measurements and are real whether or not a rate exists.
    await expect(page.locator('#outcomes-counts')).toContainText('decided 0 (the denominator)');

    // THE ASSERTION THIS PANEL EXISTS FOR. The module's sentence, not a percentage - and
    // emphatically not "0%", which is a claim nobody made.
    const status = page.locator('#outcomes-rate-status');
    await expect(status).toContainText('are needed before a rate means anything');
    await expect(status).not.toContainText('0.0%');
  });

  test('requires a period rather than defaulting to "recently"', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[29]);

    // Both dates left empty. A rate over an unstated window is a figure nobody can check.
    await page.getByRole('button', { name: 'Load the approval rate' }).click();
    await expect(page.locator('#outcomes-rate-status')).toContainText('Give both dates');
  });
});

test.describe('7.5 on the page', () => {
  test('says an overdue hold keeps holding', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[30]);

    // The rule is on the panel itself, not only in a route comment: an operator reading this
    // screen should not have to infer that a lapsed review does not release records.
    await expect(page.locator('#section-retention')).toContainText(
      'An overdue review does not release a hold',
    );

    await page.getByRole('button', { name: 'Load holds in force' }).click();

    // No hold seeded in the browser harness, and that is stated rather than left blank.
    await expect(page.locator('#retention-holds-status')).toContainText('retention schedule alone');
  });

  test('names the authority an irreversible act needs, where a button would be', async ({
    page,
  }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[31]);

    await page.getByRole('button', { name: 'Load undecided deletion requests' }).click();

    // Deleting a client's records is the most consequential control in this Console. It has no
    // button, and the panel says why rather than leaving an absence to be read as an oversight.
    await expect(page.locator('#retention-blocked')).toContainText('irreversible');
  });
});
