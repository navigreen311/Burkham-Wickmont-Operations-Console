/**
 * 5.3 Funding Recommendation Engine, end to end.
 *
 * The loop the three modules close: the catalogue holds providers (5.2), the board decides
 * which may be recommended (5.4), the engine recommends from what survives (5.3). Any two of
 * them is a system with a hole in it, so this is the test that exercises all three together
 * against a real database.
 *
 * The scenario is a deliberately awkward one, because the interesting behaviour is in the
 * rejections: one provider approved and fitting, one blacklisted, one approved but overdue,
 * one whose box the client misses, one credit union outside V1 scope, and one product that
 * fits the box but is wrong for the need.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { grant as grantConsent } from '@bwc/consent';
import { read } from '@bwc/ledger';
import { addOffering, registerProvider, type ClientProfile } from '@bwc/lenders';
import { approve, blacklist, submitForReview } from '@bwc/governance';
import { rankCandidates, requestRecommendation } from '@bwc/placement';
import type { Provenance } from '@bwc/core';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('recommendation');
  await buildCatalogue();
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });
const TODAY = new Date('2026-08-10T00:00:00.000Z');

const ISSUER: Provenance = {
  tag: 'issuer_rule',
  sourceUrl: 'https://example.test/terms',
  lastVerified: '2026-08-01T00:00:00.000Z',
  verifiedBy: 'compliance@burkhamwickmont.test',
};

const ASSUMED: Provenance = {
  tag: 'unresearched_default',
  rationale: 'Modelled on peer issuers; not confirmed against published terms.',
};

const provider = async (
  name: string,
  kind: 'national_bank' | 'mca_provider' | 'credit_union' | 'fintech_loc',
  statesServed: readonly string[],
): Promise<string> => {
  const result = await registerProvider({
    tenantId: fx.tenant.id,
    name,
    kind,
    statesServed,
    actor: actor(),
  });
  if (result.status !== 'ok') throw new Error(`fixture provider ${name} failed`);
  return result.value.id;
};

/**
 * The catalogue every case below runs against. Built once, because the scenario is the
 * fixture - each test asks a different question of the same world.
 */
