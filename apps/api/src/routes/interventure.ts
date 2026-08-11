/**
 * 10.1 Inter-Venture Commerce Hooks, as Console routes.
 *
 * **A page cannot complete a conflict disclosure, and this one does not try.**
 *
 * The module separates two things blueprint 10.1 runs together. The ARTIFACT is generated
 * automatically, and should be - a hand-written conflict disclosure varies with how the writer
 * feels about the conflict, and the version written by somebody keen to proceed is the one that
 * understates it. The DISCLOSURE is complete only when acknowledged by parties who are **not us**:
 * the venture's own representative, who is the party the conflict is against, and Gardner, who
 * governs both sides.
 *
 * So the Console shows the disclosure and its state, and offers no acknowledgement control. Not
 * because the action lacks a declared authority level - though it does - but because **an
 * acknowledgement recorded from our own staff console is not an acknowledgement.** A button here
 * that wrote `interventure.disclosure.acknowledged` would manufacture the exact evidence the
 * control exists to require, and it would look identical to the real thing afterwards.
 *
 * `generateDisclosure` is a different case and is blocked for the ordinary reason: it writes a
 * Ledger event and has no declared action. Worth separating, because they would be unblocked by
 * different things - one by a decision in `packages/core`, the other by a party who is not us.
 *
 * **The body is hashed and the hash is checked at acknowledgement**, so a template change cannot
 * rewrite what was acknowledged. The route sends the hash, and the page shows it: an operator
 * chasing an acknowledgement needs to be able to say which version they are chasing.
 */

import type { Express, Request, Response } from 'express';
import {
  GREEN_COMPANIES,
  allRelationships,
  awaitingRouting,
  deviationsFor,
  handoffsFor,
  mayProceed,
} from '@bwc/interventure';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface InterventureRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly tenantId: string;
}

/**
 * The two kinds of thing this surface cannot do, kept apart on purpose.
 *
 * Collapsing them into one list would suggest that declaring an action unlocks both. It does not:
 * an acknowledgement is not ours to give at any authority level, and the day somebody adds
 * `acknowledge_disclosure` to the catalogue is the day this distinction matters most.
 */
const BLOCKED_WRITES = [
  {
    capability: 'Generate a conflict disclosure, tag a venture, raise an intercompany invoice',
    module:
      '@bwc/interventure generateDisclosure, tagIfVenture, confirmVenture, raiseInvoice, recordDeviation',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action, and ACTION_MINIMUM_LEVEL declares none for inter-venture commerce. Unblocked by a decision about Authority Levels in packages/core.',
    unblockedBy: 'a declared action',
  },
  {
    capability: 'Acknowledge a conflict disclosure, as the venture or as Gardner',
    module: '@bwc/interventure acknowledgeByVenture, acknowledgeByGardner',
    missingAction: 'not applicable',
    why: "This is not a missing action. A disclosure completes only on acknowledgement by parties who are NOT us - the venture's own representative and Gardner (ADR-0018). A control on this Console that recorded either would manufacture the evidence the disclosure exists to require, and afterwards it would be indistinguishable from the real thing. No Authority Level makes us the counterparty.",
    unblockedBy: 'nothing on this surface, ever',
  },
] as const;

export const registerInterventureRoutes = (context: InterventureRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

  /**
   * Every tagged relationship, plus what is waiting.
   *
   * The Green Companies list travels with it because a relationship view without the ventures it
   * could name is a list somebody cannot check for omissions - and the useful question here is
   * usually "should this client have been tagged and was not".
   */
  app.get(
    '/api/console/interventure/relationships',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const [relationships, routing] = await Promise.all([
        allRelationships(tenantId),
        awaitingRouting(tenantId),
      ]);

      send(
        res,
        ok({
          relationships,
          total: relationships.length,
          /** The ventures a client could be tagged as. A closed list, from the module. */
          ventures: GREEN_COMPANIES,
          /**
           * Invoices raised and not yet routed to the Gardner ledger.
           *
           * Reported as a count and a list rather than omitted when empty: an intercompany invoice
           * that never routes is money that never reaches the ledger it belongs in.
           */
          awaitingRouting: routing,
          awaitingRoutingTotal: routing.length,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * One engagement's conflict position.
   *
   * `mayProceed` is asked rather than reconstructed from the disclosure's fields. The gate checks
   * both acknowledgements in a fixed order and says which is missing; a page that inferred the
   * verdict from two timestamps would eventually disagree with the gate, and the disagreement
   * would show as a Console saying work may proceed while the system refuses it.
   */
  app.get(
    '/api/console/interventure/engagements/:engagementId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const engagementId = param(req, 'engagementId');
      const clientId = (req.query as Record<string, unknown>)['clientId'];

      if (typeof clientId !== 'string' || clientId === '') {
        send(
          res,
          refused(
            'clientId is required. A conflict position belongs to an engagement AND the client it is for - asking by engagement alone would answer for whichever client happened to match.',
            'Input validation',
          ),
        );
        return;
      }

      const verdict = await mayProceed(tenantId, clientId, engagementId);

      if (verdict.status !== 'ok') {
        // The refusal IS the content here: it names which acknowledgement is missing, which is
        // what tells an operator whom to chase. Forwarded unchanged.
        send(res, verdict);
        return;
      }

      const disclosure = verdict.value.disclosure;

      send(
        res,
        ok({
          engagementId,
          clientId,
          intercompany: verdict.value.intercompany,
          detail: verdict.value.detail,
          disclosure:
            disclosure === null
              ? null
              : {
                  id: disclosure.id,
                  state: disclosure.state,
                  /**
                   * The body as generated, and its hash.
                   *
                   * The hash is shown because it is checked at acknowledgement: an operator
                   * chasing a signature needs to be able to say which version they are chasing,
                   * and a template change after generation cannot rewrite what was acknowledged.
                   */
                  contentHash: disclosure.contentHash,
                  body: disclosure.body,
                  ventureAcknowledgedAt: disclosure.ventureAcknowledgedAt,
                  gardnerAcknowledgedAt: disclosure.gardnerAcknowledgedAt,
                  complete: disclosure.complete,
                  /**
                   * Who is outstanding, named.
                   *
                   * Derived here for display only - the gate above is what decides. Two nulls on a
                   * page do not tell an operator that two different people need chasing.
                   */
                  outstanding: [
                    ...(disclosure.ventureAcknowledgedAt === null
                      ? ["the venture's own representative"]
                      : []),
                    ...(disclosure.gardnerAcknowledgedAt === null ? ['Gardner'] : []),
                  ],
                },
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * Cross-portfolio handoffs and pricing deviations for one client.
   *
   * Both are per-client facts an operator looks at together: a handoff to Collingswood and a price
   * that departed from the published ladder are the two things about an intercompany client that
   * somebody will be asked to justify.
   */
  app.get(
    '/api/console/interventure/clients/:clientId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const clientId = param(req, 'clientId');
      const [handoffs, deviations] = await Promise.all([
        handoffsFor(tenantId, clientId),
        deviationsFor(tenantId, clientId),
      ]);

      send(
        res,
        ok({
          clientId,
          handoffs,
          handoffsTotal: handoffs.length,
          deviations,
          deviationsTotal: deviations.length,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
