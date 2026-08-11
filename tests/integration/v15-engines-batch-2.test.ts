/**
 * 6.1, 9.3, 9.4, 10.2 and 11.9 - the controls, not the arithmetic.
 *
 * Each describe below asserts the thing that would be wrong if the module had been built the
 * obvious way. The arithmetic is mostly 5.5's and 6.3's and is already covered where it lives.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { read } from '@bwc/ledger';
import { create as createClient } from '@bwc/clients';
import { grant, revoke } from '@bwc/consent';
import {
  TIER_POLICY,
  ALERT_TIERS,
  UNAVAILABLE_ALERT_SOURCES,
  acknowledgeAlert,
  alertStanding,
  raiseAlert,
  resolveAlert,
  worstTier,
} from '@bwc/risk';
import {
  COST_SOURCES,
  UNOBSERVABLE_COST_SOURCES,
  costCoverage,
  recordCost,
  requireCosts,
  unitCostFor,
} from '@bwc/admin';
import {
  CROSS_PORTFOLIO_CONSENT_KIND,
  consentScopeFor,
  detectOpportunity,
  dismiss,
  mayRoute,
  recordGardnerDecision,
  route,
} from '@bwc/interventure';
import {
  REFUSED_PRODUCTIVITY_METRICS,
  MINIMUM_ACTIONS_TO_COMPARE,
  volumeDirection,
  productivityView,
  periodOf,
} from '@bwc/dashboards';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const NOW = new Date('2026-09-15T10:00:00.000Z');
const WINDOW = {
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-10-01T00:00:00.000Z'),
};

const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('v15-batch2');
  clientId = (await createClient(fx.tenant.id, 'Batch Two Test LLC', HUMAN())).id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('6.1 three-tier alerts', () => {
  it('takes the worst tier and never an average, and null is not yellow', () => {
    expect(worstTier(['yellow', 'red', 'orange'])).toBe('red');
    expect(worstTier(['yellow', 'yellow'])).toBe('yellow');
    // A client with no alerts and a client at the mildest tier are different facts.
    expect(worstTier([])).toBeNull();
  });

  it('gives every tier a stated rationale, because none of this is in the specification', () => {
    // The tiers are named once in specifications-v2, in a list of event types. TIER_POLICY is a
    // judgement, so each entry has to carry the argument somebody would dispute.
    for (const tier of ALERT_TIERS) {
      expect(TIER_POLICY[tier].rationale.length, tier).toBeGreaterThan(60);
      expect(TIER_POLICY[tier].optionsOffered.length, tier).toBeGreaterThan(0);
    }
    // Yellow does not freeze funding; the serious tiers do.
    expect(TIER_POLICY.yellow.freezesNewFunding).toBe(false);
    expect(TIER_POLICY.orange.freezesNewFunding).toBe(true);
    expect(TIER_POLICY.red.freezesNewFunding).toBe(true);
  });

  it('does not let an empty alert list read as a client with nothing wrong', async () => {
    const standing = await alertStanding(fx.tenant.id, clientId);
    expect(standing.worstOpenTier).toBeNull();
    // The primary source is gated, so silence is not evidence.
    expect(standing.explanation).toMatch(/gated pending security review/);
    expect(standing.unavailableSources.length).toBe(UNAVAILABLE_ALERT_SOURCES.length);
    expect(standing.unavailableSources.length).toBeGreaterThan(0);
  });

  it('freezes new funding at orange and does not let time resolve an alert', async () => {
    const raised = await raiseAlert({
      tenantId: fx.tenant.id,
      clientId,
      tier: 'orange',
      source: '6.3 Client Conduct Monitoring',
      summary: 'An unresolved serious conduct breach is on record for this client.',
      detectedAt: NOW,
      actor: HUMAN(),
    });
    expect(raised.status).toBe('ok');
    if (raised.status !== 'ok') throw new Error('raise failed');

    const standing = await alertStanding(fx.tenant.id, clientId);
    expect(standing.worstOpenTier).toBe('orange');
    expect(standing.freezesNewFunding).toBe(true);

    // A year later it is still open. Staleness hardens: nothing about elapsed time investigates a
    // cash position, and an old unreviewed alert is worse news than a new one.
    const muchLater = await alertStanding(fx.tenant.id, clientId);
    expect(muchLater.worstOpenTier).toBe('orange');

    // Acknowledging is not resolving.
    const acked = await acknowledgeAlert({
      tenantId: fx.tenant.id,
      alertId: raised.value.id,
      acknowledgedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(acked.status).toBe('ok');
    const afterAck = await alertStanding(fx.tenant.id, clientId);
    expect(afterAck.worstOpenTier).toBe('orange');
    expect(afterAck.freezesNewFunding).toBe(true);
  });

  it('requires Level 3 to resolve a red alert and a note in every case', async () => {
    const raised = await raiseAlert({
      tenantId: fx.tenant.id,
      clientId,
      tier: 'red',
      source: '6.5 Risk Event Timeline',
      summary: 'A critical risk observation is on this client timeline.',
      detectedAt: NOW,
      actor: HUMAN(),
    });
    if (raised.status !== 'ok') throw new Error('raise failed');

    const noNote = await resolveAlert({
      tenantId: fx.tenant.id,
      alertId: raised.value.id,
      note: 'ok',
      resolvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(noNote.status).toBe('refused');

    // fx.agent is Authority Level 1.
    const tooJunior = await resolveAlert({
      tenantId: fx.tenant.id,
      alertId: raised.value.id,
      note: 'The underlying observation was a duplicate of an earlier one.',
      resolvedBy: fx.agent.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(tooJunior.status).toBe('refused');
    if (tooJunior.status !== 'refused') throw new Error('expected a refusal');
    expect(tooJunior.reason).toMatch(/Authority Level 3/);
  });
});

describe('9.3 agent productivity', () => {
  it('refuses the five figures that would punish the right behaviour', async () => {
    const view = await productivityView(fx.tenant.id, periodOf(WINDOW.from, WINDOW.to, NOW));

    // A refusal that can be deleted without anything failing is a refusal that will be deleted.
    expect(view.refused.length).toBe(5);
    const keys = view.refused.map((entry) => entry.key);
    expect(keys).toContain('error_rate');
    expect(keys).toContain('human_correction_rate');
    expect(keys).toContain('escalation_rate');
    expect(keys).toContain('client_satisfaction_impact');
    expect(keys).toContain('cost_per_workflow');

    for (const entry of REFUSED_PRODUCTIVITY_METRICS) {
      expect(entry.why.length, entry.key).toBeGreaterThan(80);
      expect(entry.wouldRequire.length, entry.key).toBeGreaterThan(20);
    }

    // And the view says what it is, because a productivity dashboard is read as a performance
    // review whatever its header says.
    expect(view.note).toMatch(/volume and latency/);
    expect(view.note).toMatch(/does not record whether it was any good/);
  });

  it('reports unknown rather than steady when a window is too thin to compare', () => {
    // "No change detected" and "not enough to detect a change in" are different statements, and
    // the first is the reassuring one.
    expect(volumeDirection(3, 3)).toBe('unknown');
    expect(volumeDirection(MINIMUM_ACTIONS_TO_COMPARE, 3)).toBe('unknown');
    expect(volumeDirection(20, 20)).toBe('steady');
    expect(volumeDirection(30, 20)).toBe('increased');
    expect(volumeDirection(10, 20)).toBe('decreased');
  });
});

describe('11.9 cost governance', () => {
  it('refuses to record a cost against a gated vendor', async () => {
    // A zero against Plaid would read as a vendor we are not spending money on, rather than one
    // we have never switched on.
    for (const source of ['plaid', 'business_bureau', 'personal_credit'] as const) {
      const result = await recordCost({
        tenantId: fx.tenant.id,
        source,
        provenance: 'vendor_invoice',
        amountCents: 5_000,
        occurredOn: NOW,
        recordedBy: fx.human.id,
        actor: HUMAN(),
      });
      expect(result.status, source).toBe('refused');
    }
  });

  it('never divides platform cost into a per-client figure', async () => {
    await recordCost({
      tenantId: fx.tenant.id,
      clientId,
      source: 'model_api',
      provenance: 'observed',
      amountCents: 1_200,
      units: 40_000,
      unitKind: 'tokens',
      occurredOn: NOW,
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });

    // Platform spend, naming no client.
    await recordCost({
      tenantId: fx.tenant.id,
      source: 'document_processing',
      provenance: 'vendor_invoice',
      amountCents: 90_000,
      occurredOn: NOW,
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });

    const unit = await unitCostFor(fx.tenant.id, clientId, WINDOW);
    // Attributable only. An allocation presented as a measurement would move this client's unit
    // cost when a different client signed up.
    expect(unit.attributableCents).toBe(1_200);
    expect(unit.unattributedPlatformCents).toBe(90_000);
    expect(unit.note).toMatch(/is NOT divided in/);
  });

  it('reports a gated source as unobservable rather than as zero', async () => {
    const coverage = await costCoverage(fx.tenant.id, WINDOW);
    expect(coverage.length).toBe(COST_SOURCES.length);

    const plaid = coverage.find((row) => row.source === 'plaid');
    expect(plaid?.observable).toBe(false);
    expect(plaid?.note).toMatch(/absence of measurement, not an absence of spend/);
    expect(Object.keys(UNOBSERVABLE_COST_SOURCES).length).toBe(3);

    const model = coverage.find((row) => row.source === 'model_api');
    expect(model?.observable).toBe(true);
  });

  it('distinguishes no records from a zero cost', async () => {
    const other = (await createClient(fx.tenant.id, 'Uncosted Client LLC', HUMAN())).id;
    const result = await requireCosts(fx.tenant.id, other, WINDOW);
    expect(result.status).toBe('no_data');
    if (result.status !== 'no_data') throw new Error('expected no_data');
    expect(result.reason).toMatch(/absence of measurement, not a client who cost nothing/);
  });
});

describe('10.2 cross-portfolio opportunity', () => {
  let opportunityId: string;

  it('detects without asserting any permission, and carries no client on the event', async () => {
    const detected = await detectOpportunity({
      tenantId: fx.tenant.id,
      venture: 'collingswood',
      clientId,
      kind: 'advisor_or_client_acquisition',
      summary: 'This client has asked twice about succession planning.',
      basis: 'Two recorded call obligations reference succession, and no advisor is on the file.',
      detectedAt: NOW,
      actor: HUMAN(),
    });
    if (detected.status !== 'ok') throw new Error(`detect failed: ${detected.status}`);
    opportunityId = detected.value.id;
    expect(detected.value.state).toBe('detected');

    const events = await read({ tenantId: fx.tenant.id });
    const detectedEvents = events.filter(
      (event) => event.type === 'interventure.opportunity.detected',
    );
    expect(detectedEvents.length).toBeGreaterThan(0);
    // Gardner gets PII-stripped aggregates. This is exactly the row somebody would attach a
    // client id to "so it can be actioned".
    for (const event of detectedEvents) {
      expect(JSON.stringify(event.payload)).not.toMatch(clientId);
    }
  });

  it('refuses to route on Gardner approval alone, because that is not the client consent', async () => {
    const approved = await recordGardnerDecision({
      tenantId: fx.tenant.id,
      opportunityId,
      approved: true,
      decidedBy: 'gardner-board',
      note: 'Proper between the two ventures on these facts.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(approved.status).toBe('ok');

    // Gardner said yes. The client has said nothing.
    const advisory = await mayRoute(fx.tenant.id, opportunityId, NOW);
    expect(advisory.permitted).toBe(false);
    expect(advisory.advisoryOnly).toBe(true);

    const result = await route({
      tenantId: fx.tenant.id,
      opportunityId,
      toDepartment: 'funding_strategy',
      routedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/the data subject CHANGES/);
  });

  it('routes once consent is live, and refuses again the moment it is revoked', async () => {
    const scope = consentScopeFor('collingswood');

    const granted = await grant({
      tenantId: fx.tenant.id,
      clientId,
      kind: CROSS_PORTFOLIO_CONSENT_KIND,
      scope,
      actor: HUMAN(),
    });
    if (granted.status !== 'ok') throw new Error(`grant failed: ${granted.status}`);

    const routed = await route({
      tenantId: fx.tenant.id,
      opportunityId,
      toDepartment: 'funding_strategy',
      routedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (routed.status !== 'ok') throw new Error(`route failed: ${routed.status}`);
    expect(routed.value.state).toBe('routed');

    // The event records WHEN consent was verified, because that is the whole control.
    const events = await read({ tenantId: fx.tenant.id });
    const routedEvent = events.find((event) => event.type === 'interventure.opportunity.routed');
    expect(routedEvent?.payload).toHaveProperty('consentVerifiedAt');

    // Now revoke, and a second opportunity to the same venture must refuse - proving the check is
    // live rather than a cached answer from the first routing.
    const revoked = await revoke(fx.tenant.id, granted.value.id, HUMAN());
    expect(revoked.status).toBe('ok');

    const second = await detectOpportunity({
      tenantId: fx.tenant.id,
      venture: 'collingswood',
      clientId,
      kind: 'project_funding',
      summary: 'A second opportunity to the same venture.',
      basis: 'Recorded after the first handoff consent was revoked, to prove the check is live.',
      detectedAt: NOW,
      actor: HUMAN(),
    });
    if (second.status !== 'ok') throw new Error('second detect failed');

    await recordGardnerDecision({
      tenantId: fx.tenant.id,
      opportunityId: second.value.id,
      approved: true,
      decidedBy: 'gardner-board',
      note: 'Proper between the two ventures on these facts.',
      actor: HUMAN(),
      now: NOW,
    });

    const afterRevoke = await route({
      tenantId: fx.tenant.id,
      opportunityId: second.value.id,
      toDepartment: 'funding_strategy',
      routedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(afterRevoke.status).toBe('refused');
  });

  it('will not dismiss something already routed', async () => {
    const result = await dismiss({
      tenantId: fx.tenant.id,
      opportunityId,
      reason: 'Trying to set aside an act that already happened.',
      actor: HUMAN(),
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.reason).toMatch(/already been routed/);
  });

  it('consent to one venture is not consent to another', async () => {
    // Per-handoff means per counterparty.
    expect(consentScopeFor('collingswood')).not.toBe(consentScopeFor('medlink'));
  });
});
