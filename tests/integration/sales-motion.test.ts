/**
 * 1.3 Sales Motion & Engagement Tracking, end to end.
 *
 * Two properties carry this file.
 *
 * **Attribution is written once.** A referral fee is owed to whoever introduced a client, so the
 * question "who was this attributed to when the fee was calculated" has to stay answerable after
 * somebody corrects it.
 *
 * **A sales motion is not a way around the compliance one.** Converting a lead produces a client in
 * `pending_assessment`, which the placement gate refuses - and that is asserted here rather than
 * left as a comment, because the day somebody adds a second path to a client record is the day the
 * comment stops being true and nothing else notices.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { read } from '@bwc/ledger';
import { evaluate as evaluateGate } from '@bwc/firewall';
import { find as findClient } from '@bwc/clients';
import { openFor } from '@bwc/notifications';
import { publishOffer, findEngagement, fromDollars } from '@bwc/billing';
import {
  INACTIVITY_DAYS,
  LOST_REASONS,
  MINIMUM_LEADS_FOR_RATE,
  activityFor,
  closeLead,
  conversionByChannel,
  convertLead,
  correctAttribution,
  correctionHistory,
  createLead,
  currentAttribution,
  escalateStaleLeads,
  lossReasons,
  originalAttribution,
  qualifyLead,
  recordActivity,
  recordBlueprintDelivered,
  scheduleReviewCall,
  staleLeads,
  BLUEPRINT_AGE_DAYS,
  READINESS_DELTA_THRESHOLD,
  RENEWAL_WINDOW_DAYS,
  expansionSignals,
  recordReadiness,
  renewalStates,
} from '@bwc/sales';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const CREATED_ON = new Date('2026-06-01T00:00:00.000Z');

beforeAll(async () => {
  fx = await makeFixture('sales');

  await publishOffer({
    tenantId: fx.tenant.id,
    key: 'foundation',
    name: 'Foundation',
    rung: 1,
    description: 'Entry engagement.',
    retainerCents: fromDollars(2_495),
    committedMonths: 6,
    publishedBy: 'concierge-desk',
    actor: human(),
  });
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

function human() {
  return { id: fx.human.id, kind: 'human' as const };
}
const agent = () => ({ id: fx.agent.id, kind: 'village_agent' as const });

const newLead = async (name: string, overrides: Record<string, unknown> = {}) => {
  const result = await createLead({
    tenantId: fx.tenant.id,
    prospectName: name,
    sourceChannel: 'partner_referral',
    referrerName: 'Greenstone Advisors',
    createdOn: CREATED_ON,
    actor: human(),
    ...overrides,
  });
  if (result.status !== 'ok') throw new Error(`fixture lead failed: ${result.status}`);
  return result.value;
};

const qualified = async (name: string, overrides: Record<string, unknown> = {}) => {
  const lead = await newLead(name, overrides);
  await qualifyLead({
    tenantId: fx.tenant.id,
    leadId: lead.id,
    qualification: 'qualified',
    note: 'Two years trading, clean bank feed, capital need is working capital.',
    occurredAt: CREATED_ON,
    actor: human(),
  });
  return lead;
};

describe('leads and attribution', () => {
  it('requires a source channel rather than defaulting one', async () => {
    // A default such as "unknown" would be indistinguishable from a real answer the moment anyone
    // ran a channel report, and the point of recording attribution is that the report means
    // something.
    const result = await createLead({
      tenantId: fx.tenant.id,
      prospectName: 'Unattributed Co',
      sourceChannel: '   ',
      createdOn: CREATED_ON,
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/channel report/);
  });

  it('records attribution at creation and exposes no way to update it', async () => {
    const lead = await newLead('Attributed Co');
    expect(lead.sourceChannel).toBe('partner_referral');
    expect(lead.referrerName).toBe('Greenstone Advisors');

    // The structural claim, asserted as a property of the module surface rather than of a code
    // path: nothing exported updates the attribution columns.
    const surface = await import('@bwc/sales');
    const updaters = Object.keys(surface).filter((name) => /attribut/i.test(name));
    expect(updaters.sort()).toEqual([
      'correctAttribution',
      'currentAttribution',
      'originalAttribution',
    ]);
  });

  it('keeps the original readable after a correction', async () => {
    // The question a payout dispute asks is "who was this attributed to when the fee was
    // calculated". Overwriting the original destroys the only evidence of it.
    const lead = await newLead('Corrected Co');

    const corrected = await correctAttribution({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      toSourceChannel: 'direct',
      toReferrerName: null,
      reason: 'Greenstone confirmed they did not introduce this client; inbound via the website.',
      actor: human(),
      correctedBy: 'compliance@burkhamwickmont.test',
      correctedAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    expect(corrected.status).toBe('ok');

    const current = await currentAttribution(fx.tenant.id, lead.id);
    const original = await originalAttribution(fx.tenant.id, lead.id);

    if (current.status !== 'ok' || original.status !== 'ok') throw new Error('expected both');
    expect(current.value.sourceChannel).toBe('direct');
    expect(current.value.referrerName).toBeNull();
    expect(current.value.corrected).toBe(true);

    expect(original.value.sourceChannel).toBe('partner_referral');
    expect(original.value.referrerName).toBe('Greenstone Advisors');

    const history = await correctionHistory(fx.tenant.id, lead.id);
    expect(history[0]?.fromReferrerName).toBe('Greenstone Advisors');
    expect(history[0]?.reason).toMatch(/did not introduce/);
  });

  it('refuses a correction by an agent, and one with no reason', async () => {
    // It moves money between partners. An agent able to do it would make the record unreliable in
    // exactly the place it needs to be trusted.
    const lead = await newLead('Guarded Attribution Co');

    const byAgent = await correctAttribution({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      toSourceChannel: 'direct',
      reason: 'An agent trying to move a referral fee.',
      actor: agent(),
      correctedBy: 'some-agent',
      correctedAt: CREATED_ON,
    });
    expect(byAgent.status).toBe('refused');
    if (byAgent.status === 'refused') expect(byAgent.reason).toMatch(/Authority Level 3/);

    const noReason = await correctAttribution({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      toSourceChannel: 'direct',
      reason: '  ',
      actor: human(),
      correctedBy: 'compliance@burkhamwickmont.test',
      correctedAt: CREATED_ON,
    });
    expect(noReason.status).toBe('refused');
  });

  it('requires a note on a qualification decision', async () => {
    const lead = await newLead('Unexplained Co');
    const result = await qualifyLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      qualification: 'disqualified',
      note: '   ',
      occurredAt: CREATED_ON,
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });
});

describe('the pipeline runs in order', () => {
  it('refuses a Blueprint before qualification', async () => {
    const lead = await newLead('Premature Blueprint Co');
    const result = await recordBlueprintDelivered({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 72,
      deliveredOn: CREATED_ON,
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/has not been qualified/);
  });

  it('refuses a review call before a Blueprint', async () => {
    const lead = await qualified('Premature Call Co');
    const result = await scheduleReviewCall({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      scheduledFor: new Date('2026-07-01T00:00:00.000Z'),
      scheduledOn: CREATED_ON,
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/reviews the Blueprint/);
  });

  it('walks the whole pipeline and keeps the trail', async () => {
    const lead = await qualified('Full Pipeline Co');

    await recordBlueprintDelivered({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 68,
      deliveredOn: new Date('2026-06-10T00:00:00.000Z'),
      actor: human(),
    });
    await scheduleReviewCall({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      scheduledFor: new Date('2026-06-20T00:00:00.000Z'),
      scheduledOn: new Date('2026-06-12T00:00:00.000Z'),
      actor: human(),
    });

    const trail = await activityFor(fx.tenant.id, lead.id);
    const kinds = trail.map((entry) => entry.kind);

    // Every step is on the trail, and the two the test dates explicitly are in the order it dated
    // them. `created` and `qualification` are NOT compared to each other: both are stamped with the
    // wall clock a fraction of a millisecond apart, `occurredAt` is `timestamp(3)`, and when they
    // land in the same millisecond nothing decides which came first. This assertion used to demand
    // one and failed about one run in ten for that reason alone - see ADR-0034.
    expect(kinds.sort()).toEqual(
      ['blueprint_delivered', 'created', 'qualification', 'review_call_scheduled'].sort(),
    );
    expect(kinds.indexOf('blueprint_delivered')).toBeLessThan(
      kinds.indexOf('review_call_scheduled'),
    );
    // The trail explains the pipeline rather than merely accompanying it.
    expect(trail[2]?.fromStage).toBe('qualified');
    expect(trail[2]?.toStage).toBe('blueprint_delivered');
  });

  it('refuses a readiness figure outside a comparable scale', async () => {
    const lead = await qualified('Odd Readiness Co');
    for (const readiness of [-1, 101, 72.5]) {
      const result = await recordBlueprintDelivered({
        tenantId: fx.tenant.id,
        leadId: lead.id,
        readiness,
        deliveredOn: CREATED_ON,
        actor: human(),
      });
      expect(result.status, String(readiness)).toBe('refused');
    }
  });
});

describe('45-day inactivity', () => {
  it('is stale on day 46 and not on day 45', async () => {
    // "45 days" includes the 45th. An off-by-one either escalates a day early or leaves a lead
    // sitting a day longer than the rule says.
    const lead = await newLead('Quiet Co');

    const day45 = await staleLeads(fx.tenant.id, new Date('2026-07-16T00:00:00.000Z'));
    expect(day45.some((entry) => entry.lead.id === lead.id)).toBe(false);

    const day46 = await staleLeads(fx.tenant.id, new Date('2026-07-17T00:00:00.000Z'));
    const stale = day46.find((entry) => entry.lead.id === lead.id);
    expect(stale?.idleDays).toBe(46);
    expect(INACTIVITY_DAYS).toBe(45);
    expect(stale?.summary).toMatch(/no recorded activity for 46 days/);
  });

  it('resets the clock on activity, and never moves it backwards', async () => {
    // A back-dated note about a call three weeks ago is worth recording and is not evidence the
    // lead is fresh. Letting it reset the clock backwards would make an escalation disappear
    // because somebody tidied up their notes.
    const lead = await newLead('Touched Co');

    await recordActivity({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      kind: 'call',
      summary: 'Spoke with the owner.',
      occurredAt: new Date('2026-07-10T00:00:00.000Z'),
      actor: human(),
    });

    const after = await staleLeads(fx.tenant.id, new Date('2026-07-17T00:00:00.000Z'));
    expect(after.some((entry) => entry.lead.id === lead.id)).toBe(false);

    const backdated = await recordActivity({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      kind: 'note',
      summary: 'Recording an earlier email nobody logged.',
      occurredAt: new Date('2026-06-05T00:00:00.000Z'),
      actor: human(),
    });

    if (backdated.status !== 'ok') throw new Error('expected the activity to record');
    expect(backdated.value.lastActivityAt).toBe('2026-07-10T00:00:00.000Z');
  });

  it('raises one task per stale lead and does not raise a second on re-run', async () => {
    // This is meant to run on a schedule. A version that raised a fresh task every pass would put
    // the same lead in the queue daily until somebody either acted or stopped reading the queue,
    // and the second outcome is the likely one.
    const today = new Date('2026-07-20T00:00:00.000Z');

    const first = await escalateStaleLeads({ tenantId: fx.tenant.id, actor: human(), today });
    expect(first.raised).toBeGreaterThan(0);

    const second = await escalateStaleLeads({ tenantId: fx.tenant.id, actor: human(), today });
    expect(second.raised).toBe(0);
    expect(second.alreadyOpen).toBe(first.raised);

    const tasks = await openFor(fx.tenant.id, 'concierge_desk');
    const escalations = tasks.filter((task) => task.kind === 'sales_lead_inactivity');
    expect(escalations.length).toBe(first.raised);
  });

  it('does not escalate a lead that has ended', async () => {
    // A lead that closed is not idle, it is finished. An escalation queue that filled with
    // completed work would be abandoned within a week.
    const lead = await newLead('Ended Co');
    await closeLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      reason: 'went_elsewhere',
      closedBy: 'concierge-desk',
      closedOn: CREATED_ON,
      actor: human(),
    });

    const stale = await staleLeads(fx.tenant.id, new Date('2026-09-01T00:00:00.000Z'));
    expect(stale.some((entry) => entry.lead.id === lead.id)).toBe(false);
  });
});

describe('conversion cannot outrun compliance', () => {
  it('produces a client the placement gate refuses', async () => {
    // The property this module leans on, asserted rather than commented: a converted client starts
    // in `pending_assessment`, and that is the state the Funding Ethics Firewall gate blocks.
    const lead = await qualified('Compliant Path Co');

    const converted = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      convertedBy: 'concierge-desk',
      convertedOn: new Date('2026-06-20T00:00:00.000Z'),
      actor: human(),
    });

    expect(converted.status).toBe('ok');
    if (converted.status !== 'ok') return;

    expect(converted.value.complianceState).toBe('pending_assessment');

    const client = await findClient(fx.tenant.id, converted.value.clientId);
    if (client.status !== 'ok') throw new Error('expected the client');

    const gate = await evaluateGate(client.value.id, client.value.complianceState);
    expect(gate.status).toBe('refused');
  });

  it('refuses conversion of an unqualified lead', async () => {
    const lead = await newLead('Unqualified Co');
    const result = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      convertedBy: 'concierge-desk',
      convertedOn: CREATED_ON,
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/makes the step decorative/);
  });

  it('refuses a second conversion rather than creating a second client', async () => {
    // Two client records for one business would make every downstream figure - exposure, fees,
    // compliance state - compute over half a picture, with nothing indicating the split.
    const lead = await qualified('Twice Converted Co');
    const on = new Date('2026-06-20T00:00:00.000Z');

    const first = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      convertedBy: 'concierge-desk',
      convertedOn: on,
      actor: human(),
    });
    expect(first.status).toBe('ok');

    const second = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      convertedBy: 'concierge-desk',
      convertedOn: on,
      actor: human(),
    });
    expect(second.status).toBe('refused');
    if (second.status === 'refused') expect(second.reason).toMatch(/half a picture/);
  });

  it('starts an engagement when an offer is named', async () => {
    const lead = await qualified('Engaged On Conversion Co');
    const converted = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      offerKey: 'foundation',
      convertedBy: 'concierge-desk',
      convertedOn: new Date('2026-06-20T00:00:00.000Z'),
      actor: human(),
    });

    if (converted.status !== 'ok') throw new Error('expected a conversion');
    expect(converted.value.engagementId).not.toBeNull();

    const engagement = await findEngagement(fx.tenant.id, converted.value.engagementId as string);
    if (engagement.status !== 'ok') throw new Error('expected the engagement');
    expect(engagement.value.clientId).toBe(converted.value.clientId);
  });

  it('refuses rather than half-converting when the offer does not exist', async () => {
    // This test caught a real defect rather than confirming a design. The first implementation
    // created the client, then refused when the engagement could not start - leaving an orphan
    // client and, since no outcome was recorded, allowing a retry to create a second one. A
    // function whose refusal path leaves a partial write is not refusing.
    const lead = await qualified('Bad Offer Co');
    const result = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      offerKey: 'an-offer-nobody-published',
      convertedBy: 'concierge-desk',
      convertedOn: CREATED_ON,
      actor: human(),
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/Nothing has been created/);

    // The load-bearing part: no client was left behind, so converting properly still works.
    const retry = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      offerKey: 'foundation',
      convertedBy: 'concierge-desk',
      convertedOn: CREATED_ON,
      actor: human(),
    });
    expect(retry.status).toBe('ok');
  });

  it('carries attribution into the conversion event', async () => {
    const events = await read({ tenantId: fx.tenant.id, type: 'sales.lead.converted' });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.payload['sourceChannel'] !== undefined)).toBe(true);
  });
});

describe('outcomes are countable', () => {
  it('requires a categorical loss reason and counts them', async () => {
    // "Why do we lose leads" is a question somebody will want counted, and a thousand free-text
    // sentences cannot be counted.
    for (const [index, reason] of (['price', 'timing', 'price'] as const).entries()) {
      const lead = await newLead(`Lost Co ${index}`, { sourceChannel: 'webinar' });
      await closeLead({
        tenantId: fx.tenant.id,
        leadId: lead.id,
        reason,
        detail: index === 0 ? 'Wanted a success-fee-only arrangement.' : undefined,
        closedBy: 'concierge-desk',
        closedOn: CREATED_ON,
        actor: human(),
      });
    }

    const reasons = await lossReasons(fx.tenant.id);
    const price = reasons.find((entry) => entry.reason === 'price');
    expect(price?.count).toBeGreaterThanOrEqual(2);
    expect(LOST_REASONS).toContain('compliance_concern');
  });

  it('reports no conversion rate below the minimum sample', async () => {
    // Same judgement as 5.2's approval rate: a channel report ranking partners on three leads
    // each would send a marketing budget somewhere on noise.
    const stats = await conversionByChannel(fx.tenant.id);
    const thin = stats.find((entry) => entry.sourceChannel === 'webinar');

    expect(thin?.conversionRate).toBeNull();
    expect(thin?.note).toMatch(new RegExp(`${MINIMUM_LEADS_FOR_RATE} are needed`));
  });

  it('counts open leads separately from decided ones', async () => {
    const stats = await conversionByChannel(fx.tenant.id);
    const partner = stats.find((entry) => entry.sourceChannel === 'partner_referral');
    expect(partner).toBeDefined();
    expect((partner?.converted ?? 0) + (partner?.lost ?? 0) + (partner?.open ?? 0)).toBe(
      partner?.total,
    );
  });
});

describe('expansion and renewal', () => {
  it('refuses a readiness reading with no note saying what moved', async () => {
    // A delta with no explanation tells an operator to act without telling them what to say.
    const lead = await qualified('Unexplained Delta Co');
    const result = await recordReadiness({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 80,
      note: '   ',
      takenOn: CREATED_ON,
      takenBy: 'capital-readiness',
      actor: human(),
    });
    expect(result.status).toBe('refused');
  });

  it('prompts an expansion conversation when readiness moves materially', async () => {
    const lead = await qualified('Improving Co');
    await recordBlueprintDelivered({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 62,
      deliveredOn: new Date('2026-06-05T00:00:00.000Z'),
      actor: human(),
    });
    await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      convertedBy: 'concierge-desk',
      convertedOn: new Date('2026-06-10T00:00:00.000Z'),
      actor: human(),
    });

    // Below the threshold: noise, and a trigger that fired on it would train an operator to
    // ignore the queue.
    await recordReadiness({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 68,
      note: 'Balance improved slightly after a quiet month.',
      takenOn: new Date('2026-06-20T00:00:00.000Z'),
      takenBy: 'capital-readiness',
      actor: human(),
    });

    const quiet = await expansionSignals(fx.tenant.id, new Date('2026-06-25T00:00:00.000Z'));
    expect(quiet.some((signal) => signal.leadId === lead.id)).toBe(false);

    await recordReadiness({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 79,
      note: 'Two revolving balances paid down and a new trade line seasoned past six months.',
      takenOn: new Date('2026-07-01T00:00:00.000Z'),
      takenBy: 'capital-readiness',
      actor: human(),
    });

    const signals = await expansionSignals(fx.tenant.id, new Date('2026-07-05T00:00:00.000Z'));
    const signal = signals.find(
      (entry) => entry.leadId === lead.id && entry.trigger === 'readiness_improved',
    );

    expect(READINESS_DELTA_THRESHOLD).toBe(10);
    expect(signal?.readinessAtBlueprint).toBe(62);
    expect(signal?.readinessNow).toBe(79);
    // The operator gets something to open the call with, not just a flag.
    expect(signal?.basis).toMatch(/seasoned past six months/);
  });

  it('prompts on an aged Blueprint separately from a readiness move', async () => {
    // They call for different conversations, and merging them would force the operator to work
    // out which they were being handed.
    const signals = await expansionSignals(fx.tenant.id, new Date('2026-10-01T00:00:00.000Z'));
    const aged = signals.filter((signal) => signal.trigger === 'blueprint_aged');

    expect(aged.length).toBeGreaterThan(0);
    expect(aged[0]?.daysSinceBlueprint).toBeGreaterThanOrEqual(BLUEPRINT_AGE_DAYS);
    expect(aged[0]?.basis).toMatch(/acted on or overtaken/);
  });

  it('does not prompt an expansion for a prospect who never signed', async () => {
    // An expansion conversation is with a client. Prompting one for a prospect would put the
    // sales motion and the expansion motion in the same queue saying different things about the
    // same person.
    const lead = await qualified('Never Signed Co');
    await recordBlueprintDelivered({
      tenantId: fx.tenant.id,
      leadId: lead.id,
      readiness: 50,
      deliveredOn: new Date('2026-01-01T00:00:00.000Z'),
      actor: human(),
    });

    const signals = await expansionSignals(fx.tenant.id, new Date('2026-10-01T00:00:00.000Z'));
    expect(signals.some((signal) => signal.leadId === lead.id)).toBe(false);
  });

  it('separates a save motion from a lapse', async () => {
    // "At risk" is still in time to have a conversation; "lapsed" is not. A cancelled engagement
    // is lapsed regardless of its dates, because presenting a client who left at the top of a
    // retention queue helps nobody.
    const states = await renewalStates(fx.tenant.id, new Date('2027-06-01T00:00:00.000Z'));
    expect(states.length).toBeGreaterThan(0);

    const atRisk = states.filter((state) => state.status === 'at_risk');
    expect(atRisk.length).toBeGreaterThan(0);
    expect(atRisk[0]?.explanation).toMatch(/still in time to have/);

    for (const state of states) {
      expect(state.explanation.length).toBeGreaterThan(20);
    }
  });

  it('reports an engagement inside its window as approaching or not due', async () => {
    const early = await renewalStates(fx.tenant.id, new Date('2026-06-15T00:00:00.000Z'));
    const inWindow = early.filter(
      (state) => state.status === 'approaching' || state.status === 'not_due',
    );
    expect(inWindow.length).toBeGreaterThan(0);
    expect(RENEWAL_WINDOW_DAYS).toBe(60);
  });
});
