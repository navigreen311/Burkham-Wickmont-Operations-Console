/**
 * Correction obligations - blueprint 4.3's "requires correction / disclosure workflow".
 *
 * The half of promise tracking that makes the detection worth doing.
 *
 * 4.2 blocks. This cannot, and the reason is not a limitation - it is what kind of control this
 * is. The call already happened. The client already heard "we can probably get you a hundred
 * grand". A verdict describing that as `blocked` would be describing a state of affairs that does
 * not exist.
 *
 * So a detected promise becomes an OBLIGATION: what was said, who owes the correction, by when,
 * and - to close it - what they actually said to correct it. See ADR-0015.
 *
 * Two properties follow from that and are enforced here:
 *
 *   **An obligation cannot be closed without the correction.** Closing with a tick would produce a
 *   record saying a client was corrected when nobody had told them anything, which is worse than
 *   an open obligation because it stops anyone looking.
 *
 *   **Dismissing takes a Level 3 human and a reason.** "That was fine actually" is sometimes true -
 *   shape-matching produces false positives on purpose - but it is a judgement somebody should be
 *   answerable for, not a way to clear a queue.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { raise } from '@bwc/notifications';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import type { PromiseFinding, Severity } from './detect.js';

export type ObligationStatus = 'open' | 'corrected' | 'dismissed';

/** Level 3, as everywhere a judgement overrides a control. */
export const DISMISSAL_AUTHORITY_LEVEL = 3;

/**
 * How long there is to correct, by severity.
 *
 * A misstated amount is corrected the next business day, not next week. The client is making
 * plans on it now, and a correction that arrives after they have told their landlord is a record
 * of diligence rather than a correction.
 */
export const CORRECTION_WINDOW_HOURS: Readonly<Record<Severity, number>> = {
  critical: 24,
  serious: 72,
  notable: 168,
};

export interface Obligation {
  readonly id: string;
  readonly callId: string;
  readonly clientId: string;
  readonly kind: string;
  readonly severity: Severity;
  readonly excerpt: string;
  readonly speaker: string;
  readonly whyItMatters: string;
  readonly status: ObligationStatus;
  readonly owedBy: string;
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly correctionText: string | null;
  readonly dismissalReason: string | null;
}

interface ObligationRow {
  id: string;
  callId: string;
  clientId: string;
  kind: string;
  severity: string;
  excerpt: string;
  speaker: string;
  whyItMatters: string;
  status: string;
  owedBy: string;
  dueAt: Date;
  correctionText: string | null;
  dismissalReason: string | null;
}

const toObligation = (row: ObligationRow, now: Date): Obligation => ({
  id: row.id,
  callId: row.callId,
  clientId: row.clientId,
  kind: row.kind,
  severity: row.severity as Severity,
  excerpt: row.excerpt,
  speaker: row.speaker,
  whyItMatters: row.whyItMatters,
  status: row.status as ObligationStatus,
  owedBy: row.owedBy,
  dueAt: row.dueAt.toISOString(),
  // Derived, never stored. A stored overdue flag needs a job, and a job that stops leaves every
  // overdue correction reading as in-hand.
  overdue: row.status === 'open' && now.getTime() > row.dueAt.getTime(),
  correctionText: row.correctionText,
  dismissalReason: row.dismissalReason,
});

/**
 * Turn detected promises into obligations.
 *
 * One per finding, each with its own deadline, and each raising a task in 11.4 so it lands in a
 * human queue rather than waiting to be noticed. Idempotent per (call, excerpt): re-analysing a
 * transcript must not produce a second obligation for the same sentence, because the first may
 * already have been corrected.
 */
export const raiseObligations = async (input: {
  tenantId: string;
  clientId: string;
  callId: string;
  findings: readonly PromiseFinding[];
  owedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<readonly Obligation[]>> => {
  const now = input.now ?? new Date();

  const existing = await db().correctionObligation.findMany({
    where: { tenantId: input.tenantId, callId: input.callId },
  });
  const seen = new Set(existing.map((row) => row.excerpt));

  const created: Obligation[] = [];

  for (const finding of input.findings) {
    if (seen.has(finding.excerpt)) continue;

    const dueAt = new Date(now.getTime() + CORRECTION_WINDOW_HOURS[finding.severity] * 3600 * 1000);

    const row = await db().correctionObligation.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        callId: input.callId,
        kind: finding.kind,
        severity: finding.severity,
        excerpt: finding.excerpt,
        speaker: finding.speaker,
        whyItMatters: finding.whyItMatters,
        owedBy: input.owedBy,
        dueAt,
      },
    });

    await raise({
      tenantId: input.tenantId,
      assignedTo: input.owedBy,
      kind: 'correct_call_promise',
      // Describes the task; the sentence itself stays in the obligation row. The Ledger and the
      // task queue are both places a quoted excerpt does not need to travel.
      summary: `A ${finding.severity} ${finding.kind.replace(/_/g, ' ')} was detected on a call and must be corrected to the client.`,
      actor: input.actor,
      clientId: input.clientId,
      slaDueAt: dueAt,
    });

    await append({
      tenantId: input.tenantId,
      type: 'calls.promise.detected',
      actor: input.actor,
      clientId: input.clientId,
      payload: {
        callId: input.callId,
        obligationId: row.id,
        kind: finding.kind,
        severity: finding.severity,
        dueAt: dueAt.toISOString(),
      },
    });

    created.push(toObligation(row, now));
    seen.add(finding.excerpt);
  }

  return ok(created);
};

