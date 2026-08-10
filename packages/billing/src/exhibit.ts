/**
 * Building 7.3's fee-exhibit input from the engagement record.
 *
 * This closes the gap 7.3 recorded in its own Fact Check List: until now the exhibit took a tier
 * and a set of figures on trust from whoever called it, and nothing checked that they matched the
 * engagement actually sold.
 *
 * The single dollars boundary in this package lives here. Everything upstream is integer cents;
 * `buildFeeExhibit` renders rather than accumulates, so converting once at the edge is safe - see
 * the deviation note in the plan doc for why 7.3 was not retrofitted in this slice.
 */

import { db } from '@bwc/db';
import { noData, ok, type Outcome } from '@bwc/core';
import type { FeeExhibitInput } from '@bwc/contracts';
import { toDollars, type Cents } from './money.js';

export interface ExhibitFromEngagementInput {
  readonly tenantId: string;
  readonly engagementId: string;
  /**
   * The approved credit limit, when an approval exists. Omit it and the success fee is presented
   * as contingent rather than estimated - 7.3's behaviour, reached from real data rather than from
   * a caller deciding what to pass.
   */
  readonly approvedCreditLimitCents?: Cents;
}

/**
 * Assemble the exhibit input.
 *
 * Every figure comes from the offer version the engagement was started on, not from the current
 * one. A repricing must not change what an existing client's exhibit says they agreed to pay.
 */
export const exhibitInputFor = async (
  input: ExhibitFromEngagementInput,
): Promise<Outcome<FeeExhibitInput>> => {
  const engagement = await db().engagement.findFirst({
    where: { tenantId: input.tenantId, id: input.engagementId },
    include: { offer: true },
  });
  if (!engagement) return noData('No such engagement in this tenant.');

  const { offer } = engagement;

  const exhibit: FeeExhibitInput = {
    offerTier: offer.name,
    ...(offer.retainerCents > 0
      ? {
          retainer: {
            amount: toDollars(offer.retainerCents),
            whenCharged: 'On signature of the service agreement.',
          },
        }
      : {}),
    ...(offer.monthlyCents > 0 && offer.committedMonths > 0
      ? {
          monthly: {
            amount: toDollars(offer.monthlyCents),
            months: offer.committedMonths,
          },
        }
      : {}),
    ...(offer.successFeeBasisPoints > 0
      ? {
          successFee: {
            // Basis points to percent for the human-facing exhibit. The arithmetic that produces
            // money stayed in basis points; this is presentation.
            ratePercent: offer.successFeeBasisPoints / 100,
            ...(input.approvedCreditLimitCents !== undefined
              ? { approvedCreditLimit: toDollars(input.approvedCreditLimitCents) }
              : {}),
          },
        }
      : {}),
  };

  return ok(exhibit);
};
