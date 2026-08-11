/**
 * Partner commercial terms - blueprint 8.2's "partner contracts, referral fee terms".
 *
 * Versioned, never edited in place. A payout cites the agreement version it was computed under,
 * so "what were we paying them in March" survives the terms changing in April. 7.3 made the same
 * choice about contracts and for the same reason: an issued document is frozen.
 *
 * **Activating an agreement is a Level 3 human act.** It binds this company to pay money on
 * facts a computation will later assert, and the computation is unattended. Automatic in, human
 * out - the human is at both ends here, once on the terms and once on each payout.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findPartner } from './partners.js';

/** Agreeing terms that bind us to pay is a Level 3 decision. */
export const AGREEMENT_AUTHORITY_LEVEL = 3;

/**
 * The most a partner may be given of what we earned, before any state cap.
 *
 * A ceiling in code rather than a parameter, because a share above half of the fee stops being a
 * referral arrangement and starts looking like the partner selling our service - which is a
 * different regulatory character (principle 1's Seek Capital test) and not a number an operator
 * should be able to cross on a form.
 */
export const MAXIMUM_SHARE_BASIS_POINTS = 5_000;

export type AgreementStatus = 'draft' | 'active' | 'superseded' | 'terminated';

export interface PartnerAgreement {
  readonly id: string;
  readonly partnerId: string;
  readonly version: number;
  readonly shareBasisPoints: number;
  readonly termsSummary: string;
  readonly status: AgreementStatus;
  readonly effectiveFrom: string;
  readonly supersededAt: string | null;
  readonly activatedBy: string | null;
}

interface Row {
  id: string;
  partnerId: string;
  version: number;
  shareBasisPoints: number;
  termsSummary: string;
  status: string;
  effectiveFrom: Date;
  supersededAt: Date | null;
  activatedBy: string | null;
}

const toAgreement = (row: Row): PartnerAgreement => ({
  id: row.id,
  partnerId: row.partnerId,
  version: row.version,
  shareBasisPoints: row.shareBasisPoints,
  termsSummary: row.termsSummary,
  status: row.status as AgreementStatus,
  effectiveFrom: row.effectiveFrom.toISOString(),
  supersededAt: row.supersededAt?.toISOString() ?? null,
  activatedBy: row.activatedBy,
});

export interface DraftAgreementInput {
  readonly tenantId: string;
  readonly partnerId: string;
  readonly shareBasisPoints: number;
  readonly termsSummary: string;
  readonly effectiveFrom: Date;
  readonly draftedBy: string;
  readonly actor: EventActor;
}

/** Write the terms down. Drafting pays nobody and needs no authority beyond writing it. */
export const draftAgreement = async (
  input: DraftAgreementInput,
): Promise<Outcome<PartnerAgreement>> => {
  const partner = await findPartner(input.tenantId, input.partnerId);
  if (!partner) return noData(`No partner ${input.partnerId} is on record.`);

  const share = input.shareBasisPoints;
  if (!Number.isInteger(share) || share <= 0 || share > MAXIMUM_SHARE_BASIS_POINTS) {
    return refused(
      `A partner share is basis points between 1 and ${MAXIMUM_SHARE_BASIS_POINTS}; received ${share}. Above half the fee this stops being a referral arrangement and starts looking like the partner selling our service, which is a different regulatory character and not a number a form should be able to cross.`,
      'ADR-0011 with principle 1 - basis points, and the Seek Capital test',
    );
  }

  if (input.termsSummary.trim().length < 20) {
    return refused(
      'An agreement needs a readable summary of what was agreed. A share with no terms behind it is a number somebody will have to reconstruct from memory when it is disputed.',
      'Blueprint 8.2 - partner contracts and referral fee terms',
    );
  }

  const latest = await db().partnerAgreement.findFirst({
    where: { tenantId: input.tenantId, partnerId: input.partnerId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const row = await db().partnerAgreement.create({
    data: {
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      version: (latest?.version ?? 0) + 1,
      shareBasisPoints: share,
      termsSummary: input.termsSummary,
      status: 'draft',
      effectiveFrom: input.effectiveFrom,
      createdBy: input.draftedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.agreement.drafted',
    actor: input.actor,
    payload: {
      agreementId: row.id,
      partnerId: input.partnerId,
      version: row.version,
      shareBasisPoints: share,
    },
  });

  return ok(toAgreement(row));
};

/**
 * Bring an agreement into force, superseding whatever preceded it.
 *
 * Supersession is a write, not a delete. The old version keeps its rows and its payouts keep
 * citing it, so a payout computed in March still reads as it did.
 */
export const activateAgreement = async (input: {
  tenantId: string;
  agreementId: string;
  activatedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<PartnerAgreement>> => {
  const now = input.now ?? new Date();

  const row = await db().partnerAgreement.findFirst({
    where: { tenantId: input.tenantId, id: input.agreementId },
  });
  if (!row) return noData(`No partner agreement ${input.agreementId} is on record.`);

  if (row.status !== 'draft') {
    return refused(
      `That agreement is '${row.status}'. Only a draft can be brought into force; a superseded one is history and a terminated one ended.`,
      'Blueprint 8.2 - partner contracts',
    );
  }

  const actor = await findActor(input.activatedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < AGREEMENT_AUTHORITY_LEVEL) {
    return refused(
      `Bringing partner terms into force requires a human at Authority Level ${AGREEMENT_AUTHORITY_LEVEL}. It commits this company to paying money on facts a later computation will assert unattended.`,
      'Principle 4 with blueprint 8.2 - automatic in, human out',
    );
  }

  const updated = await db().$transaction(async (tx) => {
    await tx.partnerAgreement.updateMany({
      where: { tenantId: input.tenantId, partnerId: row.partnerId, status: 'active' },
      data: { status: 'superseded', supersededAt: now },
    });
    return tx.partnerAgreement.update({
      where: { id: row.id },
      data: { status: 'active', activatedBy: input.activatedBy, activatedAt: now },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.agreement.activated',
    actor: input.actor,
    payload: {
      agreementId: row.id,
      partnerId: row.partnerId,
      version: row.version,
      shareBasisPoints: row.shareBasisPoints,
      activatedBy: input.activatedBy,
    },
  });

  return ok(toAgreement(updated));
};

/**
 * The terms in force for a partner.
 *
 * `no_data` when there are none, and that is what stops a payout: a partner with referrals and no
 * agreement is owed nothing this system can compute, because nobody wrote down what they are owed.
 */
export const activeAgreement = async (
  tenantId: string,
  partnerId: string,
): Promise<Outcome<PartnerAgreement>> => {
  const row = await db().partnerAgreement.findFirst({
    where: { tenantId, partnerId, status: 'active' },
    orderBy: { version: 'desc' },
  });

  if (!row) {
    return noData(
      `Partner ${partnerId} has no agreement in force. Referrals are tracked, and what they are worth is a term somebody has to have agreed - there is no default share, because a default share is a number nobody negotiated.`,
    );
  }

  return ok(toAgreement(row));
};

export const agreementHistory = async (
  tenantId: string,
  partnerId: string,
): Promise<readonly PartnerAgreement[]> => {
  const rows = await db().partnerAgreement.findMany({
    where: { tenantId, partnerId },
    orderBy: { version: 'asc' },
  });
  return rows.map(toAgreement);
};
