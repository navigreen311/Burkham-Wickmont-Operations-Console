/**
 * 8.1 Partner & Referrer Portal and 8.3 Training & Certification, end to end.
 *
 * Three properties carry this file.
 *
 * **An uncertified partner cannot refer, co-brand or white-label.** The gate is 8.3's reason for
 * existing, and it is asserted at each of the three capabilities rather than once, because they
 * are three call sites and a gate applied at two of them is a gate that does not exist.
 *
 * **A partner sees a named client's status only with that client's consent, and only while the
 * consent lives.** Revocation is tested by revoking, not by trusting that the read is live.
 *
 * **An aggregate below the cohort threshold is withheld, not rounded.** A partner who referred two
 * clients and is shown a stage breakdown has been told which of their two clients is where.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { forClient as consentsForClient, grant, revoke } from '@bwc/consent';
import { publish as publishClaim, seedFoundingClaims } from '@bwc/claims';
import { createLead, convertLead, correctAttribution, qualifyLead } from '@bwc/sales';
import { read } from '@bwc/ledger';
import { publishOffer } from '@bwc/billing';
import {
  MINIMUM_COHORT,
  PARTNER_VISIBILITY_CONSENT_KIND,
  RECERTIFICATION_CADENCE_DAYS,
  aggregateStatus,
  approveBrandArrangement,
  approveClaim,
  approvedClaimsFor,
  canRefer,
  completeOnboarding,
  completionsFor,
  identifiedStatus,
  leadsAttributedTo,
  payableToPartner,
  provisionWorkspace,
  publishModule,
  recordCompletion,
  recordQualification,
  referralSummary,
  registerPartner,
  requirementsFor,
  reviewBrandMaterial,
  suspendPartner,
  terminatePartner,
  withdrawClaim,
} from '@bwc/partners';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let cpa: string;
let broker: string;
let claimsModuleId: string;
let privacyModuleId: string;

const NOW = new Date('2026-08-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

/** Register a partner, produce every qualification, and activate them. */
const onboard = async (track: 'cpa_bookkeeper' | 'cre_business_broker', name: string) => {
  const registered = await registerPartner({
    tenantId: fx.tenant.id,
    legalName: name,
    contactName: 'A Contact',
    contactEmail: 'contact@example.com',
    track,
    actor: HUMAN(),
  });
  if (registered.status !== 'ok') throw new Error('fixture: registration failed');

  for (const qualification of requirementsFor(track).qualifications) {
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

  return registered.value.id;
};

const certify = async (partnerId: string, completedAt: Date = new Date(NOW.getTime() - DAY)) => {
  for (const moduleId of [claimsModuleId, privacyModuleId]) {
    await recordCompletion({
      tenantId: fx.tenant.id,
      partnerId,
      moduleId,
      completedAt,
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
  }
};

beforeAll(async () => {
  fx = await makeFixture('partner-portal');
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', HUMAN());

  const claimsModule = await publishModule({
    tenantId: fx.tenant.id,
    key: 'approved-claims',
    title: 'Approved and prohibited claims',
    objective: 'What a partner may and may not say about capital outcomes.',
    changeKind: 'material',
    publishedBy: fx.human.id,
    actor: HUMAN(),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  const privacyModule = await publishModule({
    tenantId: fx.tenant.id,
    key: 'data-privacy',
    title: 'Data privacy and referral disclosure',
    objective: 'What client information a partner may receive, and on what authority.',
    changeKind: 'material',
    publishedBy: fx.human.id,
    actor: HUMAN(),
    now: new Date('2026-01-01T00:00:00.000Z'),
  });
  if (claimsModule.status !== 'ok' || privacyModule.status !== 'ok') {
    throw new Error('fixture: curriculum publish failed');
  }
  claimsModuleId = claimsModule.value.id;
  privacyModuleId = privacyModule.value.id;

  cpa = await onboard('cpa_bookkeeper', 'Ridgeline CPA LLC');
  broker = await onboard('cre_business_broker', 'Harbor Business Brokers LLC');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('8.1 onboarding', () => {
  it('refuses a track outside the seven', async () => {
    const result = await registerPartner({
      tenantId: fx.tenant.id,
      legalName: 'Somebody Else LLC',
      contactName: 'A Contact',
      contactEmail: 'x@example.com',
      track: 'insurance_agent',
      actor: HUMAN(),
    });
    expect(result.status).toBe('refused');
  });

  it('refuses a qualification the track does not ask for', async () => {
    const result = await recordQualification({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      qualification: 'A reference from a friend',
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(result.status).toBe('refused');
  });

  it('refuses to activate a partner with qualifications outstanding, and names them', async () => {
    const registered = await registerPartner({
      tenantId: fx.tenant.id,
      legalName: 'Half Done LLC',
      contactName: 'A Contact',
      contactEmail: 'x@example.com',
      track: 'cpa_bookkeeper',
      actor: HUMAN(),
    });
    if (registered.status !== 'ok') throw new Error('setup');

    await recordQualification({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      qualification: requirementsFor('cpa_bookkeeper').qualifications[0] as string,
      recordedBy: fx.human.id,
      actor: HUMAN(),
    });

    const result = await completeOnboarding({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      completedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/insurance certificate/i);
    }
  });
});

describe('8.3 the gate', () => {
  it('refuses every gated capability while the partner is uncertified', async () => {
    // Onboarded but no training recorded. All three capabilities must refuse, and each is a
    // separate call site - a gate applied at two of them is not a gate.
    const referral = await canRefer(fx.tenant.id, cpa, NOW);
    expect(referral.status).toBe('refused');
    if (referral.status === 'refused') expect(referral.reason).toMatch(/not certified/);

    const brand = await approveBrandArrangement({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      arrangement: 'co_brand',
      presentedName: 'Ridgeline x Burkham Wickmont',
      surface: 'Landing page',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(brand.status).toBe('refused');

    const whiteLabel = await approveBrandArrangement({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      arrangement: 'white_label',
      presentedName: 'Ridgeline Capital Advisory',
      surface: 'Client workspace',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(whiteLabel.status).toBe('refused');
  });

  it('permits referring once the curriculum is complete', async () => {
    await certify(cpa);
    const result = await canRefer(fx.tenant.id, cpa, NOW);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.state).toBe('certified');
  });

  it('decertifies when the cadence passes, with nothing running', async () => {
    const later = new Date(NOW.getTime() + (RECERTIFICATION_CADENCE_DAYS + 2) * DAY);
    const result = await canRefer(fx.tenant.id, cpa, later);
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/Recertification is overdue/);
  });

  it('reports the relationship problem before the training one', async () => {
    // A suspended partner told to retake a course would do the course and still be suspended.
    await suspendPartner({
      tenantId: fx.tenant.id,
      partnerId: broker,
      reason: 'Under review following a client complaint.',
      suspendedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    const result = await canRefer(fx.tenant.id, broker, NOW);
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/suspended/);
      expect(result.reason).not.toMatch(/certif/i);
    }

    await completeOnboarding({
      tenantId: fx.tenant.id,
      partnerId: broker,
      completedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    await certify(broker);
  });

  it('takes a Level 3 human to terminate', async () => {
    const registered = await registerPartner({
      tenantId: fx.tenant.id,
      legalName: 'Short Lived LLC',
      contactName: 'A Contact',
      contactEmail: 'x@example.com',
      track: 'payroll_hr',
      actor: HUMAN(),
    });
    if (registered.status !== 'ok') throw new Error('setup');

    const byAgent = await terminatePartner({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      reason: 'The agent believes this relationship should end.',
      terminatedBy: fx.agent.id,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const byHuman = await terminatePartner({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      reason: 'Partner withdrew from the programme in writing on 2026-08-01.',
      terminatedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(byHuman.status).toBe('ok');

    // Terminated is not a state onboarding resumes from.
    const reonboard = await completeOnboarding({
      tenantId: fx.tenant.id,
      partnerId: registered.value.id,
      completedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(reonboard.status).toBe('refused');
  });
});

describe('8.3 curriculum versioning', () => {
  it('refuses an editorial first version', async () => {
    const result = await publishModule({
      tenantId: fx.tenant.id,
      key: 'brand-new',
      title: 'Brand new module',
      objective: 'Something a partner should know afterwards.',
      changeKind: 'editorial',
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('carries completions forward on an editorial change, and keeps the original date', async () => {
    const completedAt = new Date('2026-03-01T00:00:00.000Z');
    const partnerId = await onboard('cre_business_broker', 'Editorial Test Brokers LLC');

    const published = await publishModule({
      tenantId: fx.tenant.id,
      key: 'editorial-subject',
      title: 'Editorial subject',
      objective: 'Something a partner should know afterwards.',
      // Scoped to one track deliberately. A module with no track list is required by EVERY
      // track, so publishing one mid-file would decertify every partner the later tests use -
      // which is correct behaviour, and is asserted on its own at the end of this file.
      requiredForTracks: ['payroll_hr'],
      changeKind: 'material',
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    if (published.status !== 'ok') throw new Error('setup');

    await recordCompletion({
      tenantId: fx.tenant.id,
      partnerId,
      moduleId: published.value.id,
      completedAt,
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    const republished = await publishModule({
      tenantId: fx.tenant.id,
      key: 'editorial-subject',
      title: 'Editorial subject',
      objective: 'Something a partner should know afterwards, with a typo fixed.',
      requiredForTracks: ['payroll_hr'],
      changeKind: 'editorial',
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(republished.status).toBe('ok');
    if (republished.status !== 'ok') return;

    // The completion was carried forward by the editorial republish - nothing was recorded here.
    const completions = await completionsFor(fx.tenant.id, partnerId);
    const carried = completions.find((entry) => entry.moduleId === republished.value.id);
    expect(carried).toBeDefined();
    // And it kept its ORIGINAL date. Stamping today would quietly extend every partner's
    // certification by a year because somebody fixed a link.
    expect(carried?.completedAt.toISOString()).toBe(completedAt.toISOString());
  });

  it('refuses a completion dated in the future', async () => {
    const result = await recordCompletion({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      moduleId: claimsModuleId,
      completedAt: new Date(NOW.getTime() + 10 * DAY),
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });
});

describe('8.1 approved claims resolve to 7.4', () => {
  it('refuses to approve a claim outside the library', async () => {
    const result = await approveClaim({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      claimId: '00000000-0000-4000-8000-000000000000',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('refuses to approve a banned claim', async () => {
    const banned = await publishClaim({
      tenantId: fx.tenant.id,
      phrase: 'we can wipe your existing debt',
      disposition: 'banned',
      rationale: 'A statement we cannot make and no partner may make for us.',
      approvedBy: 'compliance@burkhamwickmont.test',
      actor: HUMAN(),
    });
    if (banned.status !== 'ok') throw new Error('setup');

    const result = await approveClaim({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      claimId: banned.value.id,
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('drops an approval whose claim is later banned, without deleting the record', async () => {
    const claim = await publishClaim({
      tenantId: fx.tenant.id,
      phrase: 'we help businesses prepare for capital',
      disposition: 'approved',
      rationale: 'Descriptive and accurate.',
      approvedBy: 'compliance@burkhamwickmont.test',
      actor: HUMAN(),
    });
    if (claim.status !== 'ok') throw new Error('setup');

    const approved = await approveClaim({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      claimId: claim.value.id,
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(approved.status).toBe('ok');
    expect((await approvedClaimsFor(fx.tenant.id, cpa)).map((entry) => entry.phrase)).toContain(
      'we help businesses prepare for capital',
    );

    // 7.4 changes its mind. Nothing comes back here to update anything.
    const rebanned = await publishClaim({
      tenantId: fx.tenant.id,
      phrase: 'we help businesses prepare for capital',
      disposition: 'banned',
      rationale: 'Reconsidered by the Compliance Review Board.',
      approvedBy: 'compliance@burkhamwickmont.test',
      actor: HUMAN(),
    });
    expect(rebanned.status).toBe('ok');

    expect((await approvedClaimsFor(fx.tenant.id, cpa)).map((entry) => entry.phrase)).not.toContain(
      'we help businesses prepare for capital',
    );
  });

  it('withdraws an approval explicitly', async () => {
    const claim = await publishClaim({
      tenantId: fx.tenant.id,
      phrase: 'we work with credit unions and community lenders',
      disposition: 'approved',
      rationale: 'Accurate description of the provider set.',
      approvedBy: 'compliance@burkhamwickmont.test',
      actor: HUMAN(),
    });
    if (claim.status !== 'ok') throw new Error('setup');

    await approveClaim({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      claimId: claim.value.id,
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    const withdrawn = await withdrawClaim({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      claimId: claim.value.id,
      reason: 'Partner is no longer placing with credit unions.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(withdrawn.status).toBe('ok');
    expect(
      (
        await withdrawClaim({
          tenantId: fx.tenant.id,
          partnerId: cpa,
          claimId: claim.value.id,
          reason: 'Again.',
          actor: HUMAN(),
          now: NOW,
        })
      ).status,
    ).toBe('refused');
  });
});

describe('8.1 brand arrangements', () => {
  it('approves a white label with its own stricter rules', async () => {
    const result = await approveBrandArrangement({
      tenantId: fx.tenant.id,
      partnerId: broker,
      arrangement: 'white_label',
      presentedName: 'Harbor Capital Advisory',
      surface: 'Client workspace',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // Under a white label the client may not know we exist, so the disclosure obligation has to
    // be carried by the only party the client can see.
    expect(result.value.brandRules.some((rule) => /performed by a third party/.test(rule))).toBe(
      true,
    );
  });

  it('reports the workspace itself as not built', async () => {
    const result = await provisionWorkspace('any-config-id');
    expect(result.status).toBe('not_built');
  });

  it('runs partner material through the compliance scanner', async () => {
    const blocked = await reviewBrandMaterial({
      tenantId: fx.tenant.id,
      partnerId: broker,
      text: 'Work with Harbor and your approval is guaranteed once you sign.',
      actor: HUMAN(),
    });
    expect(blocked.status).toBe('refused');
    if (blocked.status === 'refused') {
      expect(blocked.reason).toMatch(/bans/);
    }

    const clean = await reviewBrandMaterial({
      tenantId: fx.tenant.id,
      partnerId: broker,
      text: 'Harbor works with Burkham Wickmont to help businesses prepare for capital.',
      actor: HUMAN(),
    });
    expect(clean.status).toBe('ok');
  });
});

describe('8.1 referral tracking and visibility', () => {
  it('withholds a stage breakdown below the cohort threshold', async () => {
    for (let index = 0; index < 2; index += 1) {
      await createLead({
        tenantId: fx.tenant.id,
        prospectName: `Small Cohort ${index} LLC`,
        sourceChannel: 'partner_referral',
        referrerName: 'Ridgeline CPA LLC',
        referrerPartnerId: cpa,
        createdOn: NOW,
        actor: HUMAN(),
      });
    }

    const aggregate = await aggregateStatus(fx.tenant.id, cpa);

    // Two referrals. A stage breakdown here tells the partner which of their two clients is where.
    expect(aggregate.released).toBe(false);
    expect(aggregate.countsByStage).toEqual({});
    // The count itself is released - the partner already knows how many they sent.
    expect(aggregate.totalReferrals).toBe(2);
    expect(aggregate.detail).toMatch(/removing the name does not make it anonymous/);
  });

  it('releases a breakdown at the threshold', async () => {
    for (let index = 2; index < MINIMUM_COHORT; index += 1) {
      await createLead({
        tenantId: fx.tenant.id,
        prospectName: `Small Cohort ${index} LLC`,
        sourceChannel: 'partner_referral',
        referrerName: 'Ridgeline CPA LLC',
        referrerPartnerId: cpa,
        createdOn: NOW,
        actor: HUMAN(),
      });
    }

    const aggregate = await aggregateStatus(fx.tenant.id, cpa);
    expect(aggregate.released).toBe(true);
    expect(aggregate.totalReferrals).toBe(MINIMUM_COHORT);
    expect(aggregate.countsByStage['new_lead']).toBe(MINIMUM_COHORT);
  });

  it('follows an attribution correction rather than the lead column', async () => {
    // The lead's own attribution columns are never updated - that is 1.3's design. A portal
    // reading them would show a partner a client that is no longer theirs.
    const lead = await createLead({
      tenantId: fx.tenant.id,
      prospectName: 'Reattributed Holdings LLC',
      sourceChannel: 'partner_referral',
      referrerName: 'Ridgeline CPA LLC',
      referrerPartnerId: cpa,
      createdOn: NOW,
      actor: HUMAN(),
    });
    if (lead.status !== 'ok') throw new Error('setup');

    expect((await leadsAttributedTo(fx.tenant.id, cpa)).map((l) => l.leadId)).toContain(
      lead.value.id,
    );

    const corrected = await correctAttribution({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      toSourceChannel: 'partner_referral',
      toReferrerName: 'Harbor Business Brokers LLC',
      toReferrerPartnerId: broker,
      reason: 'The introduction was made by Harbor; Ridgeline was recorded in error.',
      actor: HUMAN(),
      correctedBy: fx.human.id,
      correctedAt: NOW,
    });
    expect(corrected.status).toBe('ok');

    expect((await leadsAttributedTo(fx.tenant.id, cpa)).map((l) => l.leadId)).not.toContain(
      lead.value.id,
    );
    expect((await leadsAttributedTo(fx.tenant.id, broker)).map((l) => l.leadId)).toContain(
      lead.value.id,
    );
  });

  it('counts referrals without producing a conversion rate', async () => {
    const summary = await referralSummary(fx.tenant.id, cpa);
    expect(summary.status).toBe('ok');
    if (summary.status !== 'ok') return;
    expect(summary.value.totalReferrals).toBe(MINIMUM_COHORT);
    expect(Object.keys(summary.value)).not.toContain('conversionRate');
  });

  it('reports what a partner is owed as not_built, naming 8.2', async () => {
    const result = await payableToPartner(cpa);
    expect(result.status).toBe('not_built');
    if (result.status === 'not_built') {
      expect(result.module).toMatch(/8\.2/);
    }
  });
});

describe('8.1 identified client status', () => {
  let referredClient: string;

  beforeAll(async () => {
    const offer = await publishOffer({
      tenantId: fx.tenant.id,
      key: 'foundation',
      name: 'Foundation engagement',
      rung: 1,
      description: 'Foundation capital readiness engagement.',
      retainerCents: 249500,
      committedMonths: 6,
      publishedBy: 'concierge-desk',
      actor: HUMAN(),
    });
    if (offer.status !== 'ok') throw new Error('setup: offer publish failed');

    const lead = await createLead({
      tenantId: fx.tenant.id,
      prospectName: 'Referred Operations LLC',
      sourceChannel: 'partner_referral',
      referrerName: 'Ridgeline CPA LLC',
      referrerPartnerId: cpa,
      createdOn: NOW,
      actor: HUMAN(),
    });
    if (lead.status !== 'ok') throw new Error('setup');

    await qualifyLead({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      qualification: 'qualified',
      note: 'Operating three years with clean statements.',
      actor: HUMAN(),
      occurredAt: NOW,
    });

    const converted = await convertLead({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      offerKey: 'foundation',
      convertedBy: 'concierge-desk',
      convertedOn: NOW,
      actor: HUMAN(),
    });
    if (converted.status !== 'ok') throw new Error('setup: conversion failed');
    referredClient = converted.value.clientId;
  });

  it("refuses without the client's own consent", async () => {
    const result = await identifiedStatus({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      clientId: referredClient,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      // The client consented to work with us. That is not consent to be reported on.
      expect(result.reason).toMatch(/not consent to be reported on/);
    }
  });

  it('releases compliance state only, once the client authorizes it', async () => {
    const consent = await grant({
      tenantId: fx.tenant.id,
      clientId: referredClient,
      kind: PARTNER_VISIBILITY_CONSENT_KIND,
      scope: 'Status updates to Ridgeline CPA LLC, the referring partner',
      actor: HUMAN(),
    });
    expect(consent.status).toBe('ok');

    const result = await identifiedStatus({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      clientId: referredClient,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.complianceState).toBe('pending_assessment');
    // Narrow on purpose. A referrer gets a status, not our assessment of the client's affairs.
    expect(Object.keys(result.value)).not.toContain('findings');
    expect(Object.keys(result.value)).not.toContain('documents');
  });

  it('logs the view, because the client is entitled to know when the partner looked', async () => {
    const events = await read({
      tenantId: fx.tenant.id,
      clientId: referredClient,
      type: 'partner.client_status.viewed',
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.payload['partnerId']).toBe(cpa);
  });

  it('stops on revocation, on the next read', async () => {
    const consents = await grant({
      tenantId: fx.tenant.id,
      clientId: referredClient,
      kind: PARTNER_VISIBILITY_CONSENT_KIND,
      scope: 'second grant',
      actor: HUMAN(),
    });
    if (consents.status !== 'ok') throw new Error('setup');

    const all = await consentsForClient(fx.tenant.id, referredClient);
    for (const record of all.filter((c) => c.kind === PARTNER_VISIBILITY_CONSENT_KIND)) {
      await revoke(fx.tenant.id, record.id, HUMAN());
    }

    const result = await identifiedStatus({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      clientId: referredClient,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/revoked/);
    }
  });

  it('refuses a client this partner did not refer', async () => {
    const other = await createClient(fx.tenant.id, 'Unrelated Holdings LLC', HUMAN());

    const result = await identifiedStatus({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      clientId: other.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/not currently the referrer of record/);
    }
  });
});

describe('8.3 a new required module decertifies the network', () => {
  it('takes certification away until the new module is completed', async () => {
    // Worth asserting rather than discovering. Publishing a module every track must complete
    // means every certified partner stops being certified - which is the intended behaviour of
    // "annual recertification with change delta training", and is also the reason the editorial
    // test above scopes its module to a single track.
    const before = await canRefer(fx.tenant.id, cpa, NOW);
    expect(before.status).toBe('ok');

    const published = await publishModule({
      tenantId: fx.tenant.id,
      key: 'suitability',
      title: 'Client suitability',
      objective: 'Which clients are a poor fit, and why referring them anyway is a harm.',
      changeKind: 'material',
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (published.status !== 'ok') throw new Error('setup');

    const after = await canRefer(fx.tenant.id, cpa, NOW);
    expect(after.status).toBe('refused');
    if (after.status === 'refused') expect(after.reason).toMatch(/suitability/);

    await recordCompletion({
      tenantId: fx.tenant.id,
      partnerId: cpa,
      moduleId: published.value.id,
      completedAt: NOW,
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect((await canRefer(fx.tenant.id, cpa, NOW)).status).toBe('ok');
  });
});
