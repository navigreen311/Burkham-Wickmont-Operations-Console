/**
 * 9.2 Unit Economics Dashboard - "financial health of the service model".
 *
 * The dashboard the founder uses to decide whether the business works, which makes it the one
 * where a confident wrong number costs the most.
 *
 * Three things this file will not do, each for a reason stated where it is enforced:
 *
 *   it will not report a gross margin while the vendor COGS lines are unmeasurable
 *   it will not project LTV
 *   it will not compute CAC from spend it invented
 */

import { db } from '@bwc/db';
import { ok, refused, type Outcome } from '@bwc/core';
import type { Cents } from '@bwc/billing';
import { measured, unmeasurable, type Metric, type Period } from './metric.js';
import { UNMEASURED_COST_LINES, unmeasuredCostLineNames } from './costs.js';

export interface OfferEconomics {
  readonly offerKey: string;
  readonly engagements: number;
  readonly billedCents: Cents;
  readonly refundedCents: Cents;
  readonly creditedCents: Cents;
  /**
   * Billed minus refunds and credits, BEFORE any vendor cost.
   *
   * Named for what it excludes. `grossMargin` would be a lie by omission - see `UNMEASURED` and
   * ADR-0017. The awkward name is the point: a caller cannot use this while believing it is a
   * margin.
   */
  readonly marginBeforeUnmeasuredCostsCents: Cents;
  readonly unmeasuredCostLines: readonly string[];
}

/**
 * Per-offer economics - blueprint 9.2's "per-offer P&L" and "gross margin per offer".
 *
 * Every figure is a cents integer, per ADR-0011, and refunds and credits are subtracted rather
 * than netted in the source query: 1.4 carries the sign by KIND rather than by the number
 * precisely so a sum cannot silently offset a refund against a charge, and reproducing that
 * offset here would undo it.
 */
export const offerEconomics = async (
  tenantId: string,
  period: Period,
): Promise<Metric<readonly OfferEconomics[]>> => {
  const engagements = await db().engagement.findMany({
    where: { tenantId, startedOn: { lt: period.to } },
    select: {
      id: true,
      offer: { select: { key: true } },
      records: {
        where: { occurredOn: { gte: period.from, lt: period.to } },
        select: { kind: true, amountCents: true },
      },
    },
  });

  if (engagements.length === 0) {
    return unmeasurable({
      key: 'offer_economics',
      label: 'Per-offer economics',
      period,
      denominator: 0,
      unmeasured: unmeasuredCostLineNames(),
      note: 'No engagement existed in this period, so there is no per-offer P&L. An empty book, not a break-even one.',
    });
  }

  const byOffer = new Map<
    string,
    { engagements: number; billed: number; refunded: number; credited: number }
  >();

  for (const engagement of engagements) {
    const bucket = byOffer.get(engagement.offer.key) ?? {
      engagements: 0,
      billed: 0,
      refunded: 0,
      credited: 0,
    };
    bucket.engagements += 1;
    for (const record of engagement.records) {
      if (record.kind === 'charge') bucket.billed += record.amountCents;
      else if (record.kind === 'refund') bucket.refunded += record.amountCents;
      else if (record.kind === 'credit_applied') bucket.credited += record.amountCents;
      // `payment` is deliberately not counted. It is cash arriving against a charge already
      // counted; adding it would double-count every engagement that actually paid.
    }
    byOffer.set(engagement.offer.key, bucket);
  }

  const value: OfferEconomics[] = [...byOffer.entries()]
    .map(([offerKey, bucket]) => ({
      offerKey,
      engagements: bucket.engagements,
      billedCents: bucket.billed,
      refundedCents: bucket.refunded,
      creditedCents: bucket.credited,
      marginBeforeUnmeasuredCostsCents: bucket.billed - bucket.refunded - bucket.credited,
      unmeasuredCostLines: unmeasuredCostLineNames(),
    }))
    .sort((a, b) => a.offerKey.localeCompare(b.offerKey));

  return measured({
    key: 'offer_economics',
    label: 'Per-offer economics',
    value,
    denominator: engagements.length,
    period,
    unmeasured: unmeasuredCostLineNames(),
    note: `${value.length} offer(s) across ${engagements.length} engagement(s). Margin is BEFORE ${UNMEASURED_COST_LINES.length} vendor cost line(s) that cannot be measured while Plaid and the bureaus are ungated - it is not a gross margin, and is named so.`,
  });
};

