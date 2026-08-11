/**
 * 3.3 Document Intelligence Pipeline, as Console routes.
 *
 * **The one way to get this wrong is to render an extraction as a fact.**
 *
 * Every derived fact in `@bwc/intelligence` is `Sourced<T>` - a value with its provenance - and the
 * module's header says why: blueprint 3.3 asks for "provenance preservation on every enriched fact
 * (Plaid feed timestamp, bureau pull timestamp, OCR confidence for PDF fallback)". A finding's
 * `detail` cannot be constructed without saying where it came from.
 *
 * A transport strips that in one line. `detail.value` is the readable half, and forwarding only
 * the readable half turns "Plaid says revenue averaged X, over 3 of the 24 months we asked for"
 * into "revenue averaged X". So **`detail` travels whole, provenance included**, and the route adds
 * the confidence the pipeline actually has rather than a confidence it would like to project.
 *
 * That confidence is two things and neither is a percentage the module invented:
 *
 *   COVERAGE   how much of the requested window the feed actually spans. A reconciliation over
 *              3 of 24 months is a different statement from one over 24, and `hasSufficientCoverage`
 *              is the module's own line between them.
 *   PROVENANCE the tag. `vendor_feed` carries a retrieval timestamp; `unresearched_default` and
 *              `client_stated` are labelled unverified by `@bwc/core`'s own predicate.
 *
 * **Nothing here ingests.** `ingest` and `recordFindings` write Ledger events and have no declared
 * action; `analyze_file` exists at Level 0 and would be the wrong label - it authorises reading a
 * file, not creating risk findings about a client. See ADR-0063.
 */

import type { Express, Request, Response } from 'express';
import {
  MINIMUM_COVERAGE,
  PHASE_REQUIREMENTS,
  assessCoverage,
  findingsFor,
  runsFor,
} from '@bwc/intelligence';
import { isUnverified, ok, refused, type Provenance } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface IntelligenceRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly tenantId: string;
}

const BLOCKED_WRITES = [
  {
    capability: 'Ingest a feed, record a normalized feed, or record findings',
    module: '@bwc/intelligence ingest, recordNormalizedFeed, recordFindings',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action, and ACTION_MINIMUM_LEVEL declares none for the pipeline. analyze_file exists at Level 0 and is the wrong label: it authorises reading a file, not creating risk findings about a client, and an ingestion also requires a per-pull consent the action name would not carry.',
  },
] as const;

/** A finding's `detail` as the module stores it: a value with the provenance it came from. */
interface SourcedDetail {
  readonly value?: unknown;
  readonly provenance?: Provenance;
}

const detailOf = (detail: unknown): SourcedDetail =>
  typeof detail === 'object' && detail !== null ? (detail as SourcedDetail) : {};

/**
 * How much the pipeline actually stands behind one finding.
 *
 * Derived from the provenance the module attached, never invented. `verified` is false for an
 * assumption or a client statement - `@bwc/core`'s own `isUnverified` decides, so the Console and
 * the deliverables renderer agree about what "unverified" means rather than each having a view.
 */
const confidenceOf = (
  provenance: Provenance | undefined,
): { verified: boolean; basis: string; retrievedAt: string | null } => {
  if (provenance === undefined) {
    return {
      verified: false,
      basis: 'No provenance is recorded on this finding, which is itself the finding to act on.',
      retrievedAt: null,
    };
  }
  return {
    verified: !isUnverified(provenance),
    basis: provenance.tag,
    retrievedAt: provenance.tag === 'vendor_feed' ? provenance.retrievedAt : null,
  };
};

export const registerIntelligenceRoutes = (context: IntelligenceRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

  /**
   * What the pipeline knows about one client, and how well it knows it.
   *
   * Findings, ingestion runs and document coverage in one answer, because the three are only
   * meaningful together: a finding with no run behind it, or a run over a feed that covered two
   * months, are both cases where the finding is weaker than its sentence sounds.
   */
  app.get(
    '/api/console/clients/:clientId/intelligence',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const clientId = param(req, 'clientId');
      const query = req.query as Record<string, unknown>;

      /**
       * The phase is required, and absent is not zero.
       *
       * An earlier draft defaulted a missing `phase` to 0, which answers a different question from
       * the one asked and looks identical in the reply. Phase 0 has its own document requirements;
       * a caller who omitted the phase gets those and reads them as "the requirements", which is
       * the silent-wrong-answer shape this whole surface is built against.
       */
      const phaseRaw = query['phase'];
      const phase = typeof phaseRaw === 'string' ? Number.parseInt(phaseRaw, 10) : Number.NaN;
      if (!Number.isInteger(phase) || PHASE_REQUIREMENTS[phase] === undefined) {
        send(
          res,
          refused(
            `phase must be one of: ${Object.keys(PHASE_REQUIREMENTS).join(', ')}. Which documents are required depends on the phase, so coverage cannot be assessed without one.`,
            'Blueprint 3.3 - missing document detection is per phase',
          ),
        );
        return;
      }

      const [findings, runs, coverage] = await Promise.all([
        findingsFor(tenantId, clientId),
        runsFor(tenantId, clientId),
        assessCoverage(tenantId, clientId, phase),
      ]);

      send(
        res,
        ok({
          clientId,

          /**
           * Findings, each with its provenance and the confidence that provenance supports.
           *
           * `detail` is forwarded WHOLE. Sending only `detail.value` would turn a sourced
           * observation into a bare assertion, which is the one thing this module is built to stop.
           */
          findings: findings.map((finding) => {
            const detail = detailOf(finding.detail);
            return {
              kind: finding.kind,
              severity: finding.severity,
              summary: finding.summary,
              detail,
              confidence: confidenceOf(detail.provenance),
              occurredAt: finding.occurredAt?.toISOString() ?? null,
            };
          }),
          findingsTotal: findings.length,
          /** Findings resting on an assumption or a client statement rather than a feed. */
          findingsUnverified: findings.filter(
            (finding) => !confidenceOf(detailOf(finding.detail).provenance).verified,
          ).length,

          /**
           * Ingestion runs, newest first.
           *
           * Carried even when every one is `unavailable`: a client with no ingested feed and a
           * client whose every ingestion was refused for want of a vendor look identical in a
           * findings list, and only the runs distinguish them.
           */
          runs,
          runsTotal: runs.length,

          /**
           * Document coverage for the phase asked about.
           *
           * `minimumCoverage` travels so the page states the line it is applying rather than
           * rendering a ratio the reader has to judge unaided.
           */
          coverage,
          minimumCoverage: MINIMUM_COVERAGE,

          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
