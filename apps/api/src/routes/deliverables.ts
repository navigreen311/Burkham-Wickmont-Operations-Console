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

import {
  COMPLIANCE_STATE_LABELS,
  SHIPPED_TEMPLATES,
  UNVERIFIED_LABEL,
  containsUnverifiedFigures,
  find,
  forClient,
  qaIssues,
  approve,
  deliver,
  draft,
  registerTemplate,
  reject,
} from '@bwc/deliverables';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type DeliverableRouteContext = ConsoleRouteContext;

const AVAILABLE_WRITES = [
  {
    capability: 'Draft a deliverable, or run QA on it',
    action: 'draft_deliverable',
    note: 'Level 1. Preparation - the document is not client-facing until somebody approves it, and 3.4 requires that approval for anything carrying a compliance state or a recommendation.',
  },
  {
    capability: 'Approve, reject or deliver a deliverable',
    action: 'deliver_deliverable',
    note: 'Level 2, where send_client_communication sits. Approval and delivery are one action because approving a client-facing document IS the decision to send it. Only an approved deliverable may be delivered.',
  },
  {
    capability: 'Register a template',
    action: 'register_deliverable_template',
    note: 'Level 3. The wording every future document of its kind is generated from, including ones nobody re-reads - the same argument as publishing a contract clause.',
  },
] as const;

const BLOCKED_WRITES = [] as const;

export const registerDeliverableRoutes = (context: DeliverableRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /** Draft one. Preparation: nothing here is client-facing yet. */
  app.post(
    '/api/console/deliverables',
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : undefined;

      const permitted = await authorised(req, res, {
        action: 'draft_deliverable',
        ...(clientId !== undefined ? { clientId } : {}),
      });
      if (!permitted) return;

      send(
        res,
        await draft({
          ...body,
          tenantId,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Approve it for delivery. 3.4's human review, and the module refuses a non-human actor. */
  app.post(
    '/api/console/deliverables/:deliverableId/approval',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'deliver_deliverable' });
      if (!permitted) return;

      send(
        res,
        await approve(
          tenantId,
          param(req, 'deliverableId'),
          {
            id: permitted.actor.id,
            kind: permitted.actor.kind,
          },
          now(),
        ),
        { trace: permitted.trace },
      );
    }),
  );

  /** Reject it, with the reason the drafter needs to act on. */
  app.post(
    '/api/console/deliverables/:deliverableId/rejection',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'deliver_deliverable' });
      if (!permitted) return;

      const body = req.body as { reason?: unknown };
      send(
        res,
        await reject(
          tenantId,
          param(req, 'deliverableId'),
          String(body.reason ?? ''),
          { id: permitted.actor.id, kind: permitted.actor.kind },
          now(),
        ),
        { trace: permitted.trace },
      );
    }),
  );

  /** Deliver it. Refused unless approved - QA, the scanner and human review come first. */
  app.post(
    '/api/console/deliverables/:deliverableId/delivery',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'deliver_deliverable' });
      if (!permitted) return;

      send(
        res,
        await deliver(
          tenantId,
          param(req, 'deliverableId'),
          {
            id: permitted.actor.id,
            kind: permitted.actor.kind,
          },
          now(),
        ),
        { trace: permitted.trace },
      );
    }),
  );

  /** Register a template. Firm-wide wording, so Level 3. */
  app.post(
    '/api/console/deliverables/templates',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'register_deliverable_template' });
      if (!permitted) return;

      const registered = await registerTemplate(req.body as never);
      send(res, ok(registered), { trace: permitted.trace });
    }),
  );
};
