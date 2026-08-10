/**
 * Integration: 3.3 ingestion gating, correlation, and missing-document detection.
 *
 * The behaviours under test are the ones that decide whether this module is *honest* while every
 * vendor is ungated: consent is checked before the vendor gate, an unavailable vendor reports
 * `not_built` rather than empty data, and correlation refuses rather than inventing agreement.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as createClient } from '@bwc/clients';
import { grant as grantConsent } from '@bwc/consent';
import { read as readLedger } from '@bwc/ledger';
import {
  EnvKekProvider,
  LocalEncryptedStore,
  generateKek,
  store as storeDocument,
} from '@bwc/vault';
import {
  REQUIRED_CONSENT,
  assessCoverage,
  classifyByFilename,
  correlate,
  findingsFor,
  ingest,
  missingDocumentFindings,
  recordFindings,
  recordNormalizedFeed,
  runsFor,
  analyzeFeed,
  type NormalizedBureauProfile,
  type NormalizedFeed,
} from '@bwc/intelligence';
import type { Provenance } from '@bwc/core';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;
let vaultRoot: string;

const FEED_PROVENANCE: Provenance = {
  tag: 'vendor_feed',
  vendor: 'plaid',
  retrievedAt: '2026-08-09',
  consentReference: 'consent-abc',
};

const BUREAU_PROVENANCE: Provenance = {
  tag: 'vendor_feed',
  vendor: 'business_bureau',
  retrievedAt: '2026-08-08',
  consentReference: 'consent-def',
};

beforeAll(async () => {
  fx = await makeFixture('intel');
  vaultRoot = await mkdtemp(join(tmpdir(), 'bwc-intel-vault-'));
  process.env['VAULT_INTEL_KEK'] = generateKek();
  clientId = (
    await createClient(fx.tenant.id, 'Intelligence Co', { id: fx.human.id, kind: 'human' })
  ).id;
});

afterAll(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

const feed = (monthsCovered = 12): NormalizedFeed => ({
  source: 'plaid',
  provenance: FEED_PROVENANCE,
  accounts: [
    {
      accountRef: 'acct-1',
      kind: 'checking',
      name: 'Operating',
      maskedIdentifier: '••1234',
      currentBalance: 42_000,
      availableBalance: 41_000,
      currency: 'USD',
    },
  ],
  transactions: Array.from({ length: 12 }, (_, index) => {
    const mm = String(index + 1).padStart(2, '0');
    return {
      accountRef: 'acct-1',
      postedOn: `2026-${mm}-05`,
      amount: 30_000,
      description: 'ACH CREDIT customer payment',
      currency: 'USD',
    };
  }),
  monthsRequested: 12,
  monthsCovered,
});

describe('consent is checked before the vendor gate', () => {
  it('refuses an unauthorized pull, naming the missing authorization', async () => {
    const result = await ingest({
      tenantId: fx.tenant.id,
      clientId,
      source: 'plaid',
      scope: 'first-national-bank',
      monthsRequested: 24,
      actor: actor(),
    });

    // The accurate reason is the client's, not ours. Our vendor gate is a fact about us.
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/authorization/i);
      expect(result.principle).toMatch(/per-event/i);
    }
  });

  it('records the attempt even when it goes nowhere', async () => {
    // A run row saying `unauthorized` is how "we tried and could not" stays distinguishable from
    // "we never tried", which is what an absent row would mean.
    const runs = await runsFor(fx.tenant.id, clientId);
    expect(runs.some((run) => run.status === 'unauthorized')).toBe(true);

    const attempts = await readLedger({
      tenantId: fx.tenant.id,
      type: 'intelligence.ingestion_attempted',
    });
    expect(attempts.length).toBeGreaterThan(0);
  });

  it('reports not_built once authorized, naming the outstanding preconditions', async () => {
    await grantConsent({
      tenantId: fx.tenant.id,
      clientId,
      kind: REQUIRED_CONSENT.plaid,
      scope: 'first-national-bank',
      actor: actor(),
    });

    const result = await ingest({
      tenantId: fx.tenant.id,
      clientId,
      source: 'plaid',
      scope: 'first-national-bank',
      monthsRequested: 24,
      actor: actor(),
    });

    // Never an empty transaction list, which downstream would read as "this client has no
    // activity".
    expect(result.status).toBe('not_built');
    if (result.status === 'not_built') {
      expect(result.reason).toMatch(/Argus security review/i);
      expect(result.reason).toMatch(/none was invented/i);
    }

    const runs = await runsFor(fx.tenant.id, clientId);
    expect(runs.some((run) => run.status === 'not_available')).toBe(true);
  });

  it('requires the source-specific consent, not a general one', async () => {
    // A Plaid connection consent must not authorize a bureau pull: Decision A is GLBA-adjacent,
    // Decision B is FCRA-adjacent, and they are separate authorizations for that reason.
    expect(REQUIRED_CONSENT.plaid).toBe('plaid_connection');
    expect(REQUIRED_CONSENT.business_bureau).toBe('business_bureau_pull');
    expect(REQUIRED_CONSENT.personal_credit).toBe('personal_credit_pull');

    const result = await ingest({
      tenantId: fx.tenant.id,
      clientId,
      source: 'business_bureau',
      scope: 'first-national-bank',
      monthsRequested: 1,
      actor: actor(),
    });
    expect(result.status).toBe('refused');
  });
});

describe('normalized feeds and findings persist', () => {
  it('records a completed run with its coverage and provenance', async () => {
    const run = await recordNormalizedFeed(fx.tenant.id, clientId, feed(), actor());

    expect(run.status).toBe('completed');
    expect(run.monthsCovered).toBe(12);

    const completed = await readLedger({
      tenantId: fx.tenant.id,
      type: 'intelligence.ingestion_completed',
    });
    expect(completed.some((event) => event.payload['runId'] === run.id)).toBe(true);
  });

  it('persists findings and writes a ledger event per finding', async () => {
    const withAnomalies: NormalizedFeed = {
      ...feed(),
      transactions: [
        ...feed().transactions,
        {
          accountRef: 'acct-1',
          postedOn: '2026-03-10',
          amount: -35,
          description: 'NSF FEE',
          currency: 'USD',
        },
      ],
    };

    const run = await recordNormalizedFeed(fx.tenant.id, clientId, withAnomalies, actor());
    const findings = analyzeFeed(withAnomalies);
    const written = await recordFindings(fx.tenant.id, clientId, run.id, findings, actor());

    expect(written).toBeGreaterThan(0);
    expect((await findingsFor(fx.tenant.id, clientId)).some((f) => f.kind === 'nsf_event')).toBe(
      true,
    );

    const events = await readLedger({
      tenantId: fx.tenant.id,
      type: 'intelligence.finding_raised',
    });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('correlation refuses rather than inventing agreement', () => {
  const bureau = (revenue: number | null): NormalizedBureauProfile => ({
    source: 'business_bureau',
    provenance: BUREAU_PROVENANCE,
    reportedMonthlyRevenue: revenue,
    reportedMonthlyDebtService: null,
    openTradelines: 4,
    derogatoryMarks: 0,
  });

  it('refuses when the bank side is absent', () => {
    const result = correlate(null, bureau(30_000));
    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') expect(result.reason).toMatch(/not agreement/i);
  });

  it('refuses when the bureau side is absent', () => {
    const result = correlate(feed(), null);
    expect(result.status).toBe('no_data');
  });

  it('refuses when the bureau reports nothing correlatable', () => {
    // The dangerous alternative: an empty correlation list reading downstream as "checked, no
    // disagreement".
    const result = correlate(feed(), bureau(null));
    expect(result.status).toBe('no_data');
  });

  it('agrees when both sides are close', () => {
    const result = correlate(feed(), bureau(31_000));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.correlations[0]?.agrees).toBe(true);
    expect(result.value.findings).toHaveLength(0);
  });

  it('raises a disagreement finding carrying both sides', () => {
    const result = correlate(feed(), bureau(90_000));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const correlation = result.value.correlations[0];
    expect(correlation?.agrees).toBe(false);
    // Both sides are dated, because "which one was stale" is the first question anyone asks.
    expect(correlation?.bankDerived.provenance).toEqual(FEED_PROVENANCE);
    expect(correlation?.bureauReported.provenance).toEqual(BUREAU_PROVENANCE);

    expect(result.value.findings[0]?.kind).toBe('bureau_bank_disagreement');
  });

  it('flags possible undisclosed debt when the bureau shows more service than the bank', () => {
    const withDebt: NormalizedBureauProfile = {
      ...bureau(30_000),
      reportedMonthlyDebtService: 9_000,
    };

    const result = correlate(feed(), withDebt);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const finding = result.value.findings.find(
      (f) => f.detail.value['dimension'] === 'monthly_debt_service',
    );
    expect(finding?.detail.value['possibleUndisclosedDebt']).toBe(true);
  });
});

describe('missing-document detection', () => {
  it('lists what a phase needs and the vault lacks', async () => {
    const coverage = await assessCoverage(fx.tenant.id, clientId, 0);

    expect(coverage.complete).toBe(false);
    expect(coverage.missing).toContain('bank_statement');
    expect(coverage.missing).toContain('government_id');
  });

  it('produces one actionable finding per missing document', async () => {
    const coverage = await assessCoverage(fx.tenant.id, clientId, 0);
    const findings = missingDocumentFindings(coverage);

    // One each rather than one combined: a client can supply a debt schedule while an ID is
    // still outstanding, and a combined finding would stay open until the last one arrived.
    expect(findings).toHaveLength(coverage.missing.length);
    expect(findings.every((finding) => finding.kind === 'missing_document')).toBe(true);
  });

  it('marks a requirement satisfied once the document is in the vault', async () => {
    const config = {
      store: new LocalEncryptedStore(vaultRoot),
      kek: new EnvKekProvider('VAULT_INTEL_KEK'),
    };

    await storeDocument(config, {
      tenantId: fx.tenant.id,
      clientId,
      kind: 'bank_statement',
      filename: 'statement.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('synthetic statement', 'utf8'),
      actorId: fx.human.id,
    });

    const coverage = await assessCoverage(fx.tenant.id, clientId, 0);
    expect(coverage.present).toContain('bank_statement');
    expect(coverage.missing).not.toContain('bank_statement');
  });

  it('labels its own findings as derived rather than vendor-sourced', async () => {
    const coverage = await assessCoverage(fx.tenant.id, clientId, 0);
    const finding = missingDocumentFindings(coverage)[0];
    // Derived from a requirement list, not from a feed - and it says so.
    expect(finding?.detail.provenance.tag).toBe('unresearched_default');
  });
});

describe('filename classification', () => {
  it('recognises common document names', () => {
    expect(classifyByFilename('Q1-bank-statement.pdf')).toBe('bank_statement');
    expect(classifyByFilename('2025 Form 1120S.pdf')).toBe('tax_return');
    expect(classifyByFilename('drivers licence.jpg')).toBe('government_id');
    expect(classifyByFilename('Operating Agreement.pdf')).toBe('entity_document');
  });

  it('returns null rather than "other" when it cannot tell', () => {
    // "Could not classify" and "classified as miscellaneous" are different states; conflating
    // them is how an unclassified tax return ends up filed as `other`.
    expect(classifyByFilename('scan_0042.pdf')).toBeNull();
  });
});
