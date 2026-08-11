/**
 * 5.4 Capital Product Governance Board — which providers the board permits, and where.
 *
 * ## Why the review queue is the surface rather than a provider list
 *
 * `standing()` refuses a provider for six distinct reasons, and one of them is time: an approved
 * provider whose review is more than its cadence old stops being recommendable without anybody
 * doing anything. **That is the only blocker that arrives by itself**, which makes it the one a
 * board finds out about from a screen rather than from a decision it remembers making.
 *
 * So the queue is computed by asking `standing()` about each approved provider rather than by a
 * date query — the module's own comment says why: the queue and the gate can never disagree about
 * what overdue means if only one of them defines it.
 *
 * ## Never governed is not the same as not approved
 *
 * A provider the board has never seen has no governance row, and `standing()` reports that as the
 * `never_governed` blocker rather than as an empty default. It is the most common reason a provider
 * is not recommendable, and reporting it as "not approved" would suggest a decision somebody made.
 * The page writes the blockers out as words for the same reason.
 *
 * ## Every write here is reported, not built
 *
 * `submitForReview`, `approve`, `recordReview`, `flagForReview`, `suspend`, `blacklist`,
 * `reinstate` and `recordComplaint` are all writes and none of them has an action in
 * `ACTION_MINIMUM_LEVEL`. Unlike 7.2's activation they have no module-level authority gate to stand
 * in for the chain, so this surface reads. ADR-0047 lists what core would need.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import {
  MAXIMUM_REVIEW_CADENCE_DAYS,
  complaintHistory,
  decisionHistory,
  governanceOf,
  reviewQueue,
  standingOf,
  stateRestrictions,
} from '@bwc/governance';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

/** See the note in `routes/regulatory.ts`: four copies, one per owned file, no fifth to share. */
export interface ConsoleRouteContext {
  readonly app: Express;
  readonly tenantId: string;
  readonly now: () => Date;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly jsonBody: RequestHandler;
}

export const registerGovernanceRoutes = (context: ConsoleRouteContext): void => {
  const { app, tenantId, now, requireStaff, asyncRoute, param } = context;

  /**
   * Providers whose review has run out of time.
   *
   * The cadence ceiling travels with the queue. "Overdue" means nothing on a page without the
   * number it is overdue against, and blueprint 5.4's quarterly minimum is a rule a reader should
   * be able to check rather than take on trust.
   */
  app.get(
    '/api/console/governance/review-queue',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const overdue = await reviewQueue(tenantId, now());

      send(
        res,
        ok({
          providers: overdue.map((entry) => ({
            providerId: entry.providerId,
            verdict: entry.verdict,
            blockers: entry.blockers,
            explanation: entry.explanation,
            daysSinceReview: entry.daysSinceReview,
            requiredDisclosures: entry.requiredDisclosures,
          })),
          total: overdue.length,
          maximumReviewCadenceDays: MAXIMUM_REVIEW_CADENCE_DAYS,
          headline:
            overdue.length === 0
              ? 'No approved provider is overdue for review.'
              : `${overdue.length} approved provider(s) are past their review cadence and are not recommendable until reviewed.`,
        }),
      );
    }),
  );

  /**
   * One provider: what the board recorded, what follows from it, and the history of both.
   *
   * `standingOf` is asked rather than derived here. A governance row says what was decided; standing
   * says what is true now, and only one of those two is a thing this transport may compute.
   */
  app.get(
    '/api/console/governance/providers/:providerId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const providerId = param(req, 'providerId');
      const at = now();

      const [record, standing, decisions, complaints] = await Promise.all([
        governanceOf(tenantId, providerId),
        standingOf(tenantId, providerId, at),
        decisionHistory(tenantId, providerId),
        complaintHistory(tenantId, providerId),
      ]);

      send(
        res,
        ok({
          providerId,
          /**
           * `null` when the board has never seen this provider, and the page writes that out.
           *
           * Absence is the answer, not a missing value: ADR-0007 put governance status outside the
           * provider record precisely so a provider nobody governed has no status rather than a
           * default one.
           */
          governance:
            record === null
              ? null
              : {
                  status: record.status,
                  lastReviewedAt: record.lastReviewedAt,
                  reviewCadenceDays: record.reviewCadenceDays,
                  approvedStates: record.approvedStates,
                  restrictedStates: record.restrictedStates,
                  requiredDisclosures: record.requiredDisclosures,
                  complaintCount: record.complaintCount,
                  blacklistReason: record.blacklistReason,
                },
          neverGoverned: record === null,
          standing: {
            verdict: standing.verdict,
            blockers: standing.blockers,
            explanation: standing.explanation,
            daysSinceReview: standing.daysSinceReview,
            requiredDisclosures: standing.requiredDisclosures,
          },
          decisions: decisions.map((entry) => ({
            fromStatus: entry.fromStatus,
            toStatus: entry.toStatus,
            rationale: entry.rationale,
            decidedBy: entry.decidedBy,
            decidedAt: entry.decidedAt,
          })),
          decisionsTotal: decisions.length,
          complaints: complaints.map((entry) => ({
            id: entry.id,
            source: entry.source,
            summary: entry.summary,
            severity: entry.severity,
            receivedAt: entry.receivedAt,
          })),
          complaintsTotal: complaints.length,
        }),
      );
    }),
  );

  /**
   * What may not happen where.
   *
   * Includes suspended and blacklisted providers rather than only approved ones, because the
   * question the Regulatory Engine asks is "what may not happen where" and a provider that may not
   * be used anywhere is the strongest possible answer to it.
   *
   * **An empty `approvedStates` means not limited, not limited to nothing**, and the two are
   * opposite answers to "may this provider be recommended anywhere". The page writes the sentence
   * rather than showing an empty list.
   */
  app.get(
    '/api/console/governance/restrictions',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const restrictions = await stateRestrictions(tenantId);

      send(
        res,
        ok({
          restrictions: restrictions.map((entry) => ({
            providerId: entry.providerId,
            status: entry.status,
            approvedStates: entry.approvedStates,
            restrictedStates: entry.restrictedStates,
            requiredDisclosures: entry.requiredDisclosures,
            limitedToStates: entry.approvedStates.length > 0,
          })),
          total: restrictions.length,
          note: 'An empty approved-states list means the approval is not limited by state, not that it is limited to none.',
        }),
      );
    }),
  );
};
