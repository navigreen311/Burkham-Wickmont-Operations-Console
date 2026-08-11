/**
 * The internal Console, in a browser.
 *
 * **What only a browser can check here is that the page is unusable without signing in.** The
 * transport test proves each route refuses; this proves the thing a person actually meets - that
 * loading the Console gives them a sign-in form and nothing else, and that a real password and a
 * real code turn it into a work surface.
 *
 * The other half is the one this slice exists for: **`x-actor-id` no longer signs anybody in.** A
 * browser cannot send it, which is exactly the point - the header only ever helped somebody with a
 * shell. The assertion here is the visible consequence: the page shows the sign-in form until a
 * credential is presented.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  E2E_CONSOLE_ACCOUNTS,
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_ORIGIN,
  E2E_CONSOLE_PASSWORD,
  nextStepCode,
  openConsole,
  type ConsoleHandoff,
} from './fixture.js';

const handoff = async (): Promise<ConsoleHandoff> =>
  JSON.parse(await readFile(E2E_CONSOLE_HANDOFF, 'utf8')) as ConsoleHandoff;

/**
 * Sign in as the account this spec claims.
 *
 * Each spec names its own. A spent code cannot be presented twice, and a suite runs faster than
 * thirty seconds - see `E2E_CONSOLE_ACCOUNTS`.
 */
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

test.describe('the Console asks who you are', () => {
  test('shows a sign-in form and no work surface', async ({ page }) => {
    await openConsole(page);

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // Nothing behind it is rendered. The page holds the other views hidden, and every value on them
    // arrives from a route that checks the session anyway - but a person should not see the shape of
    // a client list before they have proved who they are.
    await expect(page.getByRole('heading', { name: 'Today' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeHidden();
  });

  test('asks for all three fields', async ({ page }) => {
    await openConsole(page);
    const form = page.locator('#form-sign-in');

    // A second factor is a precondition of a staff account, not a setting on it - so the code is
    // asked for on the same form rather than after a first step that has already succeeded.
    await expect(form.getByLabel('Email')).toBeVisible();
    await expect(form.getByLabel('Password')).toBeVisible();
    await expect(form.getByLabel('Authenticator code')).toBeVisible();
  });

  test('refuses a wrong code in the same words as anything else', async ({ page }) => {
    await openConsole(page);

    const form = page.locator('#form-sign-in');
    await form.getByLabel('Email').fill(E2E_CONSOLE_ACCOUNTS[5]);
    await form.getByLabel('Password').fill(E2E_CONSOLE_PASSWORD);
    await form.getByLabel('Authenticator code').fill('000000');
    await form.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('status')).toHaveText('Those details are not valid.');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});

test.describe('signed in', () => {
  test('opens on what needs a person today', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[0]);

    // The signed-in actor is named, with the level they hold. A console that did not say which
    // authority is in force is a console where somebody is surprised by a refusal.
    await expect(page.locator('#who')).toContainText('E2E operations lead');
    await expect(page.locator('#who')).toContainText('Level 3');

    await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your queue' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Correction obligations' })).toBeVisible();
  });

  test('names what nothing monitors rather than showing it as fine', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[1]);

    // ADR-0019, on the surface it was written about. The default rendering of "no data" is a green
    // tick, and the person reading this is deciding whether to go home.
    await expect(page.locator('#health-components')).toContainText('unmonitored');
  });

  test('lists clients and says what the list is a page of', async ({ page }) => {
    const seed = await signIn(page, E2E_CONSOLE_ACCOUNTS[2]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();

    await expect(page.locator('#clients-list')).toContainText(seed.clientName);
    await expect(page.locator('#clients-summary')).toContainText('of');
  });

  test('opens one client file assembled from the modules that own it', async ({ page }) => {
    const seed = await signIn(page, E2E_CONSOLE_ACCOUNTS[3]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await page.getByRole('button', { name: seed.clientName }).click();

    await expect(page.getByRole('heading', { name: seed.clientName })).toBeVisible();
    await expect(page.locator('#client-compliance')).toContainText('pending_assessment');
    await expect(page.locator('#client-firewall')).toContainText('Clear.');
    // Not listed, and the banner is absent rather than empty.
    await expect(page.locator('#client-do-not-fund')).toBeHidden();
    // 6.5 carries these on every timeline, including an empty one.
    await expect(page.locator('#client-risk-unproduced')).toContainText('Not produced by anything');
  });

  test('signing out ends the session, not just the view', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[4]);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // A reload after sign-out must not restore the surface: the cookie is cleared AND the session is
    // revoked, so `me` refuses.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeHidden();
  });
});

test.describe('the policy the Console page runs under', () => {
  test('refuses an injected inline script', async ({ page }) => {
    await openConsole(page);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page
      .addScriptTag({ content: 'window.__injected = true;' })
      // Chromium rejects the injection outright; the assertion below is what matters.
      .catch(() => undefined);

    expect(await page.evaluate(() => '__injected' in window)).toBe(false);
  });

  test('sends the strict policy on the API and the page policy on the page', async ({
    request,
  }) => {
    const api = await request.get(`${E2E_CONSOLE_ORIGIN}/api/health`);
    const apiPolicy = api.headers()['content-security-policy'] ?? '';
    expect(apiPolicy).toContain("default-src 'none'");
    // The relaxation the page needs must not reach a route that serves no document.
    expect(apiPolicy).not.toContain('script-src');

    const document = await request.get(`${E2E_CONSOLE_ORIGIN}/console/`);
    const pagePolicy = document.headers()['content-security-policy'] ?? '';
    expect(pagePolicy).toContain("script-src 'self'");
    expect(pagePolicy).not.toContain('unsafe-inline');
  });
});
