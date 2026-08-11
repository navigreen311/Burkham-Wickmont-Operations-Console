/**
 * 9.1 Executive KPI Dashboard - "the primary reporting surface to Gardner".
 *
 * Nine domains, from blueprint 9.1's data model. Every one returns a `Metric`, so a figure never
 * arrives without its denominator, its period and its coverage.
 *
 * **Nothing here is stored.** 11.6 Data Warehouse is not built, so this reads live from the
 * modules that own each fact - the same choice 7.1 made, and for the stronger reason here: a
 * stored snapshot needs a job, and a job that stops leaves a dashboard showing last month's
 * numbers with this month's date on them. That failure is invisible, and it is invisible on the
 * surface the company steers by.
 *
 * A domain with no measurable data returns a `null` metric NAMING WHAT WOULD MAKE IT APPEAR,
 * rather than a zero or an absent row. A dashboard full of dashes teaches its reader to ignore
 * dashes; "4 decided placements, 10 needed" teaches them what they are waiting for.
 */

import { db } from '@bwc/db';
import { ok, type Outcome } from '@bwc/core';
import { decidedIn, decidedInByProduct } from '@bwc/outcomes';
import { measured, rate, unmeasurable, type Metric, type Period } from './metric.js';
import {
  complianceDistribution,
  transitionSummary,
  type ComplianceDistribution,
  type TransitionSummary,
} from './compliance.js';

export interface ExecutiveDashboard {
  readonly tenantId: string;
  readonly period: Period;
  readonly generatedAt: string;

  // Compliance - blueprint 9.1's headline change, and the one metric with a stated target.
  readonly complianceDistribution: Metric<ComplianceDistribution>;
  readonly complianceMovement: Metric<TransitionSummary>;

  // Readiness, Placement, Defense, Partners, Client Success, Finance.
  readonly readinessImprovement: Metric<number>;
  readonly placementApprovalRate: Metric<number>;
  /** What we CAN measure about placement. Not the metric 9.1 asked for, and named so. */
  readonly internalGateRefusalRate: Metric<number>;
  readonly firewallResolutionRate: Metric<number>;
  readonly openCorrectionObligations: Metric<number>;
  readonly partnerConversionRate: Metric<number>;
  readonly refundRate: Metric<number>;
  readonly revenuePerClientCents: Metric<number>;

  /** Domains named in blueprint 9.1 that no module currently produces. */
  readonly unproduced: readonly { readonly domain: string; readonly awaiting: string }[];
}

/**
 * Domains the specification names that nothing measures yet.
 *
 * Carried on every dashboard rather than omitted, for 7.1's reason applied to numbers: a
 * dashboard silently missing a domain asserts a completeness it does not have, and the reader
 * concludes the company has no forecast-accuracy problem because there is no forecast-accuracy row.
 */
export const UNPRODUCED_DOMAINS: readonly { domain: string; awaiting: string }[] = [
  {
    domain: 'Placement - approval rate by product',
    awaiting:
      'Only approvals are recorded. Denials and adverse-action notices belong to 5.5 Funding Outcome Ledger (V1.5), so the denominator does not exist and a rate would read 100% forever.',
  },
  {
    domain: 'Stack Management - utilization under target',
    awaiting:
      '5.1 computes utilization from supplied positions, and no feed supplies them: Plaid and issuer integrations are ungated (Decision A).',
  },
  {
    domain: 'Advisory - forecast accuracy',
    awaiting:
      'Nothing records a forecast, so nothing can be compared against an outcome. A forecast store would be the module to build first.',
  },
  {
    domain: 'Client Success - NPS',
    awaiting: 'No survey instrument exists. 4.1 could carry one; nothing collects a score today.',
  },
  {
    domain: 'Client Success - complaint rate',
    awaiting:
      '6.3 Client Conduct Monitoring is V1.5. 5.4 holds complaints about PROVIDERS, which is a different record and not a substitute.',
  },
  {
    domain: 'Finance - gross margin',
    awaiting:
      'Vendor COGS (Plaid subscription, bureau pulls) cannot be measured while both are ungated. 9.2 reports margin before unmeasured costs rather than a margin.',
  },
];

