/**
 * The five panels for the surfaces that had routes and none: 1.4, 7.3, 3.2, 11.11, 2.2.
 *
 * **What only a browser can check here is that a panel is wired at all.** The integrations view in
 * this same directory exported a render function nothing imported and no script tag loaded; it
 * rendered an empty box under a heading from the day it merged, on one of the two screens that gate
 * launch, and every server test passed the whole time. A view is reachable or it is not, and the
 * only thing that knows is a browser.
 *
 * So each spec below clicks the button and asserts the panel said something. Not what a happy path
 * would say - most of these have no seeded data - but that the wiring runs and the module's own
 * sentence arrives.
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

test.describe('the five rebuilt panels are wired', () => {
  test('1.4 says an unpublished ladder is not a free service', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[22]);

    await page.getByRole('button', { name: 'Load the published ladder' }).click();

    // The module's own sentence, carried to the page: `no_data` here means nobody has written a
    // price list, which is not the same as a service that costs nothing.
    await expect(page.locator('#billing-ladder-status')).toContainText(
      'price list nobody has written',
    );

    // The blocked list rides on `ok`, and the ladder answered `no_data` - a refusal carries no
    // payload, by design. So it is asserted where the route actually sends it.
    //
    // It is EMPTY now: `publish_offer` and `manage_engagement` were declared in Batch A, so 1.4 has
    // no write left that it cannot offer. This asserted 'none declared' when it had two.
    await page.locator('#billing-client-id').fill('00000000-0000-0000-0000-000000000001');
    await page.getByRole('button', { name: 'Load engagements' }).click();
    await expect(page.locator('#billing-blocked')).toHaveText('');
  });

  test('7.3 refuses a clause set with no jurisdiction', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[23]);

    // Left empty on purpose. "We could not tell which state" and "no state rule applies" are
    // different statements and only one of them is a check.
    await page.getByRole('button', { name: 'Load applicable clauses' }).click();

    await expect(page.locator('#contracts-clause-status')).toContainText('different question');
  });

  test('3.2 offers no download, and says that is a refusal', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[24]);

    // The standing rule, visible on the page rather than only in a route comment.
    await expect(page.locator('#section-vault')).toContainText('No document is downloadable here');

    await page.locator('#vault-client-id').fill('00000000-0000-0000-0000-000000000001');
    await page.getByRole('button', { name: 'Load documents' }).click();

    await expect(page.locator('#vault-blocked')).toContainText('separate process');
  });

  test('11.11 says an empty queue is an answer', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[25]);

    await page.getByRole('button', { name: 'Load the decision queue' }).click();

    // "Nothing needs you" and "this did not load" look identical when both render nothing.
    const status = page.locator('#workbench-status');
    await expect(status).not.toHaveText('');
  });

  test('2.2 names the missing list rather than faking one', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[26]);

    await expect(page.locator('#section-workflow')).toContainText('no tenant-scoped read');

    await page.locator('#workflow-instance-id').fill('00000000-0000-0000-0000-000000000002');
    await page.getByRole('button', { name: 'Load instance' }).click();

    // An instance in another tenant and no instance at all are the same answer, deliberately: a
    // caller must not learn that an id exists somewhere else.
    await expect(page.locator('#workflow-status')).toContainText('no_data');
  });
});

test.describe('the vendor activation board, which was never wired', () => {
  test('renders instead of leaving an empty box under a heading', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[27]);

    // THE ASSERTION THIS FILE EXISTS FOR. `views/integrations.js` exported a render function
    // nothing imported and no script tag loaded, so this div was empty from the day ADR-0065
    // merged - on the screen that records whether Plaid, the bureaus and the email provider have
    // cleared review. Every server test passed throughout.
    await page.getByRole('button', { name: 'Load the activation board' }).click();

    const board = page.locator('#integrations-board');
    await expect(board).not.toHaveText('');
    await expect(board).toContainText('plaid');
    // Read-only by design: no form, and the page says so where one would be.
    await expect(board).toContainText('not activated');
  });
});