/**
 * Gross margin.
 *
 * **Refused**, and the refusal is the feature. Blueprint 9.2 defines gross margin as including
 * per-client vendor costs, and those cannot be measured. A margin reported without them is wrong
 * in a known direction by an unknown amount, on the surface the founder steers by.
 *
 * `offerEconomics` gives the same arithmetic under a name that says what it excludes. A caller who
 * wants the number can have it; they cannot have it called a margin.
 */
export const grossMargin = async (tenantId: string): Promise<Outcome<never>> =>
  refused(
    `Gross margin cannot be computed for tenant ${tenantId}. Blueprint 9.2 defines it as including per-client vendor costs, and ${UNMEASURED_COST_LINES.map((entry) => entry.line).join(', ')} are all unmeasurable while Plaid and the bureaus are ungated. Use marginBeforeUnmeasuredCostsCents from offerEconomics, which is the same arithmetic under a name that says what it leaves out.`,
    'Blueprint 9.2 - vendor costs are COGS lines feeding gross margin',
  );

export interface ChannelAcquisition {
  readonly sourceChannel: string;
  readonly converted: number;
  /** Null when the caller supplied no spend for this channel. */
  readonly spendCents: Cents | null;
  /**
   * Null in two different situations, and the pair matters: no spend was supplied, or spend was
   * supplied and nothing converted. Neither is zero - a CAC of zero would say this channel
   * acquires clients for nothing.
   */
  readonly cacCents: Cents | null;
}

/**
 * CAC by channel - blueprint 9.2.
 *
 * **Spend is a required argument**, not a lookup. No module in this system owns marketing spend:
 * 4.5 holds campaigns and their channel values but no budget, and inventing a spend store here
 * would put the company's cost base in a dashboard package and make it a second source of truth
 * the day a finance system arrives. 5.1 made the same call with capital positions.
 *
 * A channel with conversions and no supplied spend is reported with its conversion count and
 * `cacCents: null` rather than being dropped - a channel missing from a CAC report reads as a
 * channel that acquired nobody.
 */
