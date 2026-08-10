/**
 * Invariants for 5.1 Capital Stack & Monitoring.
 *
 * Utilization, PG exposure, promo runway and the health score. Pure functions, so no database.
 */

import { describe, expect, it } from 'vitest';
import type { Provenance } from '@bwc/core';
import {
  PROMO_ALERT_DAYS,
  RESTACK_LEAD_DAYS,
  aggregateUtilization,
  capitalStackHealth,
  paymentCalendar,
  pgExposureMap,
  promoAlertsDue,
  promoRunway,
  restackWindows,
  stackAsOf,
  totalMonthlyObligation,
  utilizationOf,
  type CapitalPosition,
} from '@bwc/capital';

const PROVENANCE: Provenance = {
  tag: 'vendor_feed',
  vendor: 'plaid',
  retrievedAt: '2026-08-09',
  consentReference: 'consent-abc',
};

const TODAY = '2026-08-10';

const position = (overrides: Partial<CapitalPosition> & { id: string }): CapitalPosition => ({
  provider: 'Provider',
  kind: 'credit_card',
  label: overrides.id,
  creditLimit: 50_000,
  outstandingBalance: 10_000,
  annualRate: 0.2499,
  factorRate: null,
  cadence: 'monthly',
  paymentPerPeriod: 400,
  promo: null,
  personalGuarantee: null,
  asOf: TODAY,
  provenance: PROVENANCE,
  ...overrides,
});

describe('utilization', () => {
  it('flags an over-limit position rather than clamping it to 100%', () => {
    // A client already past their limit is in a different situation from one exactly at it, and
    // clamping would render the two identically - hiding the condition that matters most.
    const over = utilizationOf(
      position({ id: 'over', creditLimit: 10_000, outstandingBalance: 12_500 }),
    );

    expect(over.ratio).toBeCloseTo(1.25, 6);
    expect(over.overLimit).toBe(true);
  });

  it('reports no ratio for a position with no limit', () => {
    const loan = utilizationOf(
      position({ id: 'loan', kind: 'term_loan', creditLimit: null, outstandingBalance: 80_000 }),
    );
    expect(loan.ratio).toBeNull();
    expect(loan.overLimit).toBe(false);
  });

  it('excludes limitless positions from the aggregate denominator', () => {
    // Including a term loan's balance while it contributes nothing to the limit would inflate the
    // ratio without bound - the arithmetic that turns a healthy client alarming on paper.
    const aggregate = aggregateUtilization([
      position({ id: 'card', creditLimit: 100_000, outstandingBalance: 20_000 }),
      position({
        id: 'loan',
        kind: 'term_loan',
        creditLimit: null,
        outstandingBalance: 500_000,
      }),
    ]);

    expect(aggregate.totalLimit).toBe(100_000);
    expect(aggregate.ratio).toBeCloseTo(0.2, 6);
  });

  it('returns no aggregate ratio when there are no revolving positions', () => {
    const aggregate = aggregateUtilization([
      position({ id: 'loan', kind: 'term_loan', creditLimit: null }),
    ]);
    expect(aggregate.ratio).toBeNull();
  });
});

