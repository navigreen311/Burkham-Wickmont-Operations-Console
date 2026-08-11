/**
 * 9.1 Executive KPI Dashboard and 9.2 Unit Economics Dashboard, as Console routes.
 *
 * **The transport's whole job here is to not help.**
 *
 * Both modules already return `Metric<T>` - a value with its basis, where `null` means "not
 * measured" and never zero (ADR-0017). Both already carry lists of things they deliberately do not
 * produce: `unproduced` on the executive dashboard, `refused` and `unmeasuredCostLines` on the unit
 * economics one. Every one of those is the module having thought about a figure and declined to
 * invent it.
 *
 * A transport can destroy all of that in one line. `value ?? 0` reads as tidy code and turns "we
 * cannot measure gross margin" into "gross margin is zero". Dropping a null metric from the payload
 * reads as tidy JSON and turns a stated refusal into a missing row, which the page then renders as
 * nothing at all. Both are one keystroke, both look like housekeeping, and both are the exact
 * failure the `Metric` type was built to make impossible.
 *
 * So this file passes the dashboards through unchanged and adds one thing: a `refusals` summary
 * that pulls every refused figure into one list the page is obliged to render. The list is
 * assembled from the modules' own words rather than restated here - a second copy of the reason is
 * a second thing to drift.
 *
 * `grossMargin` and `projectedLtv` are asked for explicitly, even though both refuse by
 * construction and neither appears on `unitEconomicsDashboard`. The reason to call a function whose
 * answer is known is that the answer carries the argument, and the argument is what an operator
 * needs when somebody asks why the margin is not on the board.
 */

import type { Express, Request, Response } from 'express';
import {
  UNMEASURED_COST_LINES,
  UNPRODUCED_DOMAINS,
  executiveDashboard,
  gardnerRollup,
  grossMargin,
  periodOf,
  projectedLtv,
  unitEconomicsDashboard,
} from '@bwc/dashboards';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface DashboardRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly tenantId: string;
  readonly now: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default window: the last 30 days, half-open, ending now. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Read the reporting window off the query string.
 *
 * A malformed date is refused rather than silently replaced with the default. A dashboard that
 * quietly reported a different period from the one asked for is a dashboard whose numbers cannot be
 * checked against anything.
 */
const readPeriod = (
  query: Record<string, unknown>,
  at: Date,
): { period: ReturnType<typeof periodOf> } | { problem: string } => {
  const fromRaw = query['from'];
  const toRaw = query['to'];

  if (fromRaw === undefined && toRaw === undefined) {
    return {
      period: periodOf(new Date(at.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS), at, at),
    };
  }
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') {
    return { problem: 'from and to must be supplied together, both as ISO dates.' };
  }

  const from = new Date(fromRaw);
  const to = new Date(toRaw);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { problem: 'from and to must each be an ISO date this runtime can parse.' };
  }
  if (to.getTime() <= from.getTime()) {
    return { problem: 'to must be after from. A period of zero length measures nothing.' };
  }

  return { period: periodOf(from, to, at) };
};

/** A metric shaped enough to ask whether it was measured. Structural, so both modules' fit. */
interface MetricLike {
  readonly key: string;
  readonly label: string;
  readonly value: unknown;
  readonly note: string;
  readonly basis: { readonly coverage: string; readonly unmeasured: readonly string[] };
}

const isMetric = (value: unknown): value is MetricLike =>
  typeof value === 'object' &&
  value !== null &&
  'key' in value &&
  'label' in value &&
  'note' in value &&
  'basis' in value;

/**
 * Every figure on a dashboard that came back without a value, with the reason it gave.
 *
 * Derived by walking the assembled dashboard rather than by listing keys, so a metric added to
 * either module appears here without anybody remembering to add it. A hand-maintained list is a
 * list that is wrong the first time somebody adds a KPI.
 */
const withheldFrom = (dashboard: Record<string, unknown>): readonly MetricLike[] =>
  Object.values(dashboard)
    .filter(isMetric)
    .filter((metric) => metric.value === null);

