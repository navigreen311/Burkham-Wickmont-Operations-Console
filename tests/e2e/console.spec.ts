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
  E2E_CONSOLE_CLIENTS,
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_ORIGIN,
  E2E_CONSOLE_PASSWORD,
  E2E_INVITEE_EMAIL,
  E2E_INVITEE_PASSWORD,
  E2E_PLACEMENT_REF,
  currentStepCode,
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

test.describe('writing from the page', () => {
  test('records a compliance determination and shows what the chain did', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[6]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    // Its own file: this spec changes one permanently.
    await page.getByRole('button', { name: E2E_CONSOLE_CLIENTS[1] }).click();

    const form = page.locator('#form-compliance');

    // The dropdown starts on the state the client is already in, so nobody reads the first option
    // as the current value.
    await expect(page.locator('#compliance-to')).toHaveValue('pending_assessment');

    // The consequence is on the page before the click, and the button says what it will do.
    await page.locator('#compliance-to').selectOption('needs_review');
    await expect(page.locator('#compliance-consequence')).toContainText('FREEZES placement');
    await expect(page.locator('#compliance-submit')).toHaveText('Record: needs_review');

    await page.locator('#compliance-to').selectOption('pass');
    await form.getByLabel('Reason').fill('assessed and clear');
    await page.locator('#compliance-submit').click();

    await expect(page.getByRole('status')).toHaveText('Compliance state recorded: pass.');
    await expect(page.locator('#client-compliance')).toContainText('pass');

    // The trace is shown on a success too. A page that only explained failures would leave an
    // operator unable to see which checks their action actually passed.
    await expect(page.locator('#trace-list')).toContainText('authority_level: passed');
    await expect(page.locator('#trace-list')).toContainText('firewall: skipped');
  });

  test('triggers the Firewall and the file says so', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[7]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await page.getByRole('button', { name: E2E_CONSOLE_CLIENTS[2] }).click();

    await page.locator('#form-firewall').getByLabel('Reason').fill('a conflict was reported');
    await page.locator('#firewall-submit').click();

    await expect(page.getByRole('status')).toContainText('Placement is frozen');
    await expect(page.locator('#client-firewall')).toContainText('a conflict was reported');
  });

  test('opens a new file from the clients view', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[8]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await page.locator('#new-client-name').fill('Opened From The Page LLC');
    await page.getByRole('button', { name: 'Open file' }).click();

    await expect(page.getByRole('status')).toContainText('Opened From The Page LLC');
    await expect(page.locator('#clients-list')).toContainText('Opened From The Page LLC');
  });
});

test.describe('an operator who may not write', () => {
  test('is offered no write, and is refused one anyway', async ({ page, request }) => {
    const seed = await signIn(page, E2E_CONSOLE_ACCOUNTS[9]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    // Level 0 cannot open a file either.
    await expect(page.locator('#section-new-client')).toBeHidden();

    await page.getByRole('button', { name: seed.clientName }).click();
    await expect(page.locator('#section-compliance')).toBeHidden();
    await expect(page.locator('#section-firewall-trigger')).toBeHidden();
    await expect(page.locator('#section-consent')).toBeHidden();

    // **And the hiding is not the control.** The same account, posting the same write directly,
    // is refused by the chain - which is the assertion that would still hold if somebody deleted
    // every `hidden` attribute on the page.
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === 'bwc_console_session');
    expect(session).toBeDefined();

    const reply = await request.post(`${E2E_CONSOLE_ORIGIN}/api/clients`, {
      headers: { cookie: `bwc_console_session=${session?.value ?? ''}` },
      data: { legalName: 'Should Not Exist LLC' },
    });
    const payload = (await reply.json()) as { status: string; reason?: string };
    expect(payload.status).toBe('refused');
    expect(payload.reason).toMatch(/Authority Level/);
  });
});

