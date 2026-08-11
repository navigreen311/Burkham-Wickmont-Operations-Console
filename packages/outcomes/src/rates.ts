/**
 * Rates and cohorts over the attempt ledger - blueprint 5.5's "cohort analysis", and the input
 * 9.1's placement approval rate has been waiting for.
 *
 * Pure arithmetic over rows, with one rule carried in from every module that came before it: **a
 * rate below the minimum sample is `null`, never a percentage.** 5.2 refuses below ten decided
 * applications, 1.3 refuses below ten decided leads, 9.1's `rate()` refuses below ten of whatever it
 * is counting. Two approvals out of three is "67%" arithmetically and nothing at all statistically,
 * and this table is the one a recommendation memo will quote.
 *
 * The denominator is DECIDED attempts. Not submitted, which includes applications still sitting with
 * a provider and can only make a rate look worse as it fills; not all attempts, which counts a
 * client changing their mind as a provider saying no.
 */

import { db } from '@bwc/db';
import { DECIDED_OUTCOMES } from './attempts.js';

/**
 * Below this many decided attempts, no rate is reported.
 *
 * Ten, matching 5.2, 1.3 and 9.1. The number is a judgement and it is stated in four places rather
 * than shared from one, because these are rates over different populations and a single constant
 * would make them look like one decision when they are four.
 */
export const MINIMUM_DECIDED_FOR_RATE = 10;

export interface Window {
  readonly from: Date;
  /** Exclusive, so consecutive windows neither overlap nor leave a gap. */
  readonly to: Date;
}

export interface AttemptCounts {
  readonly submitted: number;
  readonly approved: number;
  readonly declined: number;
  readonly withdrawn: number;
  readonly pending: number;
  /** approved + declined. The denominator, named so nobody has to re-derive it. */
  readonly decided: number;
}

export interface AttemptRate extends AttemptCounts {
  /** Null below the minimum sample, and null is not zero. */
  readonly rate: number | null;
  /** Why `rate` is what it is, including when it is null. */
  readonly note: string;
}

const rateOf = (counts: AttemptCounts, describing: string): AttemptRate => {
  if (counts.decided < MINIMUM_DECIDED_FOR_RATE) {
    return {
      ...counts,
      rate: null,
      note: `${counts.decided} decided attempt(s) ${describing}; ${MINIMUM_DECIDED_FOR_RATE} are needed before a rate means anything. ${counts.approved} approved and ${counts.declined} declined so far - the counts are real and are shown, the rate is not yet and is withheld. ${counts.pending} still pending and ${counts.withdrawn} withdrawn are in neither half.`,
    };
  }
  return {
    ...counts,
    rate: counts.approved / counts.decided,
    note: `${counts.approved} of ${counts.decided} decided attempts ${describing} were approved. ${counts.pending} still pending and ${counts.withdrawn} withdrawn are excluded: one has not happened, the other never will.`,
  };
};

const countRows = (rows: readonly { outcome: string }[]): AttemptCounts => {
  const approved = rows.filter((row) => row.outcome === 'approved').length;
  const declined = rows.filter((row) => row.outcome === 'declined').length;
  return {
    submitted: rows.length,
    approved,
    declined,
    withdrawn: rows.filter((row) => row.outcome === 'withdrawn').length,
    pending: rows.filter((row) => row.outcome === 'pending').length,
    decided: approved + declined,
  };
};

/**
 * The counts 9.1 needs, over attempts DECIDED inside the window.
 *
 * Decided rather than submitted, and the difference is not cosmetic: an attempt submitted in March
 * and declined in May belongs to May's approval rate, because May is when the provider said no.
 * Bucketing by submission would move a decision into a period that closed before it was made, and
 * would keep quietly changing a published figure for the periods that were still open.
 */
export const decidedIn = async (tenantId: string, window: Window): Promise<AttemptRate> => {
  const rows = await db().fundingAttempt.findMany({
    where: {
      tenantId,
      outcome: { in: [...DECIDED_OUTCOMES, 'withdrawn'] },
      decidedAt: { gte: window.from, lt: window.to },
    },
    select: { outcome: true },
  });

  const pending = await db().fundingAttempt.count({
    where: {
      tenantId,
      outcome: 'pending',
      submittedAt: { gte: window.from, lt: window.to },
    },
  });

  const counts = countRows(rows);
  return rateOf({ ...counts, pending, submitted: counts.submitted + pending }, 'in this period');
};

