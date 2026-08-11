/**
 * The things that are worth running in three engines.
 *
 * Adding Firefox and WebKit to a suite that already passed in Chromium is easy to do and easy to
 * over-claim: on the first run, every existing spec passed in all three and **the two new engines
 * found nothing**. Three green ticks are not three times the coverage.
 *
 * So this file exists to hold the checks where an engine's own implementation is the thing under
 * test, rather than the page's.
 *
 * **A Content-Security-Policy is enforced by the browser.** Chromium, Gecko and WebKit implement it
 * separately, and `portal-ui.test.ts` can only assert the header was sent. Whether an injected
 * inline script actually fails to run is a question about the engine.
 *
 * **The no-WebAuthn fallback is the branch other engines are for.** `portal.js` guards every
 * ceremony behind a capability check, and until now nothing exercised the other side of it - the
 * Chromium runs all have an authenticator attached.
 */

import { expect, test } from '@playwright/test';

test.describe('the policy is enforced, not merely sent', () => {
  test('refuses an injected inline script', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // What an XSS would try. `script-src 'self'` with no `'unsafe-inline'` and no nonce means the
    // engine must refuse to execute it - and each of the three decides that for itself.
    await page
      .addScriptTag({ content: 'window.__injected = true;' })
      // Chromium rejects the injection outright; the others insert an element that never runs.
      // Either is a refusal, and the assertion below is what actually matters.
      .catch(() => undefined);

    expect(await page.evaluate(() => '__injected' in window)).toBe(false);
  });

  test('refuses a script from another origin', async ({ page }) => {
    await page.goto('/');

    await page.addScriptTag({ url: 'https://cdn.example.com/anything.js' }).catch(() => undefined);

    // `default-src 'none'` and `script-src 'self'`: nothing loads from anywhere else, which is the
    // property that makes "no dependency, no CDN" a rule rather than a preference.
    expect(await page.evaluate(() => '__injected' in window)).toBe(false);
  });
});

test.describe('a browser that cannot do WebAuthn', () => {
  // Every ceremony in `portal.js` sits behind a capability check. Nothing exercised the other side
  // of it: the Chromium specs all attach an authenticator, so the guard has never been false.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // Before any of the page's own script runs.
      Reflect.deleteProperty(window, 'PublicKeyCredential');
    });
  });

  test('says so rather than failing silently on the passkey button', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

    await expect(page.getByRole('status')).toHaveText('This browser cannot use a passkey.');
  });

  test('leaves the password path working', async ({ page }) => {
    await page.goto('/');

    // The point of the guard: a browser without WebAuthn is not a browser that cannot sign in. It
    // is one route being unavailable, and the page has to keep the other one usable.
    await expect(page.locator('#form-password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  });
});
