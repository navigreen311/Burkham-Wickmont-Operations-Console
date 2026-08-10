/**
 * Integration: the middleware chain runs in the order Specification v2 section 5.5 fixes,
 * and a failure at step N prevents step N+1.
 *
 * The ordering property is the one that decays quietly. Nothing fails if event emission
 * drifts ahead of the authority check - the request still works - but the Ledger starts
 * recording actions that were then blocked, and the audit trail disagrees with reality.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { read } from '@bwc/ledger';
import { MIDDLEWARE_STEPS, chain } from '@bwc/middleware';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('chain');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const humanActor = () => ({ id: fx.human.id, kind: 'human' as const });

describe('middleware chain order', () => {
  it('declares the seven steps in specification order', () => {
    expect([...MIDDLEWARE_STEPS]).toEqual([
      'authentication',
      'tenant_scope',
      'authority_level',
      'firewall',
      'regulatory',
      'event_emission',
      'compliance_scan',
    ]);
  });

  it('runs steps in declared order and stops at the first block', async () => {
    const { result, trace } = await chain({
      actorId: fx.observer.id, // level 0
      tenantId: fx.tenant.id,
      action: 'submit_application', // requires level 3
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');

    const steps = trace.map((entry) => entry.step);
    expect(steps).toEqual(['authentication', 'tenant_scope', 'authority_level']);

    const order = steps.map((step) => MIDDLEWARE_STEPS.indexOf(step));
    expect(order).toEqual([...order].sort((x, y) => x - y));

    // Nothing past the blocking step ran.
    expect(steps).not.toContain('event_emission');
  });

  it('blocks at authentication before anything else, for an unknown actor', async () => {
    const { result, trace } = await chain({
      actorId: '00000000-0000-0000-0000-000000000000',
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');
    expect(trace).toHaveLength(1);
    expect(trace[0]?.step).toBe('authentication');
  });

  it('writes no action event when the firewall step blocks', async () => {
    const client = await createClient(fx.tenant.id, 'Blocked Co', humanActor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'fail',
      reason: 'test',
      actor: humanActor(),
    });

    await chain({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      clientId: client.id,
      eventType: 'placement.requested',
    });

    const requested = await read({ tenantId: fx.tenant.id, type: 'placement.requested' });
    const refusedEvents = await read({ tenantId: fx.tenant.id, type: 'placement.refused' });

    // The refusal is recorded; the action is not.
    expect(requested.some((event) => event.clientId === client.id)).toBe(false);
    expect(refusedEvents.some((event) => event.clientId === client.id)).toBe(true);
  });

  it('completes every step and emits the event when nothing blocks', async () => {
    const client = await createClient(fx.tenant.id, 'Clear Co', humanActor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'pass',
      reason: 'test',
      actor: humanActor(),
    });

    const { result, trace } = await chain({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      clientId: client.id,
      eventType: 'placement.requested',
      eventPayload: { applicationRef: 'app-chain-ok' },
    });

    expect(result.status).toBe('ok');
    expect(trace.map((entry) => entry.step)).toEqual([...MIDDLEWARE_STEPS]);
    expect(trace.every((entry) => entry.outcome !== 'blocked')).toBe(true);

    const requested = await read({ tenantId: fx.tenant.id, type: 'placement.requested' });
    expect(requested.some((event) => event.clientId === client.id)).toBe(true);
  });

  it('refuses client-facing content when no jurisdiction is supplied', async () => {
    const client = await createClient(fx.tenant.id, 'Comms Co', humanActor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'pass',
      reason: 'test',
      actor: humanActor(),
    });

    const { result, trace } = await chain({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      clientId: client.id,
      eventType: 'placement.requested',
      clientFacingContent: 'Your approval is guaranteed.',
    });

    // This assertion used to expect `not_built` on 7.2. The Regulatory Engine now exists, so the
    // step performs a real check - and refuses, because no jurisdiction was supplied. "We could
    // not tell which state" is not "no state rule applies", and principle 6's whole value is that
    // a pass means something was actually checked.
    //
    // The step still blocks, which is the property the chain guarantees; only the reason has
    // become a more accurate one.
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/state could not be determined/i);
      expect(result.principle).toMatch(/principle 6/i);
    }
    expect(trace.find((entry) => entry.step === 'regulatory')?.outcome).toBe('blocked');
  });

  it('refuses client-facing content for a state that has not been activated', async () => {
    const client = await createClient(fx.tenant.id, 'Unactivated State Co', humanActor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'pass',
      reason: 'test',
      actor: humanActor(),
    });

    const { result } = await chain({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      clientId: client.id,
      eventType: 'placement.requested',
      clientFacingContent: 'A perfectly ordinary sentence.',
      jurisdiction: 'OH',
    });

    // No module for Ohio, so no counsel has reviewed anything, so nothing goes out. This refusal
    // will block real work, and that is the intended behaviour rather than a rough edge.
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/No regulatory module exists for OH/);
    }
  });
});
