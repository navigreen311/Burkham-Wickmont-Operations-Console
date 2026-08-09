/**
 * Invariant: compliance state is categorical, never numeric. Decision E.
 *
 * v1 modelled this as a score, and the whole point of v2's change is that a number hides
 * the distinction that drives workflow. The way this regresses is not someone re-adding a
 * `score` column - it is someone adding a comparison helper because a UI wanted to sort,
 * and the ordinal semantics creeping back in behind it.
 *
 * These tests assert the property (no ordering exists, membership decides placement) rather
 * than the wording, so they survive a rewrite and still fail if the property breaks.
 */

import { describe, expect, it } from 'vitest';
import * as compliance from '@bwc/core';
import {
  COMPLIANCE_STATES,
  PLACEMENT_ELIGIBLE_STATES,
  autoTriggersFirewall,
  isComplianceState,
  permitsPlacement,
  requiresHumanReview,
  type ComplianceState,
} from '@bwc/core';

describe('compliance state is categorical', () => {
  it('every state is a non-numeric string', () => {
    for (const state of COMPLIANCE_STATES) {
      expect(typeof state).toBe('string');
      expect(Number.isNaN(Number(state))).toBe(true);
    }
  });

  it('exposes no ordering, ranking, comparison, or score helper', () => {
    // The regression path is an ordinal helper added for a sort. Named exports are checked
    // by shape rather than by an exact list, so a future `compareComplianceState` fails here
    // whatever it is called.
    const forbidden = /(compare|rank|score|order|severity|gt|lt|greater|less|weight)/i;
    const offenders = Object.keys(compliance).filter(
      (name) => forbidden.test(name) && /compliance|state/i.test(name),
    );
    expect(offenders).toEqual([]);
  });

  it('rejects a numeric value as a compliance state', () => {
    expect(isComplianceState(3)).toBe(false);
    expect(isComplianceState('0.72')).toBe(false);
    expect(isComplianceState('pass')).toBe(true);
  });

  it('decides placement by membership, not by threshold', () => {
    expect([...PLACEMENT_ELIGIBLE_STATES].sort()).toEqual(['pass', 'pass_with_findings']);

    const eligible = COMPLIANCE_STATES.filter(permitsPlacement);
    expect([...eligible].sort()).toEqual(['pass', 'pass_with_findings']);
  });

  it('blocks placement from every state that is not explicitly eligible', () => {
    const blocked: ComplianceState[] = ['pending_assessment', 'needs_review', 'fail'];
    for (const state of blocked) {
      expect(permitsPlacement(state)).toBe(false);
    }
  });

  it('routes fail to the Firewall and needs_review to human review, and only those', () => {
    expect(COMPLIANCE_STATES.filter(autoTriggersFirewall)).toEqual(['fail']);
    expect(COMPLIANCE_STATES.filter(requiresHumanReview)).toEqual(['needs_review']);
  });

  it('defaults a hypothetical new state to blocking placement', () => {
    // Adding a sixth state must fail closed. Cast deliberately: the point is what happens
    // when a value the union does not know about reaches the guard at runtime.
    const unknownState = 'under_appeal' as ComplianceState;
    expect(permitsPlacement(unknownState)).toBe(false);
    expect(isComplianceState(unknownState)).toBe(false);
  });
});
