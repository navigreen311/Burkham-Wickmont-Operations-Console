/**
 * 6.4 Do Not Fund Governance and 6.5 Risk Event Timeline, end to end.
 *
 * Three properties carry this file, and each is one somebody could reasonably have built the
 * other way.
 *
 * **An override permits one action; it does not delist.** The test that matters is the second
 * attempt after an override is spent - because a build that turned the listing off would pass
 * every other test here and fail only that one.
 *
 * **An overdue review keeps blocking.** The opposite of 5.4's stale approval, and asserted rather
 * than trusted, because "staleness relaxes the gate" is the more common pattern and the one a
 * future edit would drift toward.
 *
 * **The timeline says what it does not watch.** A client with no risk events and no caveat reads
 * as a clean client. The caveat is the whole point of the section, so it is asserted on the empty
 * case as well as the busy one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { createActor } from '@bwc/identity';
import { chain } from '@bwc/middleware';
import { read } from '@bwc/ledger';
import { assembleEvidenceFile } from '@bwc/evidence';
import {
  DEFAULT_REVIEW_CADENCE_DAYS,
  activeListing,
  autoListForComplianceFail,
  checkDoNotFund,
  consumeOverride,
  grantOverride,
  listClient,
  listingsDueForReview,
  recordObservation,
  recordReview,
  removeListing,
  timelineFor,
} from '@bwc/risk';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let listed: string;
let clean: string;
let autoListed: string;
let stale: string;

const NOW = new Date('2026-08-01T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  fx = await makeFixture('do-not-fund');

  const [a, b, c, d] = await Promise.all([
    createClient(fx.tenant.id, 'Listed Holdings LLC', { id: fx.human.id, kind: 'human' }),
    createClient(fx.tenant.id, 'Clean Operations LLC', { id: fx.human.id, kind: 'human' }),
    createClient(fx.tenant.id, 'Auto Listed Inc', { id: fx.human.id, kind: 'human' }),
    createClient(fx.tenant.id, 'Stale Review Co', { id: fx.human.id, kind: 'human' }),
  ]);
  listed = a.id;
  clean = b.id;
  autoListed = c.id;
  stale = d.id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('6.4 listing', () => {
  it('refuses a listing with a justification nobody could read back', () => {
    return expect(
      listClient({
        tenantId: fx.tenant.id,
        clientId: listed,
        trigger: 'fraud_indicator',
        justification: 'bad',
        listedBy: fx.human.id,
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'refused' });
  });

  it('refuses a listing by a Village agent, whatever its level', async () => {
    // The check is `kind`, not authority. A Level 3 agent would pass a numeric comparison, and
    // blueprint 6.4 asks for a human override - the point is that a person is answerable.
    const seniorAgent = await createActor({
      tenantId: fx.tenant.id,
      kind: 'village_agent',
      label: 'Risk & Defense agent',
      authorityLevel: 3,
      department: 'risk_and_defense',
    });

    const result = await listClient({
      tenantId: fx.tenant.id,
      clientId: listed,
      trigger: 'fraud_indicator',
      justification: 'Bank statements do not reconcile with the stated revenue.',
      listedBy: seniorAgent.id,
      now: NOW,
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/Village agent/);
    }
  });

  it('lists a client on a Level 3 human decision', async () => {
    const result = await listClient({
      tenantId: fx.tenant.id,
      clientId: listed,
      trigger: 'material_misrepresentation',
      justification: 'Stated revenue of $2.1m is not supported by any statement in the file.',
      listedBy: fx.human.id,
      now: NOW,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.automatic).toBe(false);
    expect(result.value.listedBy).toBe(fx.human.id);
    expect(result.value.reviewCadenceDays).toBe(DEFAULT_REVIEW_CADENCE_DAYS);
    expect(result.value.reviewOverdue).toBe(false);
  });

  it('refuses a second listing rather than treating it as an update', async () => {
    // Two live listings would mean two review clocks and two removal decisions for one
    // determination, and the caller who thought they were adding a reason has created ambiguity.
    const result = await listClient({
      tenantId: fx.tenant.id,
      clientId: listed,
      trigger: 'client_conduct',
      justification: 'A second concern was raised about the same client.',
      listedBy: fx.human.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });
});

describe('6.4 the gate', () => {
  it('blocks a placement action for a listed client', async () => {
    const result = await checkDoNotFund(fx.tenant.id, listed, 'submit_application', NOW);
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      // The refusal carries the justification, so an operator reads why rather than being told
      // to go and look somewhere else.
      expect(result.reason).toMatch(/not supported by any statement/);
    }
  });

  it('lets a listed client be contacted and read about', async () => {
    // Over-blocking here would make the determination unsayable - the operator could not tell
    // the client, and nobody could read the file to decide whether to lift it.
    for (const action of ['send_client_communication', 'read_document', 'analyze_file']) {
      const result = await checkDoNotFund(fx.tenant.id, listed, action, NOW);
      expect(result.status, action).toBe('ok');
    }
  });

  it('blocks an action nobody has classified', async () => {
    // Fail-closed. An action added next year that moves capital must not pass because nobody
    // remembered to add it to a block-list.
    const result = await checkDoNotFund(fx.tenant.id, listed, 'submit_renewal_packet', NOW);
    expect(result.status).toBe('refused');
  });

  it('passes a client who is not listed', async () => {
    const result = await checkDoNotFund(fx.tenant.id, clean, 'submit_application', NOW);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.listed).toBe(false);
    }
  });
});

describe('6.4 override', () => {
  it('refuses an override with no readable justification', async () => {
    const result = await grantOverride({
      tenantId: fx.tenant.id,
      clientId: listed,
      action: 'submit_application',
      justification: 'ok',
      approvedBy: fx.human.id,
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('permits the named action once, and leaves the listing in force', async () => {
    const granted = await grantOverride({
      tenantId: fx.tenant.id,
      clientId: listed,
      action: 'submit_application',
      justification:
        'Counsel reviewed the discrepancy on 2026-07-28 and concluded it was a bookkeeping error, not a misrepresentation. One application permitted while the listing is reconsidered.',
      approvedBy: fx.human.id,
      now: NOW,
    });
    expect(granted.status).toBe('ok');
    if (granted.status !== 'ok') return;

    // Permitted now.
    const first = await checkDoNotFund(fx.tenant.id, listed, 'submit_application', NOW);
    expect(first.status).toBe('ok');
    if (first.status === 'ok') {
      expect(first.value.overrideId).toBe(granted.value.id);
      // Still listed. The override let an action through; it did not change the determination.
      expect(first.value.listed).toBe(true);
    }

    // A DIFFERENT action is still blocked - the override was scoped to one.
    const other = await checkDoNotFund(fx.tenant.id, listed, 'submit_lender_packet', NOW);
    expect(other.status).toBe('refused');

    // Spend it.
    const consumed = await consumeOverride({
      tenantId: fx.tenant.id,
      clientId: listed,
      overrideId: granted.value.id,
      usedFor: 'application to Navy Federal',
      actorId: fx.human.id,
      now: NOW,
    });
    expect(consumed.status).toBe('ok');

    // THE ASSERTION THIS FILE EXISTS FOR. A build where an override delisted the client would
    // have passed everything above and fails here.
    const second = await checkDoNotFund(fx.tenant.id, listed, 'submit_application', NOW);
    expect(second.status).toBe('refused');

    const still = await activeListing(fx.tenant.id, listed, NOW);
    expect(still?.status).toBe('listed');
  });

  it('refuses to spend an override twice', async () => {
    const granted = await grantOverride({
      tenantId: fx.tenant.id,
      clientId: listed,
      action: 'submit_lender_packet',
      justification: 'Second exception, granted on the same counsel review as the first.',
      approvedBy: fx.human.id,
      now: NOW,
    });
    expect(granted.status).toBe('ok');
    if (granted.status !== 'ok') return;

    const args = {
      tenantId: fx.tenant.id,
      clientId: listed,
      overrideId: granted.value.id,
      usedFor: 'packet to Navy Federal',
      actorId: fx.human.id,
      now: NOW,
    };
    expect((await consumeOverride(args)).status).toBe('ok');

    const again = await consumeOverride(args);
    expect(again.status).toBe('refused');
    if (again.status === 'refused') {
      expect(again.reason).toMatch(/already used/);
    }
  });

  it('has nothing to override for an unlisted client', async () => {
    const result = await grantOverride({
      tenantId: fx.tenant.id,
      clientId: clean,
      action: 'submit_application',
      justification: 'There is no listing here, so this should not be grantable.',
      approvedBy: fx.human.id,
      now: NOW,
    });
    expect(result.status).toBe('no_data');
  });
});

describe('6.4 review cadence', () => {
  it('flags an overdue review and keeps blocking', async () => {
    const listedResult = await listClient({
      tenantId: fx.tenant.id,
      clientId: stale,
      trigger: 'repeated_default',
      justification: 'Two facilities defaulted within nine months of funding.',
      listedBy: fx.human.id,
      now: NOW,
    });
    expect(listedResult.status).toBe('ok');

    const later = new Date(NOW.getTime() + (DEFAULT_REVIEW_CADENCE_DAYS + 10) * DAY);

    const current = await activeListing(fx.tenant.id, stale, later);
    expect(current?.reviewOverdue).toBe(true);

    // The opposite of 5.4. Staleness moves toward the safe answer, and here that means the
    // listing continues to block rather than expiring.
    const gate = await checkDoNotFund(fx.tenant.id, stale, 'submit_application', later);
    expect(gate.status).toBe('refused');
    if (gate.status === 'refused') {
      expect(gate.reason).toMatch(/due for review/);
      expect(gate.reason).toMatch(/continues to block/);
    }

    const due = await listingsDueForReview(fx.tenant.id, later);
    expect(due.map((listing) => listing.clientId)).toContain(stale);
  });

  it('restarts the cadence on a review without changing the listing', async () => {
    const later = new Date(NOW.getTime() + (DEFAULT_REVIEW_CADENCE_DAYS + 10) * DAY);

    const reviewed = await recordReview({
      tenantId: fx.tenant.id,
      clientId: stale,
      reviewedBy: fx.human.id,
      notes: 'Reviewed with Risk & Defense. Both defaults stand. Listing remains appropriate.',
      now: later,
    });

    expect(reviewed.status).toBe('ok');
    if (reviewed.status !== 'ok') return;
    expect(reviewed.value.reviewOverdue).toBe(false);
    // Reviewing is not removing. A review that concluded otherwise is a removal, and says so.
    expect(reviewed.value.status).toBe('listed');

    expect((await checkDoNotFund(fx.tenant.id, stale, 'submit_application', later)).status).toBe(
      'refused',
    );
  });
});

describe('6.4 automatic listing per Decision E', () => {
  /**
   * **The assertion that would have failed for the whole life of this system.**
   *
   * `autoListForComplianceFail` was written, exported and tested, and nothing called it - so a
   * client moved to `fail` stayed fundable. Nobody here calls the lister: the transition does it,
   * because a control a caller can skip by calling a different function is not a control (ADR-0034).
   */
  it('lists a client whose compliance state reaches fail, with nobody calling the lister', async () => {
    const moved = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: autoListed,
      to: 'fail',
      reason: 'Bank statements were altered before submission.',
      actor: { id: fx.human.id, kind: 'human' },
      findings: [{ code: 'DOC-ALTERED', summary: 'Statement metadata inconsistent with issuer.' }],
    });
    expect(moved.status).toBe('ok');

    const listing = await activeListing(fx.tenant.id, autoListed);
    expect(listing).not.toBeNull();
    expect(listing?.automatic).toBe(true);
    expect(listing?.trigger).toBe('compliance_fail');
    // Null rather than an invented approver. Naming one would put a fiction in the field a
    // reviewer reads to find out who decided, indistinguishable from a real approval.
    expect(listing?.listedBy).toBeNull();
    // The reason the transition gave travels into the justification a reviewer reads.
    expect(listing?.justification).toContain('altered before submission');
  });

  it('is idempotent, because a second fail transition is not a second determination', async () => {
    const first = await activeListing(fx.tenant.id, autoListed);
    expect(first).not.toBeNull();

    const again = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: autoListed,
      to: 'fail',
      reason: 'A second finding on the same file.',
      actor: { id: fx.human.id, kind: 'human' },
    });
    expect(again.status).toBe('ok');

    const after = await activeListing(fx.tenant.id, autoListed);
    // The SAME determination, not a second one dated today.
    expect(after?.id).toBe(first?.id);
    expect(after?.listedAt).toBe(first?.listedAt);
  });

  /**
   * ADR-0013 applied to the pair: automatic in, human out.
   *
   * Resolving the findings moves the compliance state back. It does not delist - that is
   * `removeListing`, with its own Level 3 human and its own justification. A listing that lapsed
   * because a state moved would be the most serious determination this system makes disappearing
   * without anybody deciding it should.
   */
  it('leaves the listing standing when the client is moved back to pass', async () => {
    const listed = await activeListing(fx.tenant.id, autoListed);
    expect(listed).not.toBeNull();

    const restored = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: autoListed,
      to: 'pass',
      reason: 'Findings resolved.',
      actor: { id: fx.human.id, kind: 'human' },
    });
    expect(restored.status).toBe('ok');

    const still = await activeListing(fx.tenant.id, autoListed);
    expect(still?.id).toBe(listed?.id);
  });

  it('does not list a client who is not at fail', async () => {
    const result = await autoListForComplianceFail({
      tenantId: fx.tenant.id,
      clientId: clean,
      complianceState: 'needs_review',
      reason: 'Needs review is not fail.',
      triggeredBy: { id: fx.human.id, kind: 'human' },
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('still takes a human to remove an automatic listing', async () => {
    // Automatic in, human out. An automatic listing is not a lesser listing.
    const byAgent = await removeListing({
      tenantId: fx.tenant.id,
      clientId: autoListed,
      removedBy: fx.agent.id,
      justification: 'The agent believes this was resolved.',
      now: NOW,
    });
    expect(byAgent.status).toBe('refused');

    const byHuman = await removeListing({
      tenantId: fx.tenant.id,
      clientId: autoListed,
      removedBy: fx.human.id,
      justification:
        'The issuer confirmed the metadata difference was their own re-render, not an alteration. Compliance state returned to pass with findings.',
      now: NOW,
    });
    expect(byHuman.status).toBe('ok');

    expect((await checkDoNotFund(fx.tenant.id, autoListed, 'submit_application', NOW)).status).toBe(
      'ok',
    );
  });
});

describe('6.4 through the middleware chain', () => {
  it('blocks at step 4 and names Do Not Fund rather than the Firewall', async () => {
    const { result, trace } = await chain({
      actorId: fx.human.id,
      tenantId: fx.tenant.id,
      action: 'submit_application',
      clientId: listed,
      eventType: 'placement.requested',
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/Do Not Fund/);
      expect(result.principle).toMatch(/6\.4/);
    }

    const blocked = trace.find((step) => step.outcome === 'blocked');
    expect(blocked?.step).toBe('firewall');
    // The step is step 4 - design principle 7 pairs the Firewall and Do Not Fund - but the
    // detail has to say which of the two fired, or the operator resolves the wrong one.
    expect(blocked?.detail).toBe('do not fund listing');
  });

  it('carries the override id out for the caller to consume', async () => {
    const granted = await grantOverride({
      tenantId: fx.tenant.id,
      clientId: listed,
      action: 'submit_application',
      justification: 'Third exception, granted for the chain test on the same counsel review.',
      approvedBy: fx.human.id,
      now: NOW,
    });
    expect(granted.status).toBe('ok');
    if (granted.status !== 'ok') return;

    // The compliance gate has to pass for this test to say anything about the override. Left at
    // `pending_assessment` it refuses one step later, and the test would go green on a build where
    // the override id was never threaded out at all - a false pass reading as a real one.
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: listed,
      to: 'pass_with_findings',
      reason: 'Assessed for the override path; the Do Not Fund listing is what is under test here.',
      actor: { id: fx.human.id, kind: 'human' },
    });

    const { result } = await chain({
      actorId: fx.human.id,
      tenantId: fx.tenant.id,
      action: 'submit_application',
      clientId: listed,
      eventType: 'placement.requested',
    });

    // The chain does NOT spend it. A caller that checks and then abandons the action would
    // otherwise have burned an exception a Level 3 human granted.
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.doNotFundOverrideId).toBe(granted.value.id);
    }

    const stillUnspent = await checkDoNotFund(fx.tenant.id, listed, 'submit_application', NOW);
    expect(stillUnspent.status).toBe('ok');
  });
});

