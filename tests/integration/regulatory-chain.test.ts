/**
 * The Regulatory Engine inside the middleware chain - 7.2 at step 5.
 *
 * > "The Regulatory Engine is not a post-hoc check. No client-facing action fires without state
 * > compliance checks having passed."
 *
 * This is the test that makes that sentence true of the running system rather than of a module
 * nobody calls. It exercises the whole path: a client-facing action, a jurisdiction, the activation
 * gate, the disclosures the state obliges, and 5.4's provider restrictions arriving by pull.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { chain } from '@bwc/middleware';
import { registerProvider } from '@bwc/lenders';
import { seedFoundingClaims } from '@bwc/claims';
import { approve } from '@bwc/governance';
import {
  FEDERAL_BASELINE,
  activateState,
  publishStateModule,
  standingFor,
  withdrawState,
} from '@bwc/regulatory';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

beforeAll(async () => {
  fx = await makeFixture('reg-chain');

  // Step 7 of the chain now runs the Communication Compliance Scanner, and the Scanner refuses
  // rather than certifying content clean against an empty library - "we checked nothing and found
  // nothing" is not a pass. So the library has to exist before any client-facing action can pass.
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', human());

  const client = await createClient(fx.tenant.id, 'Regulated Co', human());
  clientId = client.id;
  await transitionComplianceState({
    tenantId: fx.tenant.id,
    clientId,
    to: 'pass',
    reason: 'test fixture',
    actor: human(),
  });

  // Texas: published and activated. Nevada: published, never reviewed.
  await publishStateModule({
    tenantId: fx.tenant.id,
    state: 'TX',
    summary: 'Texas module for the chain test.',
    citations: ['Tex. Fin. Code - scope confirmed by counsel'],
    disclosures: [
      {
        key: 'tx_cost_presentation',
        text: 'Any cost figure shown for a Texas client states the basis on which it was computed.',
        citation: 'Tex. Fin. Code (general conduct provisions)',
      },
    ],
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });

  await activateState({
    tenantId: fx.tenant.id,
    state: 'TX',
    actor: human(),
    reviewedBy: 'Outside counsel, Fig & Rowe LLP',
    reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
    documentReference: 'Memo BW-REG-2026-031',
  });

  await publishStateModule({
    tenantId: fx.tenant.id,
    state: 'NV',
    summary: 'Nevada module for the chain test, awaiting counsel.',
    citations: ['Nev. Rev. Stat. ch. 675 - applicability to be confirmed'],
    disclosures: [],
    changeKind: 'material',
    publishedBy: 'compliance@burkhamwickmont.test',
    actor: human(),
  });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function human() {
  return { id: fx.human.id, kind: 'human' as const };
}

const request = (overrides: Record<string, unknown> = {}) =>
  chain({
    actorId: fx.agent.id,
    tenantId: fx.tenant.id,
    action: 'draft_recommendation',
    clientId,
    eventType: 'placement.requested',
    clientFacingContent: 'A summary of your capital options, prepared for your review.',
    jurisdiction: 'TX',
    ...overrides,
  });

describe('step 5 gates client-facing action on state compliance', () => {
  it('passes for a client in an activated state and attaches the disclosures', async () => {
    const { result, trace } = await request();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const step = trace.find((entry) => entry.step === 'regulatory');
    expect(step?.outcome).toBe('passed');
    expect(step?.detail).toMatch(/TX active at module version 1/);

    // The clearance travels with the result, so a caller attaches the disclosures from the same
    // check that permitted the action rather than from a second lookup that could disagree.
    expect(result.value.clearance?.state).toBe('TX');
    expect(result.value.clearance?.requiredDisclosures.length).toBe(FEDERAL_BASELINE.length + 1);
    expect(
      result.value.clearance?.requiredDisclosures.some((d) => d.key === 'tx_cost_presentation'),
    ).toBe(true);
    expect(result.value.clearance?.requiredDisclosures[0]?.key).toBe('not_a_lender');
  });

  it('refuses for a state whose module nobody has reviewed', async () => {
    const { result, trace } = await request({ jurisdiction: 'NV' });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/never been activated/);
      expect(result.principle).toMatch(/11\.2/);
    }
    expect(trace.find((entry) => entry.step === 'regulatory')?.outcome).toBe('blocked');
  });

  it('refuses when the jurisdiction cannot be determined', async () => {
    // "We could not tell which state" is not "no state rule applies". Collapsing them would make
    // a pass mean nothing, which is the whole value of a pre-action check.
    const { result } = await request({ jurisdiction: undefined });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/could not be determined/);
  });

  it('skips step 5 entirely when nothing client-facing is in scope', async () => {
    // Placement requests run through the chain with no outbound text. They must not be blocked
    // by a state gate that has nothing to gate.
    const { result, trace } = await chain({
      actorId: fx.agent.id,
      tenantId: fx.tenant.id,
      action: 'draft_recommendation',
      clientId,
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('ok');
    const step = trace.find((entry) => entry.step === 'regulatory');
    expect(step?.outcome).toBe('skipped');
    expect(step?.detail).toMatch(/no client-facing action in scope/);
  });

  it('normalises a lower-case state code rather than refusing on formatting', async () => {
    const { result } = await request({ jurisdiction: 'tx' });
    expect(result.status).toBe('ok');
  });
});

describe('5.4 state restrictions arrive by pull', () => {
  it('refuses a provider the Governance Board has not permitted in this state', async () => {
    // ADR-0007 chose a pull over a push because a push needs a retry and a reconciliation job,
    // each of which can lag - so a provider restricted on Monday might still be usable on
    // Tuesday. This is the reader that choice was made for.
    const restricted = await registerProvider({
      tenantId: fx.tenant.id,
      name: 'Oklahoma Only Bank',
      kind: 'national_bank',
      statesServed: ['*'],
      actor: human(),
    });
    if (restricted.status !== 'ok') throw new Error('fixture failed');

    await approve({
      tenantId: fx.tenant.id,
      providerId: restricted.value.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved for Oklahoma placements only pending a broker agreement elsewhere.',
      approvedStates: ['OK'],
      actor: human(),
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    const { result } = await request({ providerId: restricted.value.id });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/has not approved this provider for use in TX/);
      expect(result.principle).toMatch(/5\.4/);
    }
  });

  it('passes a provider the Board approved without a state limit', async () => {
    const open = await registerProvider({
      tenantId: fx.tenant.id,
      name: 'Nationwide Approved Bank',
      kind: 'national_bank',
      statesServed: ['*'],
      actor: human(),
    });
    if (open.status !== 'ok') throw new Error('fixture failed');

    await approve({
      tenantId: fx.tenant.id,
      providerId: open.value.id,
      approvedBy: 'compliance@burkhamwickmont.test',
      rationale: 'Approved without state limitation.',
      actor: human(),
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    const { result } = await request({ providerId: open.value.id });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.clearance?.providerPermitted).toBe(true);
  });
});

describe('withdrawing a state stops client work immediately', () => {
  it('blocks the next action with no propagation step in between', async () => {
    // Standing is derived at read time, so there is no cache to invalidate and no job to run.
    // The action after the withdrawal is refused, on any machine, with nothing scheduled.
    expect((await request()).result.status).toBe('ok');

    const withdrawn = await withdrawState({
      tenantId: fx.tenant.id,
      state: 'TX',
      actor: human(),
      reason: 'Counsel raised a licensing question pending resolution.',
    });
    expect(withdrawn.status).toBe('ok');

    const { result } = await request();
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/licensing question/i);

    expect((await standingFor(fx.tenant.id, 'TX')).permitsClientFacingAction).toBe(false);
  });
});