describe('PG exposure map', () => {
  it('aggregates by owner across positions', () => {
    // What matters to a guarantor is total exposure, not per facility.
    const exposures = pgExposureMap(
      [
        position({
          id: 'a',
          outstandingBalance: 30_000,
          personalGuarantee: { ownerName: 'A. Owner', limitAmount: null },
        }),
        position({
          id: 'b',
          outstandingBalance: 20_000,
          personalGuarantee: { ownerName: 'A. Owner', limitAmount: null },
        }),
        position({
          id: 'c',
          outstandingBalance: 15_000,
          personalGuarantee: { ownerName: 'B. Partner', limitAmount: null },
        }),
      ],
      PROVENANCE,
    );

    expect(exposures[0]?.ownerName).toBe('A. Owner');
    expect(exposures[0]?.exposureAmount.value).toBe(50_000);
    expect(exposures[0]?.guaranteedPositions).toBe(2);
    expect(exposures[0]?.exposureAmount.provenance).toEqual(PROVENANCE);
  });

  it('caps a limited guarantee at its limit', () => {
    const exposures = pgExposureMap(
      [
        position({
          id: 'a',
          outstandingBalance: 80_000,
          personalGuarantee: { ownerName: 'A. Owner', limitAmount: 25_000 },
        }),
      ],
      PROVENANCE,
    );
    expect(exposures[0]?.exposureAmount.value).toBe(25_000);
    expect(exposures[0]?.hasUnlimitedGuarantee).toBe(false);
  });

  it('flags an unlimited guarantee, whose exposure grows with future draws', () => {
    const exposures = pgExposureMap(
      [
        position({
          id: 'a',
          personalGuarantee: { ownerName: 'A. Owner', limitAmount: null },
        }),
      ],
      PROVENANCE,
    );
    expect(exposures[0]?.hasUnlimitedGuarantee).toBe(true);
  });

  it('ignores positions with no guarantee', () => {
    expect(pgExposureMap([position({ id: 'a' })], PROVENANCE)).toHaveLength(0);
  });
});

describe('promo windows', () => {
  const promoStack = [
    position({
      id: 'promo-90',
      label: 'Card A',
      outstandingBalance: 40_000,
      promo: { endsOn: '2026-11-08', promoAnnualRate: 0, goToAnnualRate: 0.2499 },
    }),
    position({
      id: 'promo-200',
      label: 'Card B',
      outstandingBalance: 10_000,
      promo: { endsOn: '2027-02-26', promoAnnualRate: 0, goToAnnualRate: 0.1999 },
    }),
  ];

  it('computes runway and the annual cost that begins on expiry', () => {
    const runways = promoRunway(promoStack, TODAY);

    expect(runways[0]?.label).toBe('Card A');
    expect(runways[0]?.daysRemaining).toBe(90);
    // The number that makes a deadline concrete: 40,000 × 24.99%.
    expect(runways[0]?.annualCostAfterExpiry).toBeCloseTo(9_996, 0);
  });

  it('alerts on the exact threshold days rather than every day below them', () => {
    // "At or below 90" would fire on all ninety of them, and an alert that fires daily gets
    // filtered into a folder.
    expect(promoAlertsDue(promoStack, TODAY).map((alert) => alert.threshold)).toEqual([90]);
    expect(promoAlertsDue(promoStack, '2026-08-11')).toHaveLength(0);
    expect(promoAlertsDue(promoStack, '2026-09-09').map((a) => a.threshold)).toEqual([60]);
  });

  it('names the thresholds blueprint 5.1 specifies', () => {
    expect([...PROMO_ALERT_DAYS]).toEqual([90, 60, 30]);
  });

  it('opens a re-stack window ahead of expiry, with time to act', () => {
    const windows = restackWindows(promoStack, TODAY);
    // 45 days of lead time: enough for an application to be prepared, authorized and decided.
    expect(RESTACK_LEAD_DAYS).toBe(45);
    expect(windows[0]?.opensOn).toBe('2026-09-24');
    expect(windows[0]?.reason).toMatch(/24\.99%/);
  });
});

describe('payment calendar', () => {
  it('normalizes mixed cadences to a monthly equivalent', () => {
    // A stack routinely mixes a daily MCA remittance with a monthly card minimum, and the two
    // cannot be summed without normalising. "What do I owe each month" is this number.
    const calendar = paymentCalendar([
      position({ id: 'card', cadence: 'monthly', paymentPerPeriod: 500 }),
      position({
        id: 'mca',
        kind: 'merchant_cash_advance',
        creditLimit: null,
        cadence: 'daily',
        paymentPerPeriod: 400,
      }),
    ]);

    // The daily remittance dominates despite the smaller per-payment figure - which is exactly
    // the comparison an operator gets wrong by eye.
    expect(calendar[0]?.positionId).toBe('mca');
    expect(calendar[0]?.monthlyEquivalent).toBeCloseTo(8_400, 0);
    expect(totalMonthlyObligation(calendar.map(() => position({ id: 'x' })))).toBeGreaterThan(0);
  });

  it('omits positions with no payment', () => {
    expect(paymentCalendar([position({ id: 'idle', paymentPerPeriod: 0 })])).toHaveLength(0);
  });
});