const buildCatalogue = async (): Promise<void> => {
  // 1. Approved, fits, and the right product for the need.
  const good = await provider('Meridian National Bank', 'national_bank', ['*']);
  await addOffering({
    tenantId: fx.tenant.id,
    providerId: good,
    name: 'Business Line of Credit',
    productKind: 'line_of_credit',
    minAmount: 25_000,
    maxAmount: 250_000,
    minTimeInBusinessMonths: 24,
    minAnnualRevenue: 500_000,
    minPersonalCreditScore: 680,
    repaymentStructure: 'revolving; interest on the drawn balance',
    feeModel: 'no annual fee',
    typicalAnnualRate: 0.1149,
    provenance: ISSUER,
    actor: actor(),
  });
  await submitForReview({
    tenantId: fx.tenant.id,
    providerId: good,
    submittedBy: 'funding-strategy',
    rationale: 'Published terms and an existing broker agreement.',
    actor: actor(),
  });
  await approve({
    tenantId: fx.tenant.id,
    providerId: good,
    approvedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Terms verified; no open complaints.',
    requiredDisclosures: ['Burkham Wickmont is not a lender and does not make credit decisions.'],
    actor: actor(),
    now: new Date('2026-08-01T00:00:00.000Z'),
  });

  // 2. Approved, fits the box, but the product works against the need.
  const advance = await provider('Swiftline Capital', 'mca_provider', ['*']);
  await addOffering({
    tenantId: fx.tenant.id,
    providerId: advance,
    name: 'Revenue Advance',
    productKind: 'merchant_cash_advance',
    minAmount: 25_000,
    maxAmount: 250_000,
    minTimeInBusinessMonths: 6,
    minAnnualRevenue: 250_000,
    repaymentStructure: 'daily remittance over an estimated 9 months',
    feeModel: '1.38 factor plus a 3% origination fee',
    typicalFactorRate: 1.38,
    provenance: ASSUMED,
    actor: actor(),
  });
  await approve({
    tenantId: fx.tenant.id,
    providerId: advance,
    approvedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Approved for use where no cheaper option is available; disclosure required.',
    requiredDisclosures: ['Advance pricing is expressed as a factor rate, not an interest rate.'],
    actor: actor(),
    now: new Date('2026-08-01T00:00:00.000Z'),
  });

  // 3. Blacklisted.
  const banned = await provider('Fee Curtain Capital', 'mca_provider', ['*']);
  await addOffering({
    tenantId: fx.tenant.id,
    providerId: banned,
    name: 'Fast Advance',
    productKind: 'merchant_cash_advance',
    minAmount: 10_000,
    maxAmount: 500_000,
    repaymentStructure: 'daily remittance',
    feeModel: 'factor',
    typicalFactorRate: 1.49,
    provenance: ASSUMED,
    actor: actor(),
  });
  await approve({
    tenantId: fx.tenant.id,
    providerId: banned,
    approvedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Approved initially.',
    actor: actor(),
    now: new Date('2026-06-01T00:00:00.000Z'),
  });
  await blacklist({
    tenantId: fx.tenant.id,
    providerId: banned,
    decidedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Undisclosed origination fees across three client files.',
    actor: actor(),
  });

  // 4. Approved a long time ago and never re-reviewed.
  const stale = await provider('Dormant Trust Bank', 'national_bank', ['*']);
  await addOffering({
    tenantId: fx.tenant.id,
    providerId: stale,
    name: 'Operating Line',
    productKind: 'line_of_credit',
    minAmount: 25_000,
    maxAmount: 300_000,
    minTimeInBusinessMonths: 12,
    repaymentStructure: 'revolving',
    feeModel: 'annual fee',
    typicalAnnualRate: 0.0899,
    provenance: ISSUER,
    actor: actor(),
  });
  await approve({
    tenantId: fx.tenant.id,
    providerId: stale,
    approvedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Approved in January.',
    actor: actor(),
    now: new Date('2026-01-05T00:00:00.000Z'),
  });

  // 5. Approved and fits nothing - the box is out of reach.
  const strict = await provider('Highbar Commercial Bank', 'national_bank', ['*']);
  await addOffering({
    tenantId: fx.tenant.id,
    providerId: strict,
    name: 'Commercial Credit Facility',
    productKind: 'line_of_credit',
    minAmount: 500_000,
    maxAmount: 5_000_000,
    minTimeInBusinessMonths: 60,
    minAnnualRevenue: 10_000_000,
    minPersonalCreditScore: 760,
    repaymentStructure: 'revolving with covenants',
    feeModel: 'commitment fee',
    typicalAnnualRate: 0.0725,
    provenance: ISSUER,
    actor: actor(),
  });
  await approve({
    tenantId: fx.tenant.id,
    providerId: strict,
    approvedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Approved for larger files.',
    actor: actor(),
    now: new Date('2026-08-01T00:00:00.000Z'),
  });

  // 6. A credit union outside V1 scope. Registered - that is the V1.5 research - and never
  // approvable, so it must never reach a recommendation.
  const cu = await provider('Alliant Credit Union', 'credit_union', ['*']);
  await addOffering({
    tenantId: fx.tenant.id,
    providerId: cu,
    name: 'Member Business Line',
    productKind: 'line_of_credit',
    minAmount: 10_000,
    maxAmount: 250_000,
    minTimeInBusinessMonths: 12,
    repaymentStructure: 'revolving',
    feeModel: 'none',
    typicalAnnualRate: 0.0699,
    provenance: ASSUMED,
    actor: actor(),
  });
};

const profile = (overrides: Partial<ClientProfile> = {}): ClientProfile => ({
  clientId: 'client-under-test',
  state: 'TX',
  timeInBusinessMonths: 48,
  annualRevenue: 1_200_000,
  personalCreditScore: 730,
  industry: 'Professional Services',
  need: 'working_capital',
  requestedAmount: 100_000,
  ...overrides,
});