export const acquisitionCost = async (
  tenantId: string,
  period: Period,
  spendByChannelCents: Readonly<Record<string, Cents>>,
): Promise<Metric<readonly ChannelAcquisition[]>> => {
  const leads = await db().lead.findMany({
    where: { tenantId, attributedAt: { gte: period.from, lt: period.to } },
    select: { sourceChannel: true, outcome: { select: { converted: true } } },
  });

  if (leads.length === 0) {
    return unmeasurable({
      key: 'cac_by_channel',
      label: 'Customer acquisition cost by channel',
      period,
      denominator: 0,
      note: 'No lead was attributed in this period, so there is nothing to divide spend by. Any spend in the period bought nothing measurable, which is a finding rather than a CAC.',
    });
  }

  const byChannel = new Map<string, number>();
  for (const lead of leads) {
    if (lead.outcome?.converted === true) {
      byChannel.set(lead.sourceChannel, (byChannel.get(lead.sourceChannel) ?? 0) + 1);
    } else if (!byChannel.has(lead.sourceChannel)) {
      byChannel.set(lead.sourceChannel, 0);
    }
  }

  const missingSpend: string[] = [];
  const value: ChannelAcquisition[] = [...byChannel.entries()]
    .map(([sourceChannel, converted]) => {
      const spend = spendByChannelCents[sourceChannel];
      if (spend === undefined) {
        missingSpend.push(sourceChannel);
        return { sourceChannel, converted, spendCents: null, cacCents: null };
      }
      if (converted === 0) {
        // Spend with no conversions. CAC is not infinity and it is not zero; it is undefined, and
        // the spend figure is the thing worth looking at.
        return { sourceChannel, converted, spendCents: spend, cacCents: null };
      }
      return {
        sourceChannel,
        converted,
        spendCents: spend,
        // Rounded to whole cents. A fractional cent of CAC is a number nobody agreed - ADR-0011.
        cacCents: Math.round(spend / converted),
      };
    })
    .sort((a, b) => a.sourceChannel.localeCompare(b.sourceChannel));

  return measured({
    key: 'cac_by_channel',
    label: 'Customer acquisition cost by channel',
    value,
    denominator: byChannel.size,
    period,
    unmeasured: missingSpend.map((channel) => `spend for channel '${channel}'`),
    note: `${byChannel.size} channel(s) attributed in this period.${missingSpend.length > 0 ? ` No spend was supplied for: ${missingSpend.join(', ')} - these are shown with their conversion counts and no CAC, because a channel missing from a CAC report reads as a channel that acquired nobody.` : ''} Spend is supplied by the caller: no module in this system owns marketing spend, and inventing a store for it here would create a second source of truth.`,
  });
};

/**
 * Realised revenue per client - what blueprint 9.2 calls "LTV by client type", minus the L.
 *
 * LTV is a PROJECTION. It needs a churn rate, an expansion rate and a discount assumption, and
 * with the client counts this system holds, all three would be invented. A projection sitting next
 * to measured figures is read as a measurement - and this one would be read by the person deciding
 * how much to spend acquiring the next client.
 *
 * So what is reported is what has actually been billed per client to date, by offer tier. It is a
 * floor on lifetime value, it is a measurement, and it says which it is.
 */
export interface RealisedRevenue {
  readonly offerKey: string;
  readonly clients: number;
  readonly billedCents: Cents;
  readonly perClientCents: Cents;
  readonly meanTenureDays: number;
}

export const realisedRevenuePerClient = async (
  tenantId: string,
  now: Date,
): Promise<Metric<readonly RealisedRevenue[]>> => {
  const engagements = await db().engagement.findMany({
    where: { tenantId },
    select: {
      offer: { select: { key: true } },
      clientId: true,
      startedOn: true,
      records: { select: { kind: true, amountCents: true } },
    },
  });

  const period: Period = { from: new Date(0), to: now, partial: false };

  if (engagements.length === 0) {
    return unmeasurable({
      key: 'realised_revenue_per_client',
      label: 'Realised revenue per client, to date',
      period,
      denominator: 0,
      note: 'No engagement is on record, so nothing has been realised.',
    });
  }

  const byOffer = new Map<string, { clients: Set<string>; billed: number; tenureDays: number[] }>();

  for (const engagement of engagements) {
    const bucket = byOffer.get(engagement.offer.key) ?? {
      clients: new Set<string>(),
      billed: 0,
      tenureDays: [],
    };
    bucket.clients.add(engagement.clientId);
    for (const record of engagement.records) {
      if (record.kind === 'charge') bucket.billed += record.amountCents;
      else if (record.kind === 'refund') bucket.billed -= record.amountCents;
    }
    bucket.tenureDays.push(
      Math.max(
        0,
        Math.round((now.getTime() - engagement.startedOn.getTime()) / (24 * 60 * 60 * 1000)),
      ),
    );
    byOffer.set(engagement.offer.key, bucket);
  }

  const value: RealisedRevenue[] = [...byOffer.entries()]
    .map(([offerKey, bucket]) => ({
      offerKey,
      clients: bucket.clients.size,
      billedCents: bucket.billed,
      perClientCents: Math.round(bucket.billed / bucket.clients.size),
      meanTenureDays: Math.round(
        bucket.tenureDays.reduce((total, days) => total + days, 0) / bucket.tenureDays.length,
      ),
    }))
    .sort((a, b) => a.offerKey.localeCompare(b.offerKey));

  return measured({
    key: 'realised_revenue_per_client',
    label: 'Realised revenue per client, to date',
    value,
    denominator: engagements.length,
    period,
    note: `Billed to date, net of refunds, per client, by offer. This is a MEASUREMENT and a floor on lifetime value - not LTV. Mean tenure is shown alongside so a reader can see how much of a lifetime these figures actually cover.`,
  });
};

