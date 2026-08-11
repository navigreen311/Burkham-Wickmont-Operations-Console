/**
 * 8.1 Partner & Referrer Portal and 8.3 Training & Certification, as Console routes.
 *
 * **The cohort suppression is the thing to get right here, and the way to get it wrong is to be
 * helpful.**
 *
 * `aggregateStatus` withholds the stage breakdown below five referrals and returns
 * `{ released: false, countsByStage: {}, totalReferrals, detail }`. Three transport-shaped
 * temptations each destroy it:
 *
 *   forwarding `countsByStage` unconditionally  - `{}` renders as a breakdown where every stage is
 *                                                 zero, which is a false statement about the
 *                                                 partner's book rather than a withheld one
 *   dropping the field when suppressed          - the page shows nothing and the operator concludes
 *                                                 the partner referred nobody
 *   substituting a band, "fewer than five"      - the partner knows their own referral count, so a
 *                                                 band plus what they already know is most of an
 *                                                 answer
 *
 * So this route forwards `released` and `detail` as the module produced them and **omits
 * `countsByStage` entirely when it is suppressed**, so there is no empty object for a page to
 * iterate into zeros. `totalReferrals` is released either way, deliberately: the partner already
 * knows how many clients they sent, and withholding it protects nobody while making the suppression
 * look like a bug.
 *
 * The threshold travels too. A page that says "withheld" without saying "below five" teaches its
 * reader that the system is arbitrary.
 *
 * **`identifiedStatus` is not routed here.** It is a read that writes `partner.client_status.viewed`
 * - a disclosure of a named client's compliance state to a third party - and it is reachable from
 * the PARTNER portal, on the client's own consent. Exposing it on the internal Console would let a
 * staff member generate the "your partner looked at your file" event without a partner having
 * looked, which corrupts the one record that exists to tell a client who saw their status.
 */

import type { Express, Request, Response } from 'express';
import {
  MINIMUM_COHORT,
  PARTNER_TRACKS,
  RECERTIFICATION_CADENCE_DAYS,
  aggregateStatus,
  approvedClaimsFor,
  canRefer,
  completionsFor,
  currentCurriculum,
  findPartner,
  outstandingQualifications,
  partnersFor,
  referralSummary,
  requirementsFor,
  standingFor,
  type PartnerTrack,
} from '@bwc/partners';
import { ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface PartnerRouteContext {
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
    capability: 'Register, qualify, onboard, suspend or terminate a partner',
    module:
      '@bwc/partners registerPartner, recordQualification, completeOnboarding, suspendPartner, terminatePartner',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action. ACTION_MINIMUM_LEVEL has none for administering a partner relationship. send_partner_followup exists at Level 2 and means communicating WITH a partner, which is a different act from ending one.',
  },
  {
    capability: 'Publish a curriculum module, record a completion, approve or withdraw a claim',
    module:
      '@bwc/partners publishModule, recordCompletion, approveClaim, withdrawClaim, approveBrandArrangement',
    missingAction: 'none declared',
    why: 'Each emits a Ledger event and so must pass the middleware chain with a declared action, and ACTION_MINIMUM_LEVEL declares none. Recording a completion is what certifies a partner to refer clients, so it gates a commercial capability and is not a clerical write.',
  },
] as const;

const isTrack = (value: unknown): value is PartnerTrack =>
  typeof value === 'string' && (PARTNER_TRACKS as readonly string[]).includes(value);

/**
 * The aggregate, with the suppression preserved on the way through.
 *
 * `countsByStage` is present only when `released`. See the module header for why an empty object is
 * the dangerous shape.
 */
const releasableAggregate = (
  aggregate: Awaited<ReturnType<typeof aggregateStatus>>,
): Record<string, unknown> => ({
  released: aggregate.released,
  totalReferrals: aggregate.totalReferrals,
  minimumCohort: MINIMUM_COHORT,
  detail: aggregate.detail,
  ...(aggregate.released ? { countsByStage: aggregate.countsByStage } : {}),
});

