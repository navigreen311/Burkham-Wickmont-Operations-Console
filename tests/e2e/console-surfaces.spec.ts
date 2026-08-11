/**
 * The five surfaces this slice added, in a browser.
 *
 * **What only a browser checks here is that the values arrive as text.** The transport test asserts
 * every field by name; it cannot tell whether the page then renders it, renders it somewhere else,
 * or renders `undefined` into a sentence that still reads like English. A field the page reads
 * under the wrong name produces a blank in the middle of a line and no error anywhere - which is
 * the failure this repository has hit twice.
 *
 * **One account per test, and none of them writes.** The accounts are separate for the reason
 * `E2E_CONSOLE_ACCOUNTS` gives: a TOTP code is spent when accepted, so two tests sharing an
 * authenticator inside one thirty-second step is a replay rather than a test. There is no
 * one-client-per-test rule to follow here because nothing on these five surfaces mutates anything -
 * they all read the one seeded file.
 */

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  E2E_APPROVAL_QUEUE,
  E2E_CONSOLE_CLIENTS,
  E2E_CONSOLE_HANDOFF,
  E2E_CONSOLE_PASSWORD,
  nextStepCode,
  openConsole,
  type ConsoleHandoff,
} from './fixture.js';

/** The file the harness seeded four modules' worth of history onto. */
const SUBJECT = E2E_CONSOLE_CLIENTS[4];

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

/** Open the seeded client's file, which is where the three client-scoped surfaces hang. */
const openSubject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Clients', exact: true }).click();
  await page.getByRole('button', { name: SUBJECT }).click();
  await expect(page.getByRole('heading', { name: SUBJECT })).toBeVisible();
};

test.describe('2.4 the human approval console', () => {
  test('shows a queue on request, the SLA breach without one, and why nothing can be resolved here', async ({
    page,
  }) => {
    await signIn(page, 'e2e-operator-approvals@example.com');
    await page.getByRole('button', { name: 'Approvals' }).click();

    await expect(page.getByRole('heading', { name: 'Human approvals' })).toBeVisible();

    // Before a queue is named: the breach list is tenant-wide and needs none, and the page says so
    // rather than showing an empty list that reads as "nothing is open".
    await expect(page.locator('#approvals-summary')).toContainText('Name a queue');
    await expect(page.locator('#approvals-breached-summary')).toContainText('past their SLA');
    await expect(page.locator('#approvals-breached')).toContainText('compliance_review');

    await page.locator('#approvals-queue').fill(E2E_APPROVAL_QUEUE);
    await page.getByRole('button', { name: 'Show queue' }).click();

    await expect(page.locator('#approvals-summary')).toContainText(E2E_APPROVAL_QUEUE);
    const item = page.locator('#approvals-list');
    await expect(item).toContainText('Needs Review compliance state awaiting a human');
    // Every value in the row rendered. A field read under the wrong name would leave a gap here
    // rather than an error.
    await expect(item).toContainText('open');
    await expect(item).toContainText(`assigned to ${E2E_APPROVAL_QUEUE}`);

    await page
      .getByRole('button', { name: 'Needs Review compliance state awaiting a human' })
      .click();

    await expect(page.locator('#approval-task')).toContainText('compliance_review');
    await expect(page.locator('#approval-task')).toContainText('human_checkpoint');
    await expect(page.locator('#approval-task')).toContainText('waiting');
    await expect(page.locator('#approval-instance')).toContainText('Playbook');
    await expect(page.locator('#approval-siblings-summary')).toContainText('task(s) in this workflow');
    await expect(page.locator('#approval-notifications-summary')).toContainText('assignment(s)');

    // **THE ASSERTION.** The absence of a resolve button is stated, not left to be inferred. A
    // surface that simply had no control would read as one somebody had not finished.
    await expect(page.locator('#approval-resolution')).toContainText('No resolve control');
    await expect(page.locator('#approval-resolution')).toContainText('ACTION_MINIMUM_LEVEL');
  });
});

