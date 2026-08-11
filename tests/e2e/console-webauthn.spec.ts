/**
 * A staff security key, registered and used in a real browser, and the password turned off.
 *
 * **The journey is the point.** The invariants test proves each rule; only this proves that a person
 * can actually get from "password and a code" to "phishing resistant" without a developer. The last
 * assertion in the third spec is the one the whole slice exists for: a CORRECT password, refused.
 *
 * The authenticator is a Chrome DevTools Protocol virtual one - resident credentials, user
 * verification, automatic presence. The browser really runs the ceremony and the server really
 * verifies the signature over the origin it was produced at.
 */

import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_PASSWORD,
  nextStepCode,
  openConsole,
  type ConsoleHandoff,
} from './fixture.js';

/**
 * Attach a virtual authenticator.
 *
 * `hasResidentKey` and `hasUserVerification` are not optional here the way they are for a client's
 * second factor: a staff key is registered `residentKey: 'required'` and `userVerification:
 * 'required'` or not at all, because it exists to replace the password rather than sit beside it.
 */
const attachAuthenticator = async (
  page: Page,
  // **Chromium allows exactly ONE `internal` authenticator per environment**, so the second key in
  // the turn-it-off spec is a roaming one - which is what a second key usually is in life anyway: a
  // phone and a USB key rather than two phones.
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

const handoff = async (): Promise<ConsoleHandoff> =>
  JSON.parse(await readFile(E2E_CONSOLE_HANDOFF, 'utf8')) as ConsoleHandoff;

/** Sign in with the password and a code - the path this slice is trying to make unnecessary. */
const signInWithPassword = async (page: Page, email: string): Promise<ConsoleHandoff> => {
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
 * Register a key from the security section.
 *
 * The password confirms it: a live session is not enough to add a key, because a key added from a
 * stolen session is one the thief holds and the owner never hears about (ADR-0024).
 */
const registerKey = async (page: Page, label: string): Promise<void> => {
  await page.locator('#key-label').fill(label);
  await page.locator('#security-password').fill(E2E_CONSOLE_PASSWORD);
  await page.getByRole('button', { name: 'Register a key' }).click();
  await expect(page.locator('#security-notice')).toContainText(`Registered: ${label}.`);
};

test.describe('a staff security key through a real browser', () => {
  /**
   * Chromium only, and said out loud rather than arranged silently.
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

  test('registers a key, and says the account is still not phishing resistant', async ({
    page,
  }) => {
    await attachAuthenticator(page);
    await signInWithPassword(page, 'e2e-operator-key-registers@example.com');

    await page.getByRole('button', { name: 'Load', exact: true }).click();

    // Before any key: the posture says what the account actually is.
    await expect(page.locator('#security-posture')).toContainText('Not phishing resistant');
    await expect(page.locator('#security-posture')).toContainText('a proxy can collect together');
    await expect(page.locator('#security-keys')).toContainText('No security key is registered');

    await registerKey(page, 'Browser key');

    await expect(page.locator('#security-keys')).toContainText('Browser key');
    await expect(page.locator('#security-summary')).toContainText('1 key(s) registered');
    await expect(page.locator('#security-summary')).toContainText('Password sign-in is ON');

    // **THE ASSERTION.** One key registered and the account is NOT phishing resistant, because a
    // password still signs it in and a proxy never asks for the key. A page that showed a key count
    // as a finished state would be telling this operator they hold a property they do not.
    await expect(page.locator('#security-posture')).toContainText('Not phishing resistant yet');
    await expect(page.locator('#security-posture')).toContainText(
      'never the thing a proxy asks for',
    );

    // And the switch is not offered yet: one key is one lost object away from no way in at all.
    await expect(page.locator('#section-disable-password')).toBeHidden();
    await expect(page.locator('#security-switch-state')).toContainText('1 more key(s) needed');
  });

  test('signs in with the key alone, with nothing typed', async ({ page }) => {
    await attachAuthenticator(page);
    await signInWithPassword(page, 'e2e-operator-key-signs-in@example.com');

    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await registerKey(page, 'Sign-in key');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // **No email, no password, no code.** The credential is discoverable, so the authenticator
    // offers it and the assertion says whose account it is.
    await page.getByRole('button', { name: 'Use a security key' }).click();

    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.locator('#who')).toContainText('Level 3');
  });

  test('turns the password off, and a correct password is then refused', async ({ page }) => {
    const cdp = await attachAuthenticator(page, 'internal');

    const email = 'e2e-operator-key-turns-off@example.com';
    const seed = await signInWithPassword(page, email);
    const secret = seed.secrets[email] ?? '';

    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await registerKey(page, 'Platform key');

    /**
     * The second authenticator is attached AFTER the first key exists, not alongside it.
     *
     * Chromium permits one `internal` authenticator, so the second is roaming - and attaching both
     * up front lets the browser pick either for the FIRST registration, after which
     * `excludeCredentials` names a credential the remaining one does not hold and the second
     * registration is declined. Registering in order is what makes each key land on its own
     * authenticator.
     */
    await attachAuthenticator(page, 'usb', cdp);
    await registerKey(page, 'Roaming key');

    await expect(page.locator('#security-summary')).toContainText('2 key(s) registered');
    await expect(page.locator('#security-switch-state')).toContainText('Ready');

    // The page states the cost before the click, rather than after it.
    await expect(page.locator('#section-disable-password')).toBeVisible();
    await expect(page.locator('#section-disable-password')).toContainText(
      'A correct password will be refused',
    );
    await expect(page.locator('#section-disable-password')).toContainText(
      'colleague at Authority Level 3',
    );

    await page.locator('#disable-password-submit').click();

    await expect(page.locator('#security-notice')).toContainText('Password sign-in is off');
    await expect(page.locator('#security-posture')).toContainText(
      'Phishing resistant: this account signs in with a security key only.',
    );
    await expect(page.locator('#security-summary')).toContainText('Password sign-in is OFF');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // **THE ASSERTION THE WHOLE SLICE EXISTS FOR.** A correct password and a correct code, refused
    // - and refused in the same sentence a wrong one gets, so nothing here tells an attacker which
    // addresses to stop phishing.
    const form = page.locator('#form-sign-in');
    await form.getByLabel('Email').fill(email);
    await form.getByLabel('Password').fill(E2E_CONSOLE_PASSWORD);
    await form.getByLabel('Authenticator code').fill(nextStepCode(secret, 2));
    await form.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('status')).toHaveText('Those details are not valid.');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeHidden();

    // The key still works, which is what makes the refusal a security property rather than a
    // lockout.
    await page.getByRole('button', { name: 'Use a security key' }).click();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  });
});
