/**
 * The five module panels, in a browser: 5.1/5.6, 9.1/9.2, 1.2, 1.3, 8.1/8.3.
 *
 * **What only a browser can check here is that a refusal survives all the way to the screen.**
 *
 * The transport test proves each route sends a null metric with its reason, an absent
 * `countsByStage`, and a stack refusal naming Decision A. None of that is worth anything if the
 * page then renders a blank, a dash or a zero - and every one of those is what a rendering layer
 * produces by default. So the assertions here are on visible text, and specifically on the text a
 * careless renderer would have replaced:
 *
 *   "not measured"        where a `?? 0` would have put a nought
 *   the module's note     where a `—` would have said nothing
 *   the refusal sentence  where a hidden row would have said nothing at all
 *
 * The cohort suppression is asserted in the transport test rather than here: the Console harness
 * seeds clients and staff accounts and no partners, and this spec does not own the harness. What it
 * asserts instead is the honest-empty-state that fact produces - "No partner is registered" beside
 * the reason nothing on this Console can register one.
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

const ACCOUNT = 'e2e-operator-modules@example.com';

/**
 * One sign-in for the whole file, on a page these tests share.
 *
 * **Not an optimisation - the alternative does not work.** A TOTP code is spent when it is
 * accepted, and a code at or below the last accepted step is refused as a replay. Eleven tests
 * each signing in would need eleven accounts or eleven half-minutes; the first draft of this file
 * used one account per test and every test after the first failed at the sign-in, which is the
 * guard doing its job.
 *
 * `serial` because they share the page, and because a shared session is what an operator actually
 * has: these panels are reads, and reading one does not disturb another.
 */
test.describe.configure({ mode: 'serial' });

let page: Page;
let seed: ConsoleHandoff;

const handoff = async (): Promise<ConsoleHandoff> =>
  JSON.parse(await readFile(E2E_CONSOLE_HANDOFF, 'utf8')) as ConsoleHandoff;