test.describe('7.3 contracts and disclosures', () => {
  test('lists what was issued, opens one, and shows its integrity and provenance', async ({
    page,
  }) => {
    await signIn(page, 'e2e-operator-contracts@example.com');
    await openSubject(page);

    await page.getByRole('button', { name: 'Contracts & disclosures' }).click();
    await expect(page.getByRole('heading', { name: 'Contracts & disclosures' })).toBeVisible();

    await expect(page.locator('#contracts-client')).toContainText(SUBJECT);
    await expect(page.locator('#contracts-summary')).toContainText('1 issued to this client');
    await expect(page.locator('#contracts-list')).toContainText('service_agreement');
    await expect(page.locator('#contracts-list')).toContainText('template service_agreement');

    await page.getByRole('button', { name: 'service_agreement' }).click();

    await expect(page.locator('#contract-title')).toHaveText('Service Agreement');
    // Is this still what we sent? The most serious integrity question available here.
    await expect(page.locator('#contract-integrity')).toContainText('Integrity intact');
    await expect(page.locator('#contract-placeholders')).toContainText('No unresolved placeholder');
    await expect(page.locator('#contract-provenance')).toContainText('Generated from template');
    await expect(page.locator('#contract-provenance')).toContainText('state module v');

    // The substituted variable actually landed. A document still reading `{{clientLegalName}}`
    // would be a template somebody signed.
    await expect(page.locator('#contract-sections')).toContainText(SUBJECT);
    await expect(page.locator('#contract-sections')).not.toContainText('{{');
    // Each insertion carries the citation that put it there.
    await expect(page.locator('#contract-sections')).toContainText('clause scope_of_services');
    await expect(page.locator('#contract-sections')).toContainText('disclosure ');

    // Firm-wide, and labelled as such - a reader who took it for client-scoped would draw the
    // wrong conclusion from a count.
    await expect(page.locator('#contracts-stale-summary')).toContainText('Firm-wide');
  });
});

test.describe('3.2 the secure document vault', () => {
  test('shows metadata and an access log with its refusal, and never the document', async ({
    page,
  }) => {
    await signIn(page, 'e2e-operator-documents@example.com');
    await openSubject(page);

    await page.getByRole('button', { name: 'Documents' }).click();
    await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();

    const seed = await handoff();

    await expect(page.locator('#documents-client')).toContainText(SUBJECT);
    await expect(page.locator('#documents-summary')).toContainText('1 document(s)');
    await expect(page.locator('#documents-summary')).toContainText('Authority Level 3');

    const row = page.locator('#documents-list');
    await expect(row).toContainText('credit_report');
    // Written out as a word. A tick beside `pending` or `scan_unavailable` would be the shortest
    // possible lie, so the scan status is never rendered as a mark.
    await expect(row).toContainText('scan clean');
    await expect(row).toContainText('no legal hold');
    // The module's own constant: a credit report needs Level 2.
    await expect(row).toContainText('needs Authority Level 2');
    // No retention schedule has been resolved, and the page says that rather than showing a blank.
    await expect(row).toContainText('no schedule resolved');

    // **THE ASSERTION THIS SURFACE EXISTS FOR.** The seeded document's content contains a canary
    // that exists nowhere else, and it is nowhere on the page - because no route here returns
    // document content at all.
    await expect(page.locator('#documents-bytes-notice')).toContainText(
      'Metadata and the access log only',
    );
    await expect(page.locator('body')).not.toContainText(seed.vaultCanary);

    await page.getByRole('button', { name: seed.vaultFilename }).click();

    await expect(page.locator('#access-log-summary')).toContainText('2 access attempt(s)');
    await expect(page.locator('#access-log-summary')).toContainText('1 granted, 1 refused');
    // The refusal is the entry that makes the log worth a page.
    await expect(page.locator('#access-log-list')).toContainText('REFUSED');
    await expect(page.locator('#access-log-list')).toContainText('below_level');

    // Still absent after opening the log, which is the second route on this surface.
    await expect(page.locator('body')).not.toContainText(seed.vaultCanary);
  });
});

