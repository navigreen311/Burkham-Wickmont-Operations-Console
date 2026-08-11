/**
 * 3.2 Secure Document Vault, as Console routes.
 *
 * **No document bytes cross this surface, and that is the whole design.** `read` decrypts and can
 * watermark; it is reached through the Client Portal, which is a different process on a different
 * trust boundary (ADR-0022). What is here is the metadata and the access log - what exists, what
 * has been scanned, what is on legal hold, and who looked at it.
 *
 * That is not a smaller version of the vault. It is the half a staff console actually needs: an
 * operator asking "has their bank statement arrived and has it been scanned" is asking about the
 * record, and an operator who could pull the file down through the internal API would be a second
 * download path with its own rules to keep in step with 3.2's.
 *
 * **The access log is evidence, and its order is part of the evidence.** One request writes several
 * entries - a refusal, then a retry, then a read - and they share a millisecond routinely.
 * "Refused, then admitted" and "admitted, then refused" are different findings, which is why the
 * module orders by `seq` (ADR-0040) and why this route forwards that order untouched.
 */

import type { Express, Request, Response } from 'express';
import { accessLog, forClient } from '@bwc/vault';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface VaultRouteContext {
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
    capability: 'Place or release a legal hold, set retention, remove a document',
    module: '@bwc/vault setLegalHold, releaseLegalHold, setRetention, remove',
    missingAction: 'none declared',
    why: "Each writes to the Ledger and needs a declared action, and none exists. 7.5 Legal Hold & Record Retention now owns the surrounding process - a hold is a matter rather than a flag on one document - so the action names belong with that module's own surface rather than being invented here.",
  },
  {
    capability: 'Download a document',
    module: '@bwc/vault read',
    missingAction: 'deliberately absent',
    why: "Not missing - refused. Document bytes reach a client through the Client Portal, which is a separate process on a separate trust boundary (ADR-0022). A second download path in the internal API would be a second set of rules about watermarking, legal hold and virus scanning to keep in step with 3.2's, and the one that drifts is the one nobody is looking at.",
  },
] as const;

export const registerVaultRoutes = (context: VaultRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

  /**
   * What is on a client's file.
   *
   * An empty list is a real answer and is returned as one: a client who has uploaded nothing and a
   * client whose documents failed to store look identical from a count, so the module's own record
   * is what this forwards rather than a summary computed here.
   */
  app.get(
    '/api/console/vault/clients/:clientId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const documents = await forClient(tenantId, param(req, 'clientId'));

      send(
        res,
        ok({
          documents,
          /**
           * Counted here rather than left to the page, because the two states a reader confuses
           * are "nothing uploaded" and "uploaded but unscanned" - and an unscanned document is
           * unreadable by design until 3.2 clears it.
           */
          summary: {
            total: documents.length,
            onLegalHold: documents.filter((document) => document.legalHold).length,
          },
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /** Who looked at one document, in the order it happened. Evidence, not a feed. */
  app.get(
    '/api/console/vault/documents/:documentId/access-log',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const entries = await accessLog(tenantId, param(req, 'documentId'));

      send(
        res,
        ok({
          entries,
          /**
           * Refusals are counted separately and shown. A log read as "twelve accesses" hides that
           * four of them were refused, and a refused access is the more interesting row.
           */
          refused: entries.filter((entry) => !entry.granted).length,
        }),
      );
    }),
  );
};
