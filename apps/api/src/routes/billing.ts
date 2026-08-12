/**
 * 1.4 Pricing, Billing & Offer Management, as Console routes.
 *
 * **Every figure here is integer cents and none of it is arithmetic done in this file.** ADR-0011
 * exists because `(0.615).toFixed(2)` is `'0.61'` - the half-cent is below it in binary, so the
 * language rounds the wrong way - and because `paid - earned` in floating point can be `-0.001`,
 * which is not a refund anybody can pay. A transport that summed a line here would reintroduce all
 * of it one layer up, so this file reads and forwards and never adds.
 *
 * **The ladder is published prices, and it is what makes a price arm's length.** ADR-0018 rests on
 * it: a related-party engagement is priced at what strangers pay, and the only durable definition of
 * that is the published ladder. Showing it beside an engagement is what lets a reader see whether a
 * deviation happened at all.
 *
 * **No write is offered, and the reason is not that writing is dangerous.** Publishing an offer,
 * starting an engagement, applying a credit and cancelling all emit Ledger events, so each must pass
 * the middleware chain with a declared action - and `ACTION_MINIMUM_LEVEL` declares none for
 * billing. Naming those actions is a judgement about Authority Levels that belongs in
 * `packages/core`, not in a route file that happens to need one.
 */

import {
  applyCredit,
  cancelEngagement,
  engagementsForClient,
  ladder,
  publishOffer,
  startEngagement,
  totalAvailableCredit,
} from '@bwc/billing';
import { noData, ok, refused } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type BillingRouteContext = ConsoleRouteContext;

const AVAILABLE_WRITES = [
  {
    capability: 'Publish an offer',
    action: 'publish_offer',
    note: 'Level 3. A price list, not a quote: publishing supersedes the live rung, and a new engagement starts on the new one.',
  },
  {
    capability: 'Start or cancel an engagement, apply a credit',
    action: 'manage_engagement',
    note: 'Level 3. Starting commits this client to a fee, cancelling ends the commercial relationship, and a credit moves money. Money is integer cents throughout.',
  },
] as const;

const BLOCKED_WRITES = [] as const;

export const registerBillingRoutes = (context: BillingRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId } = context;

  /**
   * The published ladder, which is the answer to "what does this cost anybody".
   *
   * Rungs come back in their own order rather than sorted here: the ladder is a sequence somebody
   * published, and re-sorting it by price would silently reorder a thing whose order is the point.
   */
  app.get(
    '/api/console/billing/ladder',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const rungs = await ladder(tenantId);
      send(
        res,
        rungs.length > 0
          ? ok({ rungs, writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES } })
          : noData(
              "No offer has been published for this tenant. An empty ladder is not a free service - it is a price list nobody has written, and every arm's-length comparison (ADR-0018) needs one.",
            ),
      );
    }),
  );

  /**
   * One client's engagement, with the ladder price beside it.
   *
   * The two travel together deliberately. A deviation from the published price is only visible if
   * both are in front of the reader, and ADR-0018 requires Gardner approval for a deviation **in
   * either direction** - a discount moves profit out of this firm, a premium moves it in, and a
   * system that only questioned discounts would police the direction nobody would report.
   */
  app.get(
    '/api/console/billing/clients/:clientId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const clientId = param(req, 'clientId');

      const [engagements, rungs, credit] = await Promise.all([
        engagementsForClient(tenantId, clientId),
        ladder(tenantId),
        totalAvailableCredit(tenantId, clientId),
      ]);

      send(
        res,
        ok({
          /**
           * Every engagement, not the current one.
           *
           * A client with two is a client whose history matters - a cancelled engagement and a
           * later one are different commercial relationships, and 7.1 assembles a regulator-facing
           * file from exactly this history. Showing only the live one would make the earlier one
           * disappear from the surface a person checks.
           */
          engagements,
          /** The published prices, so a deviation is visible without a second lookup. ADR-0018. */
          ladder: rungs,
          ladderAbsent:
            rungs.length > 0
              ? null
              : 'No offer is published for this tenant, so there is nothing to compare a price against.',
          availableCreditCents: credit,
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /** Publish an offer. A price list, not a quote: it supersedes the live one. */
  app.post(
    '/api/console/billing/offers',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'publish_offer' });
      if (!permitted) return;

      send(
        res,
        await publishOffer({
          ...(req.body as Record<string, unknown>),
          tenantId,
          publishedBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Start an engagement. Commits this client to a fee. */
  app.post(
    '/api/console/billing/engagements',
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as { clientId?: unknown; offerKey?: unknown; startedOn?: unknown };
      const clientId = typeof body.clientId === 'string' ? body.clientId : undefined;

      const permitted = await authorised(req, res, {
        action: 'manage_engagement',
        ...(clientId !== undefined ? { clientId } : {}),
      });
      if (!permitted) return;

      const startedOn =
        typeof body.startedOn === 'string' ? new Date(body.startedOn) : new Date(NaN);
      if (Number.isNaN(startedOn.getTime())) {
        send(res, refused('startedOn must be a date.', 'Input validation'));
        return;
      }

      send(
        res,
        await startEngagement({
          tenantId,
          clientId: String(clientId ?? ''),
          offerKey: String(body.offerKey ?? ''),
          startedOn,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Cancel one. The end of a commercial relationship, so it carries a reason. */
  app.post(
    '/api/console/billing/engagements/:engagementId/cancellation',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'manage_engagement' });
      if (!permitted) return;

      const body = req.body as { reason?: unknown; cancelledOn?: unknown };
      const cancelledOn =
        typeof body.cancelledOn === 'string' ? new Date(body.cancelledOn) : new Date(NaN);
      if (Number.isNaN(cancelledOn.getTime())) {
        send(res, refused('cancelledOn must be a date.', 'Input validation'));
        return;
      }

      send(
        res,
        await cancelEngagement({
          tenantId,
          engagementId: param(req, 'engagementId'),
          reason: String(body.reason ?? ''),
          cancelledOn,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** Apply a credit. Money, so integer cents and a Level 3 human. */
  app.post(
    '/api/console/billing/engagements/:engagementId/credit',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'manage_engagement' });
      if (!permitted) return;

      send(
        res,
        await applyCredit({
          ...(req.body as Record<string, unknown>),
          tenantId,
          engagementId: param(req, 'engagementId'),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );
};
