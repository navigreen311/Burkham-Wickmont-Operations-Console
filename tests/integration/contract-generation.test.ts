/**
 * 7.3 Contract & Disclosure Builder, end to end.
 *
 * The property under test throughout: **a client cannot be handed a document to sign unless the
 * state was activated, the template was reviewed, and every clause it names resolves.** Each test
 * removes one of those and checks the generation refuses.
 *
 * Plus the one that matters most after issue: a document that was generated does not change when
 * the rules do.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { read } from '@bwc/ledger';
import { seedFoundingClaims } from '@bwc/claims';
import { activateState, publishStateModule, standingFor } from '@bwc/regulatory';
import {
  applicableClauses,
  contractsOnSupersededTemplates,
  findContract,
  generateContract,
  hashDocument,
  publishClause,
  publishTemplate,
  reviewTemplate,
  staleContracts,
  unresolvedPlaceholders,
  verifyStoredHash,
  type TemplateSection,
} from '@bwc/contracts';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const SERVICE_AGREEMENT: readonly TemplateSection[] = [
  {
    heading: 'Engagement',
    body: 'This agreement is between Burkham Wickmont and {{clientLegalName}}, effective {{effectiveDate}}.',
    insertClauseKeys: ['scope_of_services'],
  },
  {
    heading: 'Required disclosures',
    body: 'The following disclosures form part of this agreement.',
    insertDisclosures: true,
  },
  {
    heading: 'Termination',
    body: 'Either party may terminate on thirty days written notice.',
    insertClauseKeys: ['termination'],
  },
];

beforeAll(async () => {
  fx = await makeFixture('contracts');

  const client = await createClient(fx.tenant.id, 'Contracted Co', human());
  clientId = client.id;

  // The Marketing Claim Library, so the scanner has something to scan against.
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', human());

  // Texas activated; Nevada published but never reviewed.
  for (const state of ['TX', 'NV']) {
    await publishStateModule({
      tenantId: fx.tenant.id,
      state,
      summary: `${state} module for the contract test.`,
      citations: [`${state} commercial financing provisions`],
      disclosures: [
        {
          key: `${state.toLowerCase()}_cost_basis`,
          text: `Any cost figure shown to a ${state} client states the basis on which it was computed.`,
          citation: `${state} commercial financing provisions §1`,
        },
      ],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });
  }

  await activateState({
    tenantId: fx.tenant.id,
    state: 'TX',
    actor: human(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: 'Memo BW-REG-2026-040',
  });

  for (const key of ['scope_of_services', 'termination']) {
    await publishClause({
      tenantId: fx.tenant.id,
      key,
      text: `Standard ${key.replace(/_/g, ' ')} terms.`,
      citation: 'Standard engagement policy, approved 2026-07',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });
  }
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function human() {
  return { id: fx.human.id, kind: 'human' as const };
}

const publishServiceAgreement = (overrides: Record<string, unknown> = {}) =>
  publishTemplate({
    tenantId: fx.tenant.id,
    key: 'service-agreement',
    kind: 'service_agreement',
    title: 'Capital Advisory Service Agreement',
    sections: SERVICE_AGREEMENT,
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
    ...overrides,
  });

const review = (version: number) =>
  reviewTemplate({
    tenantId: fx.tenant.id,
    templateKey: 'service-agreement',
    templateVersion: version,
    actor: human(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-02T00:00:00.000Z'),
    documentReference: 'Memo BW-CON-2026-007',
  });

const generate = (overrides: Record<string, unknown> = {}) =>
  generateContract({
    tenantId: fx.tenant.id,
    clientId,
    templateKey: 'service-agreement',
    state: 'TX',
    offerTier: 'growth',
    channel: 'direct',
    variables: { clientLegalName: 'Contracted Co LLC', effectiveDate: '2026-08-10' },
    generatedBy: 'concierge-desk-agent',
    actor: human(),
    now: new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  });

describe('generation is gated three ways', () => {
  it('refuses before the template is reviewed by counsel', async () => {
    // The whole document is language a client signs. An unreviewed version cannot produce one.
    await publishServiceAgreement();

    const result = await generate();
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/never been reviewed by counsel/);
    }
  });

  it('generates once the template version is reviewed', async () => {
    await review(1);

    const result = await generate();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.templateVersion).toBe(1);
    expect(result.value.state).toBe('TX');
    expect(result.value.clauseKeys).toEqual(['scope_of_services', 'termination']);
  });

  it('refuses for a state the Regulatory Engine has not activated', async () => {
    const result = await generate({ state: 'NV' });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/never been activated/);
  });

  it('refuses when a clause the template names does not resolve', async () => {
    // Generating without it produces an agreement silently missing a term somebody deliberately
    // wrote, and nothing in the output would show the gap.
    await publishTemplate({
      tenantId: fx.tenant.id,
      key: 'agreement-with-hole',
      kind: 'service_agreement',
      title: 'Agreement With A Hole',
      sections: [
        { heading: 'Scope', body: 'Scope.', insertClauseKeys: ['a_clause_nobody_published'] },
      ],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });
    await reviewTemplate({
      tenantId: fx.tenant.id,
      templateKey: 'agreement-with-hole',
      templateVersion: 1,
      actor: human(),
      reviewedBy: 'Outside counsel',
      reviewedAt: new Date('2026-08-02T00:00:00.000Z'),
      documentReference: 'Memo BW-CON-2026-008',
    });

    const result = await generate({ templateKey: 'agreement-with-hole' });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/silently missing a term/);
    }
  });

  it('refuses a document containing banned language', async () => {
    // A banned phrase in a marketing email is a compliance finding. The same phrase in a signed
    // agreement is a term of the contract.
    await publishClause({
      tenantId: fx.tenant.id,
      key: 'overreaching_promise',
      text: 'Burkham Wickmont provides guaranteed approval on all applications.',
      citation: 'Deliberately non-compliant clause, for the test',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });
    await publishTemplate({
      tenantId: fx.tenant.id,
      key: 'agreement-with-banned-language',
      kind: 'service_agreement',
      title: 'Overreaching Agreement',
      sections: [
        { heading: 'Promise', body: 'Our promise.', insertClauseKeys: ['overreaching_promise'] },
      ],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });
    await reviewTemplate({
      tenantId: fx.tenant.id,
      templateKey: 'agreement-with-banned-language',
      templateVersion: 1,
      actor: human(),
      reviewedBy: 'Outside counsel',
      reviewedAt: new Date('2026-08-02T00:00:00.000Z'),
      documentReference: 'Memo BW-CON-2026-009',
    });

    const result = await generate({ templateKey: 'agreement-with-banned-language' });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/guaranteed approval/);
      expect(result.reason).toMatch(/term of the contract/);
    }
  });

  it('stops generating after a material template change, and resumes after re-review', async () => {
    await publishServiceAgreement({ title: 'Capital Advisory Service Agreement (revised)' });

    const blocked = await generate();
    expect(blocked.status).toBe('refused');
    if (blocked.status === 'refused') {
      expect(blocked.reason).toMatch(/version 2 made a material change/);
    }

    await review(2);
    expect((await generate()).status).toBe('ok');
  });

  it('keeps generating through an editorial template change', async () => {
    await publishServiceAgreement({
      changeKind: 'editorial',
      changeRationale: 'Corrected a typo in the termination heading; no term changed.',
    });

    const result = await generate();
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.templateVersion).toBe(3);
  });
});

describe('the generated document', () => {
  it('inserts the federal baseline and the state layer, by key, from 7.2', async () => {
    // One wording, one home. A second copy of "not a lender" maintained here would not become
    // wrong so much as become ambiguous.
    const result = await generate();
    if (result.status !== 'ok') throw new Error('expected a generated contract');

    expect(result.value.disclosureKeys).toContain('not_a_lender');
    expect(result.value.disclosureKeys).toContain('no_guarantee');
    expect(result.value.disclosureKeys).toContain('tx_cost_basis');

    const section = result.value.content.sections.find((s) => s.disclosures.length > 0);
    expect(section?.disclosures.every((d) => d.citation.length > 5)).toBe(true);
    expect(section?.disclosures.find((d) => d.key === 'tx_cost_basis')?.source).toBe('TX');
    expect(section?.disclosures[0]?.source).toBe('federal');
  });

  it('substitutes variables and leaves unresolved placeholders visible', async () => {
    // A contract reading "between Burkham Wickmont and {{clientLegalName}}" is obviously broken
    // and gets caught. One reading "between Burkham Wickmont and " looks like a formatting slip
    // and gets signed.
    const resolved = await generate();
    if (resolved.status !== 'ok') throw new Error('expected a generated contract');
    expect(resolved.value.content.sections[0]?.body).toContain('Contracted Co LLC');
    expect(unresolvedPlaceholders(resolved.value.content)).toHaveLength(0);

    const partial = await generate({ variables: { clientLegalName: 'Contracted Co LLC' } });
    if (partial.status !== 'ok') throw new Error('expected a generated contract');
    expect(partial.value.content.sections[0]?.body).toContain('{{effectiveDate}}');
    expect(unresolvedPlaceholders(partial.value.content)).toEqual(['effectiveDate']);
  });

  it('pins every input that produced it', async () => {
    const result = await generate();
    if (result.status !== 'ok') throw new Error('expected a generated contract');

    const { provenance } = result.value.content;
    expect(provenance.templateKey).toBe('service-agreement');
    expect(provenance.templateVersion).toBe(result.value.templateVersion);
    expect(provenance.stateModuleVersion).toBe(result.value.stateModuleVersion);
    expect(provenance.generatedAt).toBe('2026-08-10T00:00:00.000Z');
  });

  it('records the content hash in the Ledger, so the chain can answer what was signed', async () => {
    const result = await generate();
    if (result.status !== 'ok') throw new Error('expected a generated contract');

    const events = await read({ tenantId: fx.tenant.id, type: 'contract.generated' });
    const event = events.find((entry) => entry.payload['contractId'] === result.value.id);
    expect(event?.payload['contentHash']).toBe(result.value.contentHash);
    expect(event?.payload['stateModuleVersion']).toBe(result.value.stateModuleVersion);
  });

  it('re-hashes to what was recorded at issue', async () => {
    const result = await generate();
    if (result.status !== 'ok') throw new Error('expected a generated contract');

    const verified = await verifyStoredHash(fx.tenant.id, result.value.id, (content) =>
      hashDocument(content as never),
    );
    expect(verified.intact).toBe(true);
  });
});

describe('clause scoping', () => {
  it('prefers a state-scoped clause over the global one of the same key', async () => {
    await publishClause({
      tenantId: fx.tenant.id,
      key: 'termination',
      text: 'Texas termination terms, thirty days written notice with a cure period.',
      citation: 'TX policy overlay approved 2026-07',
      jurisdiction: 'TX',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });

    const clauses = await applicableClauses({ tenantId: fx.tenant.id, jurisdiction: 'TX' });
    const termination = clauses.filter((clause) => clause.key === 'termination');

    // One term, not two: a document carrying both versions of the same clause is worse than one
    // carrying the wrong version, because nobody can tell which governs.
    expect(termination).toHaveLength(1);
    expect(termination[0]?.jurisdiction).toBe('TX');
  });

  it('treats an empty scope as applying to all, not to none', async () => {
    // Read the other way round, an omitted field would silently drop a required term from every
    // document - which is how a clause disappears from a contract with nobody editing anything.
    const anyTier = await applicableClauses({
      tenantId: fx.tenant.id,
      jurisdiction: 'TX',
      offerTier: 'a-tier-nobody-configured',
    });
    expect(anyTier.some((clause) => clause.key === 'scope_of_services')).toBe(true);
  });

  it('applies a channel-scoped clause only on that channel', async () => {
    await publishClause({
      tenantId: fx.tenant.id,
      key: 'partner_disclosure',
      text: 'This engagement was referred by a partner who receives compensation.',
      citation: 'Partner programme policy; state referral-fee rules',
      appliesToChannels: ['partner'],
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });

    const direct = await applicableClauses({
      tenantId: fx.tenant.id,
      jurisdiction: 'TX',
      channel: 'direct',
    });
    const partner = await applicableClauses({
      tenantId: fx.tenant.id,
      jurisdiction: 'TX',
      channel: 'partner',
    });

    expect(direct.some((clause) => clause.key === 'partner_disclosure')).toBe(false);
    expect(partner.some((clause) => clause.key === 'partner_disclosure')).toBe(true);
  });

  it('refuses a clause with no citation', async () => {
    const result = await publishClause({
      tenantId: fx.tenant.id,
      key: 'uncited',
      text: 'A term nobody can trace.',
      citation: '   ',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });
});

describe('an issued document does not change when the rules do', () => {
  it('keeps its content and hash after a material state change, and reports as stale', async () => {
    // Blueprint 7.3's "auto-updates when Regulatory Engine flags rule changes" cannot mean
    // rewriting an issued agreement: it is the only evidence of what was agreed.
    const issued = await generate();
    if (issued.status !== 'ok') throw new Error('expected a generated contract');

    const hashAtIssue = issued.value.contentHash;
    const versionAtIssue = issued.value.stateModuleVersion;

    await publishStateModule({
      tenantId: fx.tenant.id,
      state: 'TX',
      summary: 'TX module, materially revised after the contract was issued.',
      citations: ['TX commercial financing provisions', 'TX HB 9999 (2026)'],
      disclosures: [
        {
          key: 'tx_cost_basis',
          text: 'Revised Texas cost-basis disclosure.',
          citation: 'TX HB 9999 (2026) §2',
        },
      ],
      changeKind: 'material',
      publishedBy: 'compliance@burkhamwickmont.test',
      actor: human(),
    });

    const reloaded = await findContract(fx.tenant.id, issued.value.id);
    expect(reloaded?.contentHash).toBe(hashAtIssue);
    expect(reloaded?.stateModuleVersion).toBe(versionAtIssue);
    expect(
      reloaded?.content.sections
        .flatMap((section) => section.disclosures)
        .find((d) => d.key === 'tx_cost_basis')?.text,
    ).not.toMatch(/Revised Texas/);

    const stale = await staleContracts(fx.tenant.id, 'TX');
    const entry = stale.find((candidate) => candidate.id === issued.value.id);
    expect(entry?.reason).toMatch(/made a material change/);
    expect(entry?.currentVersion).toBeGreaterThan(entry?.generatedAgainstVersion ?? 0);
  });

  it('distinguishes an editorial drift from a material one in the report', async () => {
    // The remedy differs, so the report has to as well - reissuing everything on a typo fix is
    // how a staleness report gets ignored.
    const stale = await staleContracts(fx.tenant.id, 'TX');
    expect(stale.length).toBeGreaterThan(0);
    for (const entry of stale) {
      expect(entry.reason).toMatch(/material change|Every change since has been editorial/);
    }
  });

  it('reports documents left behind by a template revision', async () => {
    const behind = await contractsOnSupersededTemplates(fx.tenant.id);
    expect(behind.some((entry) => entry.templateKey === 'service-agreement')).toBe(true);
  });

  it('cannot generate for TX until counsel reviews the new module version', async () => {
    // The material change above took the state offline, which is 7.2's gate doing its job -
    // and it means no further Texas contract issues until somebody looks at the new rules.
    expect((await standingFor(fx.tenant.id, 'TX')).status).toBe('needs_counsel_review');

    const result = await generate();
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/material change/);
  });
});
