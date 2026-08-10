/**
 * What the admin surface may and may not change - 11.7, pure, no database.
 *
 * The most important test in this file asserts an ABSENCE: that none of the compliance invariants
 * appears in the configurable registry. It is written against the real constants imported from the
 * packages that own them, so it fails if somebody adds one to the registry later - which is the
 * only moment it could ever matter.
 *
 * `unmonitored` health arithmetic is here too, for the same reason: the rule that a component
 * nobody watches is not green is cheap to state and expensive to get wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  INVARIANTS,
  PARAMETERS,
  checkBounds,
  invariantFor,
  isConfigurable,
  parameterFor,
} from '@bwc/admin';
import {
  degraded,
  failing,
  healthRank,
  healthy,
  summarise,
  unmonitored,
  worstOf,
} from '@bwc/observability';
import { PROHIBITED_ACTIONS, AUTHORITY_LEVELS, COMPLIANCE_STATES } from '@bwc/core';
import { QUIET_HOURS_START_HOUR, QUIET_HOURS_END_HOUR } from '@bwc/comms';
import { ALL_PARTY_CONSENT_STATES } from '@bwc/calls';
import { MINIMUM_COHORT } from '@bwc/partners';
import { MINIMUM_DENOMINATOR } from '@bwc/dashboards';
import { CONTROLLING_OWNERSHIP_PERCENT } from '@bwc/graph';

describe('the configurable registry', () => {
  it('gives every parameter bounds with a stated basis', () => {
    for (const parameter of PARAMETERS) {
      expect(parameter.minimum, parameter.key).toBeLessThanOrEqual(parameter.compiledDefault);
      expect(parameter.maximum, parameter.key).toBeGreaterThanOrEqual(parameter.compiledDefault);
      // A range with no reasoning is a guess with a fence around it.
      expect(parameter.boundsBasis.length, parameter.key).toBeGreaterThan(40);
      expect(parameter.owner.length, parameter.key).toBeGreaterThan(3);
    }
  });

  it('refuses a value outside the bounds, naming them', () => {
    const cadence = parameterFor('governance.MAXIMUM_REVIEW_CADENCE_DAYS');
    expect(cadence).not.toBeNull();

    const tooLong = checkBounds(cadence!, 180);
    expect(tooLong.withinBounds).toBe(false);
    expect(tooLong.detail).toMatch(/30-90/);
    // The refusal carries the reasoning, so the operator learns why rather than that they failed.
    expect(tooLong.detail).toMatch(/quarterly minimum/);

    expect(checkBounds(cadence!, 60).withinBounds).toBe(true);
  });

  it('refuses a fraction where the parameter counts whole units', () => {
    const days = parameterFor('sales.INACTIVITY_DAYS');
    expect(checkBounds(days!, 30.5).withinBounds).toBe(false);

    // A ratio is the one kind that takes a fraction.
    const target = parameterFor('dashboards.HEALTHY_SHARE_TARGET');
    expect(checkBounds(target!, 0.95).withinBounds).toBe(true);
  });

  it('caps the cadences the specification states as minimums', () => {
    // 5.4 says quarterly minimum and 8.3 says annual. Both are ceilings here: a tenant may tighten
    // them and may not loosen them past what the specification requires.
    expect(parameterFor('governance.MAXIMUM_REVIEW_CADENCE_DAYS')?.maximum).toBe(90);
    expect(parameterFor('partners.RECERTIFICATION_CADENCE_DAYS')?.maximum).toBe(365);
    // And 9.1's target is a floor, not a number to lower.
    expect(parameterFor('dashboards.HEALTHY_SHARE_TARGET')?.minimum).toBe(0.9);
  });
});

describe('invariants are absent, not permission-gated', () => {
  it('does not expose any compliance invariant as configurable', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Each of these is a control the rest of the system is
    // built around, and each is one field on a "non-technical admin surface" away from being off.
    for (const key of [
      'comms.QUIET_HOURS',
      'comms.QUIET_HOURS_START_HOUR',
      'comms.QUIET_HOURS_END_HOUR',
      'core.PROHIBITED_ACTIONS',
      'core.AUTHORITY_LEVELS',
      'core.COMPLIANCE_STATES',
      'calls.ALL_PARTY_CONSENT_STATES',
      'dashboards.MINIMUM_DENOMINATOR',
      'partners.MINIMUM_COHORT',
      'graph.CONTROLLING_OWNERSHIP_PERCENT',
      'billing.MONEY_UNIT',
    ]) {
      expect(isConfigurable(key), key).toBe(false);
      expect(parameterFor(key), key).toBeNull();
    }
  });

  it('has no parameter whose key looks like a compliance control', () => {
    // Broader than the list above, so a NEW invariant added to the registry by mistake fails here
    // even though nobody thought to name it.
    const suspicious = PARAMETERS.filter((parameter) =>
      /prohibited|authority_levels|compliance_states|quiet_hours|consent_states|minimum_denominator|minimum_cohort/i.test(
        parameter.key,
      ),
    );
    expect(suspicious.map((parameter) => parameter.key)).toEqual([]);
  });

  it('explains every invariant rather than leaving it silently missing', () => {
    // "I couldn't find the setting" and "the setting does not exist because it is the law" are
    // different answers, and only one stops somebody looking for a workaround.
    for (const invariant of INVARIANTS) {
      expect(invariant.whyFixed.length, invariant.key).toBeGreaterThan(60);
      expect(invariant.value.length, invariant.key).toBeGreaterThan(0);
    }
  });

  it('states the invariant values as they actually are in the code', () => {
    // The registry describes real constants, so a drift between the description and the code is a
    // lie on an admin screen. Checked against the packages that own them.
    expect(invariantFor('comms.QUIET_HOURS')?.value).toBe(
      `${QUIET_HOURS_START_HOUR.toString().padStart(2, '0')}:00-${QUIET_HOURS_END_HOUR}:00 local to the recipient`,
    );
    expect(invariantFor('core.PROHIBITED_ACTIONS')?.value).toBe(PROHIBITED_ACTIONS.join(', '));
    expect(invariantFor('calls.ALL_PARTY_CONSENT_STATES')?.value).toBe(
      ALL_PARTY_CONSENT_STATES.map((rule) => rule.state).join(', '),
    );
    expect(invariantFor('core.COMPLIANCE_STATES')?.value).toBe(COMPLIANCE_STATES.join(', '));
    expect(invariantFor('dashboards.MINIMUM_DENOMINATOR')?.value).toMatch(
      String(MINIMUM_DENOMINATOR),
    );
    expect(invariantFor('partners.MINIMUM_COHORT')?.value).toMatch(String(MINIMUM_COHORT));
    expect(invariantFor('graph.CONTROLLING_OWNERSHIP_PERCENT')?.value).toMatch(
      String(CONTROLLING_OWNERSHIP_PERCENT),
    );
    expect(invariantFor('core.AUTHORITY_LEVELS')?.value).toMatch(
      String(AUTHORITY_LEVELS[AUTHORITY_LEVELS.length - 1]),
    );
  });
});

describe('unmonitored is a state, and it is not green', () => {
  it('ranks unmonitored below healthy and above degraded', () => {
    // Not worse than degraded - nobody watching is not evidence of a problem. Worse than healthy -
    // "we are not looking" cannot be reported as "it is fine".
    expect(healthRank('unmonitored')).toBeGreaterThan(healthRank('degraded'));
    expect(healthRank('unmonitored')).toBeLessThan(healthRank('healthy'));
  });

  it('cannot report healthy without a measurement', () => {
    // Structural: the constructor takes one. A component nobody probed cannot accidentally be
    // reported as working, because there is no way to build the value.
    const ok = healthy({ key: 'k', label: 'L', measurement: '3 of 3', detail: 'fine' });
    expect(ok.measurement).toBe('3 of 3');

    const none = unmonitored({ key: 'k', label: 'L', wouldRequire: 'A metrics backend.' });
    expect(none.measurement).toBeNull();
    expect(none.state).not.toBe('healthy');
    expect(none.detail).toMatch(/Not monitored/);
  });

  it('takes the worst component and never the average', () => {
    const components = [
      healthy({ key: 'a', label: 'A', measurement: 'x', detail: 'd' }),
      healthy({ key: 'b', label: 'B', measurement: 'x', detail: 'd' }),
      failing({ key: 'c', label: 'C', measurement: 'x', detail: 'd' }),
    ];
    // Averaging one failing with two healthy produces "mostly fine", and the failing one is the
    // only thing anybody needed to know about.
    expect(worstOf(components)).toBe('failing');
  });

  it('treats an empty check as unmonitored rather than healthy', () => {
    // An empty check is not a healthy system. It is a system nobody checked.
    expect(worstOf([])).toBe('unmonitored');
  });

  it('reports unmonitored overall when nothing is measured, even with no failures', () => {
    const summary = summarise(
      [
        unmonitored({ key: 'a', label: 'A', wouldRequire: 'An APM.' }),
        unmonitored({ key: 'b', label: 'B', wouldRequire: 'A probe.' }),
      ],
      new Date('2026-08-11T00:00:00.000Z'),
    );
    expect(summary.overall).toBe('unmonitored');
    expect(summary.counts.healthy).toBe(0);
    expect(summary.detail).toMatch(/never an average/);
  });

  it('sorts the worst components first, so the list reads top-down', () => {
    const summary = summarise(
      [
        healthy({ key: 'z', label: 'Z', measurement: 'x', detail: 'd' }),
        degraded({ key: 'y', label: 'Y', measurement: 'x', detail: 'd' }),
        failing({ key: 'x', label: 'X', measurement: 'x', detail: 'd' }),
      ],
      new Date('2026-08-11T00:00:00.000Z'),
    );
    expect(summary.components.map((component) => component.state)).toEqual([
      'failing',
      'degraded',
      'healthy',
    ]);
  });
});