export const registerPartnerRoutes = (context: PartnerRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId, now } = context;

  /**
   * The partner list, with the curriculum that governs certification.
   *
   * The curriculum is on the same answer because a list of partners without the modules they are
   * measured against is a list of statuses nobody can act on.
   */
  app.get(
    '/api/console/partners',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const track = query['track'];
      const filter = isTrack(track) ? { track } : {};

      const [partners, curriculum] = await Promise.all([
        partnersFor(tenantId, filter),
        currentCurriculum(tenantId),
      ]);

      send(
        res,
        ok({
          partners,
          curriculum,
          tracks: PARTNER_TRACKS,
          recertificationCadenceDays: RECERTIFICATION_CADENCE_DAYS,
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  /**
   * One partner: the relationship, the certification standing, the referral book and what they may
   * do right now.
   *
   * `canRefer` is asked rather than inferred from the status and the standing. The gate runs two
   * checks in a fixed order and reports which one failed, and a page reconstructing that from two
   * fields would eventually disagree with the gate - at which point the Console would be telling an
   * operator a partner may refer while the system refuses them.
   */
  app.get(
    '/api/console/partners/:partnerId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const at = now();
      const partnerId = param(req, 'partnerId');

      const partner = await findPartner(tenantId, partnerId);
      if (partner.status !== 'ok') {
        send(res, partner);
        return;
      }

      const track = partner.value.track as PartnerTrack;
      const [standing, referrals, aggregate, completions, claims, refer] = await Promise.all([
        standingFor(tenantId, partnerId, track, at),
        referralSummary(tenantId, partnerId),
        aggregateStatus(tenantId, partnerId),
        completionsFor(tenantId, partnerId),
        approvedClaimsFor(tenantId, partnerId),
        canRefer(tenantId, partnerId, at),
      ]);

      send(
        res,
        ok({
          partner: partner.value,
          requirements: requirementsFor(track),
          outstandingQualifications: outstandingQualifications(
            track,
            partner.value.qualificationsRecorded,
          ),
          standing,
          completions,
          approvedClaims: claims,
          /**
           * Counts, forwarded whole - including `no_data` when nothing is attributed.
           *
           * The module returns `no_data` with an explanation about attribution corrections rather
           * than a zeroed summary, and that explanation is the useful part for an operator who
           * expected referrals and sees none.
           */
          referrals,
          /** The anonymity rule, applied. See `releasableAggregate` and the module header. */
          aggregateStatus: releasableAggregate(aggregate),
          /**
           * **No payout figure, and its absence is the point.**
           *
           * This read used to carry `payableToPartner`, which was 8.2's `not_built` stub taking a
           * partner id. 8.2 now exists, and the function it became COMPUTES AND RECORDS a payout -
           * it takes a period, a `computedBy` and an actor, and it writes. Calling it from here
           * would mean opening a partner's page computed a payout and wrote a Ledger event, every
           * time, attributed to whoever happened to be looking.
           *
           * A payout is an act with a period and an approver. It belongs on a surface that says so,
           * and that surface is not built - 8.2 shipped as an engine. Named here rather than
           * left as a field somebody removes without noticing what it was.
           */
          /**
           * What the gate says today, with its reason when it refuses.
           *
           * Two states carried separately: `permitted` is the answer, `reason` is why not. A page
           * that only had the boolean would render "cannot refer" with no route to fixing it.
           */
          mayRefer: {
            permitted: refer.status === 'ok',
            status: refer.status,
            reason: refer.status === 'ok' ? null : refer.reason,
            principle: refer.status === 'refused' ? refer.principle : null,
          },
          /**
           * Kept as a field rather than dropped, because a partner page with no payout section
           * reads as a partner who is owed nothing - which is a different statement and not one
           * this route can make.
           */
          payable: {
            status: 'no_surface',
            reason:
              '8.2 Partner Agreement & Payout Center computes and RECORDS a payout: it needs a period, a computedBy and an actor. A read cannot supply those, and a page that opened would have written one. The engine exists; the surface does not.',
            module: '8.2 Partner Agreement & Payout Center',
          },
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
