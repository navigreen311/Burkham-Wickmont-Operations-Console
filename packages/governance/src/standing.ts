/**
 * Whether a provider may be recommended right now - blueprint 5.4.
 *
 * Pure, and derived at the moment of asking rather than stored.
 *
 * The obvious implementation of "periodic re-review cadence (quarterly minimum)" is a
 * nightly job that flips stale approvals to an overdue status. That job is a single point of
 * silent failure: when it stops, every stale provider keeps reading as approved and the
 * system's most load-bearing claim - *this provider was reviewed recently* - decays with no
 * signal at all. Nobody notices, because nothing changed.
 *
 * Computing it from `lastReviewedAt` and today means there is nothing to run and nothing to
 * miss. A provider reviewed 91 days ago is overdue the moment it is asked about, on every
 * machine, including one that has been switched off for a month.
 */

export type GovernanceStatus =
  'pending_review' | 'approved' | 'under_review' | 'suspended' | 'blacklisted';

/** Blueprint 5.4: "quarterly minimum". A cadence may be shortened, never lengthened past it. */
export const MAXIMUM_REVIEW_CADENCE_DAYS = 90;

export interface GovernanceSnapshot {
  readonly providerId: string;
  readonly status: GovernanceStatus;
  readonly lastReviewedAt: Date | null;
  readonly reviewCadenceDays: number;
  readonly approvedStates: readonly string[];
  readonly restrictedStates: readonly string[];
  readonly blacklistReason: string | null;
  readonly requiredDisclosures: readonly string[];
}

export type StandingVerdict = 'recommendable' | 'not_recommendable';

export type StandingBlocker =
  | 'never_governed'
  | 'pending_review'
  | 'under_review'
  | 'suspended'
  | 'blacklisted'
  | 'review_overdue'
  | 'state_restricted';

export interface Standing {
  readonly providerId: string;
  readonly verdict: StandingVerdict;
  readonly blockers: readonly StandingBlocker[];
  /** One sentence per blocker, in the words a rejection memo should use. */
  readonly explanation: string;
  /** Days since the last review, or null if never reviewed. */
  readonly daysSinceReview: number | null;
  readonly requiredDisclosures: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/**
 * Derive standing.
 *
 * `snapshot` is null when the board has never seen the provider. That is not an error and
 * not an empty default - it is the single most common reason a provider is not
 * recommendable, and it has its own blocker so the memo can say so.
 */
export const standing = (
  providerId: string,
  snapshot: GovernanceSnapshot | null,
  today: Date,
  state?: string | null,
): Standing => {
  if (snapshot === null) {
    return {
      providerId,
      verdict: 'not_recommendable',
      blockers: ['never_governed'],
      explanation:
        'The Capital Product Governance Board has never reviewed this provider. Blueprint 5.4 requires approval before an agent may recommend it.',
      daysSinceReview: null,
      requiredDisclosures: [],
    };
  }

  const blockers: StandingBlocker[] = [];
  const sentences: string[] = [];

  switch (snapshot.status) {
    case 'blacklisted':
      blockers.push('blacklisted');
      sentences.push(
        `Blacklisted by the Governance Board: ${snapshot.blacklistReason ?? 'no reason recorded'}.`,
      );
      break;
    case 'suspended':
      blockers.push('suspended');
      sentences.push('Suspended by the Governance Board pending resolution.');
      break;
    case 'under_review':
      blockers.push('under_review');
      sentences.push(
        'Under active review by the Governance Board; recommendations are paused until it concludes.',
      );
      break;
    case 'pending_review':
      blockers.push('pending_review');
      sentences.push('Submitted to the Governance Board but not yet approved.');
      break;
    case 'approved':
      break;
  }

  // Cadence is checked even for a blacklisted provider, because a reader deserves the whole
  // picture rather than the first disqualifier - and because a blacklist that is also five
  // months unreviewed is a different governance failure from a fresh one.
  const daysSinceReview =
    snapshot.lastReviewedAt === null ? null : daysBetween(snapshot.lastReviewedAt, today);

  const cadence = Math.min(snapshot.reviewCadenceDays, MAXIMUM_REVIEW_CADENCE_DAYS);

  if (snapshot.status === 'approved') {
    if (daysSinceReview === null) {
      blockers.push('review_overdue');
      sentences.push('Approved but with no recorded review date, so currency cannot be shown.');
    } else if (daysSinceReview > cadence) {
      blockers.push('review_overdue');
      sentences.push(
        `Last reviewed ${daysSinceReview} days ago, past the ${cadence}-day cadence blueprint 5.4 requires.`,
      );
    }
  }

  if (state != null && state !== '') {
    if (snapshot.restrictedStates.includes(state)) {
      blockers.push('state_restricted');
      sentences.push(`The Governance Board has restricted this provider in ${state}.`);
    } else if (snapshot.approvedStates.length > 0 && !snapshot.approvedStates.includes(state)) {
      blockers.push('state_restricted');
      sentences.push(
        `Approval is limited to ${snapshot.approvedStates.join(', ')} and does not cover ${state}.`,
      );
    }
  }

  return {
    providerId,
    verdict: blockers.length === 0 ? 'recommendable' : 'not_recommendable',
    blockers,
    explanation:
      blockers.length === 0
        ? `Approved by the Governance Board and reviewed ${daysSinceReview ?? 0} day(s) ago.`
        : sentences.join(' '),
    daysSinceReview,
    requiredDisclosures: snapshot.requiredDisclosures,
  };
};

/** When this provider's next review is due, so a queue can be built from it. */
export const nextReviewDue = (snapshot: GovernanceSnapshot): Date | null => {
  if (snapshot.lastReviewedAt === null) return null;
  const cadence = Math.min(snapshot.reviewCadenceDays, MAXIMUM_REVIEW_CADENCE_DAYS);
  return new Date(snapshot.lastReviewedAt.getTime() + cadence * DAY_MS);
};
