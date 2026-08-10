/**
 * Invariants for the Funding Product Eligibility Rules and the Suitability Matrix - 5.2.
 *
 * Pure functions, so no database and no fixture. These are the parts of a recommendation an
 * operator can argue with, and the parts most worth testing exhaustively: every other stage
 * of 5.3 is a filter, and this is the stage that decides what a client is told about why.
 */

import { describe, expect, it } from 'vitest';
import {
  PRODUCT_KINDS,
  SUITABILITY_MATRIX,
  assessSuitability,
  evaluateEligibility,
  missingProfileFields,
  rankProductsForNeed,
  CAPITAL_NEEDS,
  type ClientProfile,
  type UnderwritingBox,
} from '@bwc/lenders';

const box = (overrides: Partial<UnderwritingBox> = {}): UnderwritingBox => ({
  offeringId: 'off-1',
  providerName: 'Example Bank',
  offeringName: 'Business Line of Credit',
  minAmount: 25_000,
  maxAmount: 250_000,
  minTimeInBusinessMonths: 24,
  minAnnualRevenue: 500_000,
  minPersonalCreditScore: 680,
  excludedIndustries: [],
  statesServed: ['*'],
  ...overrides,
});

const profile = (overrides: Partial<ClientProfile> = {}): ClientProfile => ({
  clientId: 'client-1',
  state: 'TX',
  timeInBusinessMonths: 48,
  annualRevenue: 1_200_000,
  personalCreditScore: 730,
  industry: 'Professional Services',
  need: 'working_capital',
  requestedAmount: 100_000,
  ...overrides,
});

describe('eligibility', () => {
  it('passes a client inside every dimension of the box', () => {
    const result = evaluateEligibility(box(), profile());
    expect(result.verdict).toBe('eligible');
    expect(result.reasons).toHaveLength(0);
  });

  it('reports every failing dimension, not just the first', () => {
    // Stopping at the first failure is cheaper and sends the client away to fix the wrong
    // thing - back again in six months for the reason nobody mentioned.
    const result = evaluateEligibility(
      box(),
      profile({ timeInBusinessMonths: 6, annualRevenue: 90_000, personalCreditScore: 590 }),
    );

    expect(result.verdict).toBe('ineligible');
    expect(result.reasons.map((reason) => reason.dimension).sort()).toEqual([
      'annual_revenue',
      'personal_credit_score',
      'time_in_business',
    ]);
  });

  it('names the shortfall in words a memo can use', () => {
    const result = evaluateEligibility(box(), profile({ timeInBusinessMonths: 14 }));
    const reason = result.reasons.find((r) => r.dimension === 'time_in_business');
    expect(reason?.detail).toMatch(/requires 24 months in business; the entity is at 14/);
  });

  it('treats a missing field as unknown rather than as a zero that fails', () => {
    // The common state of a client file early in an engagement. Reading a blank revenue as
    // zero would disqualify every provider and present as "you do not qualify".
    const result = evaluateEligibility(box(), profile({ annualRevenue: null }));

    expect(result.verdict).toBe('unknown');
    expect(result.reasons[0]?.verdict).toBe('unknown');
    expect(result.reasons[0]?.detail).toMatch(/revenue is not recorded/i);
  });

  it('lets ineligible outrank unknown', () => {
    // Filling in the revenue cannot make a provider serve a state it does not serve, so
    // reporting "unknown" would send someone off to gather data that cannot help.
    const result = evaluateEligibility(
      box({ statesServed: ['CA'] }),
      profile({ annualRevenue: null }),
    );
    expect(result.verdict).toBe('ineligible');
  });

  it('distinguishes no published threshold from a threshold of zero', () => {
    // A provider that publishes no minimum score must not be treated as requiring 0 - the
    // two are the same arithmetically and different in what they say about the provider.
    const result = evaluateEligibility(
      box({ minPersonalCreditScore: null }),
      profile({ personalCreditScore: null }),
    );
    expect(result.verdict).toBe('eligible');
  });

  it('rejects an amount below the minimum and above the maximum, separately', () => {
    expect(
      evaluateEligibility(box(), profile({ requestedAmount: 5_000 })).reasons[0]?.detail,
    ).toMatch(/below the \$25,000 minimum/);
    expect(
      evaluateEligibility(box(), profile({ requestedAmount: 900_000 })).reasons[0]?.detail,
    ).toMatch(/exceeds the \$250,000 maximum/);
  });

  it('matches an excluded industry case-insensitively', () => {
    const result = evaluateEligibility(
      box({ excludedIndustries: ['Cannabis', 'Firearms'] }),
      profile({ industry: 'cannabis' }),
    );
    expect(result.verdict).toBe('ineligible');
    expect(result.reasons[0]?.detail).toMatch(/does not fund Cannabis/);
  });

  it('honours the nationwide sentinel', () => {
    expect(
      evaluateEligibility(box({ statesServed: ['*'] }), profile({ state: 'AK' })).verdict,
    ).toBe('eligible');
    expect(
      evaluateEligibility(box({ statesServed: ['TX', 'OK'] }), profile({ state: 'AK' })).verdict,
    ).toBe('ineligible');
  });

  it('collects what is missing across offerings, deduplicated', () => {
    // The operator-facing inverse of a short list: record the revenue and several providers
    // resolve at once.
    const results = [
      evaluateEligibility(box({ offeringId: 'a' }), profile({ annualRevenue: null })),
      evaluateEligibility(box({ offeringId: 'b' }), profile({ annualRevenue: null })),
      evaluateEligibility(box({ offeringId: 'c' }), profile({ personalCreditScore: null })),
    ];

    expect([...missingProfileFields(results)].sort()).toEqual([
      'annual_revenue',
      'personal_credit_score',
    ]);
  });
});

describe('suitability matrix', () => {
  it('covers every need and product combination', () => {
    // A missing cell would throw at recommendation time, on a client request, in production.
    for (const need of CAPITAL_NEEDS) {
      for (const kind of PRODUCT_KINDS) {
        const cell = SUITABILITY_MATRIX[need][kind];
        expect(cell, `${need} x ${kind}`).toBeDefined();
        expect(cell.rationale.length).toBeGreaterThan(20);
      }
    }
  });

  it('prefers factoring for a receivables gap and cautions against a term loan', () => {
    // The mismatch no underwriting box catches: a multi-year obligation against a 45-day gap
    // leaves debt outstanding long after the reason for it ended.
    const factoring = assessSuitability('invoice_factoring', 'receivables_gap');
    const term = assessSuitability('term_loan', 'receivables_gap');

    expect(factoring.score).toBeGreaterThan(term.score);
    expect(term.caution).toBe(true);
  });

  it('cautions on a merchant cash advance for an expansion', () => {
    const mca = assessSuitability('merchant_cash_advance', 'expansion');
    expect(mca.caution).toBe(true);
    expect(mca.rationale).toMatch(/repayment begins immediately/i);
  });

  it('surfaces a poor fit as a caution rather than removing it', () => {
    // A client with no other option may still take one, and is entitled to be told why it
    // is a poor fit rather than to have it quietly deleted from the list.
    const ranked = rankProductsForNeed('receivables_gap');
    expect(ranked).toHaveLength(PRODUCT_KINDS.length);
    expect(ranked.some((entry) => entry.caution)).toBe(true);
  });

  it('ranks best first and cautions last', () => {
    const ranked = rankProductsForNeed('expansion');
    expect(ranked[0]?.score).toBeGreaterThan(0);
    expect(ranked[ranked.length - 1]?.caution).toBe(true);

    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });
});
