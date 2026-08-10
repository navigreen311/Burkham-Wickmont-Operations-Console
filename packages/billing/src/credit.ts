/**
 * The credit chain across the offer ladder - blueprint 1.4, "credit / upgrade logic; credit chain
 * tracking across the offer ladder".
 *
 * A client moving up a rung carries forward what they already paid. The whole risk in that sentence
 * is double-crediting: the same $2,495 applied to two different upgrades, or applied once and then
 * again after a partial refund.
 *
 * So a credit **draws on a specific billing record**, not on an engagement total. The available
 * balance of a payment is that payment minus what has already been drawn from it, which makes
 * double-crediting arithmetically impossible rather than procedurally discouraged. A chain built on
 * totals would let two upgrades each see the same unspent balance and each take it.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { atLeastZero, formatMoney, sum, type Cents } from './money.js';

export interface CreditSource {
  readonly recordId: string;
  readonly engagementId: string;
  readonly paidCents: Cents;
  readonly alreadyDrawnCents: Cents;
  readonly availableCents: Cents;
  readonly occurredOn: string;
}

/**
 * What a client has paid that has not yet been carried forward.
 *
 * Refunds are netted off the source engagement before anything is offered as credit: money handed
 * back is not available to carry forward, and a chain that ignored refunds would credit a client
 * for a payment they no longer have with us.
 */
export const availableCredit = async (
  tenantId: string,
  clientId: string,
): Promise<readonly CreditSource[]> => {
  const engagements = await db().engagement.findMany({ where: { tenantId, clientId } });
  const sources: CreditSource[] = [];

  for (const engagement of engagements) {
    const records = await db().billingRecord.findMany({
      where: { tenantId, engagementId: engagement.id },
      orderBy: { occurredOn: 'asc' },
    });

    const payments = records.filter((record) => record.kind === 'payment');
    const refunded = sum(
      records.filter((record) => record.kind === 'refund').map((record) => record.amountCents),
    );

    // Refunds reduce the oldest payments first. Any order is defensible; what is not defensible is
    // leaving it implicit, because it decides how much credit a partially-refunded engagement can
    // still carry forward.
    let refundRemaining = refunded;

    for (const payment of payments) {
      const drawn = await db().creditApplication.aggregate({
        where: { tenantId, sourceRecordId: payment.id },
        _sum: { amountCents: true },
      });
      const alreadyDrawn = drawn._sum.amountCents ?? 0;

      const offsetByRefund = Math.min(refundRemaining, payment.amountCents);
      refundRemaining -= offsetByRefund;

      const available = atLeastZero(payment.amountCents - offsetByRefund - alreadyDrawn);
      if (available === 0) continue;

      sources.push({
        recordId: payment.id,
        engagementId: engagement.id,
        paidCents: payment.amountCents,
        alreadyDrawnCents: alreadyDrawn,
        availableCents: available,
        occurredOn: payment.occurredOn.toISOString(),
      });
    }
  }

  return sources;
};

export const totalAvailableCredit = async (tenantId: string, clientId: string): Promise<Cents> =>
  sum((await availableCredit(tenantId, clientId)).map((source) => source.availableCents));

export interface ApplyCreditInput {
  readonly tenantId: string;
  readonly clientId: string;
  /** The engagement receiving the credit - normally the upgraded one. */
  readonly toEngagementId: string;
  readonly amountCents: Cents;
  readonly rationale: string;
  readonly appliedBy: string;
  readonly appliedOn: Date;
  readonly actor: EventActor;
}

/**
 * Carry credit forward onto a later engagement.
 *
 * Draws from the oldest available payments first and records one `CreditApplication` per source,
 * so the trail says *which* payments funded the credit rather than only that a credit happened.
 * An operator answering "why is this client's balance what it is" needs the former.
 *
 * Refuses rather than clamping when the request exceeds what is available. Clamping would apply a
 * smaller credit than asked for and report success, and the difference would show up as an
 * unexplained balance on an invoice a client is reading.
 */
