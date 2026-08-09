/**
 * Invariant: Level 4 actions are hard-blocked and logged, never executed.
 *
 * Specification v2 section 10.5 states the success criterion as "Zero Level 4 agent actions
 * succeeded (only blocked and logged)". Blocked-and-logged is one property, not two: a block
 * with no ledger entry leaves no evidence the perimeter held, which is the thing an auditor
 * would ask to see.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  ACTION_MINIMUM_LEVEL,
  AUTHORITY_LEVELS,
  PROHIBITED_ACTIONS,
  isProhibitedAction,
} from '@bwc/core';
import { decideAuthority } from '@bwc/identity';
import { read } from '@bwc/ledger';
import { chain } from '@bwc/middleware';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('authority');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('Authority Level 4 is the non-negotiable perimeter', () => {
  it('holds no actor level 4 - levels are 0 to 3 only', () => {
    expect([...AUTHORITY_LEVELS]).toEqual([0, 1, 2, 3]);
    expect((AUTHORITY_LEVELS as readonly number[]).includes(4)).toBe(false);
  });

  it('refuses every prohibited action for the highest-level actor', () => {
    // Level 3 is the highest an actor can hold. If the perimeter can be crossed at all,
    // it is crossed here.
    for (const action of PROHIBITED_ACTIONS) {
      const decision = decideAuthority({ authorityLevel: 3 }, action);
      expect(decision.status, `${action} must be refused at level 3`).toBe('refused');
    }
  });

  it('keeps prohibited actions out of the permitted-action catalogue entirely', () => {
    for (const action of Object.keys(ACTION_MINIMUM_LEVEL)) {
      expect(isProhibitedAction(action)).toBe(false);
    }
  });

  it('refuses an action absent from the catalogue rather than assuming it permitted', () => {
    const decision = decideAuthority({ authorityLevel: 3 }, 'wire_funds_directly');
    expect(decision.status).toBe('refused');
  });

  it('blocks a prohibited action through the chain AND writes a ledger event', async () => {
    const { result } = await chain({
      actorId: fx.human.id,
      tenantId: fx.tenant.id,
      action: 'guarantee_approval',
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');

    const blocked = await read({ tenantId: fx.tenant.id, type: 'authority.action_blocked' });
    const matching = blocked.filter((event) => event.payload['action'] === 'guarantee_approval');

    expect(matching.length, 'the block must leave evidence in the Ledger').toBeGreaterThan(0);
    expect(matching[0]?.payload['prohibited']).toBe(true);
  });

  it('blocks an under-level action and logs it', async () => {
    // The observer holds level 0; submitting an application requires level 3.
    const { result, trace } = await chain({
      actorId: fx.observer.id,
      tenantId: fx.tenant.id,
      action: 'submit_application',
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');
    expect(trace.find((step) => step.step === 'authority_level')?.outcome).toBe('blocked');

    const blocked = await read({ tenantId: fx.tenant.id, type: 'authority.action_blocked' });
    expect(blocked.some((event) => event.payload['action'] === 'submit_application')).toBe(true);
  });

  it('permits an in-level action to pass the authority step', async () => {
    const { trace } = await chain({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      eventType: 'placement.requested',
    });
    expect(trace.find((step) => step.step === 'authority_level')?.outcome).toBe('passed');
  });
});
