/**
 * Cohort and trend reads - blueprint 11.6's "supports cohort and trend analysis".
 *
 * **Every read takes a period, and there is no `current()`.** That is the structural half of
 * ADR-0020: nothing can quietly start using the warehouse as a faster read of what 9.1 already
 * answers live, because there is no function that would serve it.
 *
 * A trend point carries the gaps recorded with its snapshot. A series where one day could not
 * capture engagements reads as a dip unless the point says otherwise, and a reader has no way to
 * tell the difference from the number alone.
 */

import { db } from '@bwc/db';
import { noData, ok, type Outcome } from '@bwc/core';
import { snapshotsBetween, type SnapshotFacts } from './snapshot.js';

export interface TrendPoint {
  readonly asOf: string;
  readonly value: number;
  /** Gaps recorded with the snapshot. A point with gaps is not a lower number; it is a caveat. */
  readonly gaps: readonly string[];
}

export interface Trend {
  readonly metric: string;
  readonly points: readonly TrendPoint[];
  readonly from: string;
  readonly to: string;
  readonly detail: string;
}

/** The facts a trend may be taken over. Named, so a caller cannot ask for a field that moved. */
export type TrendMetric =
  'clients' | 'engagementsActive' | 'billedToDateCents' | 'compliance_healthy';

const valueOf = (facts: SnapshotFacts, metric: TrendMetric): number => {
  switch (metric) {
    case 'clients':
      return facts.clients;
    case 'engagementsActive':
      return facts.engagementsActive;
    case 'billedToDateCents':
      return facts.billedToDateCents;
    case 'compliance_healthy':
      return (
        (facts.complianceCounts['pass'] ?? 0) + (facts.complianceCounts['pass_with_findings'] ?? 0)
      );
  }
};

/**
 * A metric over time.
 *
 * `no_data` when the period holds no snapshots, rather than an empty series. An empty chart reads
 * as a flat line at zero; "no snapshots were captured in this period" reads as what it is.
 */
export const trend = async (
  tenantId: string,
  metric: TrendMetric,
  from: Date,
  to: Date,
): Promise<Outcome<Trend>> => {
  const snapshots = await snapshotsBetween(tenantId, from, to);

  if (snapshots.length === 0) {
    return noData(
      `No snapshot was captured between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}. That is a gap in the capture schedule, not a period in which nothing happened - an empty series would read as a flat line at zero.`,
    );
  }

  return ok({
    metric,
    points: snapshots.map((snapshot) => ({
      asOf: snapshot.asOf,
      value: valueOf(snapshot.facts, metric),
      gaps: snapshot.gaps,
    })),
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    detail: `${snapshots.length} snapshot(s). Points carry the gaps recorded at capture: a day where an input could not be read is a caveat, not a lower number.`,
  });
};

export interface CohortRetentionPoint {
  readonly asOf: string;
  readonly members: number;
  readonly stillEngaged: number;
  readonly billedToDateCents: number;
}

export interface CohortRetention {
  readonly cohort: string;
  readonly points: readonly CohortRetentionPoint[];
  readonly detail: string;
}

/**
 * How one cohort behaved over time - blueprint 11.6's "cohort analytics".
 *
 * Membership is fixed at capture and never recomputed, which is what makes this a curve. A client
 * that moved between cohorts would produce a retention series where the denominator changes, and
 * nobody reading it would know.
 *
 * The subject key makes this possible after the operational record is gone - and it is a
 * PSEUDONYM, not anonymisation. See `PSEUDONYMISATION_NOTE`.
 */
export const cohortRetention = async (
  tenantId: string,
  cohort: string,
  from: Date,
  to: Date,
): Promise<Outcome<CohortRetention>> => {
  const rows = await db().subjectSnapshot.findMany({
    where: {
      tenantId,
      cohort,
      snapshot: {
        asOf: {
          gte: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())),
          lte: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())),
        },
      },
    },
    include: { snapshot: { select: { asOf: true } } },
  });

  if (rows.length === 0) {
    return noData(
      `No subject rows for cohort '${cohort}' in this period. Either the cohort has no members or no snapshot covered the period; the snapshot list distinguishes the two.`,
    );
  }

  const byDate = new Map<string, { members: number; engaged: number; billed: number }>();
  for (const row of rows) {
    const key = row.snapshot.asOf.toISOString().slice(0, 10);
    const bucket = byDate.get(key) ?? { members: 0, engaged: 0, billed: 0 };
    bucket.members += 1;
    if (row.engaged) bucket.engaged += 1;
    bucket.billed += row.billedToDateCents;
    byDate.set(key, bucket);
  }

  const points = [...byDate.entries()]
    .map(([asOf, bucket]) => ({
      asOf,
      members: bucket.members,
      stillEngaged: bucket.engaged,
      billedToDateCents: bucket.billed,
    }))
    .sort((a, b) => a.asOf.localeCompare(b.asOf));

  return ok({
    cohort,
    points,
    detail: `Cohort '${cohort}' across ${points.length} snapshot(s). Membership was fixed when each client was first captured and is never recomputed - a client that moved between cohorts would change the denominator with nothing saying so.`,
  });
};

/** Every cohort with a row in the warehouse. */
export const cohorts = async (tenantId: string): Promise<readonly string[]> => {
  const rows = await db().subjectSnapshot.findMany({
    where: { tenantId },
    select: { cohort: true },
    distinct: ['cohort'],
    orderBy: { cohort: 'asc' },
  });
  return rows.map((row) => row.cohort);
};