export const applyCredit = async (
  input: ApplyCreditInput,
): Promise<Outcome<{ applied: Cents }>> => {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return refused(
      `${input.amountCents} is not a positive whole number of cents.`,
      'Blueprint 1.4 - money is integer cents',
    );
  }
  if (input.rationale.trim() === '') {
    return refused(
      'A credit needs a rationale. It moves money between engagements, and an unexplained credit is indistinguishable from an error nobody caught.',
      'Blueprint 1.4 - credit chain tracking across the offer ladder',
    );
  }

  const target = await db().engagement.findFirst({
    where: { tenantId: input.tenantId, id: input.toEngagementId, clientId: input.clientId },
  });
  if (!target) return noData('No such engagement for this client.');

  const sources = (await availableCredit(input.tenantId, input.clientId)).filter(
    (source) => source.engagementId !== input.toEngagementId,
  );
  const available = sum(sources.map((source) => source.availableCents));

  if (available < input.amountCents) {
    return refused(
      `${formatMoney(input.amountCents)} of credit was requested and only ${formatMoney(available)} is available across this client's earlier payments. Applying the smaller figure and reporting success would leave an unexplained difference on an invoice the client reads.`,
      'Blueprint 1.4 - credit can never exceed what was actually paid',
    );
  }

  let remaining = input.amountCents;

  await db().$transaction(async (tx) => {
    for (const source of sources) {
      if (remaining === 0) break;
      const draw = Math.min(remaining, source.availableCents);

      await tx.creditApplication.create({
        data: {
          tenantId: input.tenantId,
          sourceRecordId: source.recordId,
          toEngagementId: input.toEngagementId,
          amountCents: draw,
          rationale: input.rationale,
          appliedOn: input.appliedOn,
          appliedBy: input.appliedBy,
        },
      });

      remaining -= draw;
    }

    await tx.billingRecord.create({
      data: {
        tenantId: input.tenantId,
        engagementId: input.toEngagementId,
        kind: 'credit_applied',
        amountCents: input.amountCents,
        description: `Credit carried forward: ${input.rationale}`,
        occurredOn: input.appliedOn,
        createdBy: input.appliedBy,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'billing.credit.applied',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      toEngagementId: input.toEngagementId,
      amountCents: input.amountCents,
      sourceRecordIds: sources.map((source) => source.recordId),
      rationale: input.rationale,
    },
  });

  return ok({ applied: input.amountCents });
};

export interface UpgradePath {
  readonly fromRung: number;
  readonly toRung: number;
  readonly creditAvailableCents: Cents;
  readonly newRetainerCents: Cents;
  /** What the client pays to move up, after credit. Never negative. */
  readonly netToPayCents: Cents;
  readonly note: string;
}

/**
 * What an upgrade would cost, before anybody commits to it.
 *
 * `netToPay` floors at zero rather than going negative: credit exceeding the new retainer does not
 * become a payment out, it stays as credit. Returning a negative here would read as "we owe them",
 * which is a different claim with different consequences, and the remaining balance is still
 * visible through `availableCredit`.
 */
export const quoteUpgrade = async (input: {
  tenantId: string;
  clientId: string;
  fromOfferKey: string;
  toOfferKey: string;
}): Promise<Outcome<UpgradePath>> => {
  const [from, to] = await Promise.all([
    db().offerDefinition.findFirst({
      where: { tenantId: input.tenantId, key: input.fromOfferKey, supersededAt: null },
      orderBy: { version: 'desc' },
    }),
    db().offerDefinition.findFirst({
      where: { tenantId: input.tenantId, key: input.toOfferKey, supersededAt: null },
      orderBy: { version: 'desc' },
    }),
  ]);

  if (!from || !to) return noData('One or both offers are not published.');

  if (to.rung <= from.rung) {
    return refused(
      `'${input.toOfferKey}' is at rung ${to.rung} and '${input.fromOfferKey}' at rung ${from.rung}. This is not an upgrade, and the credit chain is defined for movement up the ladder - a downgrade is a cancellation and a new engagement, which is a different conversation with the client.`,
      'Blueprint 1.4 - credit chain tracking across the offer ladder',
    );
  }

  const credit = await totalAvailableCredit(input.tenantId, input.clientId);

  return ok({
    fromRung: from.rung,
    toRung: to.rung,
    creditAvailableCents: credit,
    newRetainerCents: to.retainerCents,
    netToPayCents: atLeastZero(to.retainerCents - credit),
    note:
      credit >= to.retainerCents
        ? `${formatMoney(credit)} of credit covers the ${formatMoney(to.retainerCents)} retainer in full; ${formatMoney(credit - to.retainerCents)} remains available.`
        : `${formatMoney(credit)} of credit applies against the ${formatMoney(to.retainerCents)} retainer.`,
  });
};
