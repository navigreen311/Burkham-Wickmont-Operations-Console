/**
 * Risk observations - the part of blueprint 6.5 nothing else produces.
 *
 * 6.5's data model lists fraud alerts, NSF events, missed payments and disputes. Every one of them
 * would arrive through an integration - Plaid, a bureau, an issuer - and none of those is gated in.
 * Waiting for them would leave the timeline unable to hold a fraud alert somebody took over the
 * phone, which is how these actually reach the company today.
 *
 * So: a narrow table for a risk fact a person observed, with the source in the observer's words.
 * Not a general event store. The Ledger is that, and a second one would drift.
 *
 * The `source` field is required and is the reason to trust the row. A risk fact with no
 * provenance is a rumour, and a timeline that cannot distinguish the two makes the rumour look
 * like a finding.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { SEVERITIES, type Severity } from './classify.js';

/** What kind of risk fact this is. Open-ended on purpose - the world produces new ones. */
export type ObservationKind =
  | 'fraud_alert'
  | 'nsf_event'
  | 'missed_payment'
  | 'dispute'
  | 'adverse_action'
  | 'new_debt_discovered'
  | 'freeze'
  | 'human_intervention'
  | 'complaint'
  | 'other';

export interface Observation {
  readonly id: string;
  readonly clientId: string;
  readonly kind: ObservationKind;
  readonly severity: Severity;
  readonly summary: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface RecordObservationInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: ObservationKind;
  readonly severity: Severity;
  readonly summary: string;
  /** Where this came from: "client called 2026-08-02", "Wells Fargo letter dated 2026-07-30". */
  readonly source: string;
  readonly occurredAt: Date;
  readonly recordedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Record an observation.
 *
 * `occurredAt` is separate from `recordedAt` and both are kept. A fraud alert from March written
 * down in August belongs in March on the timeline and in August in the audit trail, and a single
 * timestamp would have to lie about one of them.
 */
export const recordObservation = async (
  input: RecordObservationInput,
): Promise<Outcome<Observation>> => {
  const now = input.now ?? new Date();

  if (input.summary.trim().length < 5) {
    return refused(
      'A risk observation needs a summary somebody can read back later.',
      'Blueprint 6.5 - the timeline is read by people who were not there',
    );
  }
  if (input.source.trim() === '') {
    return refused(
      'A risk observation needs a source. A risk fact with no provenance is a rumour, and the timeline cannot tell the two apart once it is written down.',
      'Design principle 4 - provenance on every fact',
    );
  }
  if (!SEVERITIES.includes(input.severity)) {
    return refused(
      `'${input.severity}' is not a severity. Use one of: ${SEVERITIES.join(', ')}.`,
      'Blueprint 6.5 - severity is categorical',
    );
  }
  if (input.occurredAt.getTime() > now.getTime()) {
    return refused(
      'A risk observation cannot have occurred in the future. Check the date before recording it.',
      'Blueprint 6.5 - chronological timeline',
    );
  }

  const row = await db().riskObservation.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind,
      severity: input.severity,
      summary: input.summary,
      source: input.source,
      occurredAt: input.occurredAt,
      recordedAt: now,
      recordedBy: input.recordedBy,
    },
  });

  // The Ledger gets the fact of the observation and its severity, not its text. A summary is
  // written by a person in a hurry and may name anything; the redactor would catch the obvious
  // cases and the timeline holds the readable version either way.
  await append({
    tenantId: input.tenantId,
    type: 'risk.observation.recorded',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      observationId: row.id,
      kind: input.kind,
      severity: input.severity,
      occurredAt: input.occurredAt.toISOString(),
    },
  });

  return ok(toObservation(row));
};

interface ObservationRow {
  id: string;
  clientId: string;
  kind: string;
  severity: string;
  summary: string;
  source: string;
  occurredAt: Date;
  recordedAt: Date;
  recordedBy: string;
}

const toObservation = (row: ObservationRow): Observation => ({
  id: row.id,
  clientId: row.clientId,
  kind: row.kind as ObservationKind,
  severity: row.severity as Severity,
  summary: row.summary,
  source: row.source,
  occurredAt: row.occurredAt.toISOString(),
  recordedAt: row.recordedAt.toISOString(),
  recordedBy: row.recordedBy,
});

export const observationsFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly Observation[]> => {
  const rows = await db().riskObservation.findMany({
    where: { tenantId, clientId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toObservation);
};
