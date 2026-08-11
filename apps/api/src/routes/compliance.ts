/**
 * 7.1 Compliance Evidence Vault — the regulator-ready file, and who has taken a copy of it.
 *
 * ## The one thing this surface must not do
 *
 * An evidence file is a copy of a client's whole compliance history, and **its coverage map is part
 * of the evidence**. Four verdicts, and two of them produce zero rows for completely different
 * reasons:
 *
 *   `complete`   consulted; returned everything it holds
 *   `empty`      consulted; holds nothing for this client
 *   `not_built`  the module does not exist yet
 *   `failed`     consulted and errored
 *
 * "This client has no complaints" and "we have no complaints module" are different claims, and a
 * regulator reading the first when the second is true has been misled by an omission nobody
 * intended. So this route never collapses the four into a count, never reports a section as absent,
 * and never lets `itemCount: 0` stand on its own — every section carries its verdict and the note
 * that produced it, and the response separates the two zeroes into distinct totals so the page
 * cannot flatten them by accident either.
 *
 * ## What travels, and what does not
 *
 * The **coverage map travels; the evidence itself does not.** `assembleEvidenceFile` returns every
 * section's items — bank statement metadata, compliance transitions, communications, contracts —
 * and putting that on a page would ship a client's entire file into a browser to render a table of
 * contents. The page needs to know what is in the file and what is missing from it; it does not
 * need the file. Same reasoning as ADR-0038 for the Vault, arriving at a different module.
 *
 * ## The export is a write, and it is not here
 *
 * `exportEvidenceFile` records who took a copy and why. It has no action in `ACTION_MINIMUM_LEVEL`,
 * so it cannot pass middleware step 3, and unlike 7.2's activation the module has no gate of its
 * own to stand in for the chain — it checks that a purpose and a requester were supplied and
 * nothing about who is asking. Shipping it would be shipping an unauthorised write. Reported in
 * ADR-0047 instead.
 *
 * What is here is the read that answers "who has seen this": `exportHistory`, and the
 * reconciliation that says whether a copy somebody is holding is still the current picture.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import {
  assembleEvidenceFile,
  exportHistory,
  hashEvidenceFile,
  reconcileExport,
} from '@bwc/evidence';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

/** See the note in `routes/regulatory.ts`: four copies, one per owned file, no fifth to share. */
export interface ConsoleRouteContext {
  readonly app: Express;
  readonly tenantId: string;
  readonly now: () => Date;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly jsonBody: RequestHandler;
}

