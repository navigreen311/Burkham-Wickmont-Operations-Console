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

import {
  approveAttempt,
  approvedAndUnfunded,
  attemptsForClient,
  decidedIn,
  declineAttempt,
  markAttemptFunded,
  recordSatisfaction,
  submitAttempt,
  withdrawAttempt,
} from '@bwc/outcomes';
import type { Request } from 'express';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type OutcomesRouteContext = ConsoleRouteContext;

/**
 * The denominator, and the one act on it that is not bookkeeping.
 *
 * Recording what a provider decided is Level 2 - the firm is writing down somebody else's
 * decision. Marking an attempt FUNDED is Level 3, because it stops a refund clock: 1.4 drives
 * refunds from a sixty-day approved-but-unfunded trigger, and an attempt wrongly marked funded
 * silently takes a client out of the window that would have refunded them.
 */
const AVAILABLE_WRITES = [
  {
    capability: 'Submit an attempt, approve, decline, withdraw, record satisfaction',
    action: 'record_funding_outcome',
    note: 'Level 2. This is the denominator 9.1 refused to fake: a decline nobody records is an approval rate that reads better than the firm performed.',
  },
  {
    capability: 'Mark an attempt funded',
    action: 'mark_attempt_funded',
    note: 'Level 3, separately. Marking an attempt funded STOPS a refund clock - 1.4 refunds on a sixty-day approved-but-unfunded trigger, so a wrong one denies a refund the client is owed, later and invisibly.',
  },
] as const;

const BLOCKED_WRITES = [] as const;

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
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /** Record an attempt going out. Bookkeeping of a submission the placement path authorised. */
  app.post(
    '/api/console/outcomes/attempts',
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : undefined;

      const permitted = await authorised(req, res, {
        action: 'record_funding_outcome',
        ...(clientId !== undefined ? { clientId } : {}),
      });
      if (!permitted) return;

      send(
        res,
        await submitAttempt({
          ...body,
          tenantId,
          submittedAt: new Date(String(body['submittedAt'])),
          recordedBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** The provider approved. `approvedCreditLimitCents` is the figure a success fee computes on. */
  app.post(
    '/api/console/outcomes/attempts/:attemptId/approval',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'record_funding_outcome' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await approveAttempt({
          ...body,
          tenantId,
          attemptId: param(req, 'attemptId'),
          approvedCreditLimitCents: Number(body['approvedCreditLimitCents']),
          decidedAt: new Date(String(body['decidedAt'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** The provider declined. The half that makes an approval rate honest. */
  app.post(
    '/api/console/outcomes/attempts/:attemptId/decline',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'record_funding_outcome' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await declineAttempt({
          ...body,
          tenantId,
          attemptId: param(req, 'attemptId'),
          decidedAt: new Date(String(body['decidedAt'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Withdrawn - neither approved nor declined, and counted as neither. */
  app.post(
    '/api/console/outcomes/attempts/:attemptId/withdrawal',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'record_funding_outcome' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await withdrawAttempt({
          tenantId,
          attemptId: param(req, 'attemptId'),
          reason: String(body['reason'] ?? ''),
          decidedAt: new Date(String(body['decidedAt'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /**
   * The money arrived.
   *
   * A separate action from every other outcome, at a higher level, because this is the one that
   * stops the sixty-day refund trigger running.
   */
  app.post(
    '/api/console/outcomes/attempts/:attemptId/funding',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'mark_attempt_funded' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await markAttemptFunded({
          tenantId,
          attemptId: param(req, 'attemptId'),
          fundedOn: new Date(String(body['fundedOn'])),
          fundedCents: Number(body['fundedCents']),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** What the client thought of it. */
  app.post(
    '/api/console/outcomes/attempts/:attemptId/satisfaction',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'record_funding_outcome' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await recordSatisfaction({
          tenantId,
          attemptId: param(req, 'attemptId'),
          satisfaction: body['satisfaction'] as never,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );
};
