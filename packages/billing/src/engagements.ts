/**
 * The offer ladder and engagements against it - blueprint 1.4.
 *
 * An offer definition is versioned and superseded rather than edited, for the reason that recurs
 * across this codebase: what a client agreed to must remain readable after the offer is repriced.
 * A client on version 2 of the Growth offer is on version 2 forever, whatever version 5 says.
 *
 * Charges and payments are separate records with the sign carried by `kind` rather than by the
 * number. A query that summed signed amounts would net a refund against a charge and report a
 * balance that is arithmetically true and answers nobody's question.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { atLeastZero, sum, type Cents } from './money.js';

export type EngagementStatus = 'active' | 'completed' | 'cancelled';
export type BillingRecordKind = 'charge' | 'payment' | 'refund' | 'credit_applied';

export interface OfferRecord {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly name: string;
  readonly rung: number;
  readonly retainerCents: Cents;
  readonly monthlyCents: Cents;
  readonly successFeeBasisPoints: number;
  readonly minimumCents: Cents;
  readonly committedMonths: number;
}

interface OfferRow {
  id: string;
  key: string;
  version: number;
  name: string;
  rung: number;
  retainerCents: number;
  monthlyCents: number;
  successFeeBasisPoints: number;
  minimumCents: number;
  committedMonths: number;
}

const toOffer = (row: OfferRow): OfferRecord => ({
  id: row.id,
  key: row.key,
  version: row.version,
  name: row.name,
  rung: row.rung,
  retainerCents: row.retainerCents,
  monthlyCents: row.monthlyCents,
  successFeeBasisPoints: row.successFeeBasisPoints,
  minimumCents: row.minimumCents,
  committedMonths: row.committedMonths,
});

export interface PublishOfferInput {
  readonly tenantId: string;
  readonly key: string;
  readonly name: string;
  readonly rung: number;
  readonly description: string;
  readonly retainerCents: Cents;
  readonly monthlyCents?: Cents;
  /** Basis points. 8.5% is 850 - a percentage as a float is a rate nobody agreed. */
  readonly successFeeBasisPoints?: number;
  readonly minimumCents?: Cents;
  readonly committedMonths?: number;
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

export const publishOffer = async (input: PublishOfferInput): Promise<Outcome<OfferRecord>> => {
  for (const [label, value] of [
    ['retainer', input.retainerCents],
    ['monthly fee', input.monthlyCents ?? 0],
    ['minimum', input.minimumCents ?? 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return refused(
        `The ${label} for offer '${input.key}' is ${value}, which is not a whole non-negative number of cents.`,
        'Blueprint 1.4 - money is stored in cents so no figure can carry a fraction nobody agreed',
      );
    }
  }

  if (input.rung < 1) {
    return refused(
      `Offer '${input.key}' was published at rung ${input.rung}. The ladder starts at 1, and rung ordering is what makes upgrade credit computable.`,
      'Blueprint 1.4 - credit chain tracking across the offer ladder',
    );
  }

  const now = input.now ?? new Date();
  const current = await db().offerDefinition.findFirst({
    where: { tenantId: input.tenantId, key: input.key, supersededAt: null },
    orderBy: { version: 'desc' },
  });

  const row = await db().$transaction(async (tx) => {
    if (current) {
      await tx.offerDefinition.update({ where: { id: current.id }, data: { supersededAt: now } });
    }
    return tx.offerDefinition.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        version: (current?.version ?? 0) + 1,
        name: input.name,
        rung: input.rung,
        description: input.description,
        retainerCents: input.retainerCents,
        monthlyCents: input.monthlyCents ?? 0,
        successFeeBasisPoints: input.successFeeBasisPoints ?? 0,
        minimumCents: input.minimumCents ?? 0,
        committedMonths: input.committedMonths ?? 0,
        createdBy: input.publishedBy,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.offer.published',
    actor: input.actor,
    payload: {
      offerKey: input.key,
      version: row.version,
      rung: input.rung,
      publishedBy: input.publishedBy,
    },
  });

  return ok(toOffer(row));
};

export const currentOffer = async (
  tenantId: string,
  key: string,
): Promise<Outcome<OfferRecord>> => {
  const row = await db().offerDefinition.findFirst({
    where: { tenantId, key, supersededAt: null },
    orderBy: { version: 'desc' },
  });
  return row ? ok(toOffer(row)) : noData(`No offer published under '${key}'.`);
};

/** The ladder, entry rung first. */
export const ladder = async (tenantId: string): Promise<readonly OfferRecord[]> => {
  const rows = await db().offerDefinition.findMany({
    where: { tenantId, supersededAt: null },
    orderBy: { rung: 'asc' },
  });
  return rows.map(toOffer);
};

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

export interface EngagementRecord {
  readonly id: string;
  readonly clientId: string;
  readonly offerId: string;
  readonly status: EngagementStatus;
  readonly startedOn: string;
  readonly committedThrough: string | null;
  readonly annualPrepay: boolean;
  readonly cancelledOn: string | null;
}

export const startEngagement = async (input: {
  tenantId: string;
  clientId: string;
  offerKey: string;
  startedOn: Date;
  annualPrepay?: boolean;
  actor: EventActor;
}): Promise<Outcome<EngagementRecord>> => {
  const offer = await currentOffer(input.tenantId, input.offerKey);
  if (offer.status !== 'ok') return offer as Outcome<EngagementRecord>;

  // The committed window is fixed at the offer version in force when the engagement started.
  // Deriving it later from the current offer would let a repricing move a client's commitment
  // under them - and the window is what the quality trigger and prepay proration run against.
  const committedThrough =
    offer.value.committedMonths > 0
      ? new Date(
          Date.UTC(
            input.startedOn.getUTCFullYear(),
            input.startedOn.getUTCMonth() + offer.value.committedMonths,
            input.startedOn.getUTCDate(),
          ),
        )
      : null;

  const row = await db().engagement.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      offerId: offer.value.id,
      startedOn: input.startedOn,
      committedThrough,
      annualPrepay: input.annualPrepay ?? false,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.engagement.started',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      engagementId: row.id,
      offerKey: input.offerKey,
      offerVersion: offer.value.version,
      annualPrepay: input.annualPrepay ?? false,
    },
  });

  return ok(toEngagement(row));
};

