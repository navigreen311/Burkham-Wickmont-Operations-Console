/**
 * 11.9 Cost & Performance Governance.
 *
 * Two things decide the shape of this module, and both are refusals.
 *
 * **There is no `estimated` provenance.** Blueprint 11.9 wants per-client unit cost feeding 9.2
 * Unit Economics. The tempting implementation multiplies token counts by a published model price
 * and calls the result cost. That figure would sit in the same column as a vendor invoice, and
 * the moment two provenances share a column somebody sums them - at which point a unit-economics
 * number that looks measured is partly a guess about a price list that changed. `CostProvenance`
 * has exactly two members, `observed` and `vendor_invoice`, and there is no code path that writes
 * a third.
 *
 * **Platform cost is not spread across clients.** A per-client unit cost is only honest for spend
 * that was actually incurred on that client. Dividing a subscription by the number of active
 * clients produces an allocation with the shape of a measurement, and the per-client figure would
 * move when a different client signed up. So `unitCostFor` reports attributable cost, reports
 * unattributed platform cost separately, and never merges them.
 *
 * **Most of what 11.9 is supposed to track cannot be observed yet**, and the reason is Decisions
 * A and B: Plaid, the business bureau and the personal credit provider are gated behind Argus
 * review and a DPA, so there are no per-connection or per-pull costs to record. `costCoverage`
 * says so per source. A cost report that showed zero for a gated vendor would be read as a vendor
 * we are not spending money on, rather than one we have not switched on.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export const COST_SOURCES = [
  'model_api',
  'voice_minutes',
  'document_processing',
  'plaid',
  'business_bureau',
  'personal_credit',
] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export type CostProvenance = 'observed' | 'vendor_invoice';

/**
 * Sources whose spend cannot be observed today, and why.
 *
 * All three are the gated vendors from Decisions A and B. Reported rather than omitted: a zero
 * against a gated vendor reads as a vendor we are not spending on.
 */
export const UNOBSERVABLE_COST_SOURCES: Readonly<Partial<Record<CostSource, string>>> = {
  plaid:
    'Gated pending Argus security review and a DPA. No connection or per-account fee exists to record until it is switched on.',
  business_bureau:
    'Gated pending Argus security review and a DPA. Per-pull cost begins when the first pull does.',
  personal_credit:
    'Gated pending Argus security review and a DPA. Per-pull cost begins when the first pull does.',
};

export interface CostRecord {
  readonly id: string;
  readonly clientId: string | null;
  readonly actorId: string | null;
  readonly source: CostSource;
  readonly provenance: CostProvenance;
  readonly amountCents: number;
  readonly units: number | null;
  readonly unitKind: string | null;
  readonly vendorRef: string | null;
  readonly occurredOn: string;
}

interface Row {
  id: string;
  clientId: string | null;
  actorId: string | null;
  source: string;
  provenance: string;
  amountCents: number;
  units: number | null;
  unitKind: string | null;
  vendorRef: string | null;
  occurredOn: Date;
}

const toRecord = (row: Row): CostRecord => ({
  id: row.id,
  clientId: row.clientId,
  actorId: row.actorId,
  source: row.source as CostSource,
  provenance: row.provenance as CostProvenance,
  amountCents: row.amountCents,
  units: row.units,
  unitKind: row.unitKind,
  vendorRef: row.vendorRef,
  occurredOn: row.occurredOn.toISOString(),
});

export interface RecordCostInput {
  readonly tenantId: string;
  readonly clientId?: string;
  readonly actorId?: string;
  readonly source: CostSource;
  readonly provenance: CostProvenance;
  readonly amountCents: number;
  readonly units?: number;
  readonly unitKind?: string;
  readonly vendorRef?: string;
  readonly occurredOn: Date;
  readonly recordedBy: string;
  readonly actor: EventActor;
}

/** Record spend. Automatic in - a meter writes these, unattended. */
export const recordCost = async (input: RecordCostInput): Promise<Outcome<CostRecord>> => {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    return refused(
      `Cost is a non-negative whole number of cents; received ${input.amountCents}. A credit is its own row rather than a negative cost, so a query summing spend cannot silently net one against the other.`,
      'ADR-0011 - money is integer cents',
    );
  }

  const gated = UNOBSERVABLE_COST_SOURCES[input.source];
  if (gated !== undefined) {
    return refused(
      `No cost can be recorded against '${input.source}' yet. ${gated} Recording one now would put a figure in the unit-economics feed for a vendor that has never been called.`,
      'Decisions A and B with 11.5 - vendor gates',
    );
  }

  const row = await db().costRecord.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId ?? null,
      actorId: input.actorId ?? null,
      source: input.source,
      provenance: input.provenance,
      amountCents: input.amountCents,
      units: input.units ?? null,
      unitKind: input.unitKind ?? null,
      vendorRef: input.vendorRef ?? null,
      occurredOn: input.occurredOn,
      createdBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'admin.cost.recorded',
    actor: input.actor,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    payload: {
      costId: row.id,
      source: input.source,
      provenance: input.provenance,
      amountCents: input.amountCents,
    },
  });

  return ok(toRecord(row));
};

export interface Window {
  readonly from: Date;
  readonly to: Date;
}

export interface UnitCost {
  readonly clientId: string;
  /** Spend actually incurred on this client. */
  readonly attributableCents: number;
  readonly recordCount: number;
  /**
   * Platform spend in the window that names no client.
   *
   * Reported beside the per-client figure and deliberately NOT divided into it. An allocation
   * presented as a measurement is a per-client cost that moves when a different client signs up.
   */
  readonly unattributedPlatformCents: number;
  readonly note: string;
}

