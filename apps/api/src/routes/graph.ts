/**
 * 1.2 Client Household / Entity Graph, as a Console route.
 *
 * **This surface reveals nothing, and it is built so that it could not.**
 *
 * `@bwc/graph` keeps SSN and EIN envelope-encrypted and hands out a display last-4 and nothing
 * else. Its own header states the mechanism plainly: the traversals, findings and rationales are
 * safe from leaking an identifier "not because each of those remembered to strip it, but because
 * they were never given it". `revealSsn` and `revealEin` are the only readers of the plaintext,
 * each takes a stated purpose, each refuses without one, and each writes an access event.
 *
 * **The Console does not call them, and this is a STOP rather than a decision.**
 *
 * A reveal is an act. It discloses a government identifier and writes `graph.ssn.revealed` to an
 * append-only store, so it must go through `chain()` with a declared action - and
 * `ACTION_MINIMUM_LEVEL` has no action that means "disclose a government identifier". The nearest
 * candidates are `read_document` and `analyze_file`, both Level 0, and using either would be worse
 * than not building the button: the Ledger would then record `authority.action_authorised` with
 * `action: 'read_document'` against an SSN disclosure, which is a false audit record about the most
 * sensitive act on this surface. A wrong label on a true event is harder to catch than a missing
 * feature, because it looks like evidence.
 *
 * Declaring the action means editing `packages/core`, which this branch does not own. So the route
 * is absent, the gap is reported in `writes.blocked` where the page must render it, and the
 * decision is somebody else's to make deliberately. See ADR-0051.
 *
 * **No identifier is ever a path segment.** A client id is; that is a UUID and already how the rest
 * of the Console addresses a file. An owner's SSN, EIN or last-4 is not, will not be, and could not
 * usefully be - the graph is addressed by client, and everything below it travels in the body of
 * the response. A value in a URL reaches access logs, browser history and `Referer`, and the last-4
 * of an SSN in a proxy log is a disclosure nobody chose.
 */

