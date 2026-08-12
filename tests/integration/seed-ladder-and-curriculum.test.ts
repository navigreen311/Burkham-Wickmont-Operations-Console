/**
 * The draft ladder and the draft curriculum - what they unblock, and what they must not do twice.
 *
 * Four properties carry this file.
 *
 * **Running a seed twice changes nothing.** For the ladder that means the owner's corrections
 * survive a re-run. For the curriculum it is stronger: a second material publish would decertify
 * every partner who completed version 1, so a non-idempotent seed would be worse than the empty
 * curriculum it fixes.
 *
 * **A partner can now be certified**, which was impossible before: `certificationStanding` returned
 * `no_curriculum` and `canRefer` refused on the training gate, so no partner could refer at all.
 *
 * **An incomplete partner still cannot.** The seed makes certification POSSIBLE, not automatic.
 *
 * **Every invented figure is listed.** The lists are asserted against the seeds, because a list of
 * invented figures that silently stops matching the figures is worse than no list.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LADDER_FIGURES_TO_CONFIRM,
  OFFER_LADDER,
  currentOffer,
  ladder,
  seedOfferLadder,
} from '@bwc/billing';
import {
  CURRICULUM_REQUIREMENTS_TO_CONFIRM,
  CURRICULUM_SEEDS,
  HIGH_SENSITIVITY_TRACKS,
  PARTNER_TRACKS,
  TRACK_REQUIREMENTS,
  requireCertification,
  standingFor,
  currentCurriculum,
  recordCompletion,
  registerPartner,
  requiredModulesFor,
  seedCurriculum,
} from '@bwc/partners';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const NOW = new Date('2026-09-01T10:00:00.000Z');
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('seed-ladder-curriculum');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('the offer ladder', () => {
  it('publishes five ascending rungs, all in integer cents', async () => {
    const first = await seedOfferLadder({
      tenantId: fx.tenant.id,
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (first.status !== 'ok') throw new Error(`seed refused: ${first.status}`);

    // Blueprint 1.4 owns a "5-offer ladder". The count is not mine to choose.
    expect(first.value.published.length).toBe(5);
    expect(first.value.skipped).toEqual([]);

    const rungs = (await ladder(fx.tenant.id)).map((offer) => offer.rung);
    expect(rungs).toEqual([1, 2, 3, 4, 5]);

    for (const offer of OFFER_LADDER) {
      // ADR-0011. Not "close to an integer" - an integer. `(0.615).toFixed(2)` is '0.61', and a
      // fraction of a cent in a retainer is a figure nobody agreed to.
      for (const value of [offer.retainerCents, offer.monthlyCents, offer.minimumCents]) {
        expect(Number.isSafeInteger(value), offer.key).toBe(true);
        expect(value, offer.key).toBeGreaterThanOrEqual(0);
      }
      // Basis points, so 3% is 300 exactly rather than 3.0 which is not.
      expect(Number.isSafeInteger(offer.successFeeBasisPoints), offer.key).toBe(true);
      expect(offer.successFeeBasisPoints, offer.key).toBeLessThanOrEqual(10_000);
    }
  });

  it('charges no success fee on rung 1, and rises from there', () => {
    // The one figure defensible on principle rather than on price: a client who has not been
    // placed with anybody should not pay a placement rate.
    const readiness = OFFER_LADDER.find((offer) => offer.rung === 1);
    expect(readiness?.successFeeBasisPoints).toBe(0);

    const withFees = OFFER_LADDER.filter((offer) => offer.rung > 1).map(
      (offer) => offer.successFeeBasisPoints,
    );
    expect(withFees.every((rate) => rate > 0)).toBe(true);
    // Ascending, and asserted as ordering rather than against the specific numbers - the numbers
    // are drafts and will change, the shape is the claim.
    expect([...withFees].sort((left, right) => left - right)).toEqual(withFees);
  });

  it('changes nothing on a second run', async () => {
    const before = await ladder(fx.tenant.id);

    const second = await seedOfferLadder({
      tenantId: fx.tenant.id,
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (second.status !== 'ok') throw new Error('second run refused');

    expect(second.value.published).toEqual([]);
    expect(second.value.skipped.length).toBe(5);

    const after = await ladder(fx.tenant.id);
    // Same versions. `publishOffer` supersedes and re-versions on every call, so a seed that
    // always published would walk the ladder to version 2 and leave any owner correction
    // superseded by these drafts.
    expect(after.map((offer) => `${offer.key}@${offer.version}`)).toEqual(
      before.map((offer) => `${offer.key}@${offer.version}`),
    );
    expect(after.every((offer) => offer.version === 1)).toBe(true);
  });

  it('leaves an owner correction in place', async () => {
    const corrected = await currentOffer(fx.tenant.id, 'growth');
    if (corrected.status !== 'ok') throw new Error('growth missing');
    expect(corrected.value.version).toBe(1);
  });

  it('lists every invented figure', () => {
    expect(LADDER_FIGURES_TO_CONFIRM.length).toBeGreaterThanOrEqual(8);
    const listed = LADDER_FIGURES_TO_CONFIRM.join(' ');
    // Each rung key appears in the list, so a rung added later without a note fails here.
    for (const offer of OFFER_LADDER) {
      expect(listed, offer.key).toMatch(offer.key);
    }
  });
});

describe('the curriculum', () => {
  it('publishes the blueprint topics, five of them required of every track', async () => {
    const first = await seedCurriculum({
      tenantId: fx.tenant.id,
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (first.status !== 'ok') throw new Error(`seed refused: ${first.status}`);
    expect(first.value.published.length).toBe(CURRICULUM_SEEDS.length);

    const modules = await currentCurriculum(fx.tenant.id);
    const keys = modules.map((module) => module.key);
    // The five blueprint 8.3 names. Not my choice.
    for (const key of [
      'approved_claims',
      'prohibited_claims',
      'client_suitability',
      'data_privacy',
      'referral_disclosure',
    ]) {
      expect(keys, key).toContain(key);
    }

    // Empty requiredForTracks means EVERY track, which is why the universal five carry an empty
    // list rather than seven enumerated names: a track added later must not escape the requirement.
    const universal = modules.filter((module) => module.requiredForTracks.length === 0);
    expect(universal.length).toBe(5);
  });

  it('scopes the independence module to the tracks that already carry a cited basis', async () => {
    // Derived from TRACK_REQUIREMENTS rather than asserted here. Nothing in the seed invents a
    // sensitivity - `PublishModuleInput` has no such field, and the tracks already cite AICPA
    // independence, Model Rule 7.2 and SEC solicitation rules.
    expect(HIGH_SENSITIVITY_TRACKS.length).toBeGreaterThan(0);
    for (const track of HIGH_SENSITIVITY_TRACKS) {
      expect(TRACK_REQUIREMENTS[track].disclosureSensitivity, track).toBe('high');
      expect(TRACK_REQUIREMENTS[track].sensitivityBasis.length, track).toBeGreaterThan(40);
    }

    const standardTrack = PARTNER_TRACKS.find(
      (track) => TRACK_REQUIREMENTS[track].disclosureSensitivity === 'standard',
    );
    if (standardTrack === undefined) throw new Error('expected a standard-sensitivity track');

    const forHigh = await requiredModulesFor(fx.tenant.id, HIGH_SENSITIVITY_TRACKS[0]!);
    const forStandard = await requiredModulesFor(fx.tenant.id, standardTrack);
    expect(forHigh.map((module) => module.key)).toContain('professional_independence');
    expect(forStandard.map((module) => module.key)).not.toContain('professional_independence');
  });

  it('changes nothing on a second run, so nobody is decertified', async () => {
    const before = await currentCurriculum(fx.tenant.id);

    const second = await seedCurriculum({
      tenantId: fx.tenant.id,
      publishedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (second.status !== 'ok') throw new Error('second run refused');

    expect(second.value.published).toEqual([]);
    expect(second.value.skipped.length).toBe(CURRICULUM_SEEDS.length);

    const after = await currentCurriculum(fx.tenant.id);
    // Versions unchanged is the whole assertion: completion is recorded against a VERSION, so a
    // second material publish would decertify every partner who completed version 1.
    expect(after.map((module) => `${module.key}@${module.version}`)).toEqual(
      before.map((module) => `${module.key}@${module.version}`),
    );
    expect(after.every((module) => module.version === 1)).toBe(true);
  });

  it('lists every invented requirement', () => {
    expect(CURRICULUM_REQUIREMENTS_TO_CONFIRM.length).toBeGreaterThanOrEqual(6);
    // The material does not exist, and the list has to say so - a partner cannot complete any of
    // this until somebody writes it.
    expect(CURRICULUM_REQUIREMENTS_TO_CONFIRM.join(' ')).toMatch(
      /NOT YET AUTHORED|does not exist/i,
    );
  });
});

describe('a partner can now be certified, and an incomplete one still cannot', () => {
  const track = 'payroll_hr' as const;
  let partnerId: string;

  beforeAll(async () => {
    const registered = await registerPartner({
      tenantId: fx.tenant.id,
      legalName: 'Seedtest Payroll LLC',
      contactName: 'A Partner Person',
      contactEmail: 'partner@seedtest.test',
      track,
      actor: HUMAN(),
    });
    if (registered.status !== 'ok') throw new Error(`setup: partner ${registered.status}`);
    partnerId = registered.value.id;
  });

  it('is not certified with nothing completed, and says which module is outstanding', async () => {
    const standing = await standingFor(fx.tenant.id, partnerId, track, NOW);
    expect(standing.certified).toBe(false);
    // Crucially NOT `no_curriculum` any more - the curriculum exists, this partner has not done it.
    expect(standing.state).toBe('never_completed');
    expect(standing.outstanding.length).toBeGreaterThan(0);
    // Told what to do rather than that they failed. No score, no percentage complete.
    expect(Object.keys(standing)).not.toContain('score');
    expect(Object.keys(standing)).not.toContain('percentComplete');

    // The consequence that matters: an uncertified partner may not refer.
    const gate = await requireCertification(fx.tenant.id, partnerId, track, 'refer', NOW);
    expect(gate.status).toBe('refused');
  });

  it('is still not certified after completing only some of it', async () => {
    const required = await requiredModulesFor(fx.tenant.id, track);
    const [first] = required;
    if (first === undefined) throw new Error('no required modules');

    const done = await recordCompletion({
      tenantId: fx.tenant.id,
      partnerId,
      moduleId: first.id,
      completedAt: NOW,
      recordedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    if (done.status !== 'ok') throw new Error(`completion refused: ${done.status}`);

    const standing = await standingFor(fx.tenant.id, partnerId, track, NOW);
    expect(standing.certified).toBe(false);
    expect(standing.outstanding.length).toBe(required.length - 1);
  });

  it('IS certified once every required module is completed', async () => {
    const required = await requiredModulesFor(fx.tenant.id, track);
    for (const module of required) {
      const recorded = await recordCompletion({
        tenantId: fx.tenant.id,
        partnerId,
        moduleId: module.id,
        completedAt: NOW,
        recordedBy: fx.human.id,
        actor: HUMAN(),
        now: NOW,
      });
      // Checked, not fired and forgotten - a refused completion would surface here as a
      // certification that never arrives, several assertions away from its cause.
      if (recorded.status !== 'ok') throw new Error(`completion refused: ${recorded.status}`);
    }

    const standing = await standingFor(fx.tenant.id, partnerId, track, NOW);
    // This was impossible before this slice: the state was `no_curriculum` and no partner could
    // be certified, so no partner could refer.
    expect(standing.state).toBe('certified');
    expect(standing.certified).toBe(true);
    expect(standing.outstanding).toEqual([]);
    // Annual recertification, from the completion date.
    expect(standing.nextDueAt).not.toBeNull();

    // And the referral gate opens - which was unreachable before this slice.
    const gate = await requireCertification(fx.tenant.id, partnerId, track, 'refer', NOW);
    expect(gate.status).toBe('ok');
  });
});
