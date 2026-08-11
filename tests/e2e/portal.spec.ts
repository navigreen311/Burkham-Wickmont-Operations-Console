/**
 * The portal page, in a browser.
 *
 * Two things here cannot be checked from Node.
 *
 * **The Content-Security-Policy actually permits the page to run.** A policy is a header until a
 * browser enforces it; a header asserting `script-src 'self'` proves nothing about whether the
 * module loaded. If it did not, nothing on this page would work at all.
 *
 * **A value carrying markup arrives as text.** `portal-ui.test.ts` asserts the source never assigns
 * to a markup-writing property; only a browser can say whether the result is what that was for.
 */

import { expect, test } from '@playwright/test';
import { E2E_EMAIL, E2E_MESSAGE_WITH_MARKUP, E2E_PASSWORD, openPortal } from './fixture.js';

test.describe('the page runs', () => {
  test('loads its module under the policy and shows the sign-in view', async ({ page }) => {
    const violations: string[] = [];
    // A CSP refusal appears here and nowhere else. Without this listener a blocked script is a page
    // that quietly does nothing, and every assertion below would fail for the wrong reason.
    page.on('console', (message) => {
      if (message.type() === 'error') violations.push(message.text());
    });

    await openPortal(page);

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    // The button only does anything if `portal.js` was fetched, parsed and executed - which is the
    // policy being satisfied rather than merely being sent.
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();

    expect(violations.filter((text) => text.includes('Content Security Policy'))).toEqual([]);
  });

  test('signs in with a password and shows the room', async ({ page }) => {
    await openPortal(page);
    await page.locator('#form-password').getByLabel('Email').fill(E2E_EMAIL);
    await page.locator('#form-password').getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByRole('heading', { name: /Holdings LLC/u })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('says what it is withholding rather than omitting it', async ({ page }) => {
    await openPortal(page);
    await page.locator('#form-password').getByLabel('Email').fill(E2E_EMAIL);
    await page.locator('#form-password').getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Holdings LLC/u })).toBeVisible();

    // 11.10 carries what it withheld and why; a room that silently omitted would assert there was
    // nothing there. The section exists on the page whether or not anything is in it.
    await expect(page.getByRole('heading', { name: 'Not shown here' })).toBeVisible();
    await expect(page.locator('#room-withheld li').first()).toBeVisible();
  });

  test('refuses a wrong password with the sentence the server chose', async ({ page }) => {
    await openPortal(page);
    await page.locator('#form-password').getByLabel('Email').fill(E2E_EMAIL);
    await page
      .locator('#form-password')
      .getByLabel('Password', { exact: true })
      .fill('not-the-password-at-all');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // Not reworded on the way to the screen. The refusal is deliberately identical for a wrong
    // password, an unknown address, an unenrolled user and a disabled one, and a page that
    // helpfully distinguished them would undo that.
    await expect(page.getByRole('status')).toHaveText('Those sign-in details are not correct.');
  });
});

test.describe('nothing reaches the DOM as markup', () => {
  test('renders a message body carrying a tag as text', async ({ page }) => {
    await openPortal(page);
    await page.locator('#form-password').getByLabel('Email').fill(E2E_EMAIL);
    await page.locator('#form-password').getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Holdings LLC/u })).toBeVisible();

    await page.locator('#form-message').getByLabel('Subject').fill(E2E_MESSAGE_WITH_MARKUP);
    await page.locator('#form-message').getByLabel('Message').fill(E2E_MESSAGE_WITH_MARKUP);
    await page.getByRole('button', { name: 'Send' }).click();

    // The status line is the one place a server-supplied string is displayed on this path.
    await expect(page.getByRole('status')).toBeVisible();

    // THE ASSERTION. If anything on this page ever assigned to a markup-writing property, this
    // string would have become an element and its handler would have run.
    expect(await page.locator('img').count()).toBe(0);
    expect(await page.title()).not.toBe('xss');
  });
});

test.describe('the password reset path', () => {
  test('says the same thing for an address that exists and one that does not', async ({ page }) => {
    await openPortal(page);
    await page.getByText('Forgotten your password?').click();

    const answers: string[] = [];
    for (const address of [E2E_EMAIL, 'nobody-at-all@example.com']) {
      await page.locator('#reset-email').fill(address);
      await page.getByRole('button', { name: 'Send a reset link' }).click();
      await expect(page.getByRole('status')).toBeVisible();
      answers.push((await page.getByRole('status').textContent()) ?? '');
    }

    // The server answers identically for every address; showing anything else here would undo the
    // property on the way to the screen, which is the one place a UI can quietly break a server's
    // guarantee.
    expect(answers[0]).toBe(answers[1]);
  });
});