describe('6.5 the timeline', () => {
  it('records an observation with its own provenance', async () => {
    const noSource = await recordObservation({
      tenantId: fx.tenant.id,
      clientId: listed,
      kind: 'fraud_alert',
      severity: 'critical',
      summary: 'Client reported an unauthorised account opened in the business name.',
      source: '  ',
      occurredAt: new Date('2026-07-20T10:00:00.000Z'),
      recordedBy: fx.human.id,
      actor: { id: fx.human.id, kind: 'human' },
      now: NOW,
    });
    // A risk fact with no provenance is a rumour, and the timeline cannot tell them apart once
    // it is written down.
    expect(noSource.status).toBe('refused');

    const recorded = await recordObservation({
      tenantId: fx.tenant.id,
      clientId: listed,
      kind: 'fraud_alert',
      severity: 'critical',
      summary: 'Client reported an unauthorised account opened in the business name.',
      source: 'Client call 2026-07-20, notes in the file.',
      occurredAt: new Date('2026-07-20T10:00:00.000Z'),
      recordedBy: fx.human.id,
      actor: { id: fx.human.id, kind: 'human' },
      now: NOW,
    });
    expect(recorded.status).toBe('ok');
  });

  it('refuses an observation dated in the future', async () => {
    const result = await recordObservation({
      tenantId: fx.tenant.id,
      clientId: listed,
      kind: 'nsf_event',
      severity: 'serious',
      summary: 'An NSF that has not happened yet.',
      source: 'Typo in the date field.',
      occurredAt: new Date(NOW.getTime() + 30 * DAY),
      recordedBy: fx.human.id,
      actor: { id: fx.human.id, kind: 'human' },
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('orders ledger events and observations into one chronology', async () => {
    const timeline = await timelineFor(fx.tenant.id, listed, {}, NOW);

    expect(timeline.entries.length).toBeGreaterThan(3);

    const times = timeline.entries.map((entry) => entry.at);
    expect([...times].sort()).toEqual(times);

    // Both origins are present, and a reader can tell which is which.
    expect(timeline.entries.some((entry) => entry.origin === 'ledger')).toBe(true);
    expect(timeline.entries.some((entry) => entry.origin === 'observation')).toBe(true);

    // The listing is on the timeline, which is why the two modules ship together.
    expect(timeline.entries.some((entry) => entry.kind === 'risk.do_not_fund.listed')).toBe(true);
    expect(timeline.doNotFund).toMatch(/Listed 2026-08-01/);
  });

  it('reports the worst severity present and never an average', async () => {
    const timeline = await timelineFor(fx.tenant.id, listed, {}, NOW);
    expect(timeline.worst).toBe('critical');
    expect(timeline.counts.critical).toBeGreaterThan(0);
    // A tally, not a score. Nothing here sums across severities.
    expect(Object.keys(timeline.counts).sort()).toEqual([
      'context',
      'critical',
      'notable',
      'serious',
    ]);
  });

  it('filters by severity, time and text', async () => {
    const serious = await timelineFor(fx.tenant.id, listed, { minimumSeverity: 'serious' }, NOW);
    expect(serious.entries.every((entry) => entry.severity !== 'notable')).toBe(true);
    expect(serious.entries.every((entry) => entry.severity !== 'context')).toBe(true);

    const searched = await timelineFor(fx.tenant.id, listed, { search: 'unauthorised' }, NOW);
    expect(searched.entries.length).toBe(1);
    expect(searched.entries[0]?.origin).toBe('observation');

    const windowed = await timelineFor(
      fx.tenant.id,
      listed,
      { from: new Date('2026-07-01T00:00:00.000Z'), to: new Date('2026-07-25T00:00:00.000Z') },
      NOW,
    );
    expect(windowed.entries.length).toBe(1);
  });

  it('excludes events the classification table does not name', async () => {
    // The Ledger holds far more than the timeline shows, and that is the design.
    const everything = await read({ tenantId: fx.tenant.id, clientId: listed });
    const timeline = await timelineFor(fx.tenant.id, listed, {}, NOW);
    expect(timeline.entries.filter((entry) => entry.origin === 'ledger').length).toBeLessThan(
      everything.length,
    );
  });

  it('says what it does not watch, even for a client with no risk history', async () => {
    // A timeline with no entries and no caveat reads as a client with no risk. The caveat is the
    // section's point, so it has to survive the empty case.
    const timeline = await timelineFor(fx.tenant.id, clean, {}, NOW);
    expect(timeline.worst).toBeNull();
    expect(timeline.doNotFund).toBeNull();
    expect(timeline.unmonitored.length).toBeGreaterThan(0);
    expect(timeline.unmonitored.map((source) => source.fact)).toContain('Missed payments');
  });
});

describe('6.5 into the Compliance Evidence Vault', () => {
  it('carries the risk timeline as a source in the client file', async () => {
    const file = await assembleEvidenceFile({
      tenantId: fx.tenant.id,
      clientId: listed,
      now: NOW,
    });

    expect(file.status).toBe('ok');
    if (file.status !== 'ok') return;

    const entry = file.value.coverage.find((source) => source.key === 'risk_timeline');
    expect(entry).toBeDefined();
    expect(entry?.coverage).toBe('complete');
    // The note is what a regulator reads first, so the listing has to be visible there rather
    // than buried inside the section body.
    expect(entry?.note).toMatch(/ON THE DO NOT FUND LIST/);
    expect(entry?.note).toMatch(/no producer/);
  });
});
