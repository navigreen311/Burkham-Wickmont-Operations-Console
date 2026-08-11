/**
 * 3.1 Document & Deliverable Management, as Console routes.
 *
 * **Two things travel with every deliverable, and dropping either is the failure.**
 *
 * A deliverable is VERSIONED, and its approval belongs to the version. `forClient` orders by
 * template then version descending, so the newest of each is first - and a surface that showed only
 * the newest would hide that version 2 is in draft while version 1 is the one the client has. Both
 * are true at once and an operator needs both, so every version is sent with its own status.
 *
 * PROVENANCE travels with the content (principle 8). The module renders unverified figures with a
 * visible label - `UNVERIFIED_LABEL` - and `containsUnverifiedFigures` is its own predicate for
 * whether a document rests on anything unresearched. That predicate is asked here rather than
 * re-derived, so the Console and the PDF renderer cannot disagree about whether a brief is
 * carrying an assumption.
 *
 * The compliance state on a deliverable is a CATEGORY with its finding list, never a number
 * (Decision E). `COMPLIANCE_STATE_LABELS` is the module's own wording and is forwarded rather than
 * restated, because a second copy of a label is a second thing to drift.
 *
 * **Nothing here drafts, approves, rejects or delivers.** Each writes a Ledger event and needs a
 * declared action; `ACTION_MINIMUM_LEVEL` has none. `draft_communication` and
 * `send_client_communication` are near misses and are the wrong labels - a Capital Command Brief is
 * a deliverable rather than a communication, and approval is a governance determination that has no
 * counterpart in the catalogue at all. See ADR-0063.
 */

import type { Express, Request, Response } from 'express';
import {
  COMPLIANCE_STATE_LABELS,
  SHIPPED_TEMPLATES,
  UNVERIFIED_LABEL,
  containsUnverifiedFigures,
  find,
  forClient,
  qaIssues,
} from '@bwc/deliverables';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface DeliverableRouteContext {
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
    capability: 'Draft, QA, approve, reject or deliver a deliverable; register a template',
    module:
      '@bwc/deliverables draft, runQaCheck, runComplianceScan, requestHumanReview, approve, reject, deliver, registerTemplate',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action, and ACTION_MINIMUM_LEVEL declares none for deliverables. draft_communication and send_client_communication are the near misses and are wrong: a Capital Command Brief is a deliverable rather than a communication, and approving one is a governance determination with no counterpart in the catalogue.',
  },
] as const;

export const registerDeliverableRoutes = (context: DeliverableRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

  /**
   * The template library.
   *
   * A compile-time constant, served rather than written into the page: a hard-coded copy in the
   * browser drifts the moment a template ships, and the failure is a Console offering a template
   * the system does not have.
   */
  app.get(
    '/api/console/deliverables/templates',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(
        res,
        ok({
          templates: SHIPPED_TEMPLATES,
          total: SHIPPED_TEMPLATES.length,
          /** The label the renderer puts on an unresearched figure, so the page uses that wording. */
          unverifiedLabel: UNVERIFIED_LABEL,
          complianceStateLabels: COMPLIANCE_STATE_LABELS,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * Every deliverable for a client, every version.
   *
   * Not the newest per template. An operator looking at a client's file needs to see that version 3
   * is awaiting approval while version 2 is what was delivered - and a "latest only" list makes the
   * delivered one disappear the moment somebody starts a draft.
   */
  app.get(
    '/api/console/clients/:clientId/deliverables',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const clientId = param(req, 'clientId');
      const deliverables = await forClient(tenantId, clientId);

      send(
        res,
        ok({
          clientId,
          deliverables: deliverables.map((deliverable) => ({
            id: deliverable.id,
            templateKey: deliverable.templateKey,
            templateVersion: deliverable.templateVersion,
            version: deliverable.version,
            status: deliverable.status,
            contentHash: deliverable.contentHash,
            reviewedBy: deliverable.reviewedBy,
            deliveredAt: deliverable.deliveredAt?.toISOString() ?? null,
            /**
             * Whether this version rests on anything unresearched.
             *
             * The module's own predicate, asked rather than re-derived, so the Console and the PDF
             * renderer cannot disagree about whether a brief carries an assumption.
             */
            carriesUnverifiedFigures: containsUnverifiedFigures(deliverable.content),
            title: deliverable.content.title,
          })),
          total: deliverables.length,
          /** How many are on an unverified figure, so the count is visible without scanning. */
          withUnverifiedFigures: deliverables.filter((deliverable) =>
            containsUnverifiedFigures(deliverable.content),
          ).length,
          delivered: deliverables.filter((deliverable) => deliverable.deliveredAt !== null).length,
          unverifiedLabel: UNVERIFIED_LABEL,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * One deliverable, whole, with its QA issues.
   *
   * `qaIssues` is recomputed on read rather than served from the stored scan. The stored scan says
   * what was true when somebody ran it; this says what is true of the content now, and the two
   * differing is itself worth seeing - it means the document changed after its check.
   */
  app.get(
    '/api/console/deliverables/:deliverableId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const result = await find(tenantId, param(req, 'deliverableId'));
      if (result.status !== 'ok') {
        send(res, result);
        return;
      }

      const deliverable = result.value;
      const issues = qaIssues(deliverable.content);

      send(
        res,
        ok({
          id: deliverable.id,
          clientId: deliverable.clientId,
          templateKey: deliverable.templateKey,
          templateVersion: deliverable.templateVersion,
          version: deliverable.version,
          status: deliverable.status,
          contentHash: deliverable.contentHash,
          reviewedBy: deliverable.reviewedBy,
          deliveredAt: deliverable.deliveredAt?.toISOString() ?? null,
          /** The stored scan, which may predate the current content. */
          scanResult: deliverable.scanResult,
          /** Recomputed now. A difference from the stored scan is the finding. */
          qaIssues: issues,
          qaIssuesTotal: issues.length,
          content: deliverable.content,
          carriesUnverifiedFigures: containsUnverifiedFigures(deliverable.content),
          unverifiedLabel: UNVERIFIED_LABEL,
          complianceStateLabels: COMPLIANCE_STATE_LABELS,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