describe('ranking', () => {
  it('recommends the approved, eligible, well-suited option first', async () => {
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.recommendations[0]?.provider.value).toBe('Meridian National Bank');
    expect(result.value.recommendations[0]?.suitability.score).toBe(3);
  });

  it('never recommends a blacklisted provider, and says why it was rejected', async () => {
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    expect(result.value.recommendations.map((r) => r.provider.value)).not.toContain(
      'Fee Curtain Capital',
    );

    const rejection = result.value.rejected.find((r) => r.providerName === 'Fee Curtain Capital');
    expect(rejection?.stage).toBe('governance');
    expect(rejection?.reason).toMatch(/undisclosed origination fees/i);
  });

  it('never recommends a provider whose review lapsed', async () => {
    // The behaviour that needs no job to run: Dormant Trust was approved in January and is
    // simply past its cadence when asked about in August.
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    const rejection = result.value.rejected.find((r) => r.providerName === 'Dormant Trust Bank');
    expect(rejection?.stage).toBe('governance');
    expect(rejection?.reason).toMatch(/past the 90-day cadence/);
  });

  it('never recommends a credit union outside V1 scope', async () => {
    // Alliant is in the catalogue with an attractive rate and a box the client fits. The only
    // thing keeping it out is that Decision D will not let the board approve it - which is
    // exactly where the restriction is supposed to bite.
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    expect(result.value.recommendations.map((r) => r.provider.value)).not.toContain(
      'Alliant Credit Union',
    );

    const rejection = result.value.rejected.find((r) => r.providerName === 'Alliant Credit Union');
    expect(rejection?.stage).toBe('governance');
    expect(rejection?.reason).toMatch(/never reviewed this provider/i);
  });

  it('rejects on the box with a reason naming the dimension', async () => {
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    const rejection = result.value.rejected.find(
      (r) => r.providerName === 'Highbar Commercial Bank',
    );
    expect(rejection?.stage).toBe('eligibility');
    expect(rejection?.reason).toMatch(
      /exceeds the \$5,000,000 maximum|below the \$500,000 minimum/,
    );
    expect(rejection?.reason).toMatch(/60 months in business/);
    expect(rejection?.reason).toMatch(/10,000,000 annual revenue/);
  });

  it('keeps a poorly-suited product with a caution rather than hiding it', async () => {
    // A client with no other option may still take an advance, and is entitled to be told
    // why it is a poor fit rather than to have it quietly removed.
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    const advance = result.value.recommendations.find(
      (r) => r.provider.value === 'Swiftline Capital',
    );
    expect(advance).toBeDefined();
    expect(advance?.suitability.caution).toBe(true);
    expect(advance?.rationale).toMatch(/works against a working capital need/i);
    // It ranks last precisely because it is a caution.
    expect(result.value.recommendations.at(-1)?.provider.value).toBe('Swiftline Capital');
  });

  it('labels an unresearched default in the client-facing rationale - Decision D', async () => {
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    const advance = result.value.recommendations.find(
      (r) => r.provider.value === 'Swiftline Capital',
    );
    expect(advance?.containsUnverifiedInputs).toBe(true);
    expect(advance?.rationale).toMatch(/rest on an unresearched default/i);
    expect(advance?.provenanceNotes[0]).toMatch(/not verified against the issuer/i);

    const verified = result.value.recommendations.find(
      (r) => r.provider.value === 'Meridian National Bank',
    );
    expect(verified?.containsUnverifiedInputs).toBe(false);
  });

  it('carries the governance disclosures onto the recommendation', async () => {
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    expect(result.value.recommendations[0]?.requiredDisclosures[0]).toMatch(/not a lender/i);
  });

  it('reorders when the need changes, without any change to eligibility', async () => {
    // The mismatch no underwriting box catches. Same client, same providers, same boxes -
    // only the reason for the money is different.
    const gap = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile({ need: 'receivables_gap' }),
      today: TODAY,
    });
    if (gap.status !== 'ok') throw new Error('expected a recommendation set');

    expect(gap.value.recommendations[0]?.provider.value).toBe('Meridian National Bank');
    expect(gap.value.recommendations[0]?.suitability.score).toBe(2);

    const advance = gap.value.recommendations.find((r) => r.provider.value === 'Swiftline Capital');
    // An advance is a 0 against a receivables gap - poor, but not a caution the way it is
    // against working capital.
    expect(advance?.suitability.caution).toBe(false);
  });

  it('names the missing fields when an incomplete file is what emptied the list', async () => {
    // Written expecting a recommendation set, and it returned no_data - correctly, because
    // with revenue and score blank every provider resolves to `unknown` and nothing
    // survives. The bug the failure exposed was in the message, not the verdict: "none
    // survived" reads as "there is nothing for this client" when four providers are one
    // recorded field away.
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile({ annualRevenue: null, personalCreditScore: null }),
      today: TODAY,
    });

    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') {
      expect(result.reason).toMatch(/left unresolved rather than rejected/);
      expect(result.reason).toMatch(/annual revenue/);
      expect(result.reason).toMatch(/personal credit score/);
    }
  });

  it('carries the missing fields on a successful set too, for a partially complete file', async () => {
    // One field blank, and a provider that does not ask for it still resolves - so the set
    // is non-empty and the missing field is still worth surfacing.
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile({ personalCreditScore: null }),
      today: TODAY,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.recommendations.length).toBeGreaterThan(0);
    expect(result.value.missingProfileFields).toContain('personal_credit_score');
  });

  it('counts options ranked below the limit as rejected alternatives', async () => {
    // A memo claiming three options were considered when six were is a smaller lie than an
    // empty list, and still a lie.
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      profile: profile(),
      today: TODAY,
      limit: 1,
    });
    if (result.status !== 'ok') throw new Error('expected a recommendation set');

    expect(result.value.recommendations).toHaveLength(1);
    expect(result.value.rejected.some((r) => r.stage === 'suitability')).toBe(true);
  });

  it('returns no_data with the tally when nothing survives', async () => {
    const result = await rankCandidates({
      tenantId: fx.tenant.id,
      // A state nobody serves, so every provider falls at governance or eligibility.
      profile: profile({ requestedAmount: 25 }),
      today: TODAY,
    });

    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') {
      expect(result.reason).toMatch(/offering\(s\) were considered and none survived/);
      expect(result.reason).toMatch(/at governance|at eligibility/);
    }
  });
});

