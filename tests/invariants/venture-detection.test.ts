/**
 * Venture detection and arm's-length arithmetic - 10.1, pure, no database.
 *
 * Detection is worth testing on its own because both wrong answers are expensive and they are
 * expensive in opposite directions: a false tag blocks a stranger behind a conflict process that
 * cannot be completed, and a missed one is an undisclosed related-party transaction.
 */

import { describe, expect, it } from 'vitest';
import {
  GREEN_COMPANIES,
  detectVenture,
  deviationBasisPoints,
  disclosureBody,
  gardnerMayView,
  ventureByKey,
} from '@bwc/interventure';

describe('venture detection', () => {
  it('tags each of the four Green Companies ventures', () => {
    for (const [name, key] of [
      ['MedLink Pro LLC', 'medlink'],
      ['Greenstone PCA Inc', 'greenstone'],
      ['Argus Security Group', 'argus'],
      ['Collingswood Advisory LLC', 'collingswood'],
    ] as const) {
      const detection = detectVenture(name);
      expect(detection.verdict, name).toBe('venture');
      expect(detection.venture?.key, name).toBe(key);
    }
  });

  it('does not tag an unrelated client', () => {
    expect(detectVenture('Lone Star Fabrication LLC').verdict).toBe('unrelated');
  });

  it('refuses to guess on an ambiguous name', () => {
    // "Green Valley Landscaping" is not Greenstone. Tagging it would block a normal client behind
    // a conflict process nobody can complete - there is no sibling to acknowledge the disclosure.
    const detection = detectVenture('Green Valley Landscaping LLC');
    expect(detection.verdict).toBe('possible');
    expect(detection.venture).toBeNull();
    expect(detection.detail).toMatch(/costly in both directions/);
  });

  it('is case-insensitive, because a legal name is typed by a person', () => {
    expect(detectVenture('MEDLINK PRO LLC').verdict).toBe('venture');
    expect(detectVenture('medlink pro llc').verdict).toBe('venture');
  });

  it('gives Gardner visibility only for a venture', () => {
    // Derived, never set. A settable flag would eventually be set on a normal client, at which
    // point the portfolio owner is reading the file of somebody with no relationship to them.
    expect(gardnerMayView(detectVenture('MedLink Pro LLC'))).toBe(true);
    expect(gardnerMayView(detectVenture('Lone Star Fabrication LLC'))).toBe(false);
    expect(gardnerMayView(detectVenture('Green Valley Landscaping LLC'))).toBe(false);
  });

  it('gives every venture a specific conflict basis, not a generic one', () => {
    // The conflicts differ. Argus reviews our own vendors; Collingswood receives our handoffs.
    // A generic "common ownership" line would understate both.
    const bases = GREEN_COMPANIES.map((venture) => venture.conflictBasis);
    expect(new Set(bases).size).toBe(GREEN_COMPANIES.length);
    expect(ventureByKey('argus').conflictBasis).toMatch(/security reviews/);
    expect(ventureByKey('collingswood').conflictBasis).toMatch(/handoffs/);
  });
});

describe('the disclosure text', () => {
  const body = disclosureBody({
    venture: ventureByKey('medlink'),
    clientLegalName: 'MedLink Pro LLC',
    engagementDescription: 'Foundation capital readiness engagement',
    generatedOn: new Date('2026-08-10T00:00:00.000Z'),
  });

  it('states the conflict and its specific basis', () => {
    expect(body).toMatch(/related-party transaction/);
    expect(body).toMatch(/common ownership/i);
  });

  it('tells the reader they may decline', () => {
    // A disclosure that describes a conflict without saying the reader may decline is a
    // notification.
    expect(body).toMatch(/You may decline this engagement/);
    expect(body).toMatch(/unrelated provider/);
  });

  it('carries the standing disclaimers rather than assuming them', () => {
    expect(body).toMatch(/not a lender/);
    expect(body).toMatch(/independent advice/);
  });

  it('says that acknowledgement is required from both parties', () => {
    expect(body).toMatch(/MedLink Pro and from Gardner/);
  });
});

describe("arm's-length arithmetic", () => {
  it('reports no deviation at the published price', () => {
    expect(deviationBasisPoints(249500, 249500)).toBe(0);
  });

  it('reports a discount as negative and a premium as positive', () => {
    expect(deviationBasisPoints(100000, 90000)).toBe(-1000);
    expect(deviationBasisPoints(100000, 110000)).toBe(1000);
  });

  it('rounds away from zero, so a fractional deviation is still a deviation', () => {
    // Rounding toward zero would let a price a hair off the published one report as compliant.
    expect(deviationBasisPoints(100000, 99999)).toBe(-1);
    expect(deviationBasisPoints(100000, 100001)).toBe(1);
  });

  it('treats any charge against a zero published price as a full deviation', () => {
    expect(deviationBasisPoints(0, 5000)).toBe(10_000);
    expect(deviationBasisPoints(0, 0)).toBe(0);
  });
});
