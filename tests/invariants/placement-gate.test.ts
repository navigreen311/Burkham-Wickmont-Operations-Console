/**
 * Invariant: placement is refused unless the Firewall is clear AND compliance state is
 * Pass or Pass with Findings. Principle 7 and Decision E.
 *
 * This is the behaviour the whole spine exists to make reliable, so it is tested from both
 * directions: the refusal must fire for every blocking condition, and it must not fire for
 * a genuinely clear client - a gate that refuses everything is not a working gate.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { grant as grantConsent } from '@bwc/consent';
import { evaluate, trigger as triggerFirewall, clear as clearFirewall } from '@bwc/firewall';
import { read } from '@bwc/ledger';
import { requestRecommendation } from '@bwc/placement';
import type { ComplianceState } from '@bwc/core';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('placement');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const humanActor = () => ({ id: fx.human.id, kind: 'human' as const });

const clientInState = async (state: ComplianceState) => {
  const client = await createClient(fx.tenant.id, `Test Co ${state}`, humanActor());
  if (state !== 'pending_assessment') {
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: state,
      reason: `test fixture in ${state}`,
      actor: humanActor(),
    });
  }
  return client;
};

describe('placement gate refuses on compliance state', () => {
  it.each(['pending_assessment', 'needs_review', 'fail'] as const)(
    'refuses a client in %s',
    async (state) => {
      const client = await clientInState(state);
      const gate = await evaluate(client.id, state);

      expect(gate.status).toBe('refused');
      if (gate.status === 'refused') {
        expect(gate.reason.length).toBeGreaterThan(0);
        expect(gate.principle.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(['pass', 'pass_with_findings'] as const)('permits a client in %s', async (state) => {
    const client = await clientInState(state);
    const gate = await evaluate(client.id, state);
    expect(gate.status).toBe('ok');
  });
});

describe('firewall precedence', () => {
  it('refuses a triggered client even when compliance state is pass', async () => {
    const client = await clientInState('pass');
    await triggerFirewall(fx.tenant.id, client.id, 'undisclosed debt discovered', humanActor());

    const gate = await evaluate(client.id, 'pass');
    expect(gate.status).toBe('refused');
    // The reason must name the Firewall, not the compliance state - reporting the wrong
    // cause sends a human to resolve a finding that was never the blocker.
    if (gate.status === 'refused') {
      expect(gate.reason).toMatch(/firewall/i);
    }
  });

  it('refuses an agent attempting to clear the firewall', async () => {
    const client = await clientInState('pass');
    await triggerFirewall(fx.tenant.id, client.id, 'test trigger', humanActor());

    const attempt = await clearFirewall(fx.tenant.id, client.id, 'agent says it is fine', {
      id: fx.agent.id,
      kind: 'village_agent',
    });

    expect(attempt.status).toBe('refused');
    expect((await evaluate(client.id, 'pass')).status).toBe('refused');
  });

  it('permits a human to clear the firewall, restoring placement eligibility', async () => {
    const client = await clientInState('pass');
    await triggerFirewall(fx.tenant.id, client.id, 'test trigger', humanActor());

    const cleared = await clearFirewall(
      fx.tenant.id,
      client.id,
      'reviewed by compliance; finding resolved',
      humanActor(),
    );

    expect(cleared.status).toBe('ok');
    expect((await evaluate(client.id, 'pass')).status).toBe('ok');
  });
});

describe('placement request path', () => {
  it('refuses at the chain and records the refusal in the Ledger', async () => {
    const client = await clientInState('needs_review');

    const { result, trace } = await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-001',
    });

    expect(result.status).toBe('refused');
    expect(trace.find((step) => step.step === 'firewall')?.outcome).toBe('blocked');

    const refusals = await read({ tenantId: fx.tenant.id, type: 'placement.refused' });
    expect(refusals.some((event) => event.clientId === client.id)).toBe(true);
  });

  it('refuses for missing per-application authorization once the gate passes', async () => {
    const client = await clientInState('pass');

    const { result } = await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-unauthorized',
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/authorization/i);
    }
  });

  it('reports no_data once the Entity Graph exists and holds no applicant', async () => {
    const client = await clientInState('pass');
    await grantConsent({
      tenantId: fx.tenant.id,
      clientId: client.id,
      kind: 'application',
      scope: 'app-authorized',
      actor: humanActor(),
    });

    const { result } = await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-authorized',
    });

    // This assertion has now moved twice, and each move is the same event: a module named in a
    // `not_built` got built, so continuing to name it would be the system making a false
    // statement about itself. First it was 5.2 Lender Intelligence Database; then 1.2 Entity
    // Graph; now the Entity Graph exists and was consulted, and this client simply has no
    // entity designated as the applicant.
    //
    // There is no `not_built` left on the funding path.
    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') {
      expect(result.reason).toMatch(/designate one as primary/i);
    }
  });

  it('reports no_data - not not_built - when the catalogue exists and is empty', async () => {
    // The distinction principle 9 is built on. `not_built` says the capability does not
    // exist; `no_data` says it does, we consulted it, and there was nothing. Once 5.2
    // shipped, an empty catalogue stopped being the former and became the latter, and a
    // client memo that confused the two would misdescribe the state of the business.
    const client = await clientInState('pass');
    await grantConsent({
      tenantId: fx.tenant.id,
      clientId: client.id,
      kind: 'application',
      scope: 'app-empty-catalogue',
      actor: humanActor(),
    });

    const { result } = await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-empty-catalogue',
      profile: {
        clientId: client.id,
        state: 'TX',
        timeInBusinessMonths: 36,
        annualRevenue: 900_000,
        personalCreditScore: 720,
        industry: 'Professional Services',
        need: 'working_capital',
        requestedAmount: 75_000,
      },
    });

    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') {
      expect(result.reason).toMatch(/no active product offerings/i);
    }
  });

  it('never leaves a requested placement without a recorded outcome', async () => {
    // Found by running the demo: the chain writes `placement.requested`, then a post-chain
    // refusal (missing authorization, or the lender catalogue not existing) returned without
    // writing anything further. The Compliance Evidence Vault generates regulator-ready files
    // from this history, and a request with no resolution cannot be explained after the fact.
    const client = await clientInState('pass');

    // Exit A: authorized, but no lender catalogue -> not_built.
    await grantConsent({
      tenantId: fx.tenant.id,
      clientId: client.id,
      kind: 'application',
      scope: 'app-terminal-a',
      actor: humanActor(),
    });
    await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-terminal-a',
    });

    // Exit B: gate passes, authorization missing -> refused.
    await requestRecommendation({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      clientId: client.id,
      applicationRef: 'app-terminal-b',
    });

    const events = await read({ tenantId: fx.tenant.id, clientId: client.id });
    const requested = events.filter((event) => event.type === 'placement.requested');
    const resolved = events.filter((event) => event.type === 'placement.refused');

    expect(requested.length).toBeGreaterThanOrEqual(2);

    // Every application reference that was requested must also appear in a terminal event.
    for (const ref of ['app-terminal-a', 'app-terminal-b']) {
      expect(
        requested.some((event) => event.payload['applicationRef'] === ref),
        `${ref} should have been requested`,
      ).toBe(true);
      expect(
        resolved.some((event) => event.payload['applicationRef'] === ref),
        `${ref} was requested but has no recorded outcome`,
      ).toBe(true);
    }
  });

  it('refuses an unscoped consent rather than storing a blanket authorization', async () => {
    const client = await clientInState('pass');
    const attempt = await grantConsent({
      tenantId: fx.tenant.id,
      clientId: client.id,
      kind: 'application',
      scope: '   ',
      actor: humanActor(),
    });
    expect(attempt.status).toBe('refused');
  });
});