test.describe('asking for a placement from the page', () => {
  /**
   * The ordinary outcome, and the one an operator meets first.
   *
   * A client nobody has assessed is refused at the chain's gate. The page has to make that legible
   * rather than look broken - which means the reason AND the step that produced it.
   */
  test('shows the refusal and the step that produced it', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[10]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await page.getByRole('button', { name: E2E_CONSOLE_CLIENTS[0] }).click();

    const form = page.locator('#form-placement');
    await form.getByLabel('Application reference').fill('APP-NOT-AUTHORISED');
    await page.locator('#placement-need').selectOption('working_capital');
    await form.getByLabel('Amount sought (whole dollars)').fill('100000');
    await form.getByRole('button', { name: 'Request' }).click();

    // Refused at step 4 - the client has never been assessed - and NOT for the missing consent,
    // which is a check that should not have been reached.
    await expect(page.locator('#placement-summary')).toContainText('Compliance state');
    await expect(page.locator('#trace-list')).toContainText('firewall: blocked');
  });

  test('renders a recommendation with its rejections and disclosures', async ({ page }) => {
    await signIn(page, E2E_CONSOLE_ACCOUNTS[11]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await page.getByRole('button', { name: E2E_CONSOLE_CLIENTS[3] }).click();

    const form = page.locator('#form-placement');
    await form.getByLabel('Application reference').fill(E2E_PLACEMENT_REF);
    await page.locator('#placement-need').selectOption('working_capital');
    await form.getByLabel('Amount sought (whole dollars)').fill('100000');
    await form.getByRole('button', { name: 'Request' }).click();

    await expect(page.getByRole('status')).toHaveText('Recommendation ready.');
    await expect(page.locator('#placement-recommendations')).toContainText(
      'Meridian National Bank',
    );
    // The disclosures the Governance Board attached travel with the recommendation, because a memo
    // that dropped them is the memo that gets sent.
    await expect(page.locator('#placement-recommendations')).toContainText('is not a lender');
  });

  test('offers only the purposes the system recognises, and starts on none of them', async ({
    page,
  }) => {
    // Its own account: a spent TOTP code cannot be presented twice, so no two specs share one.
    await signIn(page, E2E_CONSOLE_ACCOUNTS[12]);

    await page.getByRole('button', { name: 'Clients', exact: true }).first().click();
    await page.getByRole('button', { name: E2E_CONSOLE_CLIENTS[3] }).click();

    // Served by the API rather than written into the page, so the list cannot drift from the one
    // the server will accept.
    const options = await page.locator('#placement-need option').allTextContents();
    expect(options).toContain('equipment_purchase');
    // Left on the empty choice: suitability is assessed against this, so a default would be a
    // confident recommendation for a purpose nobody stated.
    await expect(page.locator('#placement-need')).toHaveValue('');
  });
});

test.describe('taking up an invitation', () => {
  /**
   * The whole journey in one browser: a Level 3 operator issues a code, and somebody who has no
   * credential at all turns it into one and signs in.
   *
   * **What this spec is really asserting is what the granter never sees.** The invite banner
   * carries a code; the password and the authenticator secret are chosen and shown on the other
   * side of the sign-out, in a view that has no session behind it.
   */
  test('invite, enrol, confirm, sign in', async ({ page }) => {
    const seed = await signIn(page, E2E_CONSOLE_ACCOUNTS[13]);

    await page.locator('#invite-actor').fill(seed.inviteeActorId);
    await page.locator('#invite-email').fill(E2E_INVITEE_EMAIL);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();

    await expect(page.getByRole('status')).toHaveText('Invitation issued.');
    const banner = await page.locator('#invite-result').textContent();
    expect(banner).toContain(E2E_INVITEE_EMAIL);
    // The granter is told, on the page, that whoever holds this can spend it.
    expect(banner).toContain('Anyone holding it can spend it');

    const code = (banner ?? '').split(': ').pop()?.split(' —')[0]?.trim() ?? '';
    expect(code.length).toBeGreaterThan(20);

    // Out of the session entirely: the invitee is not this operator.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Take up your invitation' }).click();

    await page.locator('#enrol-token').fill(code);
    await page.locator('#enrol-password').fill(E2E_INVITEE_PASSWORD);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Shown once, and only here. Nobody who issued the invitation has seen this.
    await expect(page.locator('#section-authenticator')).toBeVisible();
    const secret = (await page.locator('#enrol-secret').textContent()) ?? '';
    expect(secret.length).toBeGreaterThan(20);

    // The spent code is cleared from the field: a spent code left on screen looks like one that
    // still works.
    await expect(page.locator('#enrol-token')).toHaveValue('');

    // The CURRENT step: this factor has never been used, so nothing is spent yet - and spending
    // the current one leaves the next free for the sign-in immediately below.
    await page.locator('#enrol-code').fill(currentStepCode(secret));
    await page.getByRole('button', { name: 'Finish' }).click();

    await expect(page.getByRole('status')).toHaveText(
      'Enrolment complete. Sign in with your password and a code.',
    );
    // The secret is off the screen once it is confirmed. It is not recoverable, and it should not
    // sit on a monitor in an office.
    await expect(page.locator('#enrol-secret')).toHaveText('');

    const form = page.locator('#form-sign-in');
    await form.getByLabel('Email').fill(E2E_INVITEE_EMAIL);
    await form.getByLabel('Password').fill(E2E_INVITEE_PASSWORD);
    await form.getByLabel('Authenticator code').fill(nextStepCode(secret));
    await form.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.locator('#who')).toContainText('E2E invitee');
    await expect(page.locator('#who')).toContainText('Level 2');

    // Level 2 cannot invite anybody else. The section is not offered - and the module refuses
    // regardless, which `console-transport.test.ts` asserts directly.
    await expect(page.locator('#section-invite')).toBeHidden();
  });
});