test.describe('1.4 pricing, billing and offers', () => {
  test('shows the balance as components and the success fee as contingent, never as zero', async ({
    page,
  }) => {
    await signIn(page, 'e2e-operator-billing@example.com');
    await openSubject(page);

    await page.getByRole('button', { name: 'Billing' }).click();
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

    await expect(page.locator('#billing-client')).toContainText(SUBJECT);
    await expect(page.locator('#billing-summary')).toContainText('1 engagement(s)');

    const engagements = page.locator('#billing-engagements');
    await expect(engagements).toContainText('active');
    await expect(engagements).toContainText('outstanding $4,250.00');
    // Derived rather than stored, and unresolved: nobody has paid or declined it.
    await expect(engagements).toContainText('1 unresolved of 1 refund entitlement(s)');

    await expect(page.locator('#offers-summary')).toContainText('1 offer(s) on the ladder');
    // Basis points, never a percentage - the stored figure is what the fee computes from.
    await expect(page.locator('#offers-list')).toContainText('850 basis points');
    await expect(page.locator('#offers-list')).toContainText('retainer $2,495.00');

    await page.locator('#billing-engagements').getByRole('button').first().click();

    // Four numbers, not one. A client disputing an invoice is asking about one of the four.
    const balance = page.locator('#engagement-balance');
    await expect(balance).toContainText('Charged $6,745.00');
    await expect(balance).toContainText('paid $2,495.00');
    await expect(balance).toContainText('refunded $0.00');
    await expect(balance).toContainText('outstanding $4,250.00');

    // The APPROVED limit. 1.4 has no field for a requested one anywhere.
    await expect(page.locator('#engagement-records')).toContainText(
      'against approved credit limit $50,000.00',
    );

    await expect(page.locator('#engagement-refunds')).toContainText('approved_not_funded_60_days');
    await expect(page.locator('#engagement-refunds')).toContainText('unresolved');

    // **THE ASSERTION.** No approval figure reaches the exhibit, so the success fee is contingent
    // and carries no amount. Rendering it as $0.00 would state the client owes nothing, which is a
    // different claim from "this is not determinable yet".
    await expect(page.locator('#engagement-exhibit')).toContainText('contingent, not yet determinable');
    await expect(page.locator('#engagement-exhibit-contingent')).toContainText('excluded from the total');
    // Dollars here, cents everywhere else on the page, and the label says which.
    await expect(page.locator('#engagement-exhibit-summary')).toContainText('dollars, not cents');
  });
});

test.describe('11.11 the founder workbench', () => {
  test('shows what happens if nobody acts, and withheld metrics rather than zeroes', async ({
    page,
  }) => {
    await signIn(page, 'e2e-operator-workbench@example.com');
    await page.getByRole('button', { name: 'Workbench' }).click();

    await expect(page.getByRole('heading', { name: 'Founder workbench' })).toBeVisible();

    await expect(page.locator('#workbench-decisions-summary')).toContainText('decision(s)');
    // The seeded refund entitlement reaches the founder queue, which is what makes this an
    // assembly over the modules rather than a second store.
    const decisions = page.locator('#workbench-decisions');
    await expect(decisions).toContainText('refunds_unresolved');
    // The field that makes this a queue rather than a feed.
    await expect(decisions).toContainText('if nobody acts:');
    await expect(decisions).toContainText('resolve in 1.4');

    await expect(page.locator('#workbench-period')).toContainText('Period');
    await expect(page.locator('#workbench-clients')).toContainText('client(s)');
    await expect(page.locator('#workbench-compliance')).toContainText('pending_assessment');

    // A metric with no value is written as "not measured", never as 0. 9.1's rule is that a
    // missing measurement is not a measurement of zero, and zero is the value that reads as a
    // finding.
    await expect(page.locator('#workbench-withheld-summary')).toContainText('metric');

    await expect(page.locator('#workbench-health')).toContainText('component(s) unmonitored');
    // `unmonitored` is a word on the page. Nobody looking is not evidence of health, and this is
    // the surface where a green tick would do the most damage.
    await expect(page.locator('#workbench-health-components')).toContainText('unmonitored');

    await expect(page.locator('#workbench-departments-summary')).toContainText('department(s)');
    await expect(page.locator('#workbench-departments')).toContainText('Compliance & Evidence');
  });
});
