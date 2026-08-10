/**
 * Payment Command Calendar, promo expiry and re-stack windows — blueprint 5.1.
 *
 * Blueprint 5.1 calls for "promo period orchestration with 60/90-day expiration alerts" and a
 * "Payment Command Calendar (monthly productized deliverable)".
 *
 * These are computed here and surfaced as findings. The **scheduling** belongs to the Workflow
 * Engine (2.2), which already has a cron scheduler, wait states and SLA escalation — a second
 * timer living in this module would drift from that one, and the two would eventually disagree
 * about when a 60-day alert is due.
 */

import type { CapitalPosition } from './positions.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);

export interface PromoRunway {
  readonly positionId: string;
  readonly label: string;
  readonly endsOn: string;
  readonly daysRemaining: number;
  readonly promoAnnualRate: number;
  readonly goToAnnualRate: number;
  readonly balanceAtRisk: number;
  /**
   * Extra annual interest once the promotional rate ends, at today's balance.
   *
   * The number that makes the deadline concrete: "your rate goes to 24.99%" is abstract, and
   * "this begins costing $9,400 a year on 14 March" is not.
   */
  readonly annualCostAfterExpiry: number;
}

export const promoRunway = (positions: readonly CapitalPosition[], today: string): PromoRunway[] =>
  positions
    .filter((position) => position.promo !== null)
    .map((position) => {
      const promo = position.promo as NonNullable<CapitalPosition['promo']>;
      return {
        positionId: position.id,
        label: position.label,
        endsOn: promo.endsOn,
        daysRemaining: daysBetween(today, promo.endsOn),
        promoAnnualRate: promo.promoAnnualRate,
        goToAnnualRate: promo.goToAnnualRate,
        balanceAtRisk: position.outstandingBalance,
        annualCostAfterExpiry:
          position.outstandingBalance * (promo.goToAnnualRate - promo.promoAnnualRate),
      };
    })
    .sort((a, b) => a.daysRemaining - b.daysRemaining);

/**
 * The alert thresholds blueprint 5.1 names.
 *
 * Descending, and checked as "crossed into this band today" rather than "is below this number",
 * so a position does not re-alert every day for ninety days. An alert that fires daily is an
 * alert that gets filtered into a folder.
 */
export const PROMO_ALERT_DAYS = [90, 60, 30] as const;

export interface PromoAlert {
  readonly runway: PromoRunway;
  readonly threshold: number;
}

/**
 * Alerts due exactly today.
 *
 * Exact-day matching is deliberate: the Workflow Engine runs this daily, and "days remaining is
 * at or below 90" would fire on all ninety of them.
 */
export const promoAlertsDue = (
  positions: readonly CapitalPosition[],
  today: string,
): PromoAlert[] => {
  const alerts: PromoAlert[] = [];

  for (const runway of promoRunway(positions, today)) {
    const threshold = PROMO_ALERT_DAYS.find((days) => days === runway.daysRemaining);
    if (threshold !== undefined) alerts.push({ runway, threshold });
  }

  return alerts;
};

export interface PaymentObligation {
  readonly positionId: string;
  readonly label: string;
  readonly provider: string;
  readonly amount: number;
  readonly cadence: CapitalPosition['cadence'];
  /** Payments in a 30-day month, so cadences can be compared on one calendar. */
  readonly monthlyEquivalent: number;
}

const MONTHLY_MULTIPLE: Record<CapitalPosition['cadence'], number> = {
  daily: 21, // banking days in a month; remittances do not run on weekends
  weekly: 4.33,
  biweekly: 2.17,
  monthly: 1,
};

/**
 * The Payment Command Calendar's data.
 *
 * `monthlyEquivalent` exists because a stack routinely mixes a daily MCA remittance with a monthly
 * card minimum, and the two cannot be compared or summed without normalising. A client asking
 * "what do I owe each month" is asking for this number, and computing it by eye from mixed
 * cadences is how the answer comes out wrong.
 */
export const paymentCalendar = (positions: readonly CapitalPosition[]): PaymentObligation[] =>
  positions
    .filter((position) => position.paymentPerPeriod > 0)
    .map((position) => ({
      positionId: position.id,
      label: position.label,
      provider: position.provider,
      amount: position.paymentPerPeriod,
      cadence: position.cadence,
      monthlyEquivalent: position.paymentPerPeriod * MONTHLY_MULTIPLE[position.cadence],
    }))
    .sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);

export const totalMonthlyObligation = (positions: readonly CapitalPosition[]): number =>
  paymentCalendar(positions).reduce((sum, item) => sum + item.monthlyEquivalent, 0);

export interface RestackWindow {
  readonly positionId: string;
  readonly label: string;
  readonly opensOn: string;
  readonly reason: string;
}

/**
 * Re-Stack Calendar — when a position becomes a candidate for restructuring.
 *
 * A promotional window closing is the clearest trigger: the balance is about to become expensive,
 * and the window to move it opens before that, not after. Opening 45 days ahead leaves time for an
 * application to be prepared, authorized and decided.
 */
export const RESTACK_LEAD_DAYS = 45;

export const restackWindows = (
  positions: readonly CapitalPosition[],
  today: string,
): RestackWindow[] =>
  promoRunway(positions, today)
    .filter((runway) => runway.daysRemaining > 0)
    .map((runway) => ({
      positionId: runway.positionId,
      label: runway.label,
      opensOn: new Date(Date.parse(runway.endsOn) - RESTACK_LEAD_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10),
      reason: `Promotional rate ends ${runway.endsOn}; the balance then accrues at ${(runway.goToAnnualRate * 100).toFixed(2)}%, costing roughly ${Math.round(runway.annualCostAfterExpiry)} per year at today's balance.`,
    }));