export const unitCostFor = async (
  tenantId: string,
  clientId: string,
  window: Window,
): Promise<UnitCost> => {
  const [mine, platform] = await Promise.all([
    db().costRecord.findMany({
      where: { tenantId, clientId, occurredOn: { gte: window.from, lt: window.to } },
      select: { amountCents: true },
    }),
    db().costRecord.findMany({
      where: { tenantId, clientId: null, occurredOn: { gte: window.from, lt: window.to } },
      select: { amountCents: true },
    }),
  ]);

  const attributable = mine.reduce((total, row) => total + row.amountCents, 0);
  const unattributed = platform.reduce((total, row) => total + row.amountCents, 0);

  return {
    clientId,
    attributableCents: attributable,
    recordCount: mine.length,
    unattributedPlatformCents: unattributed,
    note: `${attributable} cent(s) incurred on this client across ${mine.length} record(s). A further ${unattributed} cent(s) of platform spend in this window names no client and is NOT divided in - an allocation presented as a measurement would move this client's unit cost when a different client signed up.`,
  };
};

export interface SourceTotal {
  readonly source: CostSource;
  readonly totalCents: number;
  readonly records: number;
  /** Null when the source is gated: no spend is observable, which is not the same as no spend. */
  readonly observable: boolean;
  readonly note: string;
}

/** Spend by source, with the gated ones reported as unobservable rather than as zero. */
export const costCoverage = async (
  tenantId: string,
  window: Window,
): Promise<readonly SourceTotal[]> => {
  const rows = await db().costRecord.findMany({
    where: { tenantId, occurredOn: { gte: window.from, lt: window.to } },
    select: { source: true, amountCents: true },
  });

  return COST_SOURCES.map((source) => {
    const mine = rows.filter((row) => row.source === source);
    const gated = UNOBSERVABLE_COST_SOURCES[source];
    return {
      source,
      totalCents: mine.reduce((total, row) => total + row.amountCents, 0),
      records: mine.length,
      observable: gated === undefined,
      note:
        gated !== undefined
          ? `Not observable. ${gated} The zero beside this row is an absence of measurement, not an absence of spend.`
          : `${mine.length} record(s) in the window.`,
    };
  });
};

export interface CostAnomaly {
  readonly source: CostSource;
  readonly vendorRef: string | null;
  readonly currentCents: number;
  readonly priorCents: number;
  /** Direction only. No threshold, and no verdict about whether it is bad. */
  readonly direction: 'increased' | 'decreased' | 'steady';
  readonly note: string;
}

/** Below this many records in a window, a comparison between windows is noise. */
export const MINIMUM_RECORDS_TO_COMPARE = 10;

/**
 * Cost anomaly detection - blueprint 11.9's "cost anomaly detection".
 *
 * Reports direction between two windows and stops there. No threshold: a threshold is a number
 * under which nobody looks, and a cost drift that stays just under it every month is exactly the
 * thing this is supposed to catch. No verdict either - a cost that doubled because volume doubled
 * is not an anomaly, and this module cannot see volume.
 *
 * Sources with too few records in either window are omitted rather than reported as `steady`,
 * because "no change detected" and "not enough to detect a change in" are different statements
 * and the first is the reassuring one.
 */
export const costAnomalies = async (
  tenantId: string,
  current: Window,
  prior: Window,
): Promise<readonly CostAnomaly[]> => {
  const [now, before] = await Promise.all([
    db().costRecord.findMany({
      where: { tenantId, occurredOn: { gte: current.from, lt: current.to } },
      select: { source: true, amountCents: true },
    }),
    db().costRecord.findMany({
      where: { tenantId, occurredOn: { gte: prior.from, lt: prior.to } },
      select: { source: true, amountCents: true },
    }),
  ]);

  const anomalies: CostAnomaly[] = [];

  for (const source of COST_SOURCES) {
    const mineNow = now.filter((row) => row.source === source);
    const mineBefore = before.filter((row) => row.source === source);

    if (
      mineNow.length < MINIMUM_RECORDS_TO_COMPARE ||
      mineBefore.length < MINIMUM_RECORDS_TO_COMPARE
    ) {
      continue;
    }

    const currentCents = mineNow.reduce((total, row) => total + row.amountCents, 0);
    const priorCents = mineBefore.reduce((total, row) => total + row.amountCents, 0);

    anomalies.push({
      source,
      vendorRef: null,
      currentCents,
      priorCents,
      direction:
        currentCents === priorCents
          ? 'steady'
          : currentCents > priorCents
            ? 'increased'
            : 'decreased',
      note: `${currentCents} cent(s) against ${priorCents} in the prior window, over ${mineNow.length} and ${mineBefore.length} records. Direction only: this module cannot see volume, and a cost that doubled because the work doubled is not an anomaly.`,
    });
  }

  return anomalies;
};

/** Every cost record for a client. What an evidence pack would carry. */
export const costsFor = async (
  tenantId: string,
  clientId: string,
  window: Window,
): Promise<readonly CostRecord[]> => {
  const rows = await db().costRecord.findMany({
    where: { tenantId, clientId, occurredOn: { gte: window.from, lt: window.to } },
    orderBy: [{ occurredOn: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toRecord);
};

/** No record exists for this client in the window. Distinct from a zero cost. */
export const requireCosts = async (
  tenantId: string,
  clientId: string,
  window: Window,
): Promise<Outcome<readonly CostRecord[]>> => {
  const rows = await costsFor(tenantId, clientId, window);
  return rows.length > 0
    ? ok(rows)
    : noData(
        `No cost has been recorded against this client in the window. That is an absence of measurement, not a client who cost nothing to serve - model API metering is the only source currently switched on.`,
      );
};
