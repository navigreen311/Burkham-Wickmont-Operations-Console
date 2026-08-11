/**
 * Appetite signals and approval-rate tracking - blueprint 5.2.
 *
 * Both are claims about the near future made from the recent past, and both are wrong in
 * the same way if built carelessly: they present a number without the sample or the age
 * that would let a reader discount it.
 *
 * So an approval rate below the minimum sample is `null`, never a percentage, and an
 * appetite signal always reports how old it is.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, type EventActor, type Outcome } from '@bwc/core';
import type { ProductKind } from './suitability.js';

// ---------------------------------------------------------------------------
// Appetite
// ---------------------------------------------------------------------------

export type AppetiteValue = 'expanding' | 'steady' | 'tightening' | 'paused';

/**
 * Blueprint 5.2 specifies weekly updates. Fourteen days is two missed cycles - the point
 * where "we update this weekly" stops being true of a particular provider.
 */
export const APPETITE_STALE_AFTER_DAYS = 14;

export interface AppetiteReading {
  readonly providerId: string;
  readonly signal: AppetiteValue;
  readonly note: string;
  readonly observedBy: string;
  readonly observedAt: string;
  readonly ageDays: number;
  /** True when the reading is older than the weekly cadence should allow. */
  readonly stale: boolean;
}

export const recordAppetite = async (input: {
  tenantId: string;
  providerId: string;
  signal: AppetiteValue;
  note: string;
  observedBy: string;
  observedAt: Date;
  actor: EventActor;
}): Promise<Outcome<AppetiteReading>> => {
  const row = await db().appetiteSignal.create({
    data: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      signal: input.signal as never,
      note: input.note,
      observedBy: input.observedBy,
      observedAt: input.observedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.appetite.observed',
    actor: input.actor,
    payload: { providerId: input.providerId, signal: input.signal, observedBy: input.observedBy },
  });

  return ok(readingOf(row, input.observedAt));
};

const DAY_MS = 24 * 60 * 60 * 1000;

const readingOf = (
  row: {
    providerId: string;
    signal: string;
    note: string;
    observedBy: string;
    observedAt: Date;
  },
  now: Date,
): AppetiteReading => {
  const ageDays = Math.max(0, Math.floor((now.getTime() - row.observedAt.getTime()) / DAY_MS));
  return {
    providerId: row.providerId,
    signal: row.signal as AppetiteValue,
    note: row.note,
    observedBy: row.observedBy,
    observedAt: row.observedAt.toISOString(),
    ageDays,
    stale: ageDays > APPETITE_STALE_AFTER_DAYS,
  };
};

/**
 * The most recent reading.
 *
 * `no_data` rather than a default of `steady` when nobody has observed the provider. A
 * default would be indistinguishable from a real observation of steadiness, and "we have
 * never looked" is materially different information from "we looked and it was normal".
 */
export const currentAppetite = async (
  tenantId: string,
  providerId: string,
  now: Date = new Date(),
): Promise<Outcome<AppetiteReading>> => {
  const row = await db().appetiteSignal.findFirst({
    where: { tenantId, providerId },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
  });
  return row
    ? ok(readingOf(row, now))
    : noData('No appetite signal has been recorded for this provider.');
};

