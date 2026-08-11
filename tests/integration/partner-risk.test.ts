/**
 * 8.4 Partner Risk Score, end to end.
 *
 * Four properties carry this file.
 *
 * **There is no score.** Blueprint 8.4 asks for one and this module does not produce one, because a
 * single figure over these dimensions lets revenue contribution offset an unauthorized promise -
 * the trade design principle 1 forbids, made invisibly. The standing is categorical and worst-of;
 * the measures are numeric and separate; nothing combines them. ADR-0043 has the argument.
 *
 * **Worst-of, not mean.** Asserted by giving a partner a clean record on every countable dimension
 * and one open critical finding, and checking that the clean record buys them nothing.
 *
 * **A critical finding suspends immediately, from inside the recording function.** An unauthorized
 * promise is a Level 4 prohibited action performed by somebody outside the authority system, and
 * waiting for Monday is 6.4's Friday problem with a client on the other end of it.
 *
 * **The assessment is a control, not a report.** `canRefer` consults the standing. Without that,
 * 8.4 would compute `review_required` for a partner making unapproved claims and that partner would
 * go on introducing clients - which is exactly the state ADR-0034 found `autoListForComplianceFail`
 * in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { read as readLedger } from '@bwc/ledger';
import { createLead, convertLead, qualifyLead } from '@bwc/sales';
import { fromDollars, publishOffer } from '@bwc/billing';
import { seedFoundingClaims } from '@bwc/claims';
import {
  MINIMUM_REFERRALS_FOR_RATE,
  STANDING_THRESHOLDS,
  assessPartner,
  canRefer,
  completeOnboarding,
  findingsFor,
  partnersNeedingReview,
  publishModule,
  recordCompletion,
  recordFinding,
  recordQualification,
  registerPartner,
  requirementsFor,
  resolveFinding,
  standingFromTriggers,
} from '@bwc/partners';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clean: string;
let sloppy: string;
let promiser: string;
let claimsModuleId: string;

const NOW = new Date('2026-08-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

const onboard = async (name: string) => {
  const registered = await registerPartner({
    tenantId: fx.tenant.id,
    legalName: name,
    contactName: 'A Contact',
    contactEmail: 'contact@example.com',
    track: 'cpa_bookkeeper',
    actor: HUMAN(),
  });
  if (registered.status !== 'ok') throw new Error('fixture: registration failed');

  for (const qualification of requirementsFor('cpa_bookkeeper').qualifications) {
    await recordQualification({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      qualification,
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });
  }
  await completeOnboarding({
    tenantId: fx.tenant.id,
    partnerId: registered.value.id,
    completedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });

  await recordCompletion({
    tenantId: fx.tenant.id,
    partnerId: registered.value.id,
    moduleId: claimsModuleId,
    completedAt: new Date(NOW.getTime() - DAY),
    recordedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });

  return registered.value.id;
};

const finding = (
  partnerId: string,
  severity: 'critical' | 'serious' | 'notable' | 'context',
  kind:
    | 'unauthorized_promise'
    | 'unapproved_claim'
    | 'client_complaint'
    | 'documentation_gap' = 'unapproved_claim',
  summary = 'Used language outside the approved claims library on a co-branded page.',
) =>
  recordFinding({
    tenantId: fx.tenant.id,
    partnerId,
    kind,
    severity,
    summary,
    source: 'Compliance review of the partner microsite, 2026-08-01.',
    occurredAt: new Date(NOW.getTime() - DAY),
    recordedBy: fx.human.id,
    actor: HUMAN(),
    now: NOW,
  });

beforeAll(async () => {
  fx = await makeFixture('partner-risk');
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', HUMAN());

  const published = await publishModule({
    tenantId: fx.tenant.id,
    key: 'approved-claims',
    title: 'Approved and prohibited claims',
    objective: 'What a partner may and may not say about capital outcomes.',
    changeKind: 'material',
    publishedBy: fx.human.id,
    actor: HUMAN(),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  if (published.status !== 'ok') throw new Error('fixture: module');
  claimsModuleId = published.value.id;

  await publishOffer({
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

  clean = await onboard('Clean Books CPA');
  sloppy = await onboard('Sloppy Practice CPA');
  promiser = await onboard('Promises Made CPA');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('there is no score', () => {
  it('reports a categorical standing beside numeric measures, and never one number', async () => {
    const assessment = await assessPartner(fx.tenant.id, clean, NOW);
    expect(assessment.status).toBe('ok');
    if (assessment.status !== 'ok') return;

    expect(assessment.value.standing).toBe('good_standing');
    expect(assessment.value.measures.length).toBeGreaterThan(0);

    // The shape assertion. If somebody adds a composite figure later, this fails - which is the
    // point of writing it down rather than trusting the module header.
    expect(Object.keys(assessment.value)).not.toContain('score');
    expect(Object.keys(assessment.value)).not.toContain('riskScore');
    expect(assessment.value.note).toMatch(/reported separately/);
  });

  it('names the dimensions 8.4 asks for that nothing can answer yet', async () => {
    // Honest empty states: a dimension left silently out reads as a dimension that came back clean.
    const assessment = await assessPartner(fx.tenant.id, clean, NOW);
    if (assessment.status !== 'ok') return;
    expect(assessment.value.unmeasured.join(' ')).toMatch(/8\.2 Partner Agreement/);
    expect(assessment.value.unmeasured.join(' ')).toMatch(/high-risk client rate/);
  });

  it('withholds a rate below the minimum sample rather than computing one', async () => {
    const assessment = await assessPartner(fx.tenant.id, clean, NOW);
    if (assessment.status !== 'ok') return;
    const conversion = assessment.value.measures.find((m) => m.key === 'conversion_rate');
    expect(conversion?.value).toBeNull();
    expect(conversion?.note).toMatch(new RegExp(`${MINIMUM_REFERRALS_FOR_RATE} are needed`));
  });
});

describe('worst-of, not mean', () => {
  it('lets nothing a partner did well soften an open critical finding', async () => {
    // Ten decided referrals, every one converted - a perfect record on the only countable
    // dimension this fixture can produce - and one unauthorized promise.
    for (let index = 0; index < 10; index += 1) {
      const lead = await createLead({
        tenantId: fx.tenant.id,
        prospectName: `Referred Co ${index}`,
        sourceChannel: 'partner_referral',
        referrerName: 'Promises Made CPA',
        referrerPartnerId: promiser,
        createdOn: new Date(NOW.getTime() - 30 * DAY),
        actor: HUMAN(),
      });
      if (lead.status !== 'ok') throw new Error('fixture: lead');
      await qualifyLead({
        tenantId: fx.tenant.id,
        leadId: lead.value.id,
        qualification: 'qualified',
        note: 'Trading two years with a clean bank feed and a working capital need.',
        occurredAt: new Date(NOW.getTime() - 29 * DAY),
        actor: HUMAN(),
      });
      await convertLead({
        tenantId: fx.tenant.id,
        leadId: lead.value.id,
        offerKey: 'foundation',
        convertedBy: fx.human.id,
        convertedOn: new Date(NOW.getTime() - 28 * DAY),
        actor: HUMAN(),
      });
    }

    const before = await assessPartner(fx.tenant.id, promiser, NOW);
    if (before.status !== 'ok') return;
    const conversion = before.value.measures.find((m) => m.key === 'conversion_rate');
    expect(conversion?.value).toBe(1);
    expect(before.value.standing).toBe('good_standing');

    await finding(
      promiser,
      'critical',
      'unauthorized_promise',
      'Told a client on a recorded call that funding was guaranteed at $250,000.',
    );

    const after = await assessPartner(fx.tenant.id, promiser, NOW);
    if (after.status !== 'ok') return;

    // A perfect conversion rate is still a perfect conversion rate, and it buys nothing.
    expect(after.value.measures.find((m) => m.key === 'conversion_rate')?.value).toBe(1);
    expect(after.value.standing).toBe('decertification_recommended');
    expect(after.value.note).toMatch(/worst-of, not mean/);
  });

  it('takes the worst standing when several thresholds fire at once', () => {
    // Pure, so the rule can be read without a database.
    expect(
      standingFromTriggers([
        { dimension: 'a', threshold: 1, observed: 1, standing: 'watch', note: '' },
        { dimension: 'b', threshold: 1, observed: 1, standing: 'review_required', note: '' },
      ]),
    ).toBe('review_required');
    expect(standingFromTriggers([])).toBe('good_standing');
  });
});

describe('a critical finding suspends, from inside the recording', () => {
  it('suspends the partner and says that it did', async () => {
    const assessment = await assessPartner(fx.tenant.id, promiser, NOW);
    if (assessment.status !== 'ok') return;
    // The suspension happened when the finding above was recorded. There is no second call a
    // caller could have skipped.
    const gate = await canRefer(fx.tenant.id, promiser, NOW);
    expect(gate.status).toBe('refused');
    if (gate.status === 'refused') expect(gate.reason).toMatch(/suspended/);
  });

  it('reports the suspension in the return value rather than leaving it to be inferred', async () => {
    const fresh = await onboard('Second Promiser CPA');
    const result = await recordFinding({
      tenantId: fx.tenant.id,
      partnerId: fresh,
      kind: 'unauthorized_promise',
      severity: 'critical',
      summary: 'Promised a specific approval amount in writing to a prospect.',
      source: 'Forwarded email from the prospect, 2026-08-05.',
      occurredAt: new Date(NOW.getTime() - DAY),
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.suspendedPartner).toBe(true);
  });

  it('does not suspend on a serious finding, which is a different judgement', async () => {
    const result = await finding(sloppy, 'serious');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.suspendedPartner).toBe(false);
  });
});

describe('thresholds escalate, and the assessment is a control', () => {
  it('stops a partner referring once open findings reach the review threshold', async () => {
    // One serious finding is `watch`, which costs nothing.
    const watching = await assessPartner(fx.tenant.id, sloppy, NOW);
    if (watching.status !== 'ok') return;
    expect(watching.value.standing).toBe('watch');
    expect((await canRefer(fx.tenant.id, sloppy, NOW)).status).toBe('ok');

    // The threshold is three. Two more.
    await finding(sloppy, 'serious');
    await finding(sloppy, 'serious');

    const reviewing = await assessPartner(fx.tenant.id, sloppy, NOW);
    if (reviewing.status !== 'ok') return;
    expect(reviewing.value.standing).toBe('review_required');
    expect(reviewing.value.triggers.some((t) => t.dimension === 'serious_findings')).toBe(true);
    expect(reviewing.value.triggers[0]?.threshold).toBe(STANDING_THRESHOLDS.seriousFindings);

    // **The assertion that makes this a control rather than a report.**
    const gate = await canRefer(fx.tenant.id, sloppy, NOW);
    expect(gate.status).toBe('refused');
    if (gate.status === 'refused') {
      expect(gate.reason).toMatch(/Channel Partnerships review/);
      expect(gate.principle).toMatch(/8\.4/);
    }
  });

  it('puts the partner on the weekly review queue and takes them off when resolved', async () => {
    const queue = await partnersNeedingReview(fx.tenant.id, NOW);
    expect(queue.map((entry) => entry.partnerId)).toContain(sloppy);

    const open = (await findingsFor(fx.tenant.id, sloppy)).filter((entry) => entry.open);
    for (const entry of open) {
      const resolved = await resolveFinding({
        tenantId: fx.tenant.id,
        findingId: entry.id,
        upheld: false,
        note: 'Reviewed with the partner; the page predated the current claims library and is now corrected.',
        resolvedBy: fx.human.id,
        actor: HUMAN(),
        now: NOW,
      });
      expect(resolved.status).toBe('ok');
    }

    const after = await assessPartner(fx.tenant.id, sloppy, NOW);
    if (after.status !== 'ok') return;
    expect(after.value.standing).toBe('good_standing');
    expect((await canRefer(fx.tenant.id, sloppy, NOW)).status).toBe('ok');

    const queueAfter = await partnersNeedingReview(fx.tenant.id, NOW);
    expect(queueAfter.map((entry) => entry.partnerId)).not.toContain(sloppy);
  });

  it('keeps a dismissed finding on the record, because a pattern of them is a signal', async () => {
    const all = await findingsFor(fx.tenant.id, sloppy);
    const dismissed = all.filter((entry) => entry.upheld === false);
    expect(dismissed.length).toBeGreaterThan(0);
    expect(dismissed[0]?.resolutionNote).toMatch(/predated the current claims library/);
  });
});

describe('what a finding requires', () => {
  it('refuses one with no summary a person could read back', async () => {
    const result = await recordFinding({
      tenantId: fx.tenant.id,
      partnerId: clean,
      kind: 'other',
      severity: 'notable',
      summary: 'bad',
      source: 'A review.',
      occurredAt: new Date(NOW.getTime() - DAY),
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/read back/);
  });

  it('refuses one with no source, because that is a rumour', async () => {
    const result = await recordFinding({
      tenantId: fx.tenant.id,
      partnerId: clean,
      kind: 'other',
      severity: 'notable',
      summary: 'Something a colleague mentioned in passing at the desk.',
      source: '   ',
      occurredAt: new Date(NOW.getTime() - DAY),
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/rumour/);
  });

  it('refuses a resolution by an agent', async () => {
    const recorded = await finding(clean, 'notable');
    if (recorded.status !== 'ok') throw new Error('setup: finding');

    const result = await resolveFinding({
      tenantId: fx.tenant.id,
      findingId: recorded.value.finding.id,
      upheld: false,
      note: 'An agent deciding whether a complaint about a partner was founded.',
      resolvedBy: fx.agent.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/requires a human/);
  });
});

describe('the Ledger', () => {
  it('records findings without the free text about a partner or a client', async () => {
    const events = await readLedger(fx.tenant.id);
    const mine = events.filter((event) => event.type.startsWith('partner.finding.'));
    expect(mine.length).toBeGreaterThan(0);
    for (const event of mine) {
      const payload = JSON.stringify(event.payload);
      expect(payload).not.toMatch(/guaranteed at/);
      expect(payload).not.toMatch(/co-branded page/);
    }
  });
});