/**
 * Projected lifetime value.
 *
 * **Refused.** It would need a churn rate this system has not observed, an expansion rate it has
 * not observed, and a discount rate nobody has set. Producing one would mean choosing all three,
 * and the number would then be compared against a measured CAC to decide whether acquisition is
 * profitable - a decision made on two figures where only one is real.
 *
 * The refusal names what would make it computable, so it becomes a piece of work rather than a
 * permanent gap.
 */
export const projectedLtv = async (tenantId: string): Promise<Outcome<never>> =>
  refused(
    `Projected LTV cannot be computed for tenant ${tenantId}. It requires an observed churn rate, an observed expansion rate and a chosen discount rate; this system has recorded no completed client lifecycles, so all three would be assumptions presented next to measured figures. Use realisedRevenuePerClient, which is a measurement and a floor. This becomes computable once enough engagements have ENDED to observe retention - the missing input is time and outcomes, not code.`,
    'Blueprint 9.2 with design principle 9 - a projection presented as a measurement is worse than an absent metric',
  );

export interface UnitEconomicsDashboard {
  readonly tenantId: string;
  readonly period: Period;
  readonly generatedAt: string;
  readonly offerEconomics: Metric<readonly OfferEconomics[]>;
  readonly acquisitionCost: Awaited<ReturnType<typeof acquisitionCost>>;
  readonly realisedRevenuePerClient: Metric<readonly RealisedRevenue[]>;
  /** The COGS lines 9.2 requires and nothing can measure, with the gate each is behind. */
  readonly unmeasuredCostLines: typeof UNMEASURED_COST_LINES;
  /**
   * Metrics 9.2 names that this module deliberately refuses rather than approximates.
   * Carried so the absence is a stated decision rather than a missing row.
   */
  readonly refused: readonly { readonly metric: string; readonly why: string }[];
}

export const unitEconomicsDashboard = async (input: {
  tenantId: string;
  period: Period;
  spendByChannelCents?: Readonly<Record<string, Cents>>;
  now?: Date;
}): Promise<Outcome<UnitEconomicsDashboard>> => {
  const now = input.now ?? new Date();

  const [offers, cac, realised] = await Promise.all([
    offerEconomics(input.tenantId, input.period),
    acquisitionCost(input.tenantId, input.period, input.spendByChannelCents ?? {}),
    realisedRevenuePerClient(input.tenantId, now),
  ]);

  return ok({
    tenantId: input.tenantId,
    period: input.period,
    generatedAt: now.toISOString(),
    offerEconomics: offers,
    acquisitionCost: cac,
    realisedRevenuePerClient: realised,
    unmeasuredCostLines: UNMEASURED_COST_LINES,
    refused: [
      {
        metric: 'Gross margin',
        why: 'Defined by 9.2 as including per-client vendor costs, which are unmeasurable while Plaid and the bureaus are ungated. Reported as margin BEFORE unmeasured costs instead.',
      },
      {
        metric: 'Projected LTV',
        why: 'Requires observed churn, observed expansion and a chosen discount rate. None exists; all three would be assumptions sitting next to measurements.',
      },
      {
        metric: 'Cost per funded dollar',
        why: 'Requires funded amounts, which come from 5.5 Funding Outcome Ledger (V1.5). Only approvals are recorded today.',
      },
    ],
  });
};
