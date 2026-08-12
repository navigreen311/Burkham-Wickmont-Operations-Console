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

import {
  accessLog,
  forClient,
  releaseLegalHold,
  remove,
  setLegalHold,
  setRetention,
} from '@bwc/vault';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type VaultRouteContext = ConsoleRouteContext;

/**
 * The document-level half of a hold, and the one act that destroys evidence.
 *
 * 7.5 owns the matter; this owns the document. Both use `place_legal_hold` and
 * `release_legal_hold`, because they are the same decision applied at two grains - a matter-wide
 * hold and a hold on one file are not different authorities, and giving them different actions
 * would let somebody hold at one grain who may not hold at the other.
 */
const AVAILABLE_WRITES = [
  {
    capability: 'Place or release a legal hold on one document',
    action: 'place_legal_hold / release_legal_hold',
    note: 'The same actions 7.5 uses for a matter-wide hold. Releasing is the half that lets a document be destroyed on schedule again.',
  },
  {
    capability: 'Set a retention schedule',
    action: 'set_document_retention',
    note: 'A schedule decides when documents are destroyed without anybody deciding again, so this is one decision executed for years.',
  },
  {
    capability: 'Remove a document',
    action: 'remove_vault_document',
    note: 'IRREVERSIBLE, and it removes evidence: the artifact set here is what the firm would produce if asked to show its work. Refused while a legal hold is in force.',
  },
] as const;

const BLOCKED_WRITES = [
  {
    capability: 'Download a document',
    module: '@bwc/vault read',
    missingAction: 'deliberately absent',
    why: "Not missing - refused. Document bytes reach a client through the Client Portal, which is a separate process on a separate trust boundary (ADR-0022). A second download path in the internal API would be a second set of rules about watermarking, legal hold and virus scanning to keep in step with 3.2's, and the one that drifts is the one nobody is looking at.",
  },
] as const;

export const registerVaultRoutes = (context: VaultRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

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
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
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

  // --- Writes -------------------------------------------------------------

  /** Place a hold on one document. Same action as a matter-wide hold, applied at file grain. */
  app.post(
    '/api/console/vault/documents/:documentId/legal-hold',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'place_legal_hold' });
      if (!permitted) return;

      const body = req.body as { reason?: unknown };
      send(
        res,
        await setLegalHold(
          tenantId,
          param(req, 'documentId'),
          String(body.reason ?? ''),
          permitted.actor.id,
          now(),
        ),
        { trace: permitted.trace },
      );
    }),
  );

  /** Release it. The half that puts the document back on a schedule that destroys it. */
  app.post(
    '/api/console/vault/documents/:documentId/legal-hold/release',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'release_legal_hold' });
      if (!permitted) return;

      send(res, await releaseLegalHold(tenantId, param(req, 'documentId'), permitted.actor.id), {
        trace: permitted.trace,
      });
    }),
  );

  /** Set the date after which this document may be destroyed. */
  app.post(
    '/api/console/vault/documents/:documentId/retention',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'set_document_retention' });
      if (!permitted) return;

      const body = req.body as { retainUntil?: unknown };
      const retainUntil =
        typeof body.retainUntil === 'string' ? new Date(body.retainUntil) : new Date(NaN);
      if (Number.isNaN(retainUntil.getTime())) {
        send(res, refused('retainUntil must be a date.', 'Input validation'));
        return;
      }

      send(res, await setRetention(tenantId, param(req, 'documentId'), retainUntil), {
        trace: permitted.trace,
      });
    }),
  );

  /**
   * Remove a document.
   *
   * The irreversible one on this surface, and the module refuses while a legal hold is in force -
   * which is the check that matters, because the reason to destroy a document and the reason
   * somebody placed a hold on it are usually the same reason.
   */
  app.post(
    '/api/console/vault/documents/:documentId/removal',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'remove_vault_document' });
      if (!permitted) return;

      send(
        res,
        await remove({
          tenantId,
          documentId: param(req, 'documentId'),
          actorId: permitted.actor.id,
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );
};