/**
 * Close an obligation by recording what was said to the client.
 *
 * The correction text is required and is checked for substance. A one-word close would satisfy a
 * non-empty check while telling a later reader nothing about whether the client was actually put
 * right - and this record exists precisely for that reader.
 */
export const recordCorrection = async (input: {
  tenantId: string;
  obligationId: string;
  correctionText: string;
  correctedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Obligation>> => {
  const now = input.now ?? new Date();

  if (input.correctionText.trim().length < 20) {
    return refused(
      'Closing a correction obligation requires the correction itself - what was said to the client to put the statement right. A tick would record that a client was corrected when nobody had told them anything.',
      'Blueprint 4.3 - requires correction / disclosure workflow',
    );
  }

  const row = await db().correctionObligation.findFirst({
    where: { tenantId: input.tenantId, id: input.obligationId },
  });
  if (!row) return noData(`No correction obligation ${input.obligationId} is on record.`);
  if (row.status !== 'open') {
    return refused(
      `This obligation is already ${row.status}.`,
      'Blueprint 4.3 - an obligation closes once',
    );
  }

  const updated = await db().correctionObligation.update({
    where: { id: row.id },
    data: {
      status: 'corrected',
      correctionText: input.correctionText,
      correctedAt: now,
      correctedBy: input.correctedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'calls.promise.corrected',
    actor: input.actor,
    clientId: row.clientId,
    payload: {
      obligationId: row.id,
      callId: row.callId,
      kind: row.kind,
      // Whether it was corrected in time is the fact a reviewer wants, and computing it later
      // from two timestamps invites somebody to compute it differently.
      withinWindow: now.getTime() <= row.dueAt.getTime(),
    },
  });

  return ok(toObligation(updated, now));
};

/**
 * Dismiss an obligation as a false positive.
 *
 * Shape-matching produces false positives deliberately - the alternative is missing real promises -
 * so a dismissal path has to exist. It takes a Level 3 human and a reason, because otherwise it is
 * the path of least resistance for clearing a queue.
 */
export const dismissObligation = async (input: {
  tenantId: string;
  obligationId: string;
  reason: string;
  dismissedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Obligation>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 20) {
    return refused(
      'Dismissing a correction obligation requires a reason somebody can read back. It is the record of a judgement that a client did not need to be corrected.',
      'Blueprint 4.3 - promise tracking',
    );
  }

  const row = await db().correctionObligation.findFirst({
    where: { tenantId: input.tenantId, id: input.obligationId },
  });
  if (!row) return noData(`No correction obligation ${input.obligationId} is on record.`);
  if (row.status !== 'open') {
    return refused(
      `This obligation is already ${row.status}.`,
      'Blueprint 4.3 - an obligation closes once',
    );
  }

  const actor = await findActor(input.dismissedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < DISMISSAL_AUTHORITY_LEVEL) {
    return refused(
      `Dismissing a correction obligation requires a human at Authority Level ${DISMISSAL_AUTHORITY_LEVEL}. It decides that a client who was told something inaccurate does not need to be put right.`,
      'Blueprint 2.1 with 4.3 - a judgement overriding a control needs a person',
    );
  }

  const updated = await db().correctionObligation.update({
    where: { id: row.id },
    data: {
      status: 'dismissed',
      dismissalReason: input.reason,
      dismissedAt: now,
      dismissedBy: input.dismissedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'calls.promise.dismissed',
    actor: input.actor,
    clientId: row.clientId,
    payload: {
      obligationId: row.id,
      callId: row.callId,
      kind: row.kind,
      reason: input.reason,
      dismissedBy: input.dismissedBy,
    },
  });

  return ok(toObligation(updated, now));
};

export const obligationsFor = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<readonly Obligation[]> => {
  const rows = await db().correctionObligation.findMany({
    where: { tenantId, clientId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toObligation(row, now));
};

/** Everything still owed, worst-overdue first. The queue a Concierge lead works from. */
export const openObligations = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Obligation[]> => {
  const rows = await db().correctionObligation.findMany({
    where: { tenantId, status: 'open' },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toObligation(row, now));
};