describe('the full request path', () => {
  it('passes the gate, the authorization and the catalogue, and records the outcome', async () => {
    const client = await createClient(fx.tenant.id, 'Recommendation Test Co', actor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'pass',
      reason: 'test fixture',
      actor: actor(),
    });
    await grantConsent({
      tenantId: fx.tenant.id,
      clientId: client.id,
      kind: 'application',
      scope: 'app-recommend',
      actor: actor(),
    });

    const { result, trace } = await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-recommend',
      profile: profile({ clientId: client.id }),
      today: TODAY,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(trace.find((step) => step.step === 'firewall')?.outcome).not.toBe('blocked');
    expect(result.value.recommendations.recommendations.length).toBeGreaterThan(0);

    const events = await read({ tenantId: fx.tenant.id, type: 'placement.recommended' });
    const event = events.find((entry) => entry.clientId === client.id);
    expect(event).toBeDefined();
    expect(event?.payload['containsUnverifiedInputs']).toBe(true);
  });

  it('never writes client attributes into the Ledger', async () => {
    // The recommendation is computed from revenue and a credit score. Neither may reach the
    // event payload - the Ledger is the one store that cannot be corrected after the fact.
    const events = await read({ tenantId: fx.tenant.id, type: 'placement.recommended' });
    for (const event of events) {
      const serialized = JSON.stringify(event.payload);
      expect(serialized).not.toMatch(/1200000|1_200_000/);
      expect(serialized).not.toMatch(/730/);
      expect(serialized).not.toMatch(/annualRevenue|personalCreditScore/);
    }
  });

  it('still refuses at the gate, whatever the catalogue holds', async () => {
    // The property the walking skeleton was built to guarantee. Adding a working
    // recommendation must not have created a path around the firewall.
    const blocked = await createClient(fx.tenant.id, 'Blocked Co', actor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: blocked.id,
      to: 'fail',
      reason: 'test fixture',
      actor: actor(),
    });
    await grantConsent({
      tenantId: fx.tenant.id,
      clientId: blocked.id,
      kind: 'application',
      scope: 'app-blocked',
      actor: actor(),
    });

    const { result } = await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: blocked.id,
      applicationRef: 'app-blocked',
      profile: profile({ clientId: blocked.id }),
      today: TODAY,
    });

    expect(result.status).toBe('refused');
  });
});