/**
 * Assemble the dashboard.
 *
 * Every metric is computed independently and a failure in one does not abort the rest - 7.1's
 * rule, and for the same reason: the dashboard is most wanted when something is already wrong.
 */
export const executiveDashboard = async (input: {
  tenantId: string;
  period: Period;
  now?: Date;
}): Promise<Outcome<ExecutiveDashboard>> => {
  const now = input.now ?? new Date();
  const { tenantId, period } = input;

  const [distribution, movement] = await Promise.all([
    complianceDistribution(tenantId, period),
    transitionSummary(tenantId, period),
  ]);

  const [readiness, placement, gate, firewall, obligations, partners, refunds, revenue] =
    await Promise.all([
      readinessImprovement(tenantId, period),
      placementApprovalRate(tenantId, period),
      internalGateRefusalRate(tenantId, period),
      firewallResolutionRate(tenantId, period),
      openCorrectionObligations(tenantId, period, now),
      partnerConversionRate(tenantId, period),
      refundRate(tenantId, period),
      revenuePerClient(tenantId, period),
    ]);

  return ok({
    tenantId,
    period,
    generatedAt: now.toISOString(),
    complianceDistribution: distribution,
    complianceMovement: movement,
    readinessImprovement: readiness,
    placementApprovalRate: placement,
    internalGateRefusalRate: gate,
    firewallResolutionRate: firewall,
    openCorrectionObligations: obligations,
    partnerConversionRate: partners,
    refundRate: refunds,
    revenuePerClientCents: revenue,
    unproduced: UNPRODUCED_DOMAINS,
  });
};

/**
 * Readiness - blueprint 9.1's "score improvement".
 *
 * Mean change per client between their first and last reading IN THE PERIOD, over clients with at
 * least two readings. A client with one reading has not improved or worsened; including them at
 * zero would drag the mean toward zero in proportion to how many clients are new, which is a
 * number that moves when nothing about readiness changed.
 */
export const readinessImprovement = async (
  tenantId: string,
  period: Period,
): Promise<Metric<number>> => {
  const readings = await db().readinessReading.findMany({
    where: { tenantId, takenOn: { gte: period.from, lt: period.to } },
    orderBy: [{ takenOn: 'asc' }, { id: 'asc' }],
    select: { leadId: true, readiness: true },
  });

  const byLead = new Map<string, number[]>();
  for (const reading of readings) {
    const list = byLead.get(reading.leadId) ?? [];
    list.push(reading.readiness);
    byLead.set(reading.leadId, list);
  }

  const deltas: number[] = [];
  for (const list of byLead.values()) {
    if (list.length >= 2) deltas.push((list.at(-1) as number) - (list[0] as number));
  }

  if (deltas.length === 0) {
    return unmeasurable({
      key: 'readiness_improvement',
      label: 'Mean readiness improvement',
      period,
      denominator: byLead.size,
      note: `${byLead.size} client(s) have a readiness reading in this period and none has two, so no change can be measured. A single reading is a position, not an improvement.`,
    });
  }

  const mean = deltas.reduce((total, delta) => total + delta, 0) / deltas.length;

  return measured({
    key: 'readiness_improvement',
    label: 'Mean readiness improvement',
    value: mean,
    numerator: deltas.length,
    denominator: byLead.size,
    period,
    note: `Mean change of ${mean.toFixed(1)} points across ${deltas.length} client(s) with at least two readings. ${byLead.size - deltas.length} client(s) had one reading and are excluded - a single reading is a position, not an improvement.`,
  });
};

