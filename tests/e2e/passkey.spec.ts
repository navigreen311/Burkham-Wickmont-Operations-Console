/**
 * A passkey, registered and used in a real browser.
 *
 * **This is the file that justifies a browser runner.** Everything else here could be checked from
 * Node; this could not. `navigator.credentials` is the only thing that produces a WebAuthn
 * credential, and until now nothing in this repository could call it - five slices of server-side
 * work (#31 to #35) had no client that could exercise them end to end.
 *
 * The authenticator is a Chrome DevTools Protocol virtual one: resident credentials, user
 * verification, automatic presence. It is not a stub of the browser's API - the browser really runs
 * the ceremony, and the server really verifies the signature.
 */

import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { E2E_MUTABLE_ACCOUNTS, E2E_PASSWORD, openPortal } from './fixture.js';

/**
 * Attach a virtual authenticator to a page.
 *
 * `hasResidentKey` and `hasUserVerification` are what a **first factor** requires: a credential the
 * authenticator can offer without being told the account, asserted with the user verified. A
 * platform authenticator without them is a second factor, and the server refuses it as one
 * (ADR-0029).
 */
const attachAuthenticator = async (
  page: Page,
  // Chrome allows only ONE `internal` authenticator per environment, so a client's second key is a
  // roaming one - which is what a second key usually is anyway: a phone and a USB key rather than
  // two phones.
  transport: 'internal' | 'usb' = 'internal',
  cdp?: CDPSession,
): Promise<CDPSession> => {
  const session = cdp ?? (await page.context().newCDPSession(page));
  if (cdp === undefined) await session.send('WebAuthn.enable');

  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  return session;
};

const signInWithPassword = async (page: Page, email: string): Promise<void> => {
  await openPortal(page);
  await page.locator('#form-password').getByLabel('Email').fill(email);
  await page.locator('#form-password').getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Holdings LLC/u })).toBeVisible();
};

const registerPasskey = async (page: Page, label: string): Promise<void> => {
  await page.getByRole('button', { name: 'Security settings' }).click();
  await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();

  await page.locator('#form-register-key').getByLabel('Name for this key').fill(label);
  await page.locator('#form-register-key').getByLabel('Your password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Register a key' }).click();

  await expect(page.getByRole('status')).toHaveText('Key registered.');
  await expect(page.getByRole('listitem').filter({ hasText: label })).toBeVisible();
};

test.describe('a passkey through a real browser', () => {
  /**
   * Chromium only, and **said out loud rather than arranged silently.**
   *
   * The virtual authenticator is a Chrome DevTools Protocol feature; Firefox and WebKit have no
   * equivalent, so there is no way to hold a credential in them. A file that simply lived in a
   * chromium-only project would report nothing on the other two, and a reader counting green ticks
   * would conclude the coverage was three times what it is.
   */
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'the virtual authenticator is a Chrome DevTools Protocol feature; Firefox and WebKit have no equivalent',
  );

  test('registers, and the account then reports it', async ({ page }) => {
    await attachAuthenticator(page);
    await signInWithPassword(page, E2E_MUTABLE_ACCOUNTS[0]);
    await registerPasskey(page, 'E2E phone');

    // THE ASSERTION THIS FILE EXISTS FOR. The browser produced a real attestation object, the server
    // parsed the CBOR, verified the origin against its configuration, and stored a public key -
    // every step of which was written blind before this test existed.
    await expect(page.locator('#settings-summary')).toContainText('1 passkey(s) registered');
  });

  test('signs in with nothing but the passkey', async ({ page }) => {
    await attachAuthenticator(page);
    await signInWithPassword(page, E2E_MUTABLE_ACCOUNTS[1]);
    await registerPasskey(page, 'E2E phone for sign-in');

    // **One key, deliberately.** An earlier draft registered a second here, copied from the test
    // below that needs two - and a passwordless sign-in offers no `allowCredentials` at all, so two
    // resident credentials for one account leave the authenticator to choose between them. That
    // passed locally and timed out on a CI runner. This test needs exactly one key, so it has one.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // No email typed, no password, no second step. The authenticator names the account itself.
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: /Holdings LLC/u })).toBeVisible();
  });

  test('turns the password off, and then refuses it', async ({ page }) => {
    const cdp = await attachAuthenticator(page);
    await signInWithPassword(page, E2E_MUTABLE_ACCOUNTS[2]);
    await registerPasskey(page, 'E2E key one');

    await attachAuthenticator(page, 'usb', cdp);
    await page.locator('#form-register-key').getByLabel('Name for this key').fill('E2E key two');
    await page.locator('#form-register-key').getByLabel('Your password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Register a key' }).click();
    await expect(page.getByRole('status')).toHaveText('Key registered.');

    await page.locator('#disable-password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Turn password sign-in off' }).click();
    await expect(page.getByRole('status')).toHaveText('Password sign-in is off.');

    await page.getByRole('button', { name: 'Sign out' }).click();

    // THE ASSERTION. A passkey beside a live password is a convenience; the security property is
    // that the phishable path stops working - and it stops working with the same sentence a wrong
    // password gets, so the page cannot tell an attacker which accounts to stop guessing at.
    await page.locator('#form-password').getByLabel('Email').fill(E2E_MUTABLE_ACCOUNTS[2]);
    await page.locator('#form-password').getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Those sign-in details are not correct.');

    // The key still works.
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: /Holdings LLC/u })).toBeVisible();
  });
});
