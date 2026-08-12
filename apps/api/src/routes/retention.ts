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

import {
  DELETION_AUTHORITY_LEVEL,
  HOLD_AUTHORITY_LEVEL,
  activeHolds,
  assessEligibility,
  decideRequest,
  placeHold,
  recordCompletion,
  recordReview,
  releaseHold,
  requestsFor,
  undecidedRequests,
} from '@bwc/retention';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type RetentionRouteContext = ConsoleRouteContext;

/**
 * What this surface now offers, and what each one cannot be taken back.
 *
 * Both are irreversible in the direction that matters, and the panel says so rather than leaving
 * an operator to infer it from a button label.
 */
const AVAILABLE_WRITES = [
  {
    capability: 'Place a legal hold, or record its review',
    action: 'place_legal_hold',
    note: `Level ${HOLD_AUTHORITY_LEVEL}, and a matter reference is required - a hold nobody can trace to a matter is one nobody will dare release. Placing one suspends the retention schedule for what it covers.`,
  },
  {
    capability: 'Release a legal hold',
    action: 'release_legal_hold',
    note: 'THE DANGEROUS HALF. Releasing is what lets records be destroyed on schedule again. It is a separate action from placing one so the Ledger can tell them apart.',
  },
  {
    capability: 'Decide a deletion request, or record its completion',
    action: 'decide_deletion_request',
    note: 'IRREVERSIBLE. Recording completion says a client’s records have been destroyed; nothing here can bring them back. Deletion is refused while any hold is in force, and that refusal names the hold.',
  },
] as const;

/**
 * Nothing left, and the reason the previous entry is worth remembering.
 *
 * It read: "A button for it on a read surface would be the single most consequential control in
 * this Console reachable by accident." That was true of a surface with no authority chain in front
 * of it. It has one now - Level ${DELETION_AUTHORITY_LEVEL}, a recorded actor, a required reason,
 * a Ledger event, and a hold check that refuses while anything is in force.
 *
 * **The owner was shown that argument and chose the button anyway**, which is theirs to choose. The
 * mitigation is that the act is gated, attributable and stated as irreversible on the panel, not
 * that it is hidden.
 */
const BLOCKED_WRITES = [] as const;

export const registerRetentionRoutes = (context: RetentionRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------
  //
  // Each authorises BEFORE reading the body, so a caller with no session learns nothing about what
  // the route wants. The module performs its own validation after: a matter reference, a reason of
  // real length, a hold that exists. Two checks of different things, not a duplicate.

  /** Place a hold. Governance-classified: the client it covers is often the one step 4 refuses. */
  app.post(
    '/api/console/retention/holds',
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as {
        clientId?: unknown;
        kind?: unknown;
        scope?: unknown;
        matterReference?: unknown;
        reason?: unknown;
      };
      const clientId = typeof body.clientId === 'string' ? body.clientId : undefined;

      const permitted = await authorised(req, res, {
        action: 'place_legal_hold',
        ...(clientId !== undefined ? { clientId } : {}),
      });
      if (!permitted) return;

      const placed = await placeHold({
        tenantId,
        kind: body.kind as never,
        scope: body.scope as never,
        ...(clientId !== undefined ? { clientId } : {}),
        matterReference: String(body.matterReference ?? ''),
        reason: String(body.reason ?? ''),
        placedBy: permitted.actor.id,
        now: now(),
      });
      send(res, placed, { trace: permitted.trace });
    }),
  );

  /** Record a review. Keeps a hold current; does not release it. */
  app.post(
    '/api/console/retention/holds/:holdId/review',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'place_legal_hold' });
      if (!permitted) return;

      const body = req.body as { notes?: unknown };
      send(
        res,
        await recordReview({
          tenantId,
          holdId: param(req, 'holdId'),
          reviewedBy: permitted.actor.id,
          notes: String(body.notes ?? ''),
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /**
   * Release a hold - a separate action from placing one.
   *
   * This is what puts records back on a schedule that destroys them, so it is the one act here
   * whose consequence arrives later and silently.
   */
  app.post(
    '/api/console/retention/holds/:holdId/release',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'release_legal_hold' });
      if (!permitted) return;

      const body = req.body as { reason?: unknown };
      send(
        res,
        await releaseHold({
          tenantId,
          holdId: param(req, 'holdId'),
          releasedBy: permitted.actor.id,
          reason: String(body.reason ?? ''),
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** Decide a deletion request. Approving does not delete - completion is a second act. */
  app.post(
    '/api/console/retention/requests/:requestId/decision',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'decide_deletion_request' });
      if (!permitted) return;

      const body = req.body as { approve?: unknown; reason?: unknown };
      send(
        res,
        await decideRequest({
          tenantId,
          requestId: param(req, 'requestId'),
          approve: body.approve === true,
          decidedBy: permitted.actor.id,
          reason: String(body.reason ?? ''),
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /**
   * Record that the deletion happened.
   *
   * **The irreversible one.** Deciding to approve is a decision somebody can revisit; recording
   * completion is a statement that the records are gone. It is a separate route from the decision
   * for that reason, rather than a flag on it.
   */
  app.post(
    '/api/console/retention/requests/:requestId/completion',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'decide_deletion_request' });
      if (!permitted) return;

      const body = req.body as { documentsDeleted?: unknown };
      send(
        res,
        await recordCompletion({
          tenantId,
          requestId: param(req, 'requestId'),
          documentsDeleted: Number(body.documentsDeleted ?? -1),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );
};