/**
 * Placement - blueprint 9.1's "approval rate by product".
 *
 * **This metric spent its whole life refusing, and the refusal is worth keeping in view.**
 *
 * It used to count `billing.funding_outcomes`, which records an approval: an approved credit limit
 * and an approval date, and no column for a denial. So the denominator did not exist, every row in
 * the table was an approval, and a rate computed from it would have read 100% forever - a figure
 * arithmetically correct, extremely reassuring, and completely meaningless. It would also have been
 * the single most damaging number on this dashboard, because "our approval rate is 100%" is exactly
 * the claim the Marketing Claim Library bans and the Funding Ethics Firewall exists downstream of.
 *
 * 5.5 Funding Outcome Ledger records the attempt rather than the approval, so a decline is a row.
 * **The fix was never arithmetic; it was that the denominator had to be collected.** The refusal
 * has not gone away either: it moved to where it belongs, and `decidedIn` still returns `null`
 * below ten decided attempts rather than a percentage computed from three.
 *
 * What this counts is capital providers deciding. How many placements this company's own gate
 * stopped before they reached one is a different number and is reported separately, under its own
 * name - calling that an approval rate would be a different figure wearing this label.
 */
export const placementApprovalRate = async (
  tenantId: string,
  period: Period,
): Promise<Metric<number>> => {
  const counts = await decidedIn(tenantId, { from: period.from, to: period.to });

  if (counts.rate === null) {
    return unmeasurable({
      key: 'placement_approval_rate',
      label: 'Placement approval rate',
      period,
      numerator: counts.approved,
      denominator: counts.decided,
      note: counts.note,
    });
  }

  return measured({
    key: 'placement_approval_rate',
    label: 'Placement approval rate',
    value: counts.rate,
    numerator: counts.approved,
    denominator: counts.decided,
    period,
    note: counts.note,
  });
};

/**
 * The same rate for one product - the form blueprint 9.1 actually asks for.
 *
 * Separate rather than a parameter with a default, because "our approval rate" and "our approval
 * rate for merchant cash advances" are different claims and a defaulted argument makes the second
 * one answer to the first one's name.
 */
export const placementApprovalRateByProduct = async (
  tenantId: string,
  period: Period,
  productKind: string,
): Promise<Metric<number>> => {
  const counts = await decidedInByProduct(
    tenantId,
    { from: period.from, to: period.to },
    productKind,
  );

  if (counts.rate === null) {
    return unmeasurable({
      key: `placement_approval_rate:${productKind}`,
      label: `Placement approval rate - ${productKind}`,
      period,
      numerator: counts.approved,
      denominator: counts.decided,
      note: counts.note,
    });
  }

  return measured({
    key: `placement_approval_rate:${productKind}`,
    label: `Placement approval rate - ${productKind}`,
    value: counts.rate,
    numerator: counts.approved,
    denominator: counts.decided,
    period,
    note: counts.note,
  });
};

/**
 * How many placement attempts this company's own gate stopped.
 *
 * Deliberately NOT called an approval rate. It measures us, not the capital providers: a placement
 * refused at the gate never reached one. Reported because it is real and useful - a rising
 * refusal share means the compliance gate is doing more work, which is worth knowing either way -
 * and named so nobody reads it as the metric 9.1 asked for.
 */
export const internalGateRefusalRate = async (
  tenantId: string,
  period: Period,
): Promise<Metric<number>> => {
  const [refused, recommended] = await Promise.all([
    db().ledgerEvent.count({
      where: {
        tenantId,
        type: 'placement.refused',
        createdAt: { gte: period.from, lt: period.to },
      },
    }),
    db().ledgerEvent.count({
      where: {
        tenantId,
        type: 'placement.recommended',
        createdAt: { gte: period.from, lt: period.to },
      },
    }),
  ]);

  return rate({
    key: 'internal_gate_refusal_rate',
    label: 'Placement attempts refused at our own gate',
    numerator: refused,
    denominator: refused + recommended,
    period,
    whatCounts: 'placement attempt(s)',
  });
};

/**
 * Defense - blueprint 9.1's "alert resolution rate".
 *
 * 6.1's three-tier alerting is V1.5, so the measurable proxy is the Firewall: how many triggers in
 * the period have been cleared. Named `firewallResolutionRate` rather than `alertResolutionRate`,
 * because calling it the latter would report a number for a module that does not exist.
 */
