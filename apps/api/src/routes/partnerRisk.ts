/**
 * 8.4 Partner Risk, as Console routes.
 *
 * **The module refuses to produce a score, and this surface must refuse just as hard.**
 *
 * 8.4 asks for one. `@bwc/partners/risk` explains at length why it does not produce one: the
 * dimensions are two different kinds of thing wearing one name. Claim compliance and unauthorized
 * promises are CONDUCT - a partner either promised a client an approval or they did not. Conversion
 * and complaint rates are PERFORMANCE - numeric, and meaningless below a sample. Combining them
 * produces a figure in which **revenue contribution offsets an unauthorized promise**, which is the
 * trade design principle 1 forbids, made invisibly.
 *
 * A transport undoes that in one line. Any of these would:
 *
 *   averaging the measures into a headline number      - the arithmetic nobody may perform
 *   deriving a percentage from the standing            - the same thing wearing a different name
 *   sorting the review queue by anything numeric       - an ordering IS a ranking, and a ranking of
 *                                                        conduct against revenue is the same trade
 *
 * So `standing` and `measures` travel as the module produced them, in separate fields, and the
 * queue is ordered by the module's own ordering. Nothing here computes.
 *
 * **A `null` measure is a refusal and is forwarded as one.** Below `MINIMUM_REFERRALS_FOR_RATE` the
 * module returns null with its denominator, the same withholding 5.5, 9.1, 1.3 and 5.2 all make. A
 * page rendering that as `0%` would be inventing a partner's complaint rate out of nothing.
 */

import {
  MINIMUM_REFERRALS_FOR_RATE,
  assessPartner,
  findingsFor,
  partnersNeedingReview,
  recordFinding,
  resolveFinding,
} from '@bwc/partners';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type PartnerRiskRouteContext = ConsoleRouteContext;

const AVAILABLE_WRITES = [
  {
    capability: 'Record a conduct finding',
    action: 'record_partner_finding',
    note: 'Level 1, and deliberately the lowest: a finding STOPS things. One nobody recorded is a partner promising clients an approval; one recorded in error is visible at once and takes a person to resolve. A CRITICAL finding SUSPENDS the partner immediately, from inside the module - automatic in, human out.',
  },
  {
    capability: 'Resolve a finding',
    action: 'resolve_partner_finding',
    note: 'Level 3, because resolving is the direction that RESTORES. An open finding suppresses a standing; resolving lifts it, and one resolved carelessly puts somebody back in front of clients. A note somebody can read back is required.',
  },
] as const;

const BLOCKED_WRITES = [
  {
    capability: 'Reinstate a suspended partner',
    module: '@bwc/partners',
    missingAction: 'not applicable',
    unblockedBy: 'nothing on this surface, ever',
    why: 'A critical finding suspends automatically because leaving an unauthorized promise until Monday is 6.4 Friday problem with a client on the other end of it. Reinstatement is the human half of "automatic in, human out", and putting it on the same panel as the finding that caused it would let one person undo their own suspension in two clicks. It belongs with the partner lifecycle, at end_partner_relationship level, where a different person is looking.',
  },
] as const;

export const registerPartnerRiskRoutes = (context: PartnerRiskRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

  /**
   * One partner: their standing, and separately their measures.
   *
   * Two fields, never one. `standing` is categorical and worst-of; `measures` are numeric with
   * their denominators. The page shows both and the reader does the judging, which is the whole
   * design.
   */
  app.get(
    '/api/console/partners/:partnerId/risk',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const assessment = await assessPartner(tenantId, param(req, 'partnerId'), now());
      if (assessment.status !== 'ok') {
        send(res, assessment);
        return;
      }

      send(
        res,
        ok({
          // Forwarded whole. `standing`, `triggers`, `measures` and `unmeasured` stay in the shape
          // the module produced, because flattening them is how the two kinds get combined.
          ...assessment.value,

          /**
           * The sample the measures need, so a withheld rate is actionable rather than mysterious.
           *
           * A page saying "no complaint rate" teaches its reader the system is arbitrary. One
           * saying "10 referrals are needed and this partner has 3" tells them what would change it.
           */
          minimumReferralsForRate: MINIMUM_REFERRALS_FOR_RATE,

          /**
           * Stated rather than left for a page to infer from two fields.
           *
           * A reader who sees a good conversion rate beside a serious finding will combine them
           * unless something says not to. This is that something.
           */
          combinationRule:
            'Standing and measures are not combined, here or anywhere. A conduct finding is not offset by revenue - that trade is what design principle 1 forbids, and a single figure would make it invisibly.',

          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /** Every open finding on one partner, newest first as the module orders them. */
  app.get(
    '/api/console/partners/:partnerId/risk/findings',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const findings = await findingsFor(tenantId, param(req, 'partnerId'));
      send(
        res,
        ok({
          findings,
          total: findings.length,
          detail:
            findings.length === 0
              ? 'No finding has been recorded against this partner. That is an answer, not an empty screen.'
              : `${findings.length} finding(s), newest first.`,
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * The review queue.
   *
   * **Not sorted by anything numeric, and that is not an oversight.** An ordering is a ranking, and
   * ranking partners by a figure that mixes conduct with revenue is the combination this module
   * exists to refuse. The module orders by name; this forwards that order untouched.
   */
  app.get(
    '/api/console/partners/risk/review',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const assessments = await partnersNeedingReview(tenantId, now());
      send(
        res,
        ok({
          partners: assessments,
          total: assessments.length,
          /**
           * Counted by standing rather than totalled, for the same reason nothing else here is
           * averaged: "4 partners need review" hides that one of them made an unauthorized promise.
           */
          byStanding: assessments.reduce<Record<string, number>>((counts, assessment) => {
            counts[assessment.standing] = (counts[assessment.standing] ?? 0) + 1;
            return counts;
          }, {}),
          detail:
            assessments.length === 0
              ? 'No partner has an open conduct finding. Nothing is waiting on a review.'
              : `${assessments.length} partner(s) with an open finding.`,
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /**
   * Record a finding.
   *
   * A `critical` severity suspends the partner from inside the module. The route does not do it and
   * must not: ADR-0034 is what happens to a control a caller can reach past, and a suspension
   * performed here would be one the module could not guarantee.
   */
  app.post(
    '/api/console/partners/:partnerId/risk/findings',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'record_partner_finding' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await recordFinding({
          ...body,
          tenantId,
          partnerId: param(req, 'partnerId'),
          recordedBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
          now: now(),
        } as never),
        { trace: permitted.trace },
      );
    }),
  );

  /** Resolve one. `upheld` records which way it went; the note is required either way. */
  app.post(
    '/api/console/partners/risk/findings/:findingId/resolution',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'resolve_partner_finding' });
      if (!permitted) return;

      const body = req.body as { upheld?: unknown; note?: unknown };
      send(
        res,
        await resolveFinding({
          tenantId,
          findingId: param(req, 'findingId'),
          upheld: body.upheld === true,
          note: String(body.note ?? ''),
          resolvedBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );
};