/** The same, narrowed to one product. Blueprint 9.1 asks for "approval rate by product". */
export const decidedInByProduct = async (
  tenantId: string,
  window: Window,
  productKind: string,
): Promise<AttemptRate> => {
  const rows = await db().fundingAttempt.findMany({
    where: {
      tenantId,
      productKind: productKind as never,
      outcome: { in: [...DECIDED_OUTCOMES, 'withdrawn'] },
      decidedAt: { gte: window.from, lt: window.to },
    },
    select: { outcome: true },
  });
  const pending = await db().fundingAttempt.count({
    where: {
      tenantId,
      productKind: productKind as never,
      outcome: 'pending',
      submittedAt: { gte: window.from, lt: window.to },
    },
  });
  const counts = countRows(rows);
  return rateOf(
    { ...counts, pending, submitted: counts.submitted + pending },
    `for ${productKind} in this period`,
  );
};

export interface Cohort extends AttemptRate {
  readonly clientProfileKey: string;
}

/**
 * Blueprint 5.5's cohort analysis.
 *
 * Grouped on the coarse profile key 5.2 computes - revenue band, time in business, credit band -
 * and every cohort carries the same refusal as the headline rate. **A cohort is where a small
 * denominator does the most damage**, because a bucket is by construction narrower than the whole,
 * and "clients like you are approved 100% of the time" computed over two attempts is the most
 * confident sentence this system could produce from the least knowledge.
 *
 * Cohorts below the minimum are returned rather than dropped, with `rate: null` and a note saying
 * how many more would be needed. A list that silently omitted them would read as "we have no data
 * on that profile", which is a different and less actionable statement than "we have four".
 */
export const cohorts = async (tenantId: string, window?: Window): Promise<readonly Cohort[]> => {
  const rows = await db().fundingAttempt.findMany({
    where: {
      tenantId,
      ...(window !== undefined ? { decidedAt: { gte: window.from, lt: window.to } } : {}),
    },
    select: { outcome: true, clientProfileKey: true },
    orderBy: [{ clientProfileKey: 'asc' }, { id: 'asc' }],
  });

  const byKey = new Map<string, { outcome: string }[]>();
  for (const row of rows) {
    const bucket = byKey.get(row.clientProfileKey) ?? [];
    bucket.push({ outcome: row.outcome });
    byKey.set(row.clientProfileKey, bucket);
  }

  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([clientProfileKey, bucket]) => ({
      clientProfileKey,
      ...rateOf(countRows(bucket), `in cohort ${clientProfileKey}`),
    }));
};

export interface ProviderPerformance extends AttemptRate {
  readonly providerId: string;
  /**
   * Mean whole days from submission to decision, over decided attempts. Null when nothing has been
   * decided - a mean of an empty set is not zero, and a "0 day turnaround" is the most flattering
   * possible way to render "we have never had an answer from them".
   */
  readonly meanDaysToDecision: number | null;
  /** Approved capital that has funded, in cents. Never computed from `requestedCents`. */
  readonly fundedCents: number;
}

/**
 * Per-provider performance, for 5.2's appetite reading and 5.4's review pack.
 *
 * The funded total sums `fundedCents`, and the approved total sums `approvedCreditLimitCents`. It
 * would be shorter to sum `requestedCents` and call it volume; it would also be the revenue-integrity
 * bug this repository names first among its hard invariants, because the number would be larger and
 * nothing downstream could tell.
 */
export const byProvider = async (
  tenantId: string,
  window?: Window,
): Promise<readonly ProviderPerformance[]> => {
  const rows = await db().fundingAttempt.findMany({
    where: {
      tenantId,
      ...(window !== undefined ? { decidedAt: { gte: window.from, lt: window.to } } : {}),
    },
    select: {
      providerId: true,
      outcome: true,
      submittedAt: true,
      decidedAt: true,
      fundedCents: true,
    },
    orderBy: [{ providerId: 'asc' }, { id: 'asc' }],
  });

  const byProviderId = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byProviderId.get(row.providerId) ?? [];
    bucket.push(row);
    byProviderId.set(row.providerId, bucket);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  return [...byProviderId.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([providerId, bucket]) => {
      const turnarounds = bucket
        .filter((row) => row.decidedAt !== null && row.outcome !== 'pending')
        .map((row) =>
          Math.floor(((row.decidedAt as Date).getTime() - row.submittedAt.getTime()) / DAY_MS),
        );

      return {
        providerId,
        ...rateOf(countRows(bucket), `with this provider`),
        meanDaysToDecision:
          turnarounds.length === 0
            ? null
            : turnarounds.reduce((total, days) => total + days, 0) / turnarounds.length,
        fundedCents: bucket.reduce((total, row) => total + (row.fundedCents ?? 0), 0),
      };
    });
};
