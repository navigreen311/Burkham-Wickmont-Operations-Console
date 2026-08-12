/**
 * 7.3 Contract & Disclosure Builder, as Console routes.
 *
 * **A generated contract is frozen and hashed, and this surface never regenerates one to show it.**
 * The document a client signed is the document that was hashed at generation; rebuilding it from
 * today's clauses would produce something that looks the same and is not, and the difference would
 * only surface in an argument about what somebody agreed to. So the read returns the stored record
 * and its hash, and generation is a separate act.
 *
 * **The fee exhibit is built FROM the engagement record**, which is 1.4's, not from a figure typed
 * into a contract. The Seek Capital lesson holds both halves: 7.3 cannot state a fee on a limit that
 * was only requested, and 1.4 cannot charge one.
 *
 * **Clauses are versioned and superseded, never edited.** `clauseHistory` is the read that shows it,
 * and it matters because a clause in force in March is what governs a March contract.
 */

import type { Express, Request, Response } from 'express';
import { applicableClauses, buildFeeExhibit, clauseHistory } from '@bwc/contracts';
import { exhibitInputFor } from '@bwc/billing';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface ContractsRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly tenantId: string;
  readonly now: () => Date;
}

const BLOCKED_WRITES = [
  {
    capability: 'Publish a clause, or generate a contract for a client',
    module: '@bwc/contracts publishClause, generateContract',
    missingAction: 'none declared',
    why: 'Both write to the Ledger and so need a declared action, and none exists for contract authoring. Generation in particular is the act that FREEZES a document and its hash - it is not a preview, and a surface that offered it as one would be inviting somebody to produce a signable artefact by clicking to look at it.',
  },
] as const;

export const registerContractRoutes = (context: ContractsRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

  /**
   * The clauses that would apply to a jurisdiction and product today.
   *
   * `state` and `productKind` are required. A clause set assembled without a jurisdiction is not a
   * smaller answer, it is a different question - and 7.2's rule holds here too: "we could not tell
   * which state" and "no state rule applies" are different statements and only one of them is a
   * check.
   */
  app.get(
    '/api/console/contracts/clauses',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const query = req.query as Record<string, unknown>;
      const jurisdiction =
        typeof query['jurisdiction'] === 'string' ? query['jurisdiction'].trim().toUpperCase() : '';
      const offerTier = typeof query['offerTier'] === 'string' ? query['offerTier'] : undefined;

      if (jurisdiction.length !== 2) {
        send(
          res,
          refused(
            'jurisdiction is required and is a two-letter state code. A clause set assembled without one is a different question, not a smaller one - "we could not tell which state" and "no state rule applies" are different statements and only one of them is a check.',
            'Blueprint 7.3 with 7.2 - jurisdiction is never inferred',
          ),
        );
        return;
      }

      const clauses = await applicableClauses({
        tenantId,
        jurisdiction,
        ...(offerTier !== undefined ? { offerTier } : {}),
      });
      send(
        res,
        ok({
          jurisdiction,
          offerTier: offerTier ?? null,
          clauses,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /** Every version of one clause, oldest first. What governs a past contract is a past version. */
  app.get(
    '/api/console/contracts/clauses/:clauseKey/history',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(res, ok(await clauseHistory(tenantId, param(req, 'clauseKey'))));
    }),
  );

  /**
   * The fee exhibit for one ENGAGEMENT, not for a client.
   *
   * Keyed by engagement because that is what the exhibit is about. `exhibitInputFor` reads the
   * offer version **the engagement was started on**, not the current one - a repricing must not
   * change what an existing client's exhibit says they agreed to pay - and a client with two
   * engagements has two exhibits, which a client-keyed route could not express.
   *
   * Two calls rather than one: 1.4 assembles the terms from the engagement, 7.3 renders them. The
   * seam is where the Seek Capital lesson lives - 7.3 cannot state a fee on a limit that was only
   * requested, so an exhibit prepared before an approval reports the success fee as contingent
   * rather than estimating it. Both refusals are forwarded unchanged.
   */
  app.get(
    '/api/console/contracts/engagements/:engagementId/fee-exhibit',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const terms = await exhibitInputFor({ tenantId, engagementId: param(req, 'engagementId') });
      if (terms.status !== 'ok') {
        send(res, terms);
        return;
      }

      send(res, buildFeeExhibit(terms.value));
    }),
  );
};
