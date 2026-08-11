/**
 * Capturing a point-in-time fact set - blueprint 11.6's ETL.
 *
 * **A snapshot is immutable.** Re-running a capture for a date already taken is refused rather
 * than overwritten. An overwritten snapshot is a rewritten history, and having a history that
 * survives the present changing is the entire reason this module exists - see ADR-0020.
 *
 * What is captured is deliberately narrow: the compliance distribution, engagement counts, and a
 * per-subject row carrying compliance state, whether an engagement was live, and revenue to date.
 * Those are the facts that MOVE and are then unrecoverable. A snapshot of something that never
 * changes is a copy, and a copy drifts.
 *
 * `gaps` travels with every snapshot for 7.1's reason applied to a time series: a trend with a
 * missing input reads as a dip, and a reader has no way to tell the difference unless the snapshot
 * says so.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import {
  COMPLIANCE_STATES,
  ok,
  refused,
  type ComplianceState,
  type EventActor,
  type Outcome,
} from '@bwc/core';
import { cohortFor, subjectKeyFor } from './subjects.js';

export interface SnapshotFacts {
  readonly clients: number;
  readonly complianceCounts: Readonly<Record<string, number>>;
  readonly engagementsActive: number;
  readonly billedToDateCents: number;
}

export interface Snapshot {
  readonly id: string;
  readonly asOf: string;
  readonly facts: SnapshotFacts;
  readonly gaps: readonly string[];
  readonly subjects: number;
}

/** Midnight UTC on the date, so `asOf` is a date and not an instant that drifts by timezone. */
const dateOnly = (instant: Date): Date =>
  new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));

export interface CaptureInput {
  readonly tenantId: string;
  readonly asOf: Date;
  readonly capturedBy: string;
  readonly actor: EventActor;
  /** The key subject pseudonyms are derived with. Supplied, never defaulted - see subjects.ts. */
  readonly subjectSecret: string;
}

/**
 * Capture a snapshot for a date.
 *
 * Note what this does NOT do: it captures the state as it is when called, labelled with `asOf`. It
 * cannot reconstruct a past date, because the operational store no longer holds one - which is the
 * whole reason to capture daily rather than on demand. Calling it with a back-dated `asOf` would
 * label today's facts as last week's, so a date in the past is refused.
 */
export const captureSnapshot = async (input: CaptureInput): Promise<Outcome<Snapshot>> => {
  const asOf = dateOnly(input.asOf);
  const today = dateOnly(new Date());

  if (asOf.getTime() > today.getTime()) {
    return refused(
      'A snapshot cannot be captured for a future date. It records the state as it is when called; labelling that with a future date would put facts in the series before they happened.',
      'Blueprint 11.6 - historical retention',
    );
  }

  if (input.subjectSecret.trim().length < 16) {
    return refused(
      'A subject-key secret of at least 16 characters is required. A weak key makes the pseudonyms recomputable from the client list alone, which is the one protection they offer.',
      'Blueprint 11.6 - historical retention independent of operational data',
    );
  }

  const existing = await db().analyticsSnapshot.findFirst({
    where: { tenantId: input.tenantId, asOf },
  });
  if (existing) {
    return refused(
      `A snapshot for ${asOf.toISOString().slice(0, 10)} already exists. Snapshots are immutable: overwriting one would rewrite the history this module exists to keep, and a trend computed over rewritten points is not a trend.`,
      'Blueprint 11.6 with ADR-0020 - a snapshot is never updated',
    );
  }

  const gaps: string[] = [];

  const clients = await db().client.findMany({
    where: { tenantId: input.tenantId },
    select: { id: true, complianceState: true, createdAt: true },
  });

  if (clients.length === 0) {
    gaps.push(
      'No clients existed on this date, so every per-subject figure is absent rather than zero.',
    );
  }

  const engagements = await db().engagement.findMany({
    where: { tenantId: input.tenantId },
    select: {
      clientId: true,
      status: true,
      records: { select: { kind: true, amountCents: true } },
    },
  });

  const billedByClient = new Map<string, number>();
  const engagedClients = new Set<string>();

  for (const engagement of engagements) {
    if (engagement.status === 'active') engagedClients.add(engagement.clientId);
    let billed = billedByClient.get(engagement.clientId) ?? 0;
    for (const record of engagement.records) {
      if (record.kind === 'charge') billed += record.amountCents;
      else if (record.kind === 'refund') billed -= record.amountCents;
    }
    billedByClient.set(engagement.clientId, billed);
  }

  const complianceCounts = Object.fromEntries(
    COMPLIANCE_STATES.map((state) => [state, 0]),
  ) as Record<ComplianceState, number>;
  for (const client of clients) {
    complianceCounts[client.complianceState as ComplianceState] += 1;
  }

  // Vendor costs would belong in a snapshot and cannot be captured - the same gap 9.2 reports.
  gaps.push(
    'Per-client vendor costs (Plaid, bureau pulls) are not captured: both vendors are ungated under Decisions A and B. Any margin computed from this series is before those costs.',
  );

  const facts: SnapshotFacts = {
    clients: clients.length,
    complianceCounts,
    engagementsActive: engagedClients.size,
    billedToDateCents: [...billedByClient.values()].reduce((total, value) => total + value, 0),
  };

  const snapshot = await db().$transaction(async (tx) => {
    const created = await tx.analyticsSnapshot.create({
      data: {
        tenantId: input.tenantId,
        asOf,
        facts: facts as unknown as object,
        gaps,
        capturedBy: input.capturedBy,
      },
    });

    if (clients.length > 0) {
      await tx.subjectSnapshot.createMany({
        data: clients.map((client) => ({
          tenantId: input.tenantId,
          snapshotId: created.id,
          subjectKey: subjectKeyFor(input.tenantId, client.id, input.subjectSecret),
          cohort: cohortFor(client.createdAt),
          complianceState: client.complianceState,
          engaged: engagedClients.has(client.id),
          billedToDateCents: billedByClient.get(client.id) ?? 0,
        })),
      });
    }

    return created;
  });

  await append({
    tenantId: input.tenantId,
    type: 'warehouse.snapshot.captured',
    actor: input.actor,
    payload: {
      snapshotId: snapshot.id,
      asOf: asOf.toISOString().slice(0, 10),
      clients: clients.length,
      gaps: gaps.length,
    },
  });

  return ok({
    id: snapshot.id,
    asOf: asOf.toISOString().slice(0, 10),
    facts,
    gaps,
    subjects: clients.length,
  });
};

/**
 * Snapshots in a period.
 *
 * A period is REQUIRED and there is no function that returns the latest one on its own. That is
 * the structural half of ADR-0020: the warehouse cannot be asked about the present, so nothing can
 * quietly start using it as a faster read of what 9.1 already answers live.
 */
export const snapshotsBetween = async (
  tenantId: string,
  from: Date,
  to: Date,
): Promise<readonly Snapshot[]> => {
  const rows = await db().analyticsSnapshot.findMany({
    where: { tenantId, asOf: { gte: dateOnly(from), lte: dateOnly(to) } },
    orderBy: [{ asOf: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { subjects: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    asOf: row.asOf.toISOString().slice(0, 10),
    facts: row.facts as unknown as SnapshotFacts,
    gaps: row.gaps,
    subjects: row._count.subjects,
  }));
};
