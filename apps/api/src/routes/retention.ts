/**
 * 7.5 Legal Hold & Record Retention, as Console routes.
 *
 * **A hold is a matter, not a flag on a document** (ADR-0042). It carries a matter reference, a
 * reason, who placed it and a review cadence, and it covers a scope rather than a row - which is
 * why the read here is the hold, not the documents it happens to touch.
 *
 * **A hold's review being overdue is derived, never stored.** A stored flag needs a job, and a job
 * that stops leaves every overdue hold reading as freshly reviewed. The module derives it on read
 * and this route forwards it.
 *
 * **Deletion is refused while anything holds the record, and that refusal is the useful answer.**
 * `assessEligibility` returns the holds in force as a sentence; a page that showed only
 * `deletable: false` would leave an operator with nothing to act on.
 */

import type { Express, Request, Response } from 'express';
import {
  DELETION_AUTHORITY_LEVEL,
  HOLD_AUTHORITY_LEVEL,
  activeHolds,
  assessEligibility,
  requestsFor,
  undecidedRequests,
} from '@bwc/retention';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface RetentionRouteContext {
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
    capability: 'Place or release a legal hold, record a hold review',
    module: '@bwc/retention placeHold, releaseHold, recordReview',
    missingAction: 'none declared',
    why: `Each writes a Ledger event and needs a declared action; none exists. The module already requires a human at Authority Level ${HOLD_AUTHORITY_LEVEL} and a matter reference - releasing a hold is the dangerous half, because it is what lets records be destroyed - but the action name is a judgement about Authority Levels and belongs in packages/core.`,
  },
  {
    capability: 'Decide or complete a deletion request',
    module: '@bwc/retention decideRequest, recordCompletion',
    missingAction: 'none declared',
    why: `Deleting a client's records is irreversible and the module already requires a human at Authority Level ${DELETION_AUTHORITY_LEVEL}. A button for it on a read surface would be the single most consequential control in this Console reachable by accident.`,
  },
] as const;

export const registerRetentionRoutes = (context: RetentionRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId, now } = context;

  /**
   * Every hold in force, with the ones whose review is overdue marked.
   *
   * Overdue is derived on read. ADR-0013's rule points the safe way here: a hold whose review has
   * lapsed KEEPS HOLDING, because the alternative is records being destroyed on a date passing.
   */
  app.get(
    '/api/console/retention/holds',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const holds = await activeHolds(tenantId, now());

      send(
        res,
        ok({
          holds,
          summary: {
            total: holds.length,
            reviewOverdue: holds.filter((hold) => hold.reviewOverdue).length,
          },
          detail:
            holds.length === 0
              ? 'No hold is in force. Records are governed by their retention schedule alone.'
              : `${holds.length} hold(s) in force, ${holds.filter((hold) => hold.reviewOverdue).length} overdue for review. An overdue hold keeps holding.`,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /** Deletion requests nobody has decided. The queue a Compliance lead works from. */
  app.get(
    '/api/console/retention/requests',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const requests = await undecidedRequests(tenantId);

      send(
        res,
        ok({
          requests,
          detail:
            requests.length === 0
              ? 'Nothing is waiting on a deletion decision.'
              : `${requests.length} request(s) undecided. Each needs a Level ${DELETION_AUTHORITY_LEVEL} human and a recorded reason.`,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * One client: can their records be deleted, and what has been asked.
   *
   * Eligibility and history together, because "no" is only actionable beside the hold that says so.
   */
  app.get(
    '/api/console/retention/clients/:clientId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const clientId = param(req, 'clientId');

      const [eligibility, history] = await Promise.all([
        assessEligibility(tenantId, clientId, now()),
        requestsFor(tenantId, clientId),
      ]);

      send(
        res,
        ok({
          // `heldBy` is the sentence naming what holds the record. `deletable: false` on its own
          // leaves an operator with nothing to act on.
          eligibility,
          requests: history,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
