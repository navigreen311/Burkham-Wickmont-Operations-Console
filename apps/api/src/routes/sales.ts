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
  closeLead,
  correctAttribution,
  recordActivity,
  recordReadiness,
  convertLead,
  createLead,
  qualifyLead,
} from '@bwc/sales';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type SalesRouteContext = ConsoleRouteContext;

/**
 * What this surface cannot do, named function by function.
 *
 * Blunter than a missing button and deliberately so. An operator who can see a stale lead and
 * cannot escalate it is owed the reason, and the reason is not "not built yet" - the escalation is
 * built, tested and working. What is missing is one line in a file this branch does not own.
 */
/**
 * The lead lifecycle, and the one step in it that is not lifecycle work.
 *
 * Creating, qualifying and closing a lead is the sales team's own work on somebody who is not yet a
 * client. **Converting is a different act at a different level**: it creates a client through 1.1
 * and may start an engagement through 1.4, so declaring it at Level 1 would have been a lower-level
 * path to `create_client_record` and `manage_engagement`.
 */
const AVAILABLE_WRITES = [
  {
    capability: 'Record an activity or a readiness reading',
    action: 'record_lead_activity',
    note: 'Level 1. Ordinary pipeline hygiene on somebody who is not yet a client.',
  },
  {
    capability: 'Correct a lead attribution',
    action: 'correct_attribution',
    note: 'LEVEL 3, and the module chose it before the authority model did: it moves money between partners, and an agent able to do it would make the record unreliable in exactly the place it needs to be trusted. A reason is required - an unexplained change to who a fee is owed to is indistinguishable from an error nobody caught.',
  },
  {
    capability: 'Create, qualify or close a lead',
    action: 'manage_lead',
    note: 'Level 1. Work on a prospect who is not yet a client. A qualification needs a note - unexplained, it is a filter nobody can improve and a decision the salesperson who disagrees cannot appeal.',
  },
  {
    capability: 'Convert a lead',
    action: 'convert_lead',
    note: 'Level 3, and NOT Level 1 like the rest of the lifecycle: converting creates a client and may start an engagement. A lower level here would be a way round the gate on both. Either both happen or neither does - a half-done conversion leaves an orphan client nobody can see.',
  },
] as const;

const BLOCKED_WRITES = [] as const;

export const registerSalesRoutes = (context: SalesRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /** Record a prospect. Not a client: no client id exists yet, so step 4 has nothing to gate on. */
  app.post(
    '/api/console/sales/leads',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'manage_lead' });
      if (!permitted) return;

      send(
        res,
        await createLead({
          ...(req.body as Record<string, unknown>),
          tenantId,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Qualify one. The module requires a note and refuses without it. */
  app.post(
    '/api/console/sales/leads/:leadId/qualification',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'manage_lead' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await qualifyLead({
          tenantId,
          leadId: param(req, 'leadId'),
          qualification: body['qualification'] as never,
          note: String(body['note'] ?? ''),
          occurredAt: new Date(String(body['occurredAt'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** Close it lost. */
  app.post(
    '/api/console/sales/leads/:leadId/closure',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'manage_lead' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await closeLead({
          tenantId,
          leadId: param(req, 'leadId'),
          reason: body['reason'] as never,
          closedBy: permitted.actor.id,
          closedOn: new Date(String(body['closedOn'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /**
   * Convert.
   *
   * A separate action at Level 3 because of what it does rather than what it is called: a client is
   * created and an engagement may start. The module makes it all-or-nothing, having previously
   * created the client first and left an orphan behind when the engagement could not start.
   */
  app.post(
    '/api/console/sales/leads/:leadId/conversion',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'convert_lead' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await convertLead({
          ...body,
          tenantId,
          leadId: param(req, 'leadId'),
          convertedBy: permitted.actor.id,
          convertedOn: new Date(String(body['convertedOn'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Log an activity against a lead. */
  app.post(
    '/api/console/sales/leads/:leadId/activities',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'record_lead_activity' });
      if (!permitted) return;

      send(
        res,
        await recordActivity({
          ...(req.body as Record<string, unknown>),
          tenantId,
          leadId: param(req, 'leadId'),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Record an expansion-readiness reading. */
  app.post(
    '/api/console/sales/clients/:clientId/readiness',
    jsonBody,
    asyncRoute(async (req, res) => {
      const clientId = param(req, 'clientId');
      const permitted = await authorised(req, res, { action: 'record_lead_activity', clientId });
      if (!permitted) return;

      send(
        res,
        await recordReadiness({
          ...(req.body as Record<string, unknown>),
          tenantId,
          clientId,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /**
   * Correct an attribution.
   *
   * **The act that was hiding in "record activity".** It changes who a referral fee is owed to, and
   * the module refuses below Level 3 in its own words. A reason is required for the same reason:
   * an unexplained change to who gets paid is indistinguishable from an error nobody caught.
   */
  app.post(
    '/api/console/sales/leads/:leadId/attribution',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'correct_attribution' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await correctAttribution({
          ...body,
          tenantId,
          leadId: param(req, 'leadId'),
          correctedBy: permitted.actor.id,
          correctedAt: new Date(String(body['correctedAt'])),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );
};
