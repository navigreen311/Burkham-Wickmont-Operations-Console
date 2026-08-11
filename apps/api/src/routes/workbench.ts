/**
 * 11.11 Founder / Executive Workbench, as Console routes.
 *
 * **This module stores nothing.** It assembles a decision queue, 9.1's rollup and 11.8's health at
 * read time, from the modules that own each fact. A cached workbench would report the last time
 * somebody looked, which on the surface a founder steers by is the failure that matters.
 *
 * **The queue is decisions, not a feed.** Every item carries a cost of inaction and a route to
 * resolving it, because a list of things that are wrong with no way to act on them is a source of
 * anxiety rather than a surface. The route forwards both untouched - a page that dropped
 * `costOfInaction` to fit a column would turn the queue back into a feed.
 *
 * **Nothing here is ranked by a number.** Urgency is categorical and the worst item leads. 9.1's
 * rollup is PII-stripped by construction rather than by a redaction pass, and this route does not
 * reassemble it.
 */

import type { Express, Request, Response } from 'express';
import { decisionQueue, workbench } from '@bwc/workbench';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface WorkbenchRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly tenantId: string;
  readonly now: () => Date;
}

export const registerWorkbenchRoutes = (context: WorkbenchRouteContext): void => {
  const { app, requireStaff, asyncRoute, tenantId, now } = context;

  /**
   * The whole surface, assembled live.
   *
   * One route rather than three, because the founder's question is "what needs me" and answering it
   * from three requests would let a page render two thirds of an answer and look complete.
   */
  app.get(
    '/api/console/workbench',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(res, await workbench({ tenantId, now: now() }));
    }),
  );

  /**
   * The queue alone, for a page that wants to poll it without reassembling the dashboards.
   *
   * Same data, same order, no summary: worst first, and every item keeps its cost of inaction.
   */
  app.get(
    '/api/console/workbench/decisions',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const decisions = await decisionQueue(tenantId, now());

      send(
        res,
        ok({
          decisions,
          /**
           * An empty queue is stated rather than left to render as a blank panel. "Nothing needs
           * you" and "this did not load" look identical when both are empty.
           */
          detail:
            decisions.length === 0
              ? 'Nothing is waiting on a decision. That is an answer, not an empty screen.'
              : `${decisions.length} decision${decisions.length === 1 ? '' : 's'} waiting, worst first.`,
        }),
      );
    }),
  );
};