export const firewallResolutionRate = async (
  tenantId: string,
  period: Period,
): Promise<Metric<number>> => {
  const [triggered, cleared] = await Promise.all([
    db().ledgerEvent.count({
      where: {
        tenantId,
        type: 'firewall.triggered',
        createdAt: { gte: period.from, lt: period.to },
      },
    }),
    db().ledgerEvent.count({
      where: { tenantId, type: 'firewall.cleared', createdAt: { gte: period.from, lt: period.to } },
    }),
  ]);

  if (triggered === 0) {
    return unmeasurable({
      key: 'firewall_resolution_rate',
      label: 'Firewall resolution rate',
      period,
      numerator: cleared,
      denominator: 0,
      unmeasured: ['6.1 Risk & Defense Alerts (three-tier) is V1.5'],
      note: 'The Funding Ethics Firewall was not triggered in this period, so there is no resolution rate. Zero would read as "nothing was resolved", which is the opposite of what happened.',
    });
  }

  return rate({
    key: 'firewall_resolution_rate',
    label: 'Firewall resolution rate',
    numerator: cleared,
    denominator: triggered,
    period,
    minimum: 1,
    whatCounts: 'firewall trigger(s)',
  });
};

/**
 * Defense - open correction obligations from 4.3.
 *
 * A count rather than a rate, and overdue ones separated in the note. This is the number a
 * Concierge lead acts on directly, and turning it into a percentage would hide the thing that
 * matters: whether anybody is behind.
 */
export const openCorrectionObligations = async (
  tenantId: string,
  period: Period,
  now: Date,
): Promise<Metric<number>> => {
  const rows = await db().correctionObligation.findMany({
    where: { tenantId, status: 'open' },
    select: { dueAt: true },
  });

  const overdue = rows.filter((row) => row.dueAt.getTime() < now.getTime()).length;

  return measured({
    key: 'open_correction_obligations',
    label: 'Open call-promise corrections',
    value: rows.length,
    numerator: overdue,
    denominator: rows.length,
    period,
    note:
      rows.length === 0
        ? 'No correction obligations are open. Note this counts obligations RAISED, and none are raised for calls with no transcript - VoiceForge is ungated.'
        : `${rows.length} open, of which ${overdue} are past their correction window. Counted as of now rather than for the period: an obligation raised in June and still open is today's problem.`,
  });
};

/** Partners - blueprint 9.1's "referral-to-client conversion". */
export const partnerConversionRate = async (
  tenantId: string,
  period: Period,
): Promise<Metric<number>> => {
  const leads = await db().lead.findMany({
    where: {
      tenantId,
      referrerPartnerId: { not: null },
      attributedAt: { gte: period.from, lt: period.to },
    },
    select: { outcome: { select: { converted: true } } },
  });

  const decided = leads.filter((lead) => lead.outcome !== null).length;
  const converted = leads.filter((lead) => lead.outcome?.converted === true).length;

  return rate({
    key: 'partner_conversion_rate',
    label: 'Partner referral-to-client conversion',
    numerator: converted,
    denominator: decided,
    period,
    whatCounts: 'decided partner referral(s)',
  });
};

/** Client Success - refund rate, as a share of engagements with a decided refund position. */
export const refundRate = async (tenantId: string, period: Period): Promise<Metric<number>> => {
  const [paid, declined] = await Promise.all([
    db().ledgerEvent.count({
      where: {
        tenantId,
        type: 'billing.refund.paid',
        createdAt: { gte: period.from, lt: period.to },
      },
    }),
    db().ledgerEvent.count({
      where: {
        tenantId,
        type: 'billing.refund.declined',
        createdAt: { gte: period.from, lt: period.to },
      },
    }),
  ]);

  return rate({
    key: 'refund_rate',
    label: 'Refund rate',
    numerator: paid,
    denominator: paid + declined,
    period,
    whatCounts: 'decided refund position(s)',
  });
};

