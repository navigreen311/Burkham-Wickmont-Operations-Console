/**
 * 7.4 Marketing Claim Library and 4.5 Marketing Ops — the words the firm may use, and the queue of
 * words somebody wants to start using.
 *
 * Two modules on one surface because they are two halves of one act: 4.5 routes a proposed claim to
 * the Compliance Review Board, and 7.4 is what the Board's decision becomes. The Scanner reads only
 * the second (`activeLibrary`), which is why a proposal sitting in the queue changes nothing about
 * what may be sent.
 *
 * ## `banned` is an outcome, not an error
 *
 * The single most important thing this surface must get right. A claim reviewed and dispositioned
 * `banned` is the Board **working**: somebody asked whether the firm may say "guaranteed approval",
 * the Board answered no, and the library now carries a rule the Scanner enforces on every outbound
 * message. That entry is more valuable than an `approved` one, because it is the one that stops
 * something.
 *
 * So `banned` is counted beside `approved` and `requires_disclaimer` as a peer disposition, it is
 * never rendered as a failure or a warning state, and the response says so in a field rather than
 * leaving it to the page's styling. A library shown as "3 approved, 12 problems" would describe the
 * Board's best work as a defect.
 *
 * ## Every write here is reported, not built
 *
 * `publish`, `deprecate`, `proposeClaim`, `approveProposal`, `rejectProposal`, `createCampaign`,
 * `activateCampaign`, `createAsset`, `submitAssetForReview`, `approveAsset` and the experiment
 * writes all lack an action in `ACTION_MINIMUM_LEVEL`. 4.5's proposal decisions do carry a
 * module-level Level 3 check (`REVIEW_AUTHORITY_LEVEL`), but unlike ADR-0009 they do not require a
 * human, so there is no stronger-gate argument to make for them. ADR-0047 lists what core needs.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import { ALL_JURISDICTIONS, activeLibrary, type ClaimDisposition } from '@bwc/claims';
import { REVIEW_AUTHORITY_LEVEL, assetsFor, pendingProposals } from '@bwc/marketing';
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

/** The closed set, served rather than written into the page (ADR-0035). */
const DISPOSITIONS: readonly ClaimDisposition[] = ['approved', 'banned', 'requires_disclaimer'];

export const registerMarketingRoutes = (context: ConsoleRouteContext): void => {
  const { app, tenantId, requireStaff, asyncRoute } = context;

  /**
   * The library the Scanner reads.
   *
   * A jurisdiction narrows it to global entries plus that state's, because a state ban **adds** to
   * the national list rather than replacing it — so the filtered view is a superset question, not a
   * subset one, and the response says which entries are global so a reader is not left to infer it
   * from a sentinel.
   */
  app.get(
    '/api/console/marketing/claims',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const jurisdiction =
        typeof query['jurisdiction'] === 'string' && query['jurisdiction'].trim() !== ''
          ? query['jurisdiction'].trim().toUpperCase()
          : undefined;

      const claims = await activeLibrary({
        tenantId,
        ...(jurisdiction !== undefined ? { jurisdiction } : {}),
      });

      // Every disposition seeded to zero, so a disposition with no entries appears as `0` rather
      // than as an absent key the page would render as nothing at all.
      const byDisposition: Record<string, number> = {
        approved: 0,
        banned: 0,
        requires_disclaimer: 0,
      };
      for (const claim of claims) {
        byDisposition[claim.disposition] = (byDisposition[claim.disposition] ?? 0) + 1;
      }

      send(
        res,
        ok({
          claims: claims.map((claim) => ({
            id: claim.id,
            phrase: claim.phrase,
            disposition: claim.disposition,
            rationale: claim.rationale,
            jurisdiction: claim.jurisdiction,
            global: claim.jurisdiction === ALL_JURISDICTIONS,
            requiredDisclosure: claim.requiredDisclosure,
            approvedBy: claim.approvedBy,
            version: claim.version,
          })),
          total: claims.length,
          byDisposition,
          dispositions: DISPOSITIONS,
          jurisdiction: jurisdiction ?? null,
          /**
           * Stated in the response, not left to the page's styling.
           *
           * A `banned` entry is the Board having answered a question, and it is the entry that
           * stops something being sent. Rendering it as a problem would describe 7.4's best work as
           * a defect.
           */
          bannedIsAnOutcome: true,
          bannedNote:
            'A banned entry is the Compliance Review Board working, not a fault. It is the rule the Scanner enforces on every outbound message, and it is worth more than an approved one because it is the one that stops something.',
        }),
      );
    }),
  );

  /**
   * Claims somebody wants to start using, awaiting the Board.
   *
   * `intendedUse` travels with every row and is the point of the queue: "we help businesses get
   * funded" is fine on a landing page and a problem in a cold email to a client mid-application,
   * and the Board cannot tell which is being asked without being told.
   */
  app.get(
    '/api/console/marketing/proposals',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const proposals = await pendingProposals(tenantId);

      send(
        res,
        ok({
          proposals: proposals.map((proposal) => ({
            id: proposal.id,
            phrase: proposal.phrase,
            intendedUse: proposal.intendedUse,
            jurisdiction: proposal.jurisdiction,
            status: proposal.status,
            submittedAt: proposal.submittedAt,
          })),
          total: proposals.length,
          reviewAuthorityLevel: REVIEW_AUTHORITY_LEVEL,
          decisionAvailableHere: false,
          decisionUnavailableReason:
            'Approving or rejecting a proposal needs an action in ACTION_MINIMUM_LEVEL, and decideAuthority refuses an action absent from the catalogue. 4.5 checks Level 3 on the recorded actor but does not require a human, so there is no stronger-gate argument for bypassing the chain the way 7.2 activation does. See ADR-0047.',
          requiredActions: ['approve_marketing_claim', 'reject_marketing_claim'],
          /**
           * Written here so the page cannot present the Board's options as approve-or-fail.
           *
           * Approving a proposal AS BANNED is a decision, and it is the one that produces the most
           * useful library entry. A queue that offered "approve" and "reject" alone would lose it.
           */
          outcomesNote:
            'A proposal has three outcomes, not two: approved, approved as banned, or rejected. Approving as banned records that the firm asked and the Board said no, which is what the Scanner then enforces. Rejecting records only that the Board declined to rule.',
        }),
      );
    }),
  );

  /**
   * Marketing assets and where each sits in the review pipeline.
   *
   * `rejectionReason` travels with a rejected asset. An asset in `rejected` with no reason is a
   * decision nobody can act on, and the author is the person who has to.
   */
  app.get(
    '/api/console/marketing/assets',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const state =
        typeof query['state'] === 'string' && query['state'] !== '' ? query['state'] : undefined;

      const assets = await assetsFor(
        tenantId,
        state === undefined ? {} : { state: state as never },
      );

      const byState: Record<string, number> = {
        draft: 0,
        in_review: 0,
        approved: 0,
        rejected: 0,
        retired: 0,
      };
      for (const asset of assets) byState[asset.state] = (byState[asset.state] ?? 0) + 1;

      send(
        res,
        ok({
          assets: assets.map((asset) => ({
            id: asset.id,
            key: asset.key,
            kind: asset.kind,
            state: asset.state,
            body: asset.body,
            rejectionReason: asset.rejectionReason,
          })),
          total: assets.length,
          byState,
          filteredTo: state ?? null,
        }),
      );
    }),
  );
};