interface EngagementRow {
  id: string;
  clientId: string;
  offerId: string;
  status: string;
  startedOn: Date;
  committedThrough: Date | null;
  annualPrepay: boolean;
  cancelledOn: Date | null;
}

const toEngagement = (row: EngagementRow): EngagementRecord => ({
  id: row.id,
  clientId: row.clientId,
  offerId: row.offerId,
  status: row.status as EngagementStatus,
  startedOn: row.startedOn.toISOString(),
  committedThrough: row.committedThrough?.toISOString() ?? null,
  annualPrepay: row.annualPrepay,
  cancelledOn: row.cancelledOn?.toISOString() ?? null,
});

export const findEngagement = async (
  tenantId: string,
  engagementId: string,
): Promise<Outcome<EngagementRecord>> => {
  const row = await db().engagement.findFirst({ where: { tenantId, id: engagementId } });
  return row ? ok(toEngagement(row)) : noData('No such engagement in this tenant.');
};

export const cancelEngagement = async (input: {
  tenantId: string;
  engagementId: string;
  reason: string;
  cancelledOn: Date;
  actor: EventActor;
}): Promise<Outcome<EngagementRecord>> => {
  if (input.reason.trim() === '') {
    return refused(
      'A cancellation needs a reason. It is the fact that drives unearned-prepay refund entitlement, and a cancellation nobody can explain cannot be assessed.',
      'Blueprint 1.4 - refund logic driven by objective triggers',
    );
  }

  const existing = await db().engagement.findFirst({
    where: { tenantId: input.tenantId, id: input.engagementId },
  });
  if (!existing) return noData('No such engagement in this tenant.');

  const row = await db().engagement.update({
    where: { id: input.engagementId },
    data: {
      status: 'cancelled',
      cancelledOn: input.cancelledOn,
      cancelledReason: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.engagement.cancelled',
    actor: input.actor,
    clientId: existing.clientId,
    payload: { engagementId: input.engagementId, reason: input.reason },
  });

  return ok(toEngagement(row));
};

// ---------------------------------------------------------------------------
// Charges and payments
// ---------------------------------------------------------------------------

export interface BillingRecordEntry {
  readonly id: string;
  readonly kind: BillingRecordKind;
  readonly amountCents: Cents;
  readonly description: string;
  readonly approvedCreditLimitCents: Cents | null;
  readonly occurredOn: string;
}

export interface RecordChargeInput {
  readonly tenantId: string;
  readonly engagementId: string;
  readonly kind: BillingRecordKind;
  readonly amountCents: Cents;
  readonly description: string;
  /**
   * Only for a success fee, and only ever the **approved** figure. There is no parameter for a
   * requested limit - blueprint 1.4, the Seek Capital lesson, carried from 7.3's exhibit into what
   * is actually charged.
   */
  readonly approvedCreditLimitCents?: Cents;
  readonly occurredOn: Date;
  readonly recordedBy: string;
  readonly actor: EventActor;
}

export const recordBilling = async (
  input: RecordChargeInput,
): Promise<Outcome<BillingRecordEntry>> => {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    return refused(
      `${input.amountCents} is not a whole non-negative number of cents. The sign of a billing line is carried by its kind, not by the number - a negative charge would net against a refund in any query that summed them.`,
      'Blueprint 1.4 - money is integer cents',
    );
  }

  const engagement = await db().engagement.findFirst({
    where: { tenantId: input.tenantId, id: input.engagementId },
  });
  if (!engagement) return noData('No such engagement in this tenant.');

  const row = await db().billingRecord.create({
    data: {
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      kind: input.kind as never,
      amountCents: input.amountCents,
      description: input.description,
      approvedCreditLimitCents: input.approvedCreditLimitCents ?? null,
      occurredOn: input.occurredOn,
      createdBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.record.written',
    actor: input.actor,
    clientId: engagement.clientId,
    payload: {
      engagementId: input.engagementId,
      recordId: row.id,
      kind: input.kind,
      amountCents: input.amountCents,
    },
  });

  return ok(toRecord(row));
};

interface RecordRow {
  id: string;
  kind: string;
  amountCents: number;
  description: string;
  approvedCreditLimitCents: number | null;
  occurredOn: Date;
}

const toRecord = (row: RecordRow): BillingRecordEntry => ({
  id: row.id,
  kind: row.kind as BillingRecordKind,
  amountCents: row.amountCents,
  description: row.description,
  approvedCreditLimitCents: row.approvedCreditLimitCents,
  occurredOn: row.occurredOn.toISOString(),
});

export const recordsFor = async (
  tenantId: string,
  engagementId: string,
): Promise<readonly BillingRecordEntry[]> => {
  const rows = await db().billingRecord.findMany({
    where: { tenantId, engagementId },
    orderBy: { occurredOn: 'asc' },
  });
  return rows.map(toRecord);
};

export interface EngagementBalance {
  readonly charged: Cents;
  readonly paid: Cents;
  readonly refunded: Cents;
  readonly credited: Cents;
  /** What the client still owes. Never negative - an overpayment is a credit, not a debt. */
  readonly outstanding: Cents;
  /** Whether the engagement has met the offer's minimum. Reported, never enforced silently. */
  readonly meetsMinimum: boolean;
  readonly minimumCents: Cents;
}

/**
 * The balance, with each component named.
 *
 * Returning the components rather than a single net figure is the same discipline the capital
 * health score follows: "you owe $4,200" answers less than the four numbers that produced it, and
 * a client disputing an invoice is asking about one of the four.
 */
export const balanceOf = async (
  tenantId: string,
  engagementId: string,
): Promise<Outcome<EngagementBalance>> => {
  const engagement = await db().engagement.findFirst({
    where: { tenantId, id: engagementId },
    include: { offer: true },
  });
  if (!engagement) return noData('No such engagement in this tenant.');

  const records = await recordsFor(tenantId, engagementId);
  const of = (kind: BillingRecordKind): Cents =>
    sum(records.filter((record) => record.kind === kind).map((record) => record.amountCents));

  const charged = of('charge');
  const paid = of('payment');
  const refunded = of('refund');
  const credited = of('credit_applied');

  // Net receipts: what the client has actually parted with, after anything given back.
  const netReceived = paid + credited - refunded;

  return ok({
    charged,
    paid,
    refunded,
    credited,
    outstanding: atLeastZero(charged - netReceived),
    meetsMinimum: netReceived >= engagement.offer.minimumCents,
    minimumCents: engagement.offer.minimumCents,
  });
};

/**
 * Every engagement a client has had, oldest first.
 *
 * Added for the Compliance Evidence Vault (7.1), which assembles a client-scoped file across
 * engagements. Cancelled and completed ones are included: the file is the history.
 */
export const engagementsForClient = async (
  tenantId: string,
  clientId: string,
): Promise<readonly EngagementRecord[]> => {
  const rows = await db().engagement.findMany({
    where: { tenantId, clientId },
    orderBy: { startedOn: 'asc' },
  });
  return rows.map(toEngagement);
};