/**
 * Finance - revenue per client.
 *
 * Revenue BILLED in the period over clients with an engagement in the period. Billed rather than
 * collected, and the note says so: this system records charges, not receipts, and describing
 * billed revenue as revenue collected would overstate cash on the surface the founder uses to
 * decide whether the business can pay for itself.
 */
export const revenuePerClient = async (
  tenantId: string,
  period: Period,
): Promise<Metric<number>> => {
  const records = await db().billingRecord.findMany({
    where: { tenantId, occurredOn: { gte: period.from, lt: period.to } },
    select: { amountCents: true, kind: true, engagement: { select: { clientId: true } } },
  });

  const clients = new Set<string>();
  let billed = 0;

  for (const record of records) {
    if (record.kind !== 'charge') continue;
    billed += record.amountCents;
    clients.add(record.engagement.clientId);
  }

  if (clients.size === 0) {
    return unmeasurable({
      key: 'revenue_per_client',
      label: 'Revenue billed per client',
      period,
      denominator: 0,
      note: 'No client was billed in this period, so there is no per-client figure. Zero would read as clients billed nothing, rather than as no clients billed.',
    });
  }

  return measured({
    key: 'revenue_per_client',
    label: 'Revenue billed per client',
    value: Math.round(billed / clients.size),
    numerator: billed,
    denominator: clients.size,
    period,
    note: `${billed} cents billed across ${clients.size} client(s). BILLED, not collected - this system records charges and not receipts. Only charge lines count: payments, refunds and applied credits are separate kinds, and summing them together would net a refund against a charge, which is the failure the sign-by-kind rule in 1.4 exists to prevent.`,
  });
};

/**
 * The Gardner rollup - blueprint 9.1's "Gardner-facing rollup with PII stripped".
 *
 * The stripping is STRUCTURAL. `GardnerRollup` has no field that could hold a client identifier,
 * so there is no path by which one arrives - rather than a redaction pass over a richer object,
 * which works until somebody adds a field.
 *
 * Every value is a count, a share or a cents figure over the whole book. Client names, ids and
 * per-client rows are not omitted from this type; they were never expressible in it.
 */
export interface GardnerRollup {
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly periodPartial: boolean;
  readonly clients: number;
  readonly complianceCounts: Readonly<Record<string, number>>;
  readonly healthyShare: number | null;
  readonly meetsComplianceTarget: boolean | null;
  readonly placementApprovalRate: number | null;
  readonly revenuePerClientCents: number | null;
  readonly openCorrectionObligations: number;
  /** Every metric that could not be computed, and why. Carried, never dropped. */
  readonly withheld: readonly { readonly key: string; readonly note: string }[];
}

export const gardnerRollup = (dashboard: ExecutiveDashboard): GardnerRollup => {
  const metrics: readonly Metric<unknown>[] = [
    dashboard.complianceDistribution,
    dashboard.complianceMovement,
    dashboard.readinessImprovement,
    dashboard.placementApprovalRate,
    dashboard.internalGateRefusalRate,
    dashboard.firewallResolutionRate,
    dashboard.partnerConversionRate,
    dashboard.refundRate,
    dashboard.revenuePerClientCents,
  ];

  const distribution = dashboard.complianceDistribution.value;

  return {
    periodFrom: dashboard.period.from.toISOString(),
    periodTo: dashboard.period.to.toISOString(),
    periodPartial: dashboard.period.partial,
    clients: distribution?.clients ?? 0,
    complianceCounts: distribution?.counts ?? {},
    healthyShare: distribution?.healthyShare ?? null,
    meetsComplianceTarget: distribution?.meetsTarget ?? null,
    placementApprovalRate: dashboard.placementApprovalRate.value,
    revenuePerClientCents: dashboard.revenuePerClientCents.value,
    openCorrectionObligations: dashboard.openCorrectionObligations.value ?? 0,
    // A rollup that quietly omitted its gaps would let a portfolio view read as complete. The
    // withheld list travels with it for the same reason 7.1's coverage map travels with a file.
    withheld: metrics
      .filter((metric) => metric.value === null)
      .map((metric) => ({ key: metric.key, note: metric.note })),
  };
};
