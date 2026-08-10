/**
 * The referral path - blueprint 8.1's "referral fee tracking", and the gate 8.3 puts in front
 * of it.
 *
 * 1.3 already owns attribution and owns it deliberately: written once at lead creation, no update
 * path in the package, corrections as separate rows. This module does not take any of that over.
 * What it adds is the check that runs BEFORE a lead is created with a partner attached, and the
 * read that answers "what has this partner sent us".
 *
 * **No money is computed here.** Blueprint 8.1 lists "referral fee tracking" and blueprint 8.2 -
 * which owns fee terms, the state-by-state restrictions on referral fees, payout approval and
 * clawback - is V1.5. A fee number produced without the rules that make it lawful in the client's
 * state would be a figure somebody would act on, and the module that knows whether it is legal
 * has not been built. So this tracks that a referral happened and who it is attributed to, and
 * stops there. The absence is a refusal with a name, not a silence.
 */

import { noData, notBuilt, ok, type Outcome } from '@bwc/core';
import { leadsAttributedTo } from './attributed.js';
import { findPartner } from './partners.js';
import { requireCertification, type CertificationStanding } from './certification.js';

/**
 * May this partner refer a client right now?
 *
 * Two gates, in this order: the relationship, then the training. The order is the design - "your
 * relationship with us is suspended" and "your certification lapsed" are different problems with
 * different fixes, and a suspended partner told to retake a course would do the course and still
 * be suspended.
 */
export const canRefer = async (
  tenantId: string,
  partnerId: string,
  now: Date = new Date(),
): Promise<Outcome<CertificationStanding>> => {
  const partner = await findPartner(tenantId, partnerId);
  if (partner.status !== 'ok') return partner;

  if (!partner.value.engageable) {
    const detail =
      partner.value.status === 'terminated'
        ? 'This partner relationship was terminated.'
        : partner.value.status === 'suspended'
          ? 'This partner is suspended.'
          : `This partner has not completed onboarding. Outstanding: ${partner.value.outstandingQualifications.join('; ') || 'none recorded'}.`;
    return {
      status: 'refused',
      reason: `${detail} They cannot refer a client.`,
      principle: 'Blueprint 8.1 - onboarding status and termination triggers',
    };
  }

  return requireCertification(tenantId, partnerId, partner.value.track, 'refer', now);
};

export interface ReferralSummary {
  readonly partnerId: string;
  readonly totalReferrals: number;
  readonly converted: number;
  readonly lost: number;
  readonly open: number;
}

/**
 * What this partner has sent us.
 *
 * Counts, not a conversion rate. 1.3 established that a rate below a minimum denominator is
 * `null` rather than a number, and computing one here from a handful of referrals would
 * reintroduce exactly the figure that module refuses to produce - with the added problem that a
 * partner-facing rate is a performance judgement, and 8.4 Partner Risk Score, which owns
 * performance judgements about partners, is V1.5.
 */
export const referralSummary = async (
  tenantId: string,
  partnerId: string,
): Promise<Outcome<ReferralSummary>> => {
  const partner = await findPartner(tenantId, partnerId);
  if (partner.status !== 'ok') return partner;

  const leads = await leadsAttributedTo(tenantId, partnerId);

  if (leads.length === 0) {
    return noData(
      `No lead is attributed to this partner. If they have introduced someone, the lead was created without the partner id and 1.3's attribution is written once - the fix is an attribution correction, not a second lead.`,
    );
  }

  const converted = leads.filter((lead) => lead.converted === true).length;
  const lost = leads.filter((lead) => lead.converted === false).length;

  return ok({
    partnerId,
    totalReferrals: leads.length,
    converted,
    lost,
    open: leads.length - converted - lost,
  });
};

/**
 * What this partner is owed.
 *
 * `not_built`, deliberately and permanently until 8.2 ships. Blueprint 8.2 owns referral fee
 * terms, the state restrictions on referral fees, payout approval and clawback on refunds - and
 * every one of those is required before a number here would mean anything. Half of it is not a
 * smaller version of the whole: a fee computed without the state restriction is a figure that
 * looks payable and may be unlawful to pay.
 */
export const payableToPartner = async (partnerId: string): Promise<Outcome<never>> =>
  notBuilt(
    '8.2 Partner Agreement & Payout Center (V1.5)',
    `Referrals attributed to partner ${partnerId} are tracked, but referral fee terms, the state-by-state restrictions on referral fees, payout approval and refund clawback all live in 8.2, which is deferred to V1.5. A figure produced without them would look payable without anybody having checked whether it is lawful to pay.`,
  );
