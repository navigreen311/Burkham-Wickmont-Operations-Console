/**
 * 9.1 Executive KPI Dashboard and 9.2 Unit Economics Dashboard, end to end.
 *
 * Three properties carry this file.
 *
 * **The compliance KPI is a distribution and never an average.** Blueprint 9.1 changed this
 * between versions specifically to stop somebody averaging it, so the distribution is asserted
 * state by state, including the states at zero.
 *
 * **An approval rate is refused rather than computed.** Only approvals are recorded - denials
 * belong to 5.5, which is V1.5 - so a rate from what exists would read 100% forever. That is the
 * most dangerous number this dashboard could produce, and the test asserts it is absent.
 *
 * **Margin is named for what it excludes.** A gross margin missing its vendor COGS is wrong in a
 * known direction by an unknown amount, on the surface the founder steers by.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { publishOffer, startEngagement, recordBilling, fromDollars } from '@bwc/billing';
import { createLead, convertLead, qualifyLead, recordReadiness } from '@bwc/sales';
import { trigger as triggerFirewall, clear as clearFirewall } from '@bwc/firewall';
import {
  acquisitionCost,
  executiveDashboard,
  gardnerRollup,
  grossMargin,
  offerEconomics,
  periodOf,
  projectedLtv,
  realisedRevenuePerClient,
  unitEconomicsDashboard,
  vendorCostForClient,
} from '@bwc/dashboards';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let passing: string;
let failing: string;

const NOW = new Date('2026-08-15T12:00:00.000Z');
const PERIOD = periodOf(
  new Date('2026-08-01T00:00:00.000Z'),
  new Date('2026-08-14T00:00:00.000Z'),
  NOW,
);
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('kpi-dashboards');

  const offer = await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    publishedBy: 'concierge-desk',
    actor: HUMAN(),
  });
  if (offer.status !== 'ok') throw new Error('setup: offer');

  const [a, b, c] = await Promise.all([
    createClient(fx.tenant.id, 'Passing Holdings LLC', HUMAN()),
    createClient(fx.tenant.id, 'Failing Ventures LLC', HUMAN()),
    createClient(fx.tenant.id, 'Untouched Co', HUMAN()),
  ]);
  passing = a.id;
  failing = b.id;
  void c;

  await transitionComplianceState({
    tenantId: fx.tenant.id,
    clientId: passing,
    to: 'pass_with_findings',
    reason: 'Assessed; two minor documentation findings.',
    actor: HUMAN(),
  });
  await transitionComplianceState({
    tenantId: fx.tenant.id,
    clientId: failing,
    to: 'fail',
    reason: 'Statements do not reconcile with stated revenue.',
    actor: HUMAN(),
  });

  // An engagement with real billing, so the economics have something to compute over.
  const engagement = await startEngagement({
    tenantId: fx.tenant.id,
    clientId: passing,
    offerKey: 'foundation',
    startedOn: new Date('2026-08-02T00:00:00.000Z'),
    startedBy: fx.human.id,
    actor: HUMAN(),
  });
  if (engagement.status !== 'ok') throw new Error(`setup: engagement ${engagement.status}`);

  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId: engagement.value.id,
    kind: 'charge',
    amountCents: fromDollars(2_495),
    description: 'Foundation retainer',
    occurredOn: new Date('2026-08-03T00:00:00.000Z'),
    recordedBy: fx.human.id,
    actor: HUMAN(),
  });
  await recordBilling({
    tenantId: fx.tenant.id,
    engagementId: engagement.value.id,
    kind: 'payment',
    amountCents: fromDollars(2_495),
    description: 'Retainer paid',
    occurredOn: new Date('2026-08-04T00:00:00.000Z'),
    recordedBy: fx.human.id,
    actor: HUMAN(),
  });

  // A firewall trigger and clear, so the defense metric has a denominator.
  await triggerFirewall(fx.tenant.id, failing, 'Statements do not reconcile.', HUMAN());
  await clearFirewall(fx.tenant.id, failing, 'Resolved after document review.', HUMAN());

  // Two leads on one channel, one converted, so CAC has something to divide.
  for (const [index, name] of ['Lead One LLC', 'Lead Two LLC'].entries()) {
    const lead = await createLead({
      tenantId: fx.tenant.id,
      prospectName: name,
      sourceChannel: 'paid_search',
      createdOn: new Date('2026-08-05T00:00:00.000Z'),
      actor: HUMAN(),
    });
    if (lead.status !== 'ok') throw new Error('setup: lead');

    await recordReadiness({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      readiness: 40,
      note: 'First blueprint reading.',
      takenOn: new Date('2026-08-05T00:00:00.000Z'),
      takenBy: fx.human.id,
      actor: HUMAN(),
    });
    await recordReadiness({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      readiness: 40 + (index + 1) * 10,
      note: 'Improved after document work.',
      takenOn: new Date('2026-08-09T00:00:00.000Z'),
      takenBy: fx.human.id,
      actor: HUMAN(),
    });

    if (index === 0) {
      await qualifyLead({
        tenantId: fx.tenant.id,
        leadId: lead.value.id,
        qualification: 'qualified',
        note: 'Three years operating with clean statements.',
        occurredAt: new Date('2026-08-06T00:00:00.000Z'),
        actor: HUMAN(),
      });
      await convertLead({
        tenantId: fx.tenant.id,
        leadId: lead.value.id,
        convertedBy: 'concierge-desk',
        convertedOn: new Date('2026-08-07T00:00:00.000Z'),
        actor: HUMAN(),
      });
    }
  }
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('9.1 the compliance KPI is a distribution', () => {
  it('counts clients per state, including the states at zero', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    expect(dashboard.status).toBe('ok');
    if (dashboard.status !== 'ok') return;

    const distribution = dashboard.value.complianceDistribution.value;
    expect(distribution).not.toBeNull();
    if (distribution === null) return;

    expect(distribution.counts['pass_with_findings']).toBe(1);
    expect(distribution.counts['fail']).toBe(1);
    // Present at zero rather than absent. A missing row reads as no problem.
    expect(distribution.counts['needs_review']).toBe(0);
    expect(distribution.counts).toHaveProperty('pass');

    // And there is no single number summarising the whole.
    expect(Object.keys(distribution)).not.toContain('score');
    expect(Object.keys(distribution)).not.toContain('average');
    expect(dashboard.value.complianceDistribution.note).toMatch(/never an average/);
  });

  it('reports the healthy share against the stated target', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;
    const distribution = dashboard.value.complianceDistribution.value;
    if (distribution === null) return;

    // 1 of 4 in pass/pass_with_findings (one converted lead also created a client).
    expect(distribution.healthyShare).toBeLessThan(0.9);
    expect(distribution.meetsTarget).toBe(false);
  });

  it('classifies state movement by direction', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    const movement = dashboard.value.complianceMovement.value;
    // The two transitions in the fixture ran before the period, so this reports the absence
    // rather than zeros - and the note distinguishes the two.
    if (movement === null) {
      expect(dashboard.value.complianceMovement.note).toMatch(/fact about the period/);
    } else {
      expect(movement.total).toBeGreaterThan(0);
    }
  });
});

describe('9.1 an approval rate is refused, not computed', () => {
  it('withholds the placement approval rate and names 5.5', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    // THE ASSERTION THIS FILE EXISTS FOR. Only approvals are recorded, so any rate computed from
    // the table reads 100% forever - which is both meaningless and the claim the Marketing Claim
    // Library bans.
    expect(dashboard.value.placementApprovalRate.value).toBeNull();
    expect(dashboard.value.placementApprovalRate.note).toMatch(/100% forever/);
    expect(dashboard.value.placementApprovalRate.basis.unmeasured.join(' ')).toMatch(/5\.5/);
  });

  it('reports what it can measure under a different name', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;
    // Measures us, not the providers - and says so in its label.
    expect(dashboard.value.internalGateRefusalRate.label).toMatch(/our own gate/);
  });

  it('carries every domain nothing produces', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    const domains = dashboard.value.unproduced.map((entry) => entry.domain).join(' | ');
    expect(domains).toMatch(/forecast accuracy/i);
    expect(domains).toMatch(/NPS/);
    // A gap that points nowhere is a shrug; each names what would fill it.
    for (const entry of dashboard.value.unproduced) {
      expect(entry.awaiting.length, entry.domain).toBeGreaterThan(30);
    }
  });
});

describe('9.1 measurable domains', () => {
  it('measures readiness improvement only across clients with two readings', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    // Two leads, each with two readings: +10 and +20, mean +15.
    expect(dashboard.value.readinessImprovement.value).toBeCloseTo(15);
    expect(dashboard.value.readinessImprovement.basis.numerator).toBe(2);
  });

  it('reports the firewall resolution rate with a denominator of one trigger', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;
    // A single trigger is a real denominator here - unlike an approval rate, "how many of the
    // triggers we raised did we clear" is answerable at n=1.
    expect(dashboard.value.firewallResolutionRate.value).toBe(1);
  });

  it('reports revenue as BILLED and excludes payments from the numerator', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    // One charge of $2,495 and one payment of the same. Counting both would double it.
    expect(dashboard.value.revenuePerClientCents.value).toBe(fromDollars(2_495));
    expect(dashboard.value.revenuePerClientCents.note).toMatch(/BILLED, not collected/);
  });
});

describe('9.1 the Gardner rollup', () => {
  it('cannot carry a client identifier', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    const rollup = gardnerRollup(dashboard.value);
    const serialised = JSON.stringify(rollup);

    // Structural, not redacted: the type has no field a client id could live in. Asserted by
    // searching for the ids we know exist.
    expect(serialised).not.toContain(passing);
    expect(serialised).not.toContain(failing);
    expect(serialised).not.toContain('Passing Holdings');
    // The tenant id is not in it either - a portfolio rollup does not need to say whose book.
    expect(serialised).not.toContain(fx.tenant.id);
  });

  it('carries what it could not compute rather than dropping it', async () => {
    const dashboard = await executiveDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    if (dashboard.status !== 'ok') return;

    const rollup = gardnerRollup(dashboard.value);
    // A rollup that quietly omitted its gaps would let a portfolio view read as complete.
    expect(rollup.withheld.length).toBeGreaterThan(0);
    expect(rollup.withheld.map((entry) => entry.key)).toContain('placement_approval_rate');
    expect(rollup.periodPartial).toBe(false);
  });
});

describe('9.2 an incomplete margin is not a margin', () => {
  it('refuses gross margin and says what is missing', async () => {
    const result = await grossMargin(fx.tenant.id);
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/Plaid/);
      expect(result.reason).toMatch(/marginBeforeUnmeasuredCostsCents/);
    }
  });

  it('gives the same arithmetic under a name that says what it excludes', async () => {
    const economics = await offerEconomics(fx.tenant.id, PERIOD);
    expect(economics.value).not.toBeNull();
    if (economics.value === null) return;

    const foundation = economics.value.find((entry) => entry.offerKey === 'foundation');
    expect(foundation).toBeDefined();
    expect(foundation!.billedCents).toBe(fromDollars(2_495));
    expect(foundation!.marginBeforeUnmeasuredCostsCents).toBe(fromDollars(2_495));
    expect(foundation!.unmeasuredCostLines.length).toBeGreaterThan(0);
    // Coverage says partial, so a caller checking coverage rather than reading the name still
    // learns something is missing.
    expect(economics.basis.coverage).toBe('partial');
  });

  it('reports vendor cost per client as not_built rather than zero', async () => {
    const result = await vendorCostForClient(passing);
    expect(result.status).toBe('not_built');
    if (result.status === 'not_built') {
      // Zero would flow into a margin as a measurement and overstate every engagement.
      expect(result.reason).toMatch(/Reporting zero/);
    }
  });
});

describe('9.2 no projected LTV', () => {
  it('refuses the projection and names what it would need', async () => {
    const result = await projectedLtv(fx.tenant.id);
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/churn/);
      expect(result.reason).toMatch(/realisedRevenuePerClient/);
      // The refusal is a piece of work, not a permanent gap.
      expect(result.reason).toMatch(/becomes computable/);
    }
  });

  it('measures realised revenue per client instead, with tenure alongside', async () => {
    const realised = await realisedRevenuePerClient(fx.tenant.id, NOW);
    expect(realised.value).not.toBeNull();
    if (realised.value === null) return;

    const foundation = realised.value.find((entry) => entry.offerKey === 'foundation');
    expect(foundation?.perClientCents).toBe(fromDollars(2_495));
    // Tenure is shown so a reader can see how much of a lifetime the figure covers.
    expect(foundation?.meanTenureDays).toBeGreaterThan(0);
    expect(realised.note).toMatch(/not LTV/);
  });
});

describe('9.2 CAC takes spend from the caller', () => {
  it('reports a channel with no supplied spend rather than dropping it', async () => {
    const cac = await acquisitionCost(fx.tenant.id, PERIOD, {});
    expect(cac.value).not.toBeNull();
    if (cac.value === null) return;

    const channel = cac.value.find((entry) => entry.sourceChannel === 'paid_search');
    expect(channel).toBeDefined();
    expect(channel!.converted).toBe(1);
    // A channel missing from a CAC report reads as a channel that acquired nobody.
    expect(channel!.cacCents).toBeNull();
    expect(cac.note).toMatch(/No spend was supplied/);
  });

  it('computes CAC when spend is supplied', async () => {
    const cac = await acquisitionCost(fx.tenant.id, PERIOD, {
      paid_search: fromDollars(1_200),
    });
    if (cac.value === null) return;

    const channel = cac.value.find((entry) => entry.sourceChannel === 'paid_search');
    expect(channel!.cacCents).toBe(fromDollars(1_200));
  });

  it('assembles the whole 9.2 dashboard with its refusals stated', async () => {
    const dashboard = await unitEconomicsDashboard({
      tenantId: fx.tenant.id,
      period: PERIOD,
      now: NOW,
    });
    expect(dashboard.status).toBe('ok');
    if (dashboard.status !== 'ok') return;

    // The refusals travel WITH the dashboard, so the absence is a stated decision rather than a
    // missing row a reader has to notice.
    const refusedMetrics = dashboard.value.refused.map((entry) => entry.metric);
    expect(refusedMetrics).toContain('Gross margin');
    expect(refusedMetrics).toContain('Projected LTV');
    expect(refusedMetrics).toContain('Cost per funded dollar');
    expect(dashboard.value.unmeasuredCostLines.length).toBeGreaterThan(0);
  });
});
