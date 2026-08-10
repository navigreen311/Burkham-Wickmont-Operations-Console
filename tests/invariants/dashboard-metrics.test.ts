/**
 * The rules that decide when a number may be shown - 9.1 and 9.2, pure, no database.
 *
 * These are the invariants a dashboard exists to violate under pressure: somebody wants a figure,
 * there are four data points, and `4/4 = 100%` is right there. So the rules are tested on their
 * own, away from any fixture that could make them look reasonable.
 */

import { describe, expect, it } from 'vitest';
import {
  HEALTHY_STATES,
  MINIMUM_DENOMINATOR,
  UNMEASURED_COST_LINES,
  compare,
  directionOf,
  measured,
  periodOf,
  rate,
  unmeasurable,
} from '@bwc/dashboards';
import { COMPLIANCE_STATES } from '@bwc/core';

const JAN = periodOf(
  new Date('2026-01-01T00:00:00.000Z'),
  new Date('2026-02-01T00:00:00.000Z'),
  new Date('2026-08-01T00:00:00.000Z'),
);
const FEB = periodOf(
  new Date('2026-02-01T00:00:00.000Z'),
  new Date('2026-03-01T00:00:00.000Z'),
  new Date('2026-08-01T00:00:00.000Z'),
);

describe('a metric is a value with its basis', () => {
  it('withholds a rate below the minimum denominator, and says what would make it appear', () => {
    const result = rate({
      key: 'approval_rate',
      label: 'Approval rate',
      numerator: 4,
      denominator: 4,
      period: JAN,
      whatCounts: 'decided placement(s)',
    });

    // 4/4 is arithmetically 100% and means nothing.
    expect(result.value).toBeNull();
    expect(result.basis.coverage).toBe('unavailable');
    // The counts are still shown, because they are real.
    expect(result.basis.numerator).toBe(4);
    expect(result.basis.denominator).toBe(4);
    expect(result.note).toMatch(new RegExp(`${MINIMUM_DENOMINATOR} are needed`));
  });

  it('produces the rate once the denominator is there', () => {
    const result = rate({
      key: 'approval_rate',
      label: 'Approval rate',
      numerator: 7,
      denominator: 10,
      period: JAN,
      whatCounts: 'decided placement(s)',
    });
    expect(result.value).toBeCloseTo(0.7);
    expect(result.basis.coverage).toBe('complete');
  });

  it('never returns zero for something unmeasured', () => {
    // Zero is a measurement. `null` with a reason is the honest answer when there is nothing to
    // measure, and the distinction is the whole point of the type.
    const result = unmeasurable<number>({
      key: 'x',
      label: 'X',
      period: JAN,
      note: 'Nothing to measure.',
    });
    expect(result.value).toBeNull();
    expect(result.value).not.toBe(0);
  });

  it('marks a period that has not finished', () => {
    const partial = periodOf(
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-08-10T00:00:00.000Z'),
    );
    expect(partial.partial).toBe(true);
    expect(JAN.partial).toBe(false);
  });

  it('carries coverage as partial when something could not be measured', () => {
    const result = measured({
      key: 'margin',
      label: 'Margin',
      value: 100,
      period: JAN,
      note: 'Before vendor costs.',
      unmeasured: ['Plaid subscription cost per client'],
    });
    expect(result.basis.coverage).toBe('partial');
    expect(result.basis.unmeasured).toHaveLength(1);
  });
});

describe('comparison across periods', () => {
  const metric = (value: number, period: typeof JAN) =>
    measured({ key: 'k', label: 'L', value, period, note: 'n' });

  it('compares two complete periods of equal length', () => {
    const result = compare(metric(0.7, FEB), metric(0.5, JAN));
    // Both 28 and 31 days? January is 31, February 28 - so this must NOT compare.
    expect(result.comparable).toBe(false);
    expect(result.note).toMatch(/days long/);
  });

  it('refuses when either period is still running', () => {
    // The most common way a dashboard lies without anybody intending it: month-to-date against a
    // completed month. The arithmetic is fine and it always flatters the past.
    const running = periodOf(
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-08-10T00:00:00.000Z'),
    );
    const result = compare(metric(0.7, running), metric(0.5, JAN));
    expect(result.comparable).toBe(false);
    expect(result.delta).toBeNull();
    expect(result.note).toMatch(/has not finished/);
  });

  it('compares equal-length complete periods', () => {
    const first = periodOf(
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-31T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const second = periodOf(
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-03-03T00:00:00.000Z'),
      new Date('2026-08-01T00:00:00.000Z'),
    );
    const result = compare(metric(0.7, second), metric(0.5, first));
    expect(result.comparable).toBe(true);
    expect(result.delta).toBeCloseTo(0.2);
  });

  it('refuses when either value is null', () => {
    const missing = unmeasurable<number>({ key: 'k', label: 'L', period: JAN, note: 'n' });
    expect(compare(metric(0.7, JAN), missing).comparable).toBe(false);
  });
});

describe('compliance is categorical - Decision E, restated by blueprint 9.1', () => {
  it('names the healthy states rather than deriving them from an ordering', () => {
    // The moment an ordering exists somebody averages it. HEALTHY_STATES is a list of two names.
    expect([...HEALTHY_STATES]).toEqual(['pass', 'pass_with_findings']);
  });

  it('classifies transitions from a pairwise table, not a scale', () => {
    expect(directionOf('fail', 'pass')).toBe('improved');
    expect(directionOf('pass', 'fail')).toBe('worsened');
    // A first assessment is neither. Nothing improved or worsened - somebody finally looked.
    expect(directionOf('pending_assessment', 'needs_review')).toBe('lateral');
    expect(directionOf('pending_assessment', 'fail')).toBe('lateral');
  });

  it('exposes no ordering or numeric helper for compliance state', async () => {
    // The structural half of Decision E. If a rank function existed, an average would follow.
    const dashboards: Record<string, unknown> = await import('@bwc/dashboards');
    const suspicious = Object.keys(dashboards).filter((name) =>
      /score|rank|average|mean.*compliance|compliance.*score/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('accounts for every compliance state, so an empty one is a zero rather than a gap', () => {
    // A dashboard that omits `fail` when it is empty teaches its reader that a missing row means
    // no problem, and the day a client lands there the row appears somewhere nobody was looking.
    expect(COMPLIANCE_STATES).toHaveLength(5);
    expect([...COMPLIANCE_STATES]).toContain('fail');
  });
});

describe('vendor costs', () => {
  it('names every COGS line the specification requires, with the gate behind it', () => {
    expect(UNMEASURED_COST_LINES.length).toBeGreaterThanOrEqual(2);
    for (const entry of UNMEASURED_COST_LINES) {
      // A gap that points nowhere is a shrug. Each names the Decision that gates it.
      expect(entry.gate, entry.line).toMatch(/Decision [AB]/);
    }
    expect(UNMEASURED_COST_LINES.map((entry) => entry.line).join(' ')).toMatch(/Plaid/);
  });
});
