/**
 * 1.3 Sales Motion & Engagement Tracking, as Console routes.
 *
 * Reads only, and the reason is the same one 1.2's route gives: every write in `@bwc/sales` emits a
 * Ledger event, so each must pass `chain()` with a declared action, and `ACTION_MINIMUM_LEVEL`
 * declares none of them. `create_client_record` is the closest thing in the catalogue and it is
 * about a CLIENT - converting a lead produces one, which is precisely why borrowing that action for
 * `createLead` would be wrong: it would authorise the wrong end of the pipeline at the wrong level.
 *
 * So the pipeline is visible and unchangeable from here. That is a smaller surface than 1.3
 * deserves and an honest one, and the gap is reported in `writes.blocked` rather than left for
 * somebody to discover by looking for a button.
 *
 * **One rate on this surface, and it refuses below its minimum.** `conversionByChannel` returns
 * `rate: null` below `MINIMUM_LEADS_FOR_RATE` decided leads and says how many more are needed. It
 * is forwarded exactly as the module produced it - a channel's conversion rate is the number a
 * marketing spend decision gets made on, and one computed over three leads is a number that reads
 * like knowledge.
 */

import type { Express, Request, Response } from 'express';
import {
  INACTIVITY_DAYS,
  MINIMUM_LEADS_FOR_RATE,
  activityFor,
  conversionByChannel,
  correctionHistory,
  currentAttribution,
  expansionSignals,
  findLead,
  lossReasons,
  originalAttribution,
  pipeline,
  readingsFor,
  renewalStates,
  staleLeads,
} from '@bwc/sales';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface SalesRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly tenantId: string;
  readonly now: () => Date;
}

/**
 * What this surface cannot do, named function by function.
 *
 * Blunter than a missing button and deliberately so. An operator who can see a stale lead and
 * cannot escalate it is owed the reason, and the reason is not "not built yet" - the escalation is
 * built, tested and working. What is missing is one line in a file this branch does not own.
 */
const BLOCKED_WRITES = [
  {
    capability: 'Create, qualify, convert or close a lead',
    module:
      '@bwc/sales createLead, qualifyLead, recordBlueprintDelivered, scheduleReviewCall, convertLead, closeLead',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action. ACTION_MINIMUM_LEVEL has none for moving a lead through the pipeline. create_client_record is about a client - conversion produces one - so borrowing it would authorise the wrong end of the motion at the wrong level.',
  },
  {
    capability: 'Record activity, a readiness reading, or an attribution correction',
    module: '@bwc/sales recordActivity, recordReadiness, correctAttribution, escalateStaleLeads',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action, and ACTION_MINIMUM_LEVEL declares none. An attribution correction in particular moves who a referral fee is owed to, which is a financial fact and the last thing to authorise under a borrowed label.',
  },
] as const;

export const registerSalesRoutes = (context: SalesRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId, now } = context;

  /**
   * The pipeline, plus everything that is overdue about it.
   *
   * `staleLeads` is on the same answer rather than its own route because the first question about a
   * pipeline is which parts of it have stopped moving, and a Console that made that a second click
   * would be a Console where nobody clicks it.
   */
  app.get(
    '/api/console/sales/pipeline',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const [leads, stale, channels, losses] = await Promise.all([
        pipeline(tenantId),
        staleLeads(tenantId, at),
        conversionByChannel(tenantId),
        lossReasons(tenantId),
      ]);

      send(
        res,
        ok({
          leads,
          stale,
          /** The threshold the escalation fires on, so the page states the rule it is applying. */
          inactivityDays: INACTIVITY_DAYS,
          /**
           * Per-channel conversion, forwarded with its refusal intact.
           *
           * `rate` is null below the minimum and the module says how many more decided leads would
           * make it a rate. The page renders that sentence rather than a dash.
           */
          conversionByChannel: channels,
          minimumLeadsForRate: MINIMUM_LEADS_FOR_RATE,
          lossReasons: losses,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * Expansion and renewal - blueprint 1.3's "expansion-path trigger firing" and "renewal / save
   * motion status".
   *
   * Separate from the pipeline because they are about clients rather than leads: a converted lead
   * has left the pipeline, and putting its renewal state in the pipeline answer would make the
   * pipeline count wrong for anybody who summed it.
   */
  app.get(
    '/api/console/sales/expansion',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const [signals, renewals] = await Promise.all([
        expansionSignals(tenantId, at),
        renewalStates(tenantId, at),
      ]);

      send(res, ok({ signals, renewals }));
    }),
  );

  /**
   * One lead's whole file: the record, its trail, its readiness history and its attribution.
   *
   * Attribution travels as both halves - what was recorded at creation and what applies now - with
   * the corrections between them. 1.3 keeps the original because a payout dispute asks what was
   * recorded when the fee was calculated, and a surface showing only the current value would make
   * the correction invisible on exactly the screen somebody would check it on.
   */
  app.get(
    '/api/console/sales/leads/:leadId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const leadId = param(req, 'leadId');
      const lead = await findLead(tenantId, leadId);
      if (lead.status !== 'ok') {
        send(res, lead);
        return;
      }

      const [trail, readings, original, current, corrections] = await Promise.all([
        activityFor(tenantId, leadId),
        readingsFor(tenantId, leadId),
        originalAttribution(tenantId, leadId),
        currentAttribution(tenantId, leadId),
        correctionHistory(tenantId, leadId),
      ]);

      send(
        res,
        ok({
          lead: lead.value,
          trail,
          readings,
          attribution: { original, current, corrections },
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
