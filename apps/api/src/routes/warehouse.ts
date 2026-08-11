/**
 * 11.6 Data Warehouse & Analytics Layer, as Console routes.
 *
 * **The warehouse answers about the past, and it exposes no way to ask about now.**
 *
 * That is structural rather than a convention: `@bwc/warehouse` has no `current()`, every read
 * takes a period, and its own header says why - nothing can quietly start using the warehouse as a
 * faster read of what 9.1 already answers live, because there is no function that would serve it.
 *
 * A transport is where that gets reintroduced. A route called `/warehouse/summary` with no period,
 * defaulting to "the last snapshot", would be a `current()` written in Express - and every reader
 * would treat the answer as live because that is what a summary looks like. So **every route here
 * requires `from` and `to`**, and refuses without them rather than defaulting.
 *
 * **An empty period is `no_data`, never a flat line at zero.** A trend over a range with no
 * snapshots is not a business that did nothing; it is a question nobody captured an answer to. The
 * module returns `no_data`, and this route forwards it unchanged.
 *
 * **Nothing captures a snapshot in production.** `captureSnapshot` is called by tests and by no
 * other code in this repository - no worker, no schedule, no route. So this surface will report
 * `no_data` for every period until an ETL job exists, and it says that in `etl` rather than leaving
 * an operator to conclude the company has no history. That is the honest reason the surface is
 * worth its keep at all: it is the only place the missing ETL becomes visible.
 */

import type { Express, Request, Response } from 'express';
import {
  PSEUDONYMISATION_NOTE,
  cohortRetention,
  cohorts,
  snapshotsBetween,
  trend,
} from '@bwc/warehouse';
import { noData, ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface WarehouseRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly tenantId: string;
}

const TREND_METRICS = [
  'clients',
  'engagementsActive',
  'billedToDateCents',
  'compliance_healthy',
] as const;

type TrendMetricName = (typeof TREND_METRICS)[number];

const isTrendMetric = (value: unknown): value is TrendMetricName =>
  typeof value === 'string' && (TREND_METRICS as readonly string[]).includes(value);

/**
 * The period, required on every route.
 *
 * **No default, deliberately.** A default period is what turns a historical store into a "current"
 * read: whatever the default is, a caller who did not think about time gets an answer that looks
 * like now. Refusing costs one round trip and buys that every answer on this surface is about a
 * period somebody chose.
 */
const readPeriod = (
  query: Record<string, unknown>,
): { from: Date; to: Date } | { problem: string } => {
  const fromRaw = query['from'];
  const toRaw = query['to'];

  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') {
    return {
      problem:
        'from and to are both required, as ISO dates. The warehouse answers about a period you name - it has no notion of "now", and a default period here would be a live read wearing a historical label.',
    };
  }

  const from = new Date(fromRaw);
  const to = new Date(toRaw);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { problem: 'from and to must each be an ISO date this runtime can parse.' };
  }
  if (to.getTime() < from.getTime()) {
    return { problem: 'to must not be before from.' };
  }
  return { from, to };
};

/**
 * What produces snapshots, which is nothing.
 *
 * Carried on every answer rather than only when empty. A period that happens to contain
 * test-seeded snapshots would otherwise read as a working pipeline, and the next empty period
 * would read as a quiet month.
 */
const ETL_STATUS = {
  producer: 'none',
  detail:
    'No worker, schedule or route calls captureSnapshot in this repository - only tests do. Until an ETL job exists, every period reports no_data, and that is a fact about the pipeline rather than about the business.',
} as const;

export const registerWarehouseRoutes = (context: WarehouseRouteContext): void => {
  const { app, requireStaff, asyncRoute, tenantId } = context;

  /**
   * Snapshots taken inside a period.
   *
   * `gaps` travels with each one. A trend point with a gap is not a lower number, it is a caveat,
   * and a reader has no way to tell the two apart from the value alone.
   */
  app.get(
    '/api/console/warehouse/snapshots',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const period = readPeriod(req.query as Record<string, unknown>);
      if ('problem' in period) {
        send(
          res,
          refused(
            period.problem,
            'Blueprint 11.6 with ADR-0020 - the warehouse answers about the past',
          ),
        );
        return;
      }

      const snapshots = await snapshotsBetween(tenantId, period.from, period.to);

      if (snapshots.length === 0) {
        send(
          res,
          noData(
            `No snapshot was captured between ${period.from.toISOString().slice(0, 10)} and ${period.to.toISOString().slice(0, 10)}. That is an absence of captures, not a period in which nothing happened - ${ETL_STATUS.detail}`,
          ),
        );
        return;
      }

      send(
        res,
        ok({
          from: period.from.toISOString(),
          to: period.to.toISOString(),
          snapshots,
          total: snapshots.length,
          /** How many carry a recorded gap, so a reader knows the series is not uniform. */
          withGaps: snapshots.filter((snapshot) => snapshot.gaps.length > 0).length,
          etl: ETL_STATUS,
          pseudonymisation: PSEUDONYMISATION_NOTE,
        }),
      );
    }),
  );

  /**
   * A trend over one named metric.
   *
   * The metric is from a closed list - the module names them so a caller cannot ask for a field
   * that moved - and an unknown one is refused with the list rather than silently returning
   * nothing, which would be indistinguishable from a period with no data.
   */
  app.get(
    '/api/console/warehouse/trend',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const period = readPeriod(query);
      if ('problem' in period) {
        send(
          res,
          refused(
            period.problem,
            'Blueprint 11.6 with ADR-0020 - the warehouse answers about the past',
          ),
        );
        return;
      }

      const metric = query['metric'];
      if (!isTrendMetric(metric)) {
        send(
          res,
          refused(
            `metric must be one of: ${TREND_METRICS.join(', ')}.`,
            'Blueprint 11.6 - a trend is taken over a named fact',
          ),
        );
        return;
      }

      const result = await trend(tenantId, metric, period.from, period.to);
      if (result.status !== 'ok') {
        // `no_data` forwarded unchanged. A zero-filled series would be a claim about the business.
        send(res, result);
        return;
      }

      send(
        res,
        ok({
          ...result.value,
          total: result.value.points.length,
          pointsWithGaps: result.value.points.filter((point) => point.gaps.length > 0).length,
          etl: ETL_STATUS,
        }),
      );
    }),
  );

  /**
   * Cohort retention, and the cohorts there are.
   *
   * The cohort list is served beside the retention answer because an operator asking about a
   * cohort needs to know which ones exist - and an empty list is the honest answer to "which
   * cohorts" when nothing has been captured.
   */
  app.get(
    '/api/console/warehouse/cohorts',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const known = await cohorts(tenantId);
      const cohort = query['cohort'];

      if (typeof cohort !== 'string' || cohort === '') {
        send(res, ok({ cohorts: known, total: known.length, retention: null, etl: ETL_STATUS }));
        return;
      }

      const period = readPeriod(query);
      if ('problem' in period) {
        send(
          res,
          refused(
            period.problem,
            'Blueprint 11.6 with ADR-0020 - the warehouse answers about the past',
          ),
        );
        return;
      }

      const retention = await cohortRetention(tenantId, cohort, period.from, period.to);

      send(
        res,
        ok({
          cohorts: known,
          total: known.length,
          retention: retention.status === 'ok' ? retention.value : null,
          /** Present when retention could not be computed, so the page states which. */
          retentionUnavailable: retention.status === 'ok' ? null : retention,
          etl: ETL_STATUS,
        }),
      );
    }),
  );
};
