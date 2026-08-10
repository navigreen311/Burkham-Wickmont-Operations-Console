/**
 * Arm's-length pricing - blueprint 10.1's "arm's-length pricing logic per Gardner-approved
 * intercompany services agreement".
 *
 * The dangerous reading of that sentence is a pricing model: compute what the market would bear
 * for a sibling venture, and charge that.
 *
 * **We do not need to model it.** 1.4 already publishes an offer ladder, and those prices are what
 * unrelated clients actually pay. That is arm's length by the only definition that survives an
 * audit: a price a stranger paid, not a price we justified.
 *
 * So an intercompany engagement is checked against the published offer, and **any deviation
 * requires Gardner approval with a stated basis, in either direction**.
 *
 * The both-directions rule is the part worth arguing about, and it is deliberate. A discount to a
 * sibling moves profit out of Burkham Wickmont; a premium moves profit in. Both are transfer
 * pricing. A system that questioned only discounts would be policing one direction of the same
 * thing - and the direction it ignored is the one that flatters this company's own numbers, which
 * is exactly the direction nobody would report.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { currentOffer, type Cents } from '@bwc/billing';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';

/** Gardner approval is a Level 3 human decision, as everywhere a judgement overrides a control. */
export const APPROVAL_AUTHORITY_LEVEL = 3;

export type DeviationDirection = 'discount' | 'premium';

export interface PricingCheck {
  readonly atPublishedPrice: boolean;
  readonly publishedCents: Cents;
  readonly chargedCents: Cents;
  readonly direction: DeviationDirection | null;
  readonly deviationBasisPoints: number;
  readonly detail: string;
}

/**
 * Basis points of deviation from the published price.
 *
 * Basis points rather than a percentage float, per ADR-0011 - and rounded away from zero, so a
 * deviation of a fraction of a basis point still reports as a deviation rather than rounding into
 * compliance.
 */
export const deviationBasisPoints = (publishedCents: Cents, chargedCents: Cents): number => {
  if (publishedCents === 0) return chargedCents === 0 ? 0 : 10_000;
  const raw = ((chargedCents - publishedCents) / publishedCents) * 10_000;
  return raw >= 0 ? Math.ceil(raw) : Math.floor(raw);
};

/**
 * Check a proposed price against the published one.
 *
 * Pure comparison, no side effects: a caller may want to know before deciding whether to seek
 * approval. `recordDeviation` is what actually permits one.
 */
export const checkAgainstLadder = async (input: {
  tenantId: string;
  offerKey: string;
  chargedCents: Cents;
}): Promise<Outcome<PricingCheck>> => {
  const offer = await currentOffer(input.tenantId, input.offerKey);
  if (offer.status !== 'ok') return offer as Outcome<never>;

  const published = offer.value.retainerCents;
  const charged = input.chargedCents;

  if (charged === published) {
    return ok({
      atPublishedPrice: true,
      publishedCents: published,
      chargedCents: charged,
      direction: null,
      deviationBasisPoints: 0,
      detail: `Charged at the published price for '${input.offerKey}'. This is the arm's-length price by definition - it is what unrelated clients pay.`,
    });
  }

  const points = deviationBasisPoints(published, charged);
  const direction: DeviationDirection = charged < published ? 'discount' : 'premium';

  return ok({
    atPublishedPrice: false,
    publishedCents: published,
    chargedCents: charged,
    direction,
    deviationBasisPoints: points,
    detail: `Charged ${charged} against a published ${published} for '${input.offerKey}' - a ${direction} of ${Math.abs(points)} basis points. A ${direction} to a related party ${direction === 'discount' ? 'moves profit out of Burkham Wickmont' : 'moves profit into Burkham Wickmont'}, so it requires Gardner approval with a stated basis.`,
  });
};

export interface RecordedDeviation {
  readonly id: string;
  readonly direction: DeviationDirection;
  readonly deviationBasisPoints: number;
  readonly basis: string;
}

/**
 * Record a Gardner-approved deviation.
 *
 * Refuses at the published price: there is nothing to approve, and a deviation record saying "no
 * deviation" would make the register of exceptions unreadable.
 */