test.beforeAll(async ({ browser }) => {
  seed = await handoff();
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

/**
 * Open one disclosure panel, and close the others.
 *
 * Native `details`, so no view switching is involved and console.js is not consulted. Closing the
 * rest keeps one test's panel from being visible to the next assertion in a shared page.
 */
const openPanel = async (id: string): Promise<void> => {
  for (const other of ['dashboards', 'capital', 'graph', 'sales', 'partners']) {
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

test.describe('9.1 and 9.2 on the page', () => {
  test('renders a withheld metric as words and its reason, never as a zero', async () => {
    await openPanel('panel-dashboards');

    const metrics = page.locator('#dash-executive-list');
    await expect(metrics.getByText('Placement approval rate', { exact: false })).toBeVisible();

    // **The assertion this spec exists for.** The metric is refused, so the page must say so in
    // words. A `?? 0` upstream would put "0" here and the test would fail on the missing phrase.
    const row = metrics.locator('li', { hasText: 'Placement approval rate' });
    await expect(row).toContainText('not measured');
    // The module's own sentence, carried intact - it is what tells an operator why. It said
    // "100% forever" until 5.5 gave 9.1 a denominator; it now says how many decided attempts would
    // make the figure appear, which is the same discipline pointing at a reachable answer.
    await expect(row).toContainText('10 are needed');

    // And it appears in the withheld list too, so a reader scanning for gaps finds it.
    await expect(page.locator('#dash-executive-withheld')).toContainText('Placement approval rate');
  });

  test('renders the compliance distribution state by state, including states at zero', async () => {
    await openPanel('panel-dashboards');

    const counts = page.locator('#dash-compliance-counts');
    // Every state written out. A missing row reads as no problem, which is the failure 9.1's
    // distribution replaced an average to avoid.
    for (const state of ['pass', 'pass_with_findings', 'needs_review', 'fail']) {
      await expect(counts).toContainText(state);
    }
  });

  test('renders gross margin and projected LTV as refusals with their reasons', async () => {
    await openPanel('panel-dashboards');

    const refused = page.locator('#dash-economics-refused');
    await expect(refused).toContainText('Gross margin');
    await expect(refused).toContainText('refused');
    // Not a zero, not a dash, not an absence: the sentence that explains the gap.
    await expect(refused).toContainText('vendor costs');

    await expect(refused).toContainText('Projected lifetime value');

    // The COGS lines that make the margin unmeasurable, each with its gate.
    await expect(page.locator('#dash-economics-costs')).toContainText('Plaid');
  });

  test('names the domains 9.1 asks for that nothing produces', async () => {
    await openPanel('panel-dashboards');
    await expect(page.locator('#dash-executive-unproduced')).toContainText('forecast accuracy');
  });
});

test.describe('5.1 and 5.6 on the page', () => {
  test('says there is no stack rather than showing an empty one', async () => {
    await openPanel('panel-capital');

    await page.locator('#capital-client-id').fill('00000000-0000-4000-8000-000000000000');
    await page.locator('#capital-check-stack').click();

    const refusal = page.locator('#capital-stack-refusal');
    await expect(refusal).toContainText('Plaid');
    // The sentence that stops somebody "fixing" this with an empty array.
    await expect(refusal).toContainText('this client has no debt');
  });

  test('models a stated stack and says on the page that the figures were stated', async () => {
    await openPanel('panel-capital');

    await page.locator('#capital-stack-json').fill(
      JSON.stringify([
        {
          provider: 'E2E Bank',
          label: 'Working capital card',
          kind: 'credit_card',
          creditLimit: 50000,
          outstandingBalance: 30000,
          annualRate: 0.219,
          factorRate: null,
          cadence: 'monthly',
          paymentPerPeriod: 1200,
          asOf: '2026-08-01',
          personalGuarantee: { ownerName: 'Jane Q Owner', limitAmount: null },
        },
      ]),
    );
    await page.locator('#capital-model').click();

    await expect(page.locator('#capital-status')).toContainText('Modelled 1 position');

    // Provenance on output, on the screen. Without this the page is a calculator whose answers
    // look like a feed's.
    await expect(page.locator('#capital-basis')).toContainText('stated by the operator');
    await expect(page.locator('#capital-asof')).toContainText('2026-08-01');

    // The health score never appears without its components.
    await expect(page.locator('#capital-health-score')).toContainText('Stack health');
    await expect(page.locator('#capital-health-components').locator('li').first()).toBeVisible();

    // An unlimited guarantee is named, not rendered as a large number.
    await expect(page.locator('#capital-pg')).toContainText('UNLIMITED');
  });

  test('names the row it could not read rather than refusing anonymously', async () => {
    await openPanel('panel-capital');

    await page
      .locator('#capital-stack-json')
      .fill(JSON.stringify([{ provider: 'E2E Bank', label: 'Bad', kind: 'not_a_kind' }]));
    await page.locator('#capital-model').click();

    await expect(page.locator('#capital-status')).toContainText('row 1');
  });
});

/**
 * A client id that resolves to no graph.
 *
 * A well-formed UUID rather than the seeded client's NAME, which is what the first draft of these
 * tests put in the id field. `loadGraph` answers for any id - an unrecorded one produces an empty
 * graph, which is exactly the state worth asserting here, and asserting it against a fixed value
 * makes the test say the same thing on every run.
 */
const NO_SUCH_CLIENT = '00000000-0000-4000-8000-0000000000aa';

test.describe('1.2 on the page', () => {
  test('shows an empty graph as empty, and says that is a fact about the store', async () => {
    await openPanel('panel-graph');

    await page.locator('#graph-client-id').fill(NO_SUCH_CLIENT);
    await page.locator('#graph-load').click();

    // Not a blank panel and not "no risk". The sentence distinguishes a client with a simple
    // structure from a client nobody has recorded - and says nothing on this Console can record one.
    const summary = page.locator('#graph-summary');
    await expect(summary).toContainText('No entity or owner is recorded');
    await expect(summary).toContainText('not a finding about the client');

    // The band is still rendered as a word, over an empty graph.
    await expect(page.locator('#graph-risk-band')).toContainText('Graph risk');
  });

  test('no longer claims a reveal cannot be offered, and still shows no identifier', async () => {
    await openPanel('panel-graph');

    await page.locator('#graph-client-id').fill(NO_SUCH_CLIENT);
    await page.locator('#graph-load').click();

    // Batch A declared `reveal_protected_identifier`, so the panel stopped saying the reveal is
    // impossible. This spec asserted the opposite and was right while nothing gated it.
    const blocked = page.locator('#graph-blocked');
    await expect(blocked).not.toContainText('Reveal an SSN or EIN');

    // The control exists now, and it states what it costs before it is pressed: a purpose is
    // required, and it is recorded against the reveal.
    await expect(page.locator('#write-graph-ssn-submit')).toBeVisible();
    await expect(page.locator('#graph-writes')).toContainText('purpose is required');

    // **The property that has not changed.** Nothing has been revealed, so no identifier is on the
    // page. The control being present is not the same as it having been used.
    await expect(page.locator('#panel-graph')).not.toContainText('123456789');
  });
});

test.describe('1.3 and 8.1 on the page', () => {
  test('renders the pipeline and the lead writes it now offers', async () => {
    await openPanel('panel-sales');

    await expect(page.locator('#sales-status')).toContainText('lead(s)');

    // Batch C declared the lead lifecycle, so this is no longer a write the surface cannot offer.
    // The two actions are on the panel at their two levels - conversion apart from the rest,
    // because it creates a client and may start an engagement.
    const available = page.locator('#sales-available');
    await expect(available).toContainText('manage_lead');
    await expect(available).toContainText('convert_lead');
  });

  test('renders an empty partner list as empty, with the reason nothing can register one', async () => {
    await openPanel('panel-partners');

    await expect(page.locator('#partners-list')).toContainText('No partner is registered');
    await expect(page.locator('#partners-blocked')).toContainText(
      'Register, qualify, onboard, suspend or terminate a partner',
    );
  });
});