describe('the health score carries its components', () => {
  const healthy = [
    position({ id: 'a', creditLimit: 100_000, outstandingBalance: 20_000, asOf: TODAY }),
  ];

  it('cannot be produced without components', () => {
    // Decision E's lesson, applied without contradicting blueprint 5.1's named score: the number
    // summarises the components rather than replacing them.
    const health = capitalStackHealth({
      positions: healthy,
      blendedApr: 0.1,
      today: TODAY,
      provenance: PROVENANCE,
    });

    expect(health.components.length).toBeGreaterThanOrEqual(5);
    for (const component of health.components) {
      expect(component.rationale.length).toBeGreaterThan(10);
      expect(component.score).toBeGreaterThanOrEqual(0);
      expect(component.score).toBeLessThanOrEqual(100);
    }
    expect(health.score.provenance).toEqual(PROVENANCE);
  });

  it('rates a low-utilization, low-cost, freshly-observed stack as strong', () => {
    const health = capitalStackHealth({
      positions: healthy,
      blendedApr: 0.1,
      today: TODAY,
      provenance: PROVENANCE,
    });
    expect(health.band).toBe('strong');
  });

  it('zeroes the utilization component when any position is over its limit', () => {
    const health = capitalStackHealth({
      positions: [position({ id: 'over', creditLimit: 10_000, outstandingBalance: 12_000 })],
      blendedApr: 0.1,
      today: TODAY,
      provenance: PROVENANCE,
    });

    const utilization = health.components.find((c) => c.name === 'utilization');
    expect(utilization?.score).toBe(0);
    expect(utilization?.rationale).toMatch(/over their limit/i);
  });

  it('scores an uncosted stack as unknown, not as healthy', () => {
    // An unknown must not read as good news - otherwise a stack of uncostable products presents
    // as strong.
    const health = capitalStackHealth({
      positions: healthy,
      blendedApr: null,
      today: TODAY,
      provenance: PROVENANCE,
    });

    const cost = health.components.find((c) => c.name === 'cost_of_capital');
    expect(cost?.score).toBe(50);
    expect(cost?.rationale).toMatch(/unknown rather than as healthy/i);
  });

  it('penalises a stale stack, because the rest of the score describes the past', () => {
    const stale = capitalStackHealth({
      positions: [position({ id: 'a', asOf: '2026-04-01' })],
      blendedApr: 0.1,
      today: TODAY,
      provenance: PROVENANCE,
    });

    const hygiene = stale.components.find((c) => c.name === 'account_hygiene');
    expect(hygiene?.score).toBe(0);
    expect(hygiene?.rationale).toMatch(/day\(s\) old/);
  });

  it('drops the band as a stack becomes expensive and heavily drawn', () => {
    const strained = capitalStackHealth({
      positions: [
        position({ id: 'a', creditLimit: 20_000, outstandingBalance: 19_000 }),
        position({
          id: 'b',
          personalGuarantee: { ownerName: 'A. Owner', limitAmount: null },
          creditLimit: 20_000,
          outstandingBalance: 19_500,
        }),
      ],
      blendedApr: 0.55,
      today: TODAY,
      provenance: PROVENANCE,
    });

    expect(['strained', 'distressed']).toContain(strained.band);
  });
});

describe('stack freshness', () => {
  it('reports the oldest observation, since a stack is only as current as its stalest position', () => {
    expect(
      stackAsOf([
        position({ id: 'a', asOf: '2026-08-10' }),
        position({ id: 'b', asOf: '2026-06-01' }),
      ]),
    ).toBe('2026-06-01');
  });

  it('returns null for an empty stack', () => {
    expect(stackAsOf([])).toBeNull();
  });
});
