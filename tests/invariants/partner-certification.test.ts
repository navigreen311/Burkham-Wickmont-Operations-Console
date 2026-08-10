/**
 * Certification standing - 8.3, pure, no database.
 *
 * `deriveStanding` is exported precisely so this file can exist: the rule that decides whether a
 * partner may speak for us is worth testing exhaustively, and fixtures would make the exhaustive
 * version too expensive to write.
 *
 * The case that matters most is the empty curriculum. "Nothing to complete" and "completed
 * everything" both produce an empty outstanding list, and a build that certified on the first
 * would certify the whole network the moment a tenant forgot to publish a curriculum.
 */

import { describe, expect, it } from 'vitest';
import {
  PARTNER_TRACKS,
  RECERTIFICATION_CADENCE_DAYS,
  TRACK_REQUIREMENTS,
  deriveStanding,
  outstandingQualifications,
  recertificationDueAt,
  requirementsFor,
  type CurriculumModule,
} from '@bwc/partners';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const module = (id: string, key: string): CurriculumModule => ({
  id,
  key,
  version: 1,
  title: `Module ${key}`,
  objective: 'Something a partner should know afterwards.',
  requiredForTracks: [],
  materialReference: null,
  publishedAt: '2026-01-01T00:00:00.000Z',
  supersededAt: null,
});

describe('certification standing', () => {
  it('does not certify against an empty curriculum', () => {
    // The scanner makes the same call about an empty claim library. Zero requirements met and
    // zero requirements existing are different facts, and only one of them is an achievement.
    const standing = deriveStanding([], new Map(), NOW);
    expect(standing.state).toBe('no_curriculum');
    expect(standing.certified).toBe(false);
    expect(standing.explanation).toMatch(/cannot be certified by the absence of a requirement/);
  });

  it('certifies when every required module is complete and current', () => {
    const modules = [module('m1', 'claims'), module('m2', 'privacy')];
    const standing = deriveStanding(
      modules,
      new Map([
        ['m1', new Date(NOW.getTime() - 30 * DAY)],
        ['m2', new Date(NOW.getTime() - 10 * DAY)],
      ]),
      NOW,
    );
    expect(standing.state).toBe('certified');
    expect(standing.certified).toBe(true);
    expect(standing.outstanding).toEqual([]);
  });

  it('names what is outstanding rather than only failing', () => {
    const standing = deriveStanding(
      [module('m1', 'claims'), module('m2', 'privacy')],
      new Map([['m1', new Date(NOW.getTime() - 30 * DAY)]]),
      NOW,
    );
    expect(standing.state).toBe('never_completed');
    expect(standing.outstanding).toEqual(['privacy']);
    expect(standing.explanation).toMatch(/privacy/);
  });

  it('decertifies past the recertification cadence, with nothing running', () => {
    const completedAt = new Date(NOW.getTime() - (RECERTIFICATION_CADENCE_DAYS + 1) * DAY);
    const standing = deriveStanding([module('m1', 'claims')], new Map([['m1', completedAt]]), NOW);

    expect(standing.state).toBe('lapsed');
    expect(standing.certified).toBe(false);
    expect(standing.lapsedModules).toEqual(['claims']);
  });

  it('is still certified on the last day of the cadence', () => {
    // The boundary is worth pinning: a partner should not lose their capability a day early
    // because somebody wrote >= where they meant >.
    const completedAt = new Date(NOW.getTime() - (RECERTIFICATION_CADENCE_DAYS - 1) * DAY);
    const standing = deriveStanding([module('m1', 'claims')], new Map([['m1', completedAt]]), NOW);
    expect(standing.certified).toBe(true);
  });

  it('distinguishes a superseded curriculum from training never done', () => {
    // A partner who did the training and had it republished under them needs the delta, not the
    // course - and the person chasing them should be told which.
    const standing = deriveStanding(
      [module('m2-v2', 'claims')],
      new Map([['m1-v1', new Date(NOW.getTime() - 30 * DAY)]]),
      NOW,
    );
    expect(standing.state).toBe('superseded');
    expect(standing.explanation).toMatch(/change-delta training/);
  });

  it('reports the earliest recertification date, not the latest', () => {
    // Certification lapses when the FIRST module does. Reporting the latest would tell a partner
    // they have eleven months left on a certification that ends next week.
    const standing = deriveStanding(
      [module('m1', 'claims'), module('m2', 'privacy')],
      new Map([
        ['m1', new Date('2026-01-01T00:00:00.000Z')],
        ['m2', new Date('2026-06-01T00:00:00.000Z')],
      ]),
      NOW,
    );
    expect(standing.nextDueAt).toBe(
      recertificationDueAt(new Date('2026-01-01T00:00:00.000Z')).toISOString(),
    );
  });
});

describe('partner tracks', () => {
  it('gives every track requirements and a stated basis for its sensitivity', () => {
    for (const track of PARTNER_TRACKS) {
      const requirements = requirementsFor(track);
      expect(requirements.qualifications.length, track).toBeGreaterThan(0);
      // A sensitivity with no reasoning is a label. The Compliance Review Board should be able to
      // disagree with the argument, which means there has to be one.
      expect(requirements.sensitivityBasis.length, track).toBeGreaterThan(40);
    }
  });

  it('requires a referral disclosure acknowledgement on every track', () => {
    for (const track of PARTNER_TRACKS) {
      expect(
        TRACK_REQUIREMENTS[track].qualifications.some((q) => /referral disclosure/i.test(q)),
        track,
      ).toBe(true);
    }
  });

  it('marks the regulated professions as disclosure-sensitive', () => {
    // These four have their own regulator with rules about referral compensation. Getting it
    // wrong costs them their licence, not just us a relationship.
    for (const track of [
      'cpa_bookkeeper',
      'business_attorney',
      'wealth_advisor',
      'ma_advisor',
    ] as const) {
      expect(TRACK_REQUIREMENTS[track].disclosureSensitivity, track).toBe('high');
    }
  });

  it('matches qualifications exactly rather than approximately', () => {
    // A qualification satisfied by something close enough is a judgement, and the record should
    // show a person made it.
    const required = requirementsFor('fractional_cfo').qualifications;
    expect(outstandingQualifications('fractional_cfo', [...required])).toEqual([]);
    expect(
      outstandingQualifications('fractional_cfo', [required[0]?.toLowerCase() ?? '']),
    ).toHaveLength(required.length);
  });
});
