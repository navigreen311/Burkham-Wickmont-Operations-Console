/**
 * Invariants for the Lender Intelligence Database - 5.2.
 *
 * The catalogue's job is to hold what we know about providers in a form that cannot present
 * a researched rule and an assumption alike. Decision D is the subject of most of this file.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MINIMUM_OUTCOMES_FOR_RATE,
  V1_5_DEFERRED_CREDIT_UNIONS,
  V1_APPROVED_CREDIT_UNIONS,
  addOffering,
  advanceResearch,
  appetiteHistory,
  approvalRate,
  catalogue,
  currentAppetite,
  currentRules,
  isWithinV1CreditUnionScope,
  linkPromotedProvider,
  listProviders,
  profileKey,
  recordAppetite,
  recordOutcome,
  recordRule,
  registerProvider,
  researchWorkstreams,
  ruleHistory,
  seedDeferredCreditUnionResearch,
  unresearchedRules,
} from '@bwc/lenders';
import { read } from '@bwc/ledger';
import { describeProvenance, isUnverified, type Provenance } from '@bwc/core';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('lenders');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

const ISSUER: Provenance = {
  tag: 'issuer_rule',
  sourceUrl: 'https://example-bank.test/business-card-terms',
  lastVerified: '2026-08-01T00:00:00.000Z',
  verifiedBy: 'compliance@burkhamwickmont.test',
};

const ASSUMED: Provenance = {
  tag: 'unresearched_default',
  rationale:
    'Consistent with peer issuers of comparable size; not confirmed against published terms.',
};

const newProvider = async (name: string, kind = 'national_bank' as const) => {
  const result = await registerProvider({
    tenantId: fx.tenant.id,
    name,
    kind,
    statesServed: ['*'],
    actor: actor(),
  });
  if (result.status !== 'ok') throw new Error(`fixture provider failed: ${result.status}`);
  return result.value;
};

describe('provider catalogue', () => {
  it('refuses an empty state list rather than storing an ambiguous one', () => {
    // An empty array reads identically to "nobody filled this in", and the two would be
    // indistinguishable forever afterwards.
    return expect(
      registerProvider({
        tenantId: fx.tenant.id,
        name: 'Ambiguous Bank',
        kind: 'national_bank',
        statesServed: [],
        actor: actor(),
      }),
    ).resolves.toMatchObject({ status: 'refused' });
  });

  it('filters by state, admitting nationwide providers', async () => {
    await newProvider('Nationwide Bank');
    const regional = await registerProvider({
      tenantId: fx.tenant.id,
      name: 'Regional Bank of Texas',
      kind: 'national_bank',
      statesServed: ['TX'],
      actor: actor(),
    });
    expect(regional.status).toBe('ok');

    const inTexas = await listProviders(fx.tenant.id, { state: 'TX' });
    const names = inTexas.map((provider) => provider.name);
    expect(names).toContain('Nationwide Bank');
    expect(names).toContain('Regional Bank of Texas');

    const inMaine = await listProviders(fx.tenant.id, { state: 'ME' });
    expect(inMaine.map((p) => p.name)).not.toContain('Regional Bank of Texas');
    expect(inMaine.map((p) => p.name)).toContain('Nationwide Bank');
  });
});

describe('provenance on every rule - Decision D', () => {
  it('carries an issuer rule through storage and back, with its source', async () => {
    const provider = await newProvider('Provenance Bank');

    const written = await recordRule({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      ruleKey: 'velocity.cards_per_6_months',
      ruleValue: '2',
      provenance: ISSUER,
      actor: actor(),
    });

    expect(written.status).toBe('ok');
    if (written.status !== 'ok') return;

    expect(written.value.value.provenance.tag).toBe('issuer_rule');
    expect(describeProvenance(written.value.value.provenance)).toMatch(/verified 2026-08-01/);
    expect(isUnverified(written.value.value.provenance)).toBe(false);
  });

  it('renders an unresearched default so a client is told it is an assumption', async () => {
    const provider = await newProvider('Assumption Bank');
    const written = await recordRule({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      ruleKey: 'inquiry.tolerance_12_months',
      ruleValue: '6',
      provenance: ASSUMED,
      actor: actor(),
    });

    expect(written.status).toBe('ok');
    if (written.status !== 'ok') return;

    expect(isUnverified(written.value.value.provenance)).toBe(true);
    expect(describeProvenance(written.value.value.provenance)).toMatch(
      /not verified against the issuer/i,
    );
  });

  it('answers "what are we telling clients that nobody verified" in one query', async () => {
    // The reason provenance is a column and not a field inside a JSON blob.
    const unverified = await unresearchedRules(fx.tenant.id);
    expect(unverified.length).toBeGreaterThan(0);
    for (const rule of unverified) {
      expect(rule.value.provenance.tag).toBe('unresearched_default');
    }
  });

  it('refuses a rule with no content', async () => {
    const provider = await newProvider('Empty Rule Bank');
    const result = await recordRule({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      ruleKey: 'velocity.cards_per_6_months',
      ruleValue: '   ',
      provenance: ISSUER,
      actor: actor(),
    });
    expect(result.status).toBe('refused');
  });
});

describe('rules supersede rather than overwrite', () => {
  it('keeps the prior version readable and marks when it stopped applying', async () => {
    // A rule current in March has to remain explicable when it justifies a March
    // recommendation. An UPDATE would destroy that.
    const provider = await newProvider('Superseding Bank');

    await recordRule({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      ruleKey: 'velocity.cards_per_6_months',
      ruleValue: '2',
      provenance: ASSUMED,
      actor: actor(),
    });

    await recordRule({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      ruleKey: 'velocity.cards_per_6_months',
      ruleValue: '3',
      provenance: ISSUER,
      actor: actor(),
    });

    const history = await ruleHistory(fx.tenant.id, provider.id, 'velocity.cards_per_6_months');

    expect(history).toHaveLength(2);
    expect(history[0]?.version).toBe(2);
    expect(history[0]?.supersededAt).toBeNull();
    expect(history[1]?.version).toBe(1);
    expect(history[1]?.supersededAt).not.toBeNull();
    // The superseded version keeps its own provenance - it was an assumption at the time,
    // and rewriting history to say otherwise would be the failure this design prevents.
    expect(history[1]?.value.provenance.tag).toBe('unresearched_default');

    const current = await currentRules(fx.tenant.id, provider.id);
    expect(current).toHaveLength(1);
    expect(current[0]?.value.value).toBe('3');
  });

  it('logs every rule change to the Ledger with its provenance tag', async () => {
    // Specification: "every rule change logged with source, verification method,
    // lastVerified timestamp."
    const events = await read({ tenantId: fx.tenant.id, type: 'lender.rule.recorded' });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.payload['provenanceTag']).toBeDefined();
      expect(event.payload['ruleKey']).toBeDefined();
    }
  });
});

describe('product offerings', () => {
  it('refuses an offering quoted as both an APR and a factor rate', async () => {
    // A factor rate is not a rate. Carrying both would make 5.6 pick one, and whichever it
    // picked would be wrong for some caller.
    const provider = await newProvider('Double Quote Capital', 'mca_provider');
    const result = await addOffering({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      name: 'Advance',
      productKind: 'merchant_cash_advance',
      minAmount: 10_000,
      maxAmount: 200_000,
      repaymentStructure: 'daily remittance',
      feeModel: 'factor',
      typicalAnnualRate: 0.45,
      typicalFactorRate: 1.35,
      provenance: ISSUER,
      actor: actor(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/factor rate is not a rate/i);
  });

  it('refuses a box whose minimum exceeds its maximum', async () => {
    const provider = await newProvider('Impossible Box Bank');
    const result = await addOffering({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      name: 'Impossible Line',
      productKind: 'line_of_credit',
      minAmount: 500_000,
      maxAmount: 100_000,
      repaymentStructure: 'revolving',
      feeModel: 'none',
      provenance: ISSUER,
      actor: actor(),
    });
    expect(result.status).toBe('refused');
  });

  it('appears in the catalogue with its provider', async () => {
    const provider = await newProvider('Catalogue Bank');
    await addOffering({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      name: 'Working Capital Line',
      productKind: 'line_of_credit',
      minAmount: 25_000,
      maxAmount: 250_000,
      repaymentStructure: 'revolving, interest on drawn balance',
      feeModel: 'annual fee waived year one',
      typicalAnnualRate: 0.1199,
      provenance: ISSUER,
      actor: actor(),
    });

    const entries = await catalogue(fx.tenant.id);
    const entry = entries.find((candidate) => candidate.offering.name === 'Working Capital Line');
    expect(entry?.provider.name).toBe('Catalogue Bank');
    expect(entry?.offering.typicalAnnualRate).toBeCloseTo(0.1199, 6);
    expect(entry?.offering.provenance.tag).toBe('issuer_rule');
  });
});

describe('appetite signals', () => {
  it('reports no data rather than defaulting to steady', async () => {
    // "We have never looked" is materially different information from "we looked and it was
    // normal", and a default would make the two indistinguishable.
    const provider = await newProvider('Unobserved Bank');
    const result = await currentAppetite(fx.tenant.id, provider.id);
    expect(result.status).toBe('no_data');
  });

  it('marks a reading stale once it is past the weekly cadence', async () => {
    const provider = await newProvider('Tightening Bank');
    await recordAppetite({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      signal: 'tightening',
      note: 'Declines rising on files that would have cleared in Q1.',
      observedBy: 'funding-strategy-agent',
      observedAt: new Date('2026-07-01T00:00:00.000Z'),
      actor: actor(),
    });

    const fresh = await currentAppetite(
      fx.tenant.id,
      provider.id,
      new Date('2026-07-08T00:00:00.000Z'),
    );
    expect(fresh.status).toBe('ok');
    if (fresh.status === 'ok') expect(fresh.value.stale).toBe(false);

    const stale = await currentAppetite(
      fx.tenant.id,
      provider.id,
      new Date('2026-08-01T00:00:00.000Z'),
    );
    if (stale.status === 'ok') {
      expect(stale.value.stale).toBe(true);
      expect(stale.value.ageDays).toBe(31);
    }
  });

  it('keeps the history so a trend is visible, not just the latest state', async () => {
    const provider = await newProvider('Trending Bank');
    for (const [index, signal] of (['expanding', 'steady', 'tightening'] as const).entries()) {
      await recordAppetite({
        tenantId: fx.tenant.id,
        providerId: provider.id,
        signal,
        note: `week ${index + 1}`,
        observedBy: 'funding-strategy-agent',
        observedAt: new Date(Date.UTC(2026, 6, 1 + index * 7)),
        actor: actor(),
      });
    }

    const history = await appetiteHistory(fx.tenant.id, provider.id);
    expect(history.map((entry) => entry.signal)).toEqual(['tightening', 'steady', 'expanding']);
  });
});

describe('approval rate refuses to be a number computed from too little', () => {
  it('returns null below the minimum sample and says why', async () => {
    // Two of three is "67%" arithmetically and nothing at all statistically. A memo carrying
    // it would be more confident than the knowledge underneath it.
    const provider = await newProvider('Thin History Bank');
    for (const outcome of ['approved', 'approved', 'declined'] as const) {
      await recordOutcome({
        tenantId: fx.tenant.id,
        providerId: provider.id,
        productKind: 'line_of_credit',
        clientProfileKey: 'revenue:250k-1m|tib:24-59|fico:700-749',
        outcome,
        decidedAt: new Date('2026-06-01T00:00:00.000Z'),
        actor: actor(),
      });
    }

    const rate = await approvalRate({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      productKind: 'line_of_credit',
    });

    expect(rate.rate).toBeNull();
    expect(rate.decidedCount).toBe(3);
    expect(rate.note).toMatch(new RegExp(`${MINIMUM_OUTCOMES_FOR_RATE} are needed`));
  });

  it('reports a rate once there is enough, excluding withdrawals from the denominator', async () => {
    // A withdrawn application was never decided; counting it against the provider would make
    // them look worse the more clients changed their minds.
    const provider = await newProvider('Deep History Bank');
    const outcomes = [
      ...Array<'approved'>(6).fill('approved'),
      ...Array<'declined'>(4).fill('declined'),
      ...Array<'withdrawn'>(3).fill('withdrawn'),
    ];

    for (const outcome of outcomes) {
      await recordOutcome({
        tenantId: fx.tenant.id,
        providerId: provider.id,
        productKind: 'term_loan',
        clientProfileKey: 'revenue:1m-5m|tib:gte60|fico:gte750',
        outcome,
        decidedAt: new Date('2026-06-01T00:00:00.000Z'),
        actor: actor(),
      });
    }

    const rate = await approvalRate({
      tenantId: fx.tenant.id,
      providerId: provider.id,
      productKind: 'term_loan',
    });

    expect(rate.decidedCount).toBe(10);
    expect(rate.rate).toBeCloseTo(0.6, 6);
  });

  it('buckets profiles coarsely enough to avoid a cohort of one', () => {
    // A finer key gives every client their own cohort, and a cohort of one produces rates of
    // exactly 0% or 100% - numbers that look like knowledge and are noise.
    const a = profileKey({
      annualRevenue: 900_000,
      timeInBusinessMonths: 30,
      personalCreditScore: 720,
    });
    const b = profileKey({
      annualRevenue: 950_000,
      timeInBusinessMonths: 36,
      personalCreditScore: 735,
    });
    expect(a).toBe(b);

    const unknown = profileKey({
      annualRevenue: null,
      timeInBusinessMonths: null,
      personalCreditScore: null,
    });
    expect(unknown).toBe('revenue:unknown|tib:unknown|fico:unknown');
  });
});

describe('the V1.5 credit-union research workstream - Decision D', () => {
  it('names Navy Federal as the only V1-scope credit union', () => {
    expect(V1_APPROVED_CREDIT_UNIONS).toEqual(['Navy Federal Credit Union']);
    expect(V1_5_DEFERRED_CREDIT_UNIONS).toHaveLength(5);
    expect(V1_5_DEFERRED_CREDIT_UNIONS).toContain('Alliant Credit Union');
    expect(V1_5_DEFERRED_CREDIT_UNIONS).toContain('Lake Michigan Credit Union');
  });

  it('restricts credit unions specifically, not every provider kind', () => {
    expect(isWithinV1CreditUnionScope('credit_union', 'Navy Federal Credit Union')).toBe(true);
    expect(isWithinV1CreditUnionScope('credit_union', 'PenFed Credit Union')).toBe(false);
    // Card issuers, national banks and fintech LOCs are in V1 scope by the blueprint's own
    // "V1 lender scope" line, so the check must not sweep them up.
    expect(isWithinV1CreditUnionScope('card_issuer', 'Anything')).toBe(true);
    expect(isWithinV1CreditUnionScope('fintech_loc', 'Anything')).toBe(true);
  });

  it('seeds the five deferred credit unions as trackable workstreams', async () => {
    // Blueprint 5.2 requires V1.5 progress to be trackable, and a workstream nobody created
    // cannot be behind schedule.
    const opened = await seedDeferredCreditUnionResearch(
      fx.tenant.id,
      actor(),
      'research@burkhamwickmont.test',
    );
    expect(opened).toBe(5);

    const workstreams = await researchWorkstreams(fx.tenant.id);
    expect(workstreams.map((entry) => entry.providerName).sort()).toEqual(
      [...V1_5_DEFERRED_CREDIT_UNIONS].sort(),
    );
    for (const entry of workstreams) {
      expect(entry.assignedTo).toBe('research@burkhamwickmont.test');
      expect(entry.status).toBe('not_started');
    }
  });

  it('is idempotent, so a re-seed does not duplicate a workstream', async () => {
    await seedDeferredCreditUnionResearch(fx.tenant.id, actor());
    const workstreams = await researchWorkstreams(fx.tenant.id);
    expect(workstreams).toHaveLength(5);
  });

  it('does not create a provider when research completes', async () => {
    // Finishing the research means we now know PenFed's rules. It does not mean anyone
    // decided to place clients there - auto-promotion would let a researcher silently widen
    // V1's lender scope by saving their notes.
    await advanceResearch({
      tenantId: fx.tenant.id,
      providerName: 'PenFed Credit Union',
      status: 'complete',
      actor: actor(),
    });

    const providers = await listProviders(fx.tenant.id, { kind: 'credit_union' });
    expect(providers.map((provider) => provider.name)).not.toContain('PenFed Credit Union');
  });

  it('refuses to link a provider while research is unfinished', async () => {
    const alliant = await linkPromotedProvider({
      tenantId: fx.tenant.id,
      providerName: 'Alliant Credit Union',
      providerId: '00000000-0000-4000-8000-000000000001',
      actor: actor(),
    });

    expect(alliant.status).toBe('refused');
    if (alliant.status === 'refused') expect(alliant.principle).toMatch(/Decision D/);
  });

  it('links a completed workstream to the provider record made from it', async () => {
    const provider = await newProvider('PenFed Credit Union', 'credit_union');
    const linked = await linkPromotedProvider({
      tenantId: fx.tenant.id,
      providerName: 'PenFed Credit Union',
      providerId: provider.id,
      actor: actor(),
      now: new Date('2026-08-10T00:00:00.000Z'),
    });

    expect(linked.status).toBe('ok');
    if (linked.status === 'ok') expect(linked.value.promotedProviderId).toBe(provider.id);
  });
});