export const registerComplianceRoutes = (context: ConsoleRouteContext): void => {
  const { app, tenantId, now, requireStaff, asyncRoute, param } = context;

  /**
   * The file, as coverage rather than as contents.
   *
   * The hash is computed and returned because it is what a held copy is compared against, and it
   * deliberately excludes `assembledAt` and `ledgerIntegrity` — see `hashEvidenceFile`. Returning
   * it here means an operator can read the current hash off the page and compare it to the one on
   * an export record without assembling anything twice.
   */
  app.get(
    '/api/console/evidence/clients/:clientId/file',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const clientId = param(req, 'clientId');
      const query = req.query as Record<string, unknown>;
      const engagementId =
        typeof query['engagementId'] === 'string' && query['engagementId'] !== ''
          ? query['engagementId']
          : undefined;

      const file = await assembleEvidenceFile({
        tenantId,
        clientId,
        ...(engagementId !== undefined ? { engagementId } : {}),
        now: now(),
      });
      if (file.status !== 'ok') {
        send(res, file);
        return;
      }

      const value = file.value;

      /**
       * **The four verdicts, counted separately.**
       *
       * A single "sections with no rows" figure would merge `empty` and `not_built`, which is the
       * exact flattening this module exists to prevent. They are different facts about the firm and
       * they are cleared by different work: one is a client who has no complaints, the other is a
       * complaints module nobody has built.
       */
      const byCoverage: Record<string, number> = {
        complete: 0,
        empty: 0,
        not_built: 0,
        failed: 0,
      };
      for (const entry of value.coverage) {
        byCoverage[entry.coverage] = (byCoverage[entry.coverage] ?? 0) + 1;
      }

      const counts = new Map(value.sections.map((section) => [section.key, section.items.length]));

      send(
        res,
        ok({
          scope: value.scope,
          clientId: value.clientId,
          engagementId: value.engagementId,
          clientLegalName: value.clientLegalName,
          complianceState: value.complianceState,
          assembledAt: value.assembledAt,
          contentHash: hashEvidenceFile(value),
          /**
           * Every source, with its verdict and the note that produced it.
           *
           * `itemCount` never travels without `coverage` beside it, and the page renders the word
           * rather than the number alone — a `0` with no verdict is the misleading half of this
           * whole document.
           */
          coverage: value.coverage.map((entry) => ({
            key: entry.key,
            module: entry.module,
            description: entry.description,
            coverage: entry.coverage,
            note: entry.note,
            itemCount: counts.get(entry.key) ?? entry.itemCount,
          })),
          coverageTotal: value.coverage.length,
          byCoverage,
          /** Restated so a reader does not have to scan the map for the sections that cannot contribute. */
          gaps: value.gaps,
          gapsTotal: value.gaps.length,
          ledgerIntegrity: {
            intact: value.ledgerIntegrity.intact,
            checked: value.ledgerIntegrity.checked,
            detail: value.ledgerIntegrity.detail,
          },
          /**
           * The section items are NOT here, and this says so rather than leaving a reader to infer
           * it from their absence.
           */
          sectionsCarried: false,
          sectionsNote:
            'The coverage map travels; the evidence does not. Assembling the file puts a client’s whole compliance history in one object, and this page needs to know what is in it and what is missing, not to render it.',
        }),
      );
    }),
  );

  /** Who has taken a copy of this client's file, and why. Newest first. */
  app.get(
    '/api/console/evidence/clients/:clientId/exports',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const records = await exportHistory(tenantId, param(req, 'clientId'));

      send(
        res,
        ok({
          exports: records.map((record) => ({
            id: record.id,
            scope: record.scope,
            engagementId: record.engagementId,
            purpose: record.purpose,
            requestedBy: record.requestedBy,
            contentHash: record.contentHash,
            exportedAt: record.exportedAt,
          })),
          total: records.length,
          /**
           * Named rather than implied by an absent button.
           *
           * `exportEvidenceFile` exists and is tested; it has no action in the catalogue and no
           * gate of its own, so this Console cannot authorise it. A page with no export control and
           * no explanation reads as one somebody had not finished.
           */
          exportAvailableHere: false,
          exportUnavailableReason:
            'Recording an export needs an action in ACTION_MINIMUM_LEVEL, and decideAuthority refuses an action absent from the catalogue. Unlike state activation, exportEvidenceFile has no authority gate of its own to stand in for the chain, so offering it here would be an unauthorised write. See ADR-0047.',
          requiredAction: 'export_evidence_file',
        }),
      );
    }),
  );

  /**
   * Whether a copy somebody is holding is still the current picture.
   *
   * **A mismatch is expected and is not an error.** The file is assembled live, so any new
   * document, deliverable or state transition changes it. What the comparison establishes is
   * whether the holder of that copy has the current picture — the question asked when a stale copy
   * turns up in a dispute — so the route reports it as a fact with both hashes rather than as a
   * pass or a failure.
   */
  app.get(
    '/api/console/evidence/exports/:exportId/reconciliation',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const reconciled = await reconcileExport(tenantId, param(req, 'exportId'), now());
      if (reconciled.status !== 'ok') {
        send(res, reconciled);
        return;
      }

      send(
        res,
        ok({
          matches: reconciled.value.matches,
          exportedHash: reconciled.value.exportedHash,
          currentHash: reconciled.value.currentHash,
          detail: reconciled.value.detail,
          // Said in the response rather than only in the page copy, so an operator reading the
          // route directly meets it too.
          isError: false,
        }),
      );
    }),
  );
};