export const registerDashboardRoutes = (context: DashboardRouteContext): void => {
  const { app, requireStaff, asyncRoute, tenantId, now } = context;

  /**
   * 9.1, whole.
   *
   * The `withheld` list is the field this route exists to add. Everything else is the module's own
   * answer, forwarded.
   */
  app.get(
    '/api/console/dashboards/executive',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const window = readPeriod(req.query as Record<string, unknown>, at);
      if ('problem' in window) {
        send(res, refused(window.problem, 'Input validation'));
        return;
      }

      const dashboard = await executiveDashboard({ tenantId, period: window.period, now: at });
      if (dashboard.status !== 'ok') {
        send(res, dashboard);
        return;
      }

      send(
        res,
        ok({
          ...dashboard.value,
          withheld: withheldFrom(dashboard.value as unknown as Record<string, unknown>).map(
            (metric) => ({
              key: metric.key,
              label: metric.label,
              note: metric.note,
              coverage: metric.basis.coverage,
              unmeasured: metric.basis.unmeasured,
            }),
          ),
        }),
      );
    }),
  );

  /**
   * 9.2, whole, plus the two figures it refuses by construction.
   *
   * `grossMargin` and `projectedLtv` are not fields on the dashboard - they are functions that
   * return a refusal - so a page rendering only the dashboard would never show either. They are
   * called here so the reason travels to the operator who has to explain the gap.
   */
  app.get(
    '/api/console/dashboards/unit-economics',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const window = readPeriod(req.query as Record<string, unknown>, at);
      if ('problem' in window) {
        send(res, refused(window.problem, 'Input validation'));
        return;
      }

      const [dashboard, margin, ltv] = await Promise.all([
        unitEconomicsDashboard({ tenantId, period: window.period, now: at }),
        grossMargin(tenantId),
        projectedLtv(tenantId),
      ]);

      if (dashboard.status !== 'ok') {
        send(res, dashboard);
        return;
      }

      send(
        res,
        ok({
          ...dashboard.value,
          withheld: withheldFrom(dashboard.value as unknown as Record<string, unknown>).map(
            (metric) => ({
              key: metric.key,
              label: metric.label,
              note: metric.note,
              coverage: metric.basis.coverage,
              unmeasured: metric.basis.unmeasured,
            }),
          ),
          /**
           * The two the module refuses outright.
           *
           * Reported with `status` so the page can tell a refusal from an unmeasured metric. They
           * are different states: an unmeasured metric might become measurable with more data, and
           * a refused one will not become computable without a decision somebody has to make.
           */
          refusedOutright: [
            {
              metric: 'gross_margin',
              label: 'Gross margin',
              status: margin.status,
              why: margin.status === 'refused' ? margin.reason : 'Unexpectedly computable.',
              principle: margin.status === 'refused' ? margin.principle : null,
            },
            {
              metric: 'projected_ltv',
              label: 'Projected lifetime value',
              status: ltv.status,
              why: ltv.status === 'refused' ? ltv.reason : 'Unexpectedly computable.',
              principle: ltv.status === 'refused' ? ltv.principle : null,
            },
          ],
        }),
      );
    }),
  );

  /**
   * The Gardner rollup - blueprint 9.1's "Gardner-facing rollup with PII stripped".
   *
   * Served on the internal Console so an operator can see exactly what leaves the tenant before it
   * leaves. A rollup nobody can inspect is a disclosure nobody reviewed.
   */
  app.get(
    '/api/console/dashboards/gardner-rollup',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const window = readPeriod(req.query as Record<string, unknown>, at);
      if ('problem' in window) {
        send(res, refused(window.problem, 'Input validation'));
        return;
      }

      const source = await executiveDashboard({ tenantId, period: window.period, now: at });
      if (source.status !== 'ok') {
        send(res, source);
        return;
      }

      send(res, ok(gardnerRollup(source.value)));
    }),
  );

  /**
   * What neither dashboard can produce, and what stands behind each gap.
   *
   * A static read of two constants, served rather than written into the page: a hard-coded copy in
   * the browser drifts the moment somebody closes a gap, and the failure mode is a Console still
   * announcing a limitation that was lifted a release ago.
   */
  app.get(
    '/api/console/dashboards/gaps',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(
        res,
        ok({ unproducedDomains: UNPRODUCED_DOMAINS, unmeasuredCostLines: UNMEASURED_COST_LINES }),
      );
    }),
  );
};
