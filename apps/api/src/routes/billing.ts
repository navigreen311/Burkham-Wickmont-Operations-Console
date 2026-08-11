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

import type { Express, Request, Response } from 'express';
import { engagementsForClient, ladder, totalAvailableCredit } from '@bwc/billing';
import { noData, ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface BillingRouteContext {
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
    capability: 'Publish an offer, start or cancel an engagement, apply a credit',
    module: '@bwc/billing publishOffer, startEngagement, cancelEngagement, applyCredit',
    missingAction: 'none declared',
    why: 'Each writes a Ledger event and so needs a declared action in ACTION_MINIMUM_LEVEL. None exists for billing. The module already enforces its own rules - a credit draws on a specific billing record so a double credit is arithmetically impossible, and declining a refund needs a Level 3 human with a recorded reason - but the action name is a decision about Authority Levels and belongs in packages/core.',
  },
] as const;

export const registerBillingRoutes = (context: BillingRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

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
          ? ok({ rungs, writes: { available: [], blocked: BLOCKED_WRITES } })
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
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
