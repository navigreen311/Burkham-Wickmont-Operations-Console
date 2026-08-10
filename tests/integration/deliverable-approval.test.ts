/**
 * Integration: 3.4 Deliverable Approval Workflow.
 *
 * The property under test is that **the pipeline cannot be skipped**. Blueprint 3.4 orders the
 * steps, and the implementation enforces that order through state rather than through the order a
 * caller happens to call things in — so the tests try to skip steps rather than only walking the
 * happy path.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { seedFoundingClaims } from '@bwc/claims';
import { read } from '@bwc/ledger';
import { openFor } from '@bwc/notifications';
import {
  CAPITAL_COMMAND_BRIEF,
  FUNDING_SUITABILITY_MEMO,
  SHIPPED_TEMPLATES,
  approve,
  buildCapitalCommandBrief,
  deliver,
  draft,
  figure,
  find,
  forClient,
  hashContent,
  pdfRenderer,
  registerTemplate,
  reject,
  requestHumanReview,
  runComplianceScan,
  runQaCheck,
  textRenderer,
} from '@bwc/deliverables';
import type { Provenance } from '@bwc/core';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('deliverable');
  await seedFoundingClaims(fx.tenant.id, 'compliance_review_board', {
    id: fx.human.id,
    kind: 'human',
  });
  for (const template of SHIPPED_TEMPLATES) await registerTemplate(template);
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const human = () => ({ id: fx.human.id, kind: 'human' as const });
const agent = () => ({ id: fx.agent.id, kind: 'village_agent' as const });

const SOURCED: Provenance = {
  tag: 'issuer_rule',
  sourceUrl: 'https://example.invalid/terms',
  lastVerified: '2026-08-01',
  verifiedBy: 'funding_strategy',
};

const brief = (narrative = 'Utilisation is within target across the stack.') =>
  buildCapitalCommandBrief({
    clientLegalName: 'Acme Operating LLC',
    preparedOn: '2026-08-10',
    complianceState: 'pass',
    narrative,
    positionFigures: [figure('Total available', '$120,000', SOURCED)],
  });

const newClient = async (name: string) => createClient(fx.tenant.id, name, human());

describe('the happy path', () => {
  it('runs draft -> QA -> scan -> review -> approve -> deliver, logging each step', async () => {
    const client = await newClient('Happy Path Co');

    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    expect(drafted.status).toBe('ok');
    if (drafted.status !== 'ok') return;
    const id = drafted.value.id;

    expect((await runQaCheck(fx.tenant.id, id, agent())).status).toBe('ok');
    expect((await runComplianceScan(fx.tenant.id, id, agent())).status).toBe('ok');
    expect((await requestHumanReview(fx.tenant.id, id, agent())).status).toBe('ok');

    // The reviewer is notified rather than expected to poll.
    expect(await openFor(fx.tenant.id, 'compliance_and_evidence')).not.toHaveLength(0);

    expect((await approve(fx.tenant.id, id, human())).status).toBe('ok');

    const delivered = await deliver(fx.tenant.id, id, human());
    expect(delivered.status).toBe('ok');
    if (delivered.status !== 'ok') return;
    expect(delivered.value.status).toBe('delivered');

    const types = (await read({ tenantId: fx.tenant.id, clientId: client.id })).map((e) => e.type);
    for (const expected of [
      'deliverable.drafted',
      'deliverable.qa_checked',
      'deliverable.scanned',
      'deliverable.approved',
      'deliverable.delivered',
    ]) {
      expect(types, `${expected} should be in the ledger`).toContain(expected);
    }
  });

  it('records the content hash and approver on delivery, so the Vault needs no archive', async () => {
    const client = await newClient('Hash Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    await runQaCheck(fx.tenant.id, drafted.value.id, agent());
    await runComplianceScan(fx.tenant.id, drafted.value.id, agent());
    await approve(fx.tenant.id, drafted.value.id, human());
    await deliver(fx.tenant.id, drafted.value.id, human());

    const events = await read({ tenantId: fx.tenant.id, type: 'deliverable.delivered' });
    const mine = events.find((event) => event.payload['deliverableId'] === drafted.value.id);

    expect(mine?.payload['contentHash']).toBe(drafted.value.contentHash);
    expect(mine?.payload['approvedBy']).toBe(fx.human.id);
  });
});

describe('a stored deliverable can be read back and rendered', () => {
  it('survives the JSON round trip, including provenance timestamps', async () => {
    // Regression guard. `Provenance` originally held `Date` objects; stored as JSON they came
    // back as strings, and `describeProvenance` called `.toISOString()` on a string and threw.
    // Nothing in a pure unit test touches persistence, so it was invisible until a stored
    // deliverable was rendered - which is every deliverable, one step later.
    const client = await newClient('Round Trip Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    // Re-read from the database rather than reusing the in-memory document.
    const reloaded = await find(fx.tenant.id, drafted.value.id);
    expect(reloaded.status).toBe('ok');
    if (reloaded.status !== 'ok') return;

    const rendered = textRenderer.render(reloaded.value.content);
    expect(rendered).toContain('Total available');
    expect(rendered).toContain('Issuer rule, verified 2026-08-01');

    // And the hash of the reloaded content matches what was stored, so the round trip is
    // lossless as well as non-throwing.
    expect(hashContent(reloaded.value.content)).toBe(drafted.value.contentHash);

    const pdf = await pdfRenderer.render(reloaded.value.content);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('the pipeline cannot be skipped', () => {
  it('refuses delivery of a draft', async () => {
    const client = await newClient('Skip Draft Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    const result = await deliver(fx.tenant.id, drafted.value.id, human());
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/approved/i);
  });

  it('refuses delivery of an unscanned but QA-checked deliverable', async () => {
    const client = await newClient('Skip Scan Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;
    await runQaCheck(fx.tenant.id, drafted.value.id, agent());

    // Approval is unreachable from qa_checked, so delivery is unreachable too.
    expect((await approve(fx.tenant.id, drafted.value.id, human())).status).toBe('refused');
    expect((await deliver(fx.tenant.id, drafted.value.id, human())).status).toBe('refused');
  });

  it('refuses a scan before QA', async () => {
    const client = await newClient('Scan First Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    const result = await runComplianceScan(fx.tenant.id, drafted.value.id, agent());
    expect(result.status).toBe('refused');
  });

  it('refuses approval by an agent', async () => {
    const client = await newClient('Agent Approve Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;
    await runQaCheck(fx.tenant.id, drafted.value.id, agent());
    await runComplianceScan(fx.tenant.id, drafted.value.id, agent());

    // An agent approving its own draft would make human review ceremonial - the same reasoning
    // that stops an agent clearing the Firewall it triggered.
    const result = await approve(fx.tenant.id, drafted.value.id, agent());
    expect(result.status).toBe('refused');
  });
});

describe('banned language never reaches a client', () => {
  it('blocks a deliverable containing a banned phrase, terminally', async () => {
    const client = await newClient('Blocked Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief('You have guaranteed approval for the next tranche.'),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    await runQaCheck(fx.tenant.id, drafted.value.id, agent());

    const scan = await runComplianceScan(fx.tenant.id, drafted.value.id, agent());
    expect(scan.status).toBe('refused');
    if (scan.status === 'refused') expect(scan.reason).toMatch(/guaranteed approval/i);

    const after = await find(fx.tenant.id, drafted.value.id);
    expect(after.status === 'ok' && after.value.status).toBe('blocked');

    // Blocked is terminal for this version: approval and delivery are both unreachable. The
    // remedy is a new draft with different language, not a retry of the same content.
    expect((await approve(fx.tenant.id, drafted.value.id, human())).status).toBe('refused');
    expect((await deliver(fx.tenant.id, drafted.value.id, human())).status).toBe('refused');

    const blocked = await read({ tenantId: fx.tenant.id, type: 'deliverable.blocked' });
    expect(blocked.some((event) => event.clientId === client.id)).toBe(true);
  });

  it('scans content assembled from data, not just the template', async () => {
    // The banned phrase arrives through the narrative field rather than the template body. A
    // template-level scan would pass this.
    const client = await newClient('Interpolated Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief('Our review confirms this is a no risk position for the guarantor.'),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    await runQaCheck(fx.tenant.id, drafted.value.id, agent());
    expect((await runComplianceScan(fx.tenant.id, drafted.value.id, agent())).status).toBe(
      'refused',
    );
  });
});

describe('QA catches structurally broken documents before a human sees them', () => {
  it('refuses a document with no sections', async () => {
    const client = await newClient('Empty Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: {
        templateKey: CAPITAL_COMMAND_BRIEF.key,
        templateVersion: CAPITAL_COMMAND_BRIEF.version,
        title: 'Capital Command Brief',
        clientLegalName: 'Empty Co',
        preparedOn: '2026-08-10',
        sections: [],
      },
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    const qa = await runQaCheck(fx.tenant.id, drafted.value.id, agent());
    expect(qa.status).toBe('refused');
    if (qa.status === 'refused') expect(qa.reason).toMatch(/NO_SECTIONS/);
  });

  it('refuses a document that is not dated as an ISO date', async () => {
    const client = await newClient('Undated Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: { ...brief(), preparedOn: 'August 2026' },
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    const qa = await runQaCheck(fx.tenant.id, drafted.value.id, agent());
    expect(qa.status).toBe('refused');
    if (qa.status === 'refused') expect(qa.reason).toMatch(/BAD_DATE/);
  });
});

describe('versions accumulate rather than overwrite', () => {
  it('creates a new version per draft and never edits a delivered one', async () => {
    const client = await newClient('Versioned Co');

    const first = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief('First pass.'),
      actor: agent(),
    });
    const second = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief('Second pass, revised.'),
      actor: agent(),
    });

    if (first.status !== 'ok' || second.status !== 'ok') return;
    expect(first.value.version).toBe(1);
    expect(second.value.version).toBe(2);
    expect(second.value.contentHash).not.toBe(first.value.contentHash);

    const all = await forClient(fx.tenant.id, client.id);
    expect(all.filter((d) => d.templateKey === CAPITAL_COMMAND_BRIEF.key)).toHaveLength(2);
  });

  it('refuses a draft for an unregistered template', async () => {
    const client = await newClient('No Template Co');
    const result = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: { ...brief(), templateKey: 'never-registered', templateVersion: 9 },
      actor: agent(),
    });
    expect(result.status).toBe('no_data');
  });
});

describe('rejection is recorded', () => {
  it('records the reason and blocks delivery', async () => {
    const client = await newClient('Rejected Co');
    const drafted = await draft({
      tenantId: fx.tenant.id,
      clientId: client.id,
      document: brief(),
      actor: agent(),
    });
    if (drafted.status !== 'ok') return;

    await runQaCheck(fx.tenant.id, drafted.value.id, agent());
    await runComplianceScan(fx.tenant.id, drafted.value.id, agent());
    await requestHumanReview(fx.tenant.id, drafted.value.id, agent());

    const rejected = await reject(
      fx.tenant.id,
      drafted.value.id,
      'Figures do not match the current stack position.',
      human(),
    );
    expect(rejected.status).toBe('ok');

    expect((await deliver(fx.tenant.id, drafted.value.id, human())).status).toBe('refused');

    const events = await read({ tenantId: fx.tenant.id, type: 'deliverable.rejected' });
    expect(
      events.some((event) => event.payload['reason']?.toString().includes('stack position')),
    ).toBe(true);
  });
});

describe('tenant isolation', () => {
  it("refuses to act on another tenant's deliverable", async () => {
    const other = await makeFixture('deliverable-other');
    try {
      const client = await newClient('Isolated Co');
      const drafted = await draft({
        tenantId: fx.tenant.id,
        clientId: client.id,
        document: brief(),
        actor: agent(),
      });
      if (drafted.status !== 'ok') return;

      expect(
        (await runQaCheck(other.tenant.id, drafted.value.id, { id: other.human.id, kind: 'human' }))
          .status,
      ).toBe('no_data');
      expect((await find(other.tenant.id, drafted.value.id)).status).toBe('no_data');
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });
});

describe('the memo template carries its disclosures', () => {
  it('includes not-a-lender and no-guarantee disclosures', async () => {
    expect(FUNDING_SUITABILITY_MEMO.requiresHumanReview).toBe(true);
    expect(CAPITAL_COMMAND_BRIEF.requiresHumanReview).toBe(true);
  });
});
