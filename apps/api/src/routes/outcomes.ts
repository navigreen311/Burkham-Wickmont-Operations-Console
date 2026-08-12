/**
 * 5.5 Funding Outcome Ledger, as Console routes.
 *
 * **This module is the denominator 9.1 spent its whole life refusing to fake.** Before it existed,
 * only approvals were recorded, so any approval rate read 100% forever - arithmetically correct,
 * extremely reassuring, and the exact claim the Marketing Claim Library bans. A decline is a row
 * here (ADR-0041), so the rate has two halves and can be computed honestly.
 *
 * **Which means the most important thing this surface does is withhold one.** Below
 * `MINIMUM_DECIDED_FOR_RATE` the module returns `rate: null` with a sentence saying how many more
 * decided attempts would produce a figure - and the counts are shown regardless, because they are
 * real. A page that rendered `null` as `0%` would undo the entire module.
 *
 * **`approvedAndUnfunded` is the operational read.** An approval that never became money is
 * invisible in a rate and is exactly what somebody should be chasing; 1.4's refund trigger counts
 * from the same window.
 */

import type { Express, Request, Response } from 'express';
import { approvedAndUnfunded, attemptsForClient, decidedIn } from '@bwc/outcomes';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface OutcomesRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly tenantId: string;
  readonly now: () => Date;
}

const BLOCKED_WRITES = [
  {
    capability: 'Submit an attempt, approve, decline, withdraw, mark funded, record satisfaction',
    module:
      '@bwc/outcomes submitAttempt, approveAttempt, declineAttempt, withdrawAttempt, markAttemptFunded, recordSatisfaction',
    missingAction: 'none declared',
    why: 'Each writes a Ledger event and needs a declared action in ACTION_MINIMUM_LEVEL; none exists for recording a funding outcome. Deciding an attempt is the consequential one - it is the row that makes an approval rate honest, and a wrong one is a number the firm then reports.',
  },
] as const;

/** A period, required. Half-open, so consecutive windows neither overlap nor leave a gap. */
const windowFrom = (req: Request): { from: Date; to: Date } | null => {
  const query = req.query as Record<string, unknown>;
  const from = typeof query['from'] === 'string' ? new Date(query['from']) : null;
  const to = typeof query['to'] === 'string' ? new Date(query['to']) : null;
  if (from === null || to === null) return null;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (from.getTime() >= to.getTime()) return null;
  return { from, to };
};

export const registerOutcomeRoutes = (context: OutcomesRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId, now } = context;

  /**
   * The approval rate over a period, or the reason there is not one yet.
   *
   * The period is required and has no default. A rate over "recently" is a rate nobody can check,
   * and two readers would disagree about what it covered.
   */
  app.get(
    '/api/console/outcomes/rate',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const window = windowFrom(req);
      if (window === null) {
        send(
          res,
          refused(
            'from and to are both required, as dates, with from before to. A rate over an unstated period is a figure nobody can check.',
            'Blueprint 5.5 - a rate is a measurement over a stated window',
          ),
        );
        return;
      }

      const rate = await decidedIn(tenantId, window);

      send(
        res,
        ok({
          // Forwarded whole. `rate` is null below the minimum sample and the note says what would
          // produce one; the counts are real and travel either way.
          ...rate,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * Approved, and still not funded.
   *
   * The read a rate cannot show: an approval that never became money counts as a success in every
   * percentage and is the thing somebody should be chasing.
   */
  app.get(
    '/api/console/outcomes/approved-unfunded',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const attempts = await approvedAndUnfunded(tenantId, now());

      send(
        res,
        ok({
          attempts,
          detail:
            attempts.length === 0
              ? 'No approval is sitting unfunded past the window. That is an answer, not an empty screen.'
              : `${attempts.length} approval(s) past the window and still unfunded.`,
        }),
      );
    }),
  );

  /** Every attempt on one client's file, in order. */
  app.get(
    '/api/console/outcomes/clients/:clientId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const attempts = await attemptsForClient(tenantId, param(req, 'clientId'), now());

      send(
        res,
        ok({
          attempts,
          // Counted here so a page cannot present "three attempts" as three approvals.
          summary: {
            total: attempts.length,
            approved: attempts.filter((attempt) => attempt.outcome === 'approved').length,
            declined: attempts.filter((attempt) => attempt.outcome === 'declined').length,
            pending: attempts.filter((attempt) => attempt.outcome === 'pending').length,
          },
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
