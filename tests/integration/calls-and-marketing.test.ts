/**
 * 4.3 Call Recording & Promise Tracking and 4.5 Marketing Ops, end to end.
 *
 * Three properties carry this file.
 *
 * **A promise produces an obligation, not a verdict.** The call already happened. The assertion
 * that matters is that closing an obligation requires the correction itself - a build that let it
 * be ticked would pass everything else here.
 *
 * **Recording follows the client's state, not ours.** Asserted in both directions, because a rule
 * applied uniformly is applied wrongly in every state but one.
 *
 * **An A/B variant that fails the scan is refused, not registered as the losing arm.** While a
 * test runs, real clients read every arm.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient } from '@bwc/clients';
import { grant, revoke, forClient as consentsForClient } from '@bwc/consent';
import { seedFoundingClaims, activeLibrary } from '@bwc/claims';
import { openFor } from '@bwc/notifications';
import { read } from '@bwc/ledger';
import { timelineFor } from '@bwc/risk';
import {
  CALL_RECORDING_CONSENT_KIND,
  CORRECTION_WINDOW_HOURS,
  analyseCall,
  attachTranscript,
  beginCall,
  captureCall,
  dismissObligation,
  obligationsFor,
  openObligations,
  recordCorrection,
  type TranscriptTurn,
} from '@bwc/calls';
import {
  activateCampaign,
  approveAsset,
  approveProposal,
  channelFor,
  createAsset,
  createCampaign,
  createExperiment,
  declareWinner,
  pendingProposals,
  proposeClaim,
  registerVariant,
  rejectProposal,
  staleVariants,
  startExperiment,
  submitAssetForReview,
} from '@bwc/marketing';
import { activateState, publishStateModule } from '@bwc/regulatory';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let texan: string;
let californian: string;

const NOW = new Date('2026-08-10T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

const us = (text: string): TranscriptTurn => ({
  speaker: 'Concierge lead',
  side: 'internal',
  text,
});
const them = (text: string): TranscriptTurn => ({ speaker: 'Client', side: 'client', text });

beforeAll(async () => {
  fx = await makeFixture('calls-marketing');
  await seedFoundingClaims(fx.tenant.id, 'compliance@burkhamwickmont.test', HUMAN());

  const [a, b] = await Promise.all([
    createClient(fx.tenant.id, 'Lone Star Fabrication LLC', HUMAN()),
    createClient(fx.tenant.id, 'Pacific Coast Logistics LLC', HUMAN()),
  ]);
  texan = a.id;
  californian = b.id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('4.3 recording consent follows the client state', () => {
  it('records in a one-party state without the client consenting', async () => {
    const call = await beginCall({
      tenantId: fx.tenant.id,
      clientId: texan,
      jurisdiction: 'TX',
      purpose: 'Discovery call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });

    expect(call.status).toBe('ok');
    if (call.status !== 'ok') return;
    expect(call.value.recordingPermitted).toBe(true);
    expect(call.value.clientConsentRequired).toBe(false);
  });

  it('refuses to record in an all-party state without the client consenting', async () => {
    const call = await beginCall({
      tenantId: fx.tenant.id,
      clientId: californian,
      jurisdiction: 'CA',
      purpose: 'Discovery call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });

    // `ok` with `recordingPermitted: false` - the call happens either way; what changes is
    // whether a recording may be made.
    expect(call.status).toBe('ok');
    if (call.status !== 'ok') return;
    expect(call.value.recordingPermitted).toBe(false);
    expect(call.value.status).toBe('consent_refused');
    expect(call.value.consentBasis).toMatch(/632/);

    // And the refusal is evidence, the same way a blocked send is.
    const events = await read({
      tenantId: fx.tenant.id,
      clientId: californian,
      type: 'calls.recording.refused',
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it('records once the Californian client consents, and stops when they revoke', async () => {
    const consent = await grant({
      tenantId: fx.tenant.id,
      clientId: californian,
      kind: CALL_RECORDING_CONSENT_KIND,
      scope: 'Recording of advisory calls',
      actor: HUMAN(),
    });
    expect(consent.status).toBe('ok');

    const permitted = await beginCall({
      tenantId: fx.tenant.id,
      clientId: californian,
      jurisdiction: 'CA',
      purpose: 'Strategy call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    expect(permitted.status).toBe('ok');
    if (permitted.status === 'ok') expect(permitted.value.recordingPermitted).toBe(true);

    const all = await consentsForClient(fx.tenant.id, californian);
    for (const record of all.filter((c) => c.kind === CALL_RECORDING_CONSENT_KIND)) {
      await revoke(fx.tenant.id, record.id, HUMAN());
    }

    const afterRevocation = await beginCall({
      tenantId: fx.tenant.id,
      clientId: californian,
      jurisdiction: 'CA',
      purpose: 'Follow-up call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    expect(afterRevocation.status).toBe('ok');
    if (afterRevocation.status === 'ok') {
      expect(afterRevocation.value.recordingPermitted).toBe(false);
    }
  });

  it('refuses without a jurisdiction rather than guessing one', async () => {
    const call = await beginCall({
      tenantId: fx.tenant.id,
      clientId: texan,
      jurisdiction: '',
      purpose: 'Discovery call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    expect(call.status).toBe('refused');
  });

  it('refuses a transcript for a call that was not permitted to be recorded', async () => {
    const refusedCall = await beginCall({
      tenantId: fx.tenant.id,
      clientId: californian,
      jurisdiction: 'CA',
      purpose: 'Unconsented call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    if (refusedCall.status !== 'ok') throw new Error('setup');

    const attached = await attachTranscript({
      tenantId: fx.tenant.id,
      callId: refusedCall.value.id,
      turns: [us('Hello.')],
      source: 'manual',
      endedAt: NOW,
      actor: HUMAN(),
    });
    // A transcript here would mean a recording was made after the consent check said no.
    expect(attached.status).toBe('refused');
  });
});

describe('4.3 the VoiceForge seam', () => {
  it('reports capture as not_built rather than an empty transcript', async () => {
    const result = await captureCall('any-call-id');
    expect(result.status).toBe('not_built');
    if (result.status === 'not_built') {
      expect(result.module).toMatch(/voice provider/);
      // The reason has to say the analysis is built, or a reader concludes the whole module is.
      expect(result.reason).toMatch(/Analysis .* is built/);
      // **And it now names the GATE rather than a constant sentence.** Before ADR-0085 this seam
      // returned a hardcoded refusal, which meant switching voice capture on was a code edit. The
      // refusal names the outstanding evidence because `voice` is a vendor.
      expect(result.reason).toMatch(/vendor selection|Argus|DPA|attestation/i);
    }
  });

  it('reports analysis of a transcript-less call as not_built, not as a clean call', async () => {
    const call = await beginCall({
      tenantId: fx.tenant.id,
      clientId: texan,
      jurisdiction: 'TX',
      purpose: 'Never captured',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    if (call.status !== 'ok') throw new Error('setup');

    const analysis = await analyseCall({
      tenantId: fx.tenant.id,
      callId: call.value.id,
      owedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(analysis.status).toBe('not_built');
    if (analysis.status === 'not_built') {
      expect(analysis.reason).toMatch(/rather than a clean call/);
    }
  });

  it('refuses an empty transcript', async () => {
    const call = await beginCall({
      tenantId: fx.tenant.id,
      clientId: texan,
      jurisdiction: 'TX',
      purpose: 'Empty transcript test',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    if (call.status !== 'ok') throw new Error('setup');

    const attached = await attachTranscript({
      tenantId: fx.tenant.id,
      callId: call.value.id,
      turns: [],
      source: 'manual',
      endedAt: NOW,
      actor: HUMAN(),
    });
    expect(attached.status).toBe('refused');
  });
});

describe('4.3 promises become obligations', () => {
  let callId: string;
  let obligationId: string;

  beforeAll(async () => {
    const call = await beginCall({
      tenantId: fx.tenant.id,
      clientId: texan,
      jurisdiction: 'TX',
      purpose: 'Capital strategy call',
      internalParticipants: ['Concierge lead'],
      startedAt: NOW,
      actor: HUMAN(),
    });
    if (call.status !== 'ok') throw new Error('setup');
    callId = call.value.id;

    const attached = await attachTranscript({
      tenantId: fx.tenant.id,
      callId,
      turns: [
        us('Thanks for the time today.'),
        them('So what sort of number are we realistically looking at?'),
        us('Honestly, we can probably get you $150K on this profile.'),
        them('That would be great. How soon?'),
        us('We will have you funded within three weeks.'),
        them('It does sound almost too good to be true.'),
        them('What is the next step?'),
      ],
      source: 'manual paste',
      endedAt: new Date(NOW.getTime() + HOUR),
      actor: HUMAN(),
    });
    if (attached.status !== 'ok') throw new Error('setup: transcript');
  });

  it('analyses, raises one obligation per promise, and carries the summary gap', async () => {
    const analysis = await analyseCall({
      tenantId: fx.tenant.id,
      callId,
      owedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(analysis.status).toBe('ok');
    if (analysis.status !== 'ok') return;

    expect(analysis.value.promises.map((p) => p.kind)).toEqual([
      'amount_capability',
      'timeline_commitment',
    ]);
    expect(analysis.value.obligations).toHaveLength(2);
    expect(analysis.value.signals.objections).toContain('trust');
    expect(analysis.value.signals.buyingSignals).toContain('next_steps');

    // The AI summary is reported as its own not_built INSIDE the result. Omitting the field
    // would let a caller conclude the call did not need one.
    expect(analysis.value.summary.status).toBe('not_built');
  });

  it('gives the critical promise a shorter correction window than the serious one', async () => {
    const obligations = await obligationsFor(fx.tenant.id, texan, NOW);
    const critical = obligations.find((o) => o.severity === 'critical');
    const serious = obligations.find((o) => o.severity === 'serious');

    expect(critical).toBeDefined();
    expect(serious).toBeDefined();
    expect(new Date(critical!.dueAt).getTime()).toBe(
      NOW.getTime() + CORRECTION_WINDOW_HOURS.critical * HOUR,
    );
    expect(new Date(serious!.dueAt).getTime()).toBeGreaterThan(new Date(critical!.dueAt).getTime());
  });

  it('raises a human task for each obligation', async () => {
    const tasks = await openFor(fx.tenant.id, fx.human.id);
    expect(tasks.filter((task) => task.kind === 'correct_call_promise').length).toBeGreaterThan(0);
  });

  it('does not duplicate obligations when the transcript is re-analysed', async () => {
    // Re-analysis is normal - a better model, a corrected transcript. A second obligation for a
    // sentence already corrected would reopen work that was done.
    const before = (await obligationsFor(fx.tenant.id, texan, NOW)).length;
    await analyseCall({
      tenantId: fx.tenant.id,
      callId,
      owedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect((await obligationsFor(fx.tenant.id, texan, NOW)).length).toBe(before);
  });

  it('cannot be closed with a tick', async () => {
    // Read from the store rather than carried out of the previous test: a test that depends on
    // an earlier one's assignment fails for the wrong reason when that test fails.
    const critical = (await obligationsFor(fx.tenant.id, texan, NOW)).find(
      (obligation) => obligation.severity === 'critical' && obligation.status === 'open',
    );
    expect(critical).toBeDefined();
    obligationId = critical!.id;

    // THE ASSERTION THIS FILE EXISTS FOR. A build where closing was a status change would pass
    // everything above and fail here.
    const ticked = await recordCorrection({
      tenantId: fx.tenant.id,
      obligationId,
      correctionText: 'done',
      correctedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(ticked.status).toBe('refused');
    if (ticked.status === 'refused') {
      expect(ticked.reason).toMatch(/what was said to the client/);
    }
  });

  it('closes when the correction itself is recorded', async () => {
    const closed = await recordCorrection({
      tenantId: fx.tenant.id,
      obligationId,
      correctionText:
        'Called the client 2026-08-11 and corrected the $150K figure: we are not the decision-maker and cannot state an amount before an offer exists.',
      correctedBy: fx.human.id,
      actor: HUMAN(),
      now: new Date(NOW.getTime() + 2 * HOUR),
    });

    expect(closed.status).toBe('ok');
    if (closed.status !== 'ok') return;
    expect(closed.value.status).toBe('corrected');
    expect(closed.value.correctionText).toMatch(/not the decision-maker/);

    // Closing twice is refused.
    expect(
      (
        await recordCorrection({
          tenantId: fx.tenant.id,
          obligationId,
          correctionText: 'Called the client again to correct the same figure a second time.',
          correctedBy: fx.human.id,
          actor: HUMAN(),
          now: NOW,
        })
      ).status,
    ).toBe('refused');
  });

  it('marks an open obligation overdue without a job running', async () => {
    const later = new Date(NOW.getTime() + 200 * HOUR);
    const open = await openObligations(fx.tenant.id, later);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((obligation) => obligation.overdue)).toBe(true);
  });

  it('takes a Level 3 human and a reason to dismiss', async () => {
    const remaining = (await obligationsFor(fx.tenant.id, texan, NOW)).find(
      (obligation) => obligation.status === 'open',
    );
    expect(remaining).toBeDefined();

    const byAgent = await dismissObligation({
      tenantId: fx.tenant.id,
      obligationId: remaining!.id,
      reason: 'The agent thinks this was a false positive and not worth correcting.',
      dismissedBy: fx.agent.id,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const noReason = await dismissObligation({
      tenantId: fx.tenant.id,
      obligationId: remaining!.id,
      reason: 'fine',
      dismissedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(noReason.status).toBe('refused');

    const dismissed = await dismissObligation({
      tenantId: fx.tenant.id,
      obligationId: remaining!.id,
      reason:
        'Reviewed the recording: the three-week figure was the client repeating their own deadline, not a commitment we made.',
      dismissedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(dismissed.status).toBe('ok');
  });

  it('puts the promise on the client risk timeline', async () => {
    // 6.5's classification table names it. A promise is the earliest point at which a client
    // forms an expectation we may not meet, which is what most complaints are about.
    const timeline = await timelineFor(fx.tenant.id, texan, {}, NOW);
    expect(timeline.entries.some((entry) => entry.kind === 'calls.promise.detected')).toBe(true);
  });
});

describe('4.5 claim proposals are the intake 7.4 never had', () => {
  it('refuses a proposal with no stated intended use', async () => {
    const result = await proposeClaim({
      tenantId: fx.tenant.id,
      phrase: 'we get results',
      intendedUse: 'ads',
      submittedBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(result.status).toBe('refused');
  });

  it('refuses a phrase already in the library', async () => {
    const library = await activeLibrary({ tenantId: fx.tenant.id });
    const existing = library[0];
    expect(existing).toBeDefined();

    const result = await proposeClaim({
      tenantId: fx.tenant.id,
      phrase: existing!.phrase,
      intendedUse: 'Landing page headline for the foundation offer.',
      submittedBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(result.status).toBe('refused');
  });

  it('publishes into 7.4 on approval, and only a Level 3 human may decide', async () => {
    const proposed = await proposeClaim({
      tenantId: fx.tenant.id,
      phrase: 'we prepare businesses to be fundable',
      intendedUse: 'Landing page headline for the foundation offer, and the partner one-pager.',
      submittedBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(proposed.status).toBe('ok');
    if (proposed.status !== 'ok') return;

    expect((await pendingProposals(fx.tenant.id)).map((p) => p.id)).toContain(proposed.value.id);

    const byAgent = await approveProposal({
      tenantId: fx.tenant.id,
      proposalId: proposed.value.id,
      disposition: 'approved',
      rationale: 'The agent believes this is accurate and should go in the library.',
      approvedBy: fx.agent.id,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const approved = await approveProposal({
      tenantId: fx.tenant.id,
      proposalId: proposed.value.id,
      disposition: 'approved',
      rationale:
        'Describes what the engagement does without asserting an outcome. Reviewed by the Compliance Review Board 2026-08-10.',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(approved.status).toBe('ok');
    if (approved.status !== 'ok') return;
    expect(approved.value.publishedClaimId).not.toBeNull();

    // It is in 7.4 - the approval and the publish happen together, so there is no window in
    // which a proposal reads approved and the library does not have it.
    const library = await activeLibrary({ tenantId: fx.tenant.id });
    expect(library.map((claim) => claim.phrase)).toContain('we prepare businesses to be fundable');
  });

  it('requires the disclaimer when approving as requires_disclaimer', async () => {
    const proposed = await proposeClaim({
      tenantId: fx.tenant.id,
      phrase: 'clients often see improved terms',
      intendedUse: 'Email nurture sequence for leads who received a readiness blueprint.',
      submittedBy: fx.human.id,
      actor: HUMAN(),
    });
    if (proposed.status !== 'ok') throw new Error('setup');

    const missing = await approveProposal({
      tenantId: fx.tenant.id,
      proposalId: proposed.value.id,
      disposition: 'requires_disclaimer',
      rationale: 'Acceptable only alongside a statement that results vary and are not typical.',
      approvedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(missing.status).toBe('refused');
  });

  it('keeps the phrase on rejection', async () => {
    const proposed = await proposeClaim({
      tenantId: fx.tenant.id,
      phrase: 'most clients get funded within thirty days',
      intendedUse: 'Paid social headline for the Texas campaign.',
      submittedBy: fx.human.id,
      actor: HUMAN(),
    });
    if (proposed.status !== 'ok') throw new Error('setup');

    const rejected = await rejectProposal({
      tenantId: fx.tenant.id,
      proposalId: proposed.value.id,
      reason:
        'We do not measure this, and a timing claim we cannot substantiate is the kind a regulator asks us to evidence.',
      rejectedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(rejected.status).toBe('ok');
    if (rejected.status !== 'ok') return;
    // "We considered saying this and decided not to" is the more useful half of the record.
    expect(rejected.value.phrase).toBe('most clients get funded within thirty days');
    expect(rejected.value.decisionReason).toMatch(/cannot substantiate/);
  });
});

describe('4.5 campaigns, assets and experiments', () => {
  let campaignId: string;

  it('refuses to activate into a state 7.2 has not activated', async () => {
    const campaign = await createCampaign({
      tenantId: fx.tenant.id,
      key: 'tx-q3-founders',
      name: 'Texas Q3 founders',
      sourceChannel: 'paid_social_tx',
      jurisdictions: ['TX'],
      createdBy: fx.human.id,
      actor: HUMAN(),
    });
    expect(campaign.status).toBe('ok');
    if (campaign.status !== 'ok') return;
    campaignId = campaign.value.id;

    const tooEarly = await activateCampaign({
      tenantId: fx.tenant.id,
      campaignId,
      actor: HUMAN(),
      now: NOW,
    });
    expect(tooEarly.status).toBe('refused');
    if (tooEarly.status === 'refused') {
      // Names which states, because "one of your five is not live" sends somebody to check five.
      expect(tooEarly.reason).toMatch(/TX/);
    }
  });

  it('activates once the state is live, and hands out the channel value', async () => {
    const published = await publishStateModule({
      tenantId: fx.tenant.id,
      state: 'TX',
      summary: 'Texas commercial finance disclosure requirements.',
      citations: ['Tex. Fin. Code - scope confirmed by counsel'],
      disclosures: [
        {
          key: 'tx_cost_presentation',
          text: 'Any cost figure shown for a Texas client states the basis on which it was computed.',
          citation: 'Tex. Fin. Code (general conduct provisions)',
        },
      ],
      changeKind: 'material',
      publishedBy: fx.human.id,
      actor: HUMAN(),
    });
    if (published.status !== 'ok') throw new Error(`setup: publish ${published.status}`);

    const activated = await activateState({
      tenantId: fx.tenant.id,
      state: 'TX',
      actor: HUMAN(),
      reviewedBy: 'Outside counsel, Fig & Rowe LLP',
      reviewedAt: new Date('2026-08-01T00:00:00.000Z'),
      documentReference: 'Memo BW-REG-2026-044',
    });
    if (activated.status !== 'ok') throw new Error(`setup: activation ${activated.status}`);

    const result = await activateCampaign({
      tenantId: fx.tenant.id,
      campaignId,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('ok');

    const channel = await channelFor(fx.tenant.id, 'tx-q3-founders');
    expect(channel.status).toBe('ok');
    if (channel.status === 'ok') expect(channel.value.sourceChannel).toBe('paid_social_tx');
  });

  it('rejects a banned asset at review rather than sending it back to draft', async () => {
    const asset = await createAsset({
      tenantId: fx.tenant.id,
      campaignId,
      key: 'tx-hero-v1',
      kind: 'landing_page',
      body: 'Guaranteed approval for Texas businesses. Apply today.',
      sourceReference: 'SelfPublisherForge cascade 2026-08-09',
      createdBy: fx.human.id,
      actor: HUMAN(),
    });
    if (asset.status !== 'ok') throw new Error('setup');

    const reviewed = await submitAssetForReview({
      tenantId: fx.tenant.id,
      assetId: asset.value.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(reviewed.status).toBe('ok');
    if (reviewed.status !== 'ok') return;
    // Rejected, not draft. Draft is where somebody is still writing; losing the distinction means
    // the same banned phrase gets resubmitted by whoever picks the file up next.
    expect(reviewed.value.state).toBe('rejected');
    expect(reviewed.value.rejectionReason).toMatch(/bans/);
  });

  it('refuses to approve an asset that never went through review', async () => {
    const asset = await createAsset({
      tenantId: fx.tenant.id,
      key: 'tx-hero-v2',
      kind: 'landing_page',
      body: 'Capital readiness for Texas businesses.',
      createdBy: fx.human.id,
      actor: HUMAN(),
    });
    if (asset.status !== 'ok') throw new Error('setup');

    const approved = await approveAsset({
      tenantId: fx.tenant.id,
      assetId: asset.value.id,
      reviewedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(approved.status).toBe('refused');

    await submitAssetForReview({
      tenantId: fx.tenant.id,
      assetId: asset.value.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(
      (
        await approveAsset({
          tenantId: fx.tenant.id,
          assetId: asset.value.id,
          reviewedBy: fx.human.id,
          actor: HUMAN(),
          now: NOW,
        })
      ).status,
    ).toBe('ok');
  });

  it('refuses a non-compliant A/B variant instead of registering it as the losing arm', async () => {
    const experiment = await createExperiment({
      tenantId: fx.tenant.id,
      campaignId,
      key: 'tx-hero-headline',
      hypothesis: 'A specificity-led headline converts better than a reassurance-led one.',
      createdBy: fx.human.id,
      actor: HUMAN(),
    });
    if (experiment.status !== 'ok') throw new Error('setup');

    const compliant = await registerVariant({
      tenantId: fx.tenant.id,
      experimentId: experiment.value.id,
      key: 'a',
      body: 'Capital readiness for Texas manufacturers. See what you qualify to apply for.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(compliant.status).toBe('ok');

    // THE ASSERTION. There is no compliant way to hold a losing arm that says something we may
    // not say - while the test runs, real clients read it.
    const banned = await registerVariant({
      tenantId: fx.tenant.id,
      experimentId: experiment.value.id,
      key: 'b',
      body: 'Guaranteed approval for Texas manufacturers.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(banned.status).toBe('refused');
    if (banned.status === 'refused') {
      expect(banned.reason).toMatch(/losing arm/);
    }

    // And a one-armed test is not a test.
    const tooFew = await startExperiment({
      tenantId: fx.tenant.id,
      experimentId: experiment.value.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(tooFew.status).toBe('refused');

    const second = await registerVariant({
      tenantId: fx.tenant.id,
      experimentId: experiment.value.id,
      key: 'c',
      body: 'Know what you can apply for before you apply. Texas manufacturers.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(second.status).toBe('ok');

    const started = await startExperiment({
      tenantId: fx.tenant.id,
      experimentId: experiment.value.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(started.status).toBe('ok');

    // No variants may be added mid-flight.
    expect(
      (
        await registerVariant({
          tenantId: fx.tenant.id,
          experimentId: experiment.value.id,
          key: 'd',
          body: 'A third idea, arriving late.',
          actor: HUMAN(),
          now: NOW,
        })
      ).status,
    ).toBe('refused');

    const winner = await declareWinner({
      tenantId: fx.tenant.id,
      experimentId: experiment.value.id,
      variantKey: 'c',
      basis: 'Two weeks of traffic, 1,400 sessions per arm, 18% versus 12% lead rate.',
      actor: HUMAN(),
      now: NOW,
    });
    expect(winner.status).toBe('ok');

    // Declaring a winner adopts nothing. A conversion number is a reason to consider a claim,
    // not a review of it.
    const stale = await staleVariants(fx.tenant.id, experiment.value.id, HUMAN());
    expect(stale.status).toBe('ok');
    if (stale.status === 'ok') expect(stale.value).toEqual([]);
  });
});