export const recordDeviation = async (input: {
  tenantId: string;
  clientId: string;
  engagementId: string;
  offerKey: string;
  chargedCents: Cents;
  basis: string;
  approvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<RecordedDeviation>> => {
  const now = input.now ?? new Date();

  if (input.basis.trim().length < 20) {
    return refused(
      'A related-party pricing deviation needs a stated basis somebody can read back. An unexplained price between entities under common ownership is the definition of the problem this check exists for.',
      "Blueprint 10.1 - arm's-length pricing per Gardner-approved agreement",
    );
  }

  const relationship = await db().ventureRelationship.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });
  if (!relationship) {
    return refused(
      'This client is not a Green Companies venture, so there is no related-party pricing question. Ordinary commercial discounts are a 1.4 matter and do not belong in the intercompany register.',
      'Blueprint 10.1 - intercompany pricing',
    );
  }

  const check = await checkAgainstLadder({
    tenantId: input.tenantId,
    offerKey: input.offerKey,
    chargedCents: input.chargedCents,
  });
  if (check.status !== 'ok') return check as Outcome<never>;

  if (check.value.atPublishedPrice) {
    return refused(
      `The proposed price matches the published price for '${input.offerKey}', so there is no deviation to approve. Recording one anyway would fill the exception register with non-exceptions and make the real ones harder to find.`,
      "Blueprint 10.1 - arm's-length pricing",
    );
  }

  const actor = await findActor(input.approvedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < APPROVAL_AUTHORITY_LEVEL) {
    return refused(
      `Approving a related-party pricing deviation requires a human at Authority Level ${APPROVAL_AUTHORITY_LEVEL}. It moves profit between two entities the same owner controls.`,
      'Blueprint 2.1 with 10.1 - Gardner-governed intercompany commerce',
    );
  }

  const row = await db().pricingDeviation.create({
    data: {
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      clientId: input.clientId,
      ventureKey: relationship.ventureKey,
      offerKey: input.offerKey,
      publishedCents: check.value.publishedCents,
      chargedCents: input.chargedCents,
      direction: check.value.direction as never,
      deviationBasisPoints: check.value.deviationBasisPoints,
      basis: input.basis,
      approvedBy: input.approvedBy,
      approvedAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.pricing.deviation_approved',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      deviationId: row.id,
      engagementId: input.engagementId,
      ventureKey: relationship.ventureKey,
      direction: check.value.direction,
      deviationBasisPoints: check.value.deviationBasisPoints,
      approvedBy: input.approvedBy,
    },
  });

  return ok({
    id: row.id,
    direction: check.value.direction as DeviationDirection,
    deviationBasisPoints: check.value.deviationBasisPoints,
    basis: input.basis,
  });
};

/**
 * Whether a price may be charged on this engagement.
 *
 * The gate 1.4 would call before billing an intercompany engagement. At the published price it
 * passes; off it, it passes only if an approved deviation already exists for that exact amount.
 * Approving one amount and charging another is the loophole this closes.
 */
export const mayCharge = async (input: {
  tenantId: string;
  clientId: string;
  engagementId: string;
  offerKey: string;
  chargedCents: Cents;
}): Promise<Outcome<PricingCheck>> => {
  const relationship = await db().ventureRelationship.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });

  const check = await checkAgainstLadder({
    tenantId: input.tenantId,
    offerKey: input.offerKey,
    chargedCents: input.chargedCents,
  });
  if (check.status !== 'ok') return check;

  // Not a venture: 1.4 owns ordinary pricing and this module has no view.
  if (!relationship) return check;

  if (check.value.atPublishedPrice) return check;

  const approved = await db().pricingDeviation.findFirst({
    where: {
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      offerKey: input.offerKey,
      chargedCents: input.chargedCents,
    },
  });

  if (!approved) {
    return refused(
      `${check.value.detail} No approved deviation exists for this engagement at this amount.`,
      "Blueprint 10.1 - arm's-length pricing per Gardner-approved agreement",
    );
  }

  return ok(check.value);
};

/** Every approved deviation, for the review Gardner runs over the intercompany book. */
export const deviationsFor = async (
  tenantId: string,
  clientId?: string,
): Promise<readonly (RecordedDeviation & { engagementId: string; offerKey: string })[]> => {
  const rows = await db().pricingDeviation.findMany({
    where: { tenantId, ...(clientId !== undefined ? { clientId } : {}) },
    orderBy: { approvedAt: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    engagementId: row.engagementId,
    offerKey: row.offerKey,
    direction: row.direction as DeviationDirection,
    deviationBasisPoints: row.deviationBasisPoints,
    basis: row.basis,
  }));
};