import type { Express, Request, Response } from 'express';
import { CAPITAL_NEEDS, type CapitalNeed } from '@bwc/lenders';
import {
  deriveProfile,
  detectRelationships,
  graphRisk,
  guaranteeExposure,
  guarantorConcentration,
  isolatedEntities,
  loadGraph,
  primaryEntity,
  unavailableFields,
} from '@bwc/graph';
import { ok, refused, toIso, type Provenance } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface GraphRouteContext {
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
 * Exposure arithmetic runs over amounts recorded on debt edges, which somebody entered.
 *
 * Tagged as such rather than left untagged: `guaranteeExposure` requires a provenance and would
 * otherwise get whatever the caller found convenient, which is how an entered figure ends up
 * rendering beside a Plaid-derived one with no way to tell them apart.
 */
const recordedByStaff = (at: Date): Provenance => ({
  tag: 'client_stated',
  statedBy: 'Recorded on the entity graph',
  statedAt: toIso(at),
});

/**
 * The writes this surface cannot offer, and precisely why.
 *
 * Carried in the payload rather than left to a code comment, because the operator looking at an
 * entity graph with no "add entity" button is owed the reason on the screen. Each entry names the
 * function that exists and the action that does not.
 *
 * This is a STOP report, not a to-do list: declaring these actions is a judgement about Authority
 * Levels that belongs with the people who wrote the other fifteen, and every one of them carries a
 * paragraph of reasoning in `packages/core/src/authority.ts`.
 */
const BLOCKED_WRITES = [
  {
    capability: 'Record an entity, owner or relationship',
    module:
      '@bwc/graph upsertEntity, upsertOwner, addEdge, endEdge, recordStatedRevenue, setPrimaryEntity',
    missingAction: 'none declared',
    why: "Each writes a Ledger event and so must pass the middleware chain with a declared action. ACTION_MINIMUM_LEVEL has no action for recording a structural fact about a client's household. Choosing one is a judgement about Authority Levels and belongs in packages/core, which this branch does not own.",
  },
  {
    capability: 'Reveal an SSN or EIN',
    module: '@bwc/graph revealSsn, revealEin',
    missingAction: 'none declared',
    why: 'A reveal discloses a government identifier and writes graph.ssn.revealed, so it must pass the middleware chain with a declared action, and ACTION_MINIMUM_LEVEL declares none. The nearest candidates are read_document and analyze_file, both Level 0; labelling an SSN disclosure as either would put a false audit record in an append-only store, which is worse than the button not existing. The module already refuses without a stated purpose - what is missing is the Authority Level, not the reason.',
  },
] as const;

const isCapitalNeed = (value: unknown): value is CapitalNeed =>
  typeof value === 'string' && (CAPITAL_NEEDS as readonly string[]).includes(value);

export const registerGraphRoutes = (context: GraphRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId, now } = context;

  /**
   * The graph for one client: nodes, edges, exposure, detections and the risk band.
   *
   * Assembled in one answer because every part of it is read from the same `Graph` value, and four
   * routes would mean four loads and four chances to render a risk band computed over a different
   * graph from the one displayed beside it.
   *
   * `graphRisk` is a BAND, not a number, and it arrives as one. Nothing here averages its
   * components or reduces them to a score - the module returns `low`/`elevated`/`high` with the
   * components that produced it, and the transport's only job is to not flatten that.
   */
  app.get(
    '/api/console/clients/:clientId/graph',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const clientId = param(req, 'clientId');
      const graph = await loadGraph(tenantId, clientId);

      const provenance = recordedByStaff(at);
      const exposures = guaranteeExposure(graph, provenance);
      const findings = detectRelationships(graph);
      const risk = graphRisk(graph, exposures, findings);
      const primary = primaryEntity(graph);

      send(
        res,
        ok({
          clientId,
          /**
           * Empty is reported as empty and named, not as an absence.
           *
           * A client with no recorded graph and a client whose graph is genuinely one entity look
           * identical in a node count. The note says which this is, and - since nothing on this
           * surface can record one - what that means today.
           */
          isEmpty: graph.entities.length === 0 && graph.owners.length === 0,
          emptyNote:
            graph.entities.length === 0 && graph.owners.length === 0
              ? 'No entity or owner is recorded for this client. That is what the store says, not a finding about the client - and nothing on this Console can record one yet (see writes.blocked below).'
              : null,
          entities: graph.entities,
          /** Last-4 only. The module never hands the plaintext to a caller that did not ask. */
          owners: graph.owners,
          edges: graph.edges,
          primaryEntityId: primary?.id ?? null,
          exposures,
          guarantorConcentration: guarantorConcentration(exposures),
          findings,
          isolatedEntityIds: isolatedEntities(graph),
          risk,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * The underwriting profile the graph can derive - blueprint 1.2 feeding 5.3.
   *
   * `no_data` when no primary operating entity is designated, forwarded unchanged: the module
   * refuses to produce a profile of nulls, because a profile of nulls is evaluated against every
   * underwriting box and produces a page of "unknown" verdicts that read as a data-gathering
   * problem when the real problem is that nobody said which company is the borrower.
   *
   * `unavailableFields` travels beside it so the operator sees what is missing and what is
   * blocking each one, rather than inferring absence from a blank.
   */
  app.get(
    '/api/console/clients/:clientId/graph/profile',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const clientId = param(req, 'clientId');
      const query = req.query as Record<string, unknown>;

      const need = query['need'];
      if (!isCapitalNeed(need)) {
        send(
          res,
          refused(
            `need must be one of: ${CAPITAL_NEEDS.join(', ')}. A profile is derived against a stated capital need, because which fields matter depends on what is being asked for.`,
            'Input validation',
          ),
        );
        return;
      }

      const requestedRaw = query['requestedAmount'];
      const requestedAmount =
        typeof requestedRaw === 'string' ? Number.parseFloat(requestedRaw) : Number.NaN;
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        send(res, refused('requestedAmount must be a number above zero.', 'Input validation'));
        return;
      }

      const graph = await loadGraph(tenantId, clientId);
      const derived = deriveProfile({ graph, need, requestedAmount, today: at });

      if (derived.status !== 'ok') {
        send(res, derived);
        return;
      }

      send(
        res,
        ok({
          clientId,
          profile: derived.value,
          unavailableFields: unavailableFields(derived.value),
        }),
      );
    }),
  );
};