/** Readings newest first, so a reader can see a provider tightening over successive weeks. */
export const appetiteHistory = async (
  tenantId: string,
  providerId: string,
  now: Date = new Date(),
): Promise<readonly AppetiteReading[]> => {
  const rows = await db().appetiteSignal.findMany({
    where: { tenantId, providerId },
    orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map((row) => readingOf(row, now));
};

// ---------------------------------------------------------------------------
// Approval rate
// ---------------------------------------------------------------------------

/**
 * Below this many decided applications, no rate is reported.
 *
 * A rate is a claim about frequency and needs frequency to make. Two approvals out of three
 * is "67%" arithmetically and nothing at all statistically, and a recommendation memo
 * carrying it would be more confident than the underlying knowledge - the failure mode this
 * whole module is built against. Ten is a judgement, stated here rather than buried, and the
 * honest answer below it is that we do not know.
 */
export const MINIMUM_OUTCOMES_FOR_RATE = 10;

export type PlacementOutcomeValue =
  'approved' | 'declined' | 'withdrawn' | 'funded' | 'failed_to_fund';

export interface ApprovalRate {
  readonly providerId: string;
  readonly productKind: ProductKind;
  readonly clientProfileKey: string | null;
  /** Null below the minimum sample. Never a number computed from too little. */
  readonly rate: number | null;
  readonly decidedCount: number;
  readonly approvedCount: number;
  /** Why `rate` is null, when it is. */
  readonly note: string;
}

export const recordOutcome = async (input: {
  tenantId: string;
  providerId: string;
  productKind: ProductKind;
  clientProfileKey: string;
  outcome: PlacementOutcomeValue;
  decidedAt: Date;
  actor: EventActor;
}): Promise<Outcome<{ id: string }>> => {
  const row = await db().lenderOutcome.create({
    data: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      productKind: input.productKind as never,
      clientProfileKey: input.clientProfileKey,
      outcome: input.outcome as never,
      decidedAt: input.decidedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.outcome.recorded',
    actor: input.actor,
    payload: {
      providerId: input.providerId,
      productKind: input.productKind,
      outcome: input.outcome,
    },
  });

  return ok({ id: row.id });
};

/**
 * Approval rate for a provider and product, optionally narrowed to a client profile bucket.
 *
 * `withdrawn` is excluded from the denominator: a withdrawn application was never decided,
 * and counting it as a non-approval would make a provider look worse the more clients
 * changed their minds. `funded` counts as approved - it is an approval that went on to
 * complete.
 */
export const approvalRate = async (input: {
  tenantId: string;
  providerId: string;
  productKind: ProductKind;
  clientProfileKey?: string;
}): Promise<ApprovalRate> => {
  const rows = await db().lenderOutcome.findMany({
    where: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      productKind: input.productKind as never,
      ...(input.clientProfileKey !== undefined ? { clientProfileKey: input.clientProfileKey } : {}),
    },
    select: { outcome: true },
  });

  const decided = rows.filter((row) => row.outcome !== 'withdrawn');
  const approved = decided.filter((row) => row.outcome === 'approved' || row.outcome === 'funded');

  const enough = decided.length >= MINIMUM_OUTCOMES_FOR_RATE;

  return {
    providerId: input.providerId,
    productKind: input.productKind,
    clientProfileKey: input.clientProfileKey ?? null,
    rate: enough ? approved.length / decided.length : null,
    decidedCount: decided.length,
    approvedCount: approved.length,
    note: enough
      ? `${approved.length} of ${decided.length} decided applications were approved.`
      : `${decided.length} decided application(s) on file; ${MINIMUM_OUTCOMES_FOR_RATE} are needed before a rate means anything.`,
  };
};

/**
 * A coarse bucket for a client, used as the cohort key.
 *
 * Coarse on purpose. A finer key gives every client a cohort of one, and a cohort of one
 * produces rates of exactly 0% or 100% - numbers that look like knowledge and are noise.
 */
export const profileKey = (profile: {
  annualRevenue: number | null;
  timeInBusinessMonths: number | null;
  personalCreditScore: number | null;
}): string => {
  const revenue =
    profile.annualRevenue === null
      ? 'unknown'
      : profile.annualRevenue < 250_000
        ? 'lt250k'
        : profile.annualRevenue < 1_000_000
          ? '250k-1m'
          : profile.annualRevenue < 5_000_000
            ? '1m-5m'
            : 'gte5m';

  const tib =
    profile.timeInBusinessMonths === null
      ? 'unknown'
      : profile.timeInBusinessMonths < 12
        ? 'lt12'
        : profile.timeInBusinessMonths < 24
          ? '12-23'
          : profile.timeInBusinessMonths < 60
            ? '24-59'
            : 'gte60';

  const fico =
    profile.personalCreditScore === null
      ? 'unknown'
      : profile.personalCreditScore < 650
        ? 'lt650'
        : profile.personalCreditScore < 700
          ? '650-699'
          : profile.personalCreditScore < 750
            ? '700-749'
            : 'gte750';

  return `revenue:${revenue}|tib:${tib}|fico:${fico}`;
};
