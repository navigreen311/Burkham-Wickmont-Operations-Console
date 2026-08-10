/**
 * Activity, inactivity and escalation - blueprint 1.3's "automatic escalation on 45-day
 * inactivity".
 *
 * Two decisions, both of which recur across this codebase and are worth restating because the
 * obvious implementation is different in each case.
 *
 * **Inactivity is derived, not scheduled.** The obvious build is a per-lead timer. Fifth appearance
 * of this reasoning (ADR-0007, 0009, 0010, 0011): a stored countdown needs a job to maintain it,
 * and a job that stops leaves stale leads looking fresh - silently, because nothing changed.
 * `staleLeads` computes it from `lastActivityAt` and today, so a lead untouched for 46 days is
 * stale the moment anybody asks, on any machine, including one switched off for a month.
 *
 * **The escalation raises a Notification & Task Queue task**, rather than scheduling its own alarm.
 * 2.4 already routes and tracks human work; a second mechanism would drift from it and the
 * operator would end up with two inboxes. The same reasoning kept 5.1's promo alerts inside the
 * Workflow Engine.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { raise, openFor } from '@bwc/notifications';
import { noData, ok, type EventActor, type Outcome } from '@bwc/core';
import { toLead, type LeadRecord } from './leads.js';

/** Blueprint 1.3 names it directly. A lead is stale on day 46: "45 days" includes the 45th. */
export const INACTIVITY_DAYS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;

const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);

export interface RecordActivityInput {
  readonly tenantId: string;
  readonly leadId: string;
  readonly kind: string;
  readonly summary: string;
  readonly occurredAt: Date;
  readonly actor: EventActor;
}

/**
 * Record something happening, and reset the inactivity clock.
 *
 * `lastActivityAt` moves only forward. A back-dated note about a call three weeks ago is worth
 * recording, and it is not evidence that the lead is fresh - letting it reset the clock backwards
 * would make an escalation disappear because somebody tidied up their notes.
 */
export const recordActivity = async (input: RecordActivityInput): Promise<Outcome<LeadRecord>> => {
  const existing = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
  });
  if (!existing) return noData('No such lead in this tenant.');

  await db().leadActivity.create({
    data: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      kind: input.kind,
      summary: input.summary,
      occurredAt: input.occurredAt,
      recordedBy: input.actor.id,
    },
  });

  const row = await db().lead.update({
    where: { id: input.leadId },
    data: {
      lastActivityAt:
        input.occurredAt > existing.lastActivityAt ? input.occurredAt : existing.lastActivityAt,
    },
  });

  return ok(toLead(row));
};

export interface ActivityEntry {
  readonly kind: string;
  readonly summary: string;
  readonly fromStage: string | null;
  readonly toStage: string | null;
  readonly occurredAt: string;
  readonly recordedBy: string;
}

/** The trail, oldest first. Append-only: nothing updates or deletes an entry. */
export const activityFor = async (
  tenantId: string,
  leadId: string,
): Promise<readonly ActivityEntry[]> => {
  const rows = await db().leadActivity.findMany({
    where: { tenantId, leadId },
    orderBy: { occurredAt: 'asc' },
  });

  return rows.map((row) => ({
    kind: row.kind,
    summary: row.summary,
    fromStage: row.fromStage,
    toStage: row.toStage,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
  }));
};

export interface StaleLead {
  readonly lead: LeadRecord;
  readonly idleDays: number;
  /** Written for the person who will pick the task up. */
  readonly summary: string;
}

/**
 * Leads nobody has touched in the inactivity window.
 *
 * Closed and converted leads are excluded: a lead that ended is not idle, it is finished, and an
 * escalation queue that filled with completed work would be abandoned within a week.
 */
export const staleLeads = async (
  tenantId: string,
  today: Date = new Date(),
): Promise<readonly StaleLead[]> => {
  const rows = await db().lead.findMany({
    where: { tenantId, stage: { notIn: ['converted', 'closed_lost'] } },
    orderBy: { lastActivityAt: 'asc' },
  });

  return rows
    .map((row) => ({ row, idleDays: daysBetween(row.lastActivityAt, today) }))
    .filter(({ idleDays }) => idleDays > INACTIVITY_DAYS)
    .map(({ row, idleDays }) => ({
      lead: toLead(row),
      idleDays,
      summary: `${row.prospectName} has had no recorded activity for ${idleDays} days, at stage ${row.stage}. Source: ${row.sourceChannel}${row.referrerName !== null ? ` via ${row.referrerName}` : ''}.`,
    }));
};

export const ESCALATION_KIND = 'sales_lead_inactivity';

export interface EscalationResult {
  readonly raised: number;
  readonly alreadyOpen: number;
}

/**
 * Raise a task for each stale lead, skipping any that already has one open.
 *
 * Idempotence matters here more than it looks: this is meant to be run on a schedule, and a
 * version that raised a fresh task on every pass would put the same lead in the queue daily until
 * somebody either acted or stopped reading the queue. The second outcome is the likely one.
 *
 * Matched on the open task's `kind` and the lead id in its summary rather than on a stored flag,
 * so the check and the queue cannot disagree - the same reasoning as 5.4's review queue asking
 * `standing()` rather than running its own date predicate.
 */
export const escalateStaleLeads = async (input: {
  tenantId: string;
  actor: EventActor;
  assignedTo?: string;
  today?: Date;
}): Promise<EscalationResult> => {
  const today = input.today ?? new Date();
  const stale = await staleLeads(input.tenantId, today);
  const open = await openFor(input.tenantId, input.assignedTo ?? 'concierge_desk');

  let raised = 0;
  let alreadyOpen = 0;

  for (const entry of stale) {
    const existing = open.find(
      (task) => task.kind === ESCALATION_KIND && task.summary.includes(entry.lead.id),
    );
    if (existing) {
      alreadyOpen += 1;
      continue;
    }

    await raise({
      tenantId: input.tenantId,
      assignedTo: input.assignedTo ?? 'concierge_desk',
      kind: ESCALATION_KIND,
      summary: `${entry.summary} [lead ${entry.lead.id}]`,
      actor: input.actor,
    });

    await append({
      tenantId: input.tenantId,
      type: 'sales.lead.escalated',
      actor: input.actor,
      payload: {
        leadId: entry.lead.id,
        idleDays: entry.idleDays,
        stage: entry.lead.stage,
      },
    });

    raised += 1;
  }

  return { raised, alreadyOpen };
};
