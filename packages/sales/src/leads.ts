/**
 * Lead records and the pipeline - blueprint 1.3.
 *
 * A lead is **pre-client**. It has no compliance state, because there is no client yet to assess -
 * which is the reason conversion is the interesting operation in this module rather than an
 * administrative one.
 *
 * Attribution is the other thing shaping this file. A referral fee is owed to whoever introduced a
 * client, which makes attribution a financial fact; a financial fact that can be edited after the
 * money is at stake is not a record but an opinion with a timestamp. So the attribution columns are
 * written at creation and **this package exposes no path that updates them** - a correction is a
 * separate row, in `attribution.ts`, with the original left intact.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export type LeadStage =
  | 'new_lead'
  | 'qualified'
  | 'blueprint_delivered'
  | 'review_call_scheduled'
  | 'converted'
  | 'closed_lost';

export const LEAD_STAGES = [
  'new_lead',
  'qualified',
  'blueprint_delivered',
  'review_call_scheduled',
  'converted',
  'closed_lost',
] as const satisfies readonly LeadStage[];

export type QualificationStatus = 'unqualified' | 'qualified' | 'disqualified';

export interface LeadRecord {
  readonly id: string;
  readonly prospectName: string;
  readonly stage: LeadStage;
  readonly qualification: QualificationStatus;
  readonly qualificationNote: string | null;
  readonly sourceChannel: string;
  readonly referrerName: string | null;
  readonly referrerPartnerId: string | null;
  readonly sourceDetail: string | null;
  readonly attributedAt: string;
  readonly blueprintDeliveredOn: string | null;
  readonly blueprintReadiness: number | null;
  readonly reviewCallScheduledFor: string | null;
  readonly lastActivityAt: string;
}

interface LeadRow {
  id: string;
  prospectName: string;
  stage: string;
  qualification: string;
  qualificationNote: string | null;
  sourceChannel: string;
  referrerName: string | null;
  referrerPartnerId: string | null;
  sourceDetail: string | null;
  attributedAt: Date;
  blueprintDeliveredOn: Date | null;
  blueprintReadiness: number | null;
  reviewCallScheduledFor: Date | null;
  lastActivityAt: Date;
}

export const toLead = (row: LeadRow): LeadRecord => ({
  id: row.id,
  prospectName: row.prospectName,
  stage: row.stage as LeadStage,
  qualification: row.qualification as QualificationStatus,
  qualificationNote: row.qualificationNote,
  sourceChannel: row.sourceChannel,
  referrerName: row.referrerName,
  referrerPartnerId: row.referrerPartnerId,
  sourceDetail: row.sourceDetail,
  attributedAt: row.attributedAt.toISOString(),
  blueprintDeliveredOn: row.blueprintDeliveredOn?.toISOString() ?? null,
  blueprintReadiness: row.blueprintReadiness,
  reviewCallScheduledFor: row.reviewCallScheduledFor?.toISOString() ?? null,
  lastActivityAt: row.lastActivityAt.toISOString(),
});

export interface CreateLeadInput {
  readonly tenantId: string;
  readonly prospectName: string;
  readonly contactName?: string;
  readonly contactEmail?: string;
  /** Where the lead came from. Required - an unattributed lead cannot be paid on or counted. */
  readonly sourceChannel: string;
  /** The partner or referrer. First touch, not last. */
  readonly referrerName?: string;
  /**
   * The 8.1 Partner record behind that name, when the referrer is an onboarded partner.
   *
   * Part of the attribution group, so it is written here and nowhere else - the same rule the
   * name follows. Callers should check `canRefer` before supplying it; this package deliberately
   * does not, because a compile-time dependency from Sales on Partners would put 1.3's lead
   * creation downstream of the partner network.
   */
  readonly referrerPartnerId?: string;
  readonly sourceDetail?: string;
  readonly createdOn: Date;
  readonly actor: EventActor;
}

/**
 * Create a lead, fixing its attribution.
 *
 * `sourceChannel` is required rather than defaulted. A default - "direct", "unknown" - would be
 * indistinguishable from a real answer the moment anyone ran a channel report, and the whole point
 * of recording attribution is that the report means something.
 */
export const createLead = async (input: CreateLeadInput): Promise<Outcome<LeadRecord>> => {
  if (input.prospectName.trim() === '') {
    return refused(
      'A lead needs a prospect name.',
      'Blueprint 1.3 - a lead nobody can name cannot be worked, counted or attributed',
    );
  }
  if (input.sourceChannel.trim() === '') {
    return refused(
      'A lead needs a source channel. A default such as "unknown" would be indistinguishable from a real answer the moment anyone ran a channel report.',
      'Blueprint 1.3 - lead records with source attribution',
    );
  }

  const row = await db().lead.create({
    data: {
      tenantId: input.tenantId,
      prospectName: input.prospectName,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      sourceChannel: input.sourceChannel,
      referrerName: input.referrerName ?? null,
      referrerPartnerId: input.referrerPartnerId ?? null,
      sourceDetail: input.sourceDetail ?? null,
      attributedAt: input.createdOn,
      lastActivityAt: input.createdOn,
    },
  });

  await db().leadActivity.create({
    data: {
      tenantId: input.tenantId,
      leadId: row.id,
      kind: 'created',
      summary: `Lead created from ${input.sourceChannel}${input.referrerName !== undefined ? ` via ${input.referrerName}` : ''}.`,
      toStage: 'new_lead',
      occurredAt: input.createdOn,
      recordedBy: input.actor.id,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.lead.created',
    actor: input.actor,
    payload: {
      leadId: row.id,
      prospectName: input.prospectName,
      sourceChannel: input.sourceChannel,
      referrerName: input.referrerName ?? null,
      referrerPartnerId: input.referrerPartnerId ?? null,
    },
  });

  return ok(toLead(row));
};

export const findLead = async (tenantId: string, leadId: string): Promise<Outcome<LeadRecord>> => {
  const row = await db().lead.findFirst({ where: { tenantId, id: leadId } });
  return row ? ok(toLead(row)) : noData('No such lead in this tenant.');
};

/**
 * Qualify or disqualify a lead.
 *
 * A note is required either way. A qualification nobody can explain is a filter nobody can
 * improve, and a disqualification nobody can explain is one that cannot be appealed by the
 * salesperson who disagrees.
 */
export const qualifyLead = async (input: {
  tenantId: string;
  leadId: string;
  qualification: Exclude<QualificationStatus, 'unqualified'>;
  note: string;
  occurredAt: Date;
  actor: EventActor;
}): Promise<Outcome<LeadRecord>> => {
  if (input.note.trim() === '') {
    return refused(
      'A qualification decision needs a note. Unexplained, it is a filter nobody can improve and a decision the salesperson who disagrees cannot appeal.',
      'Blueprint 1.3 - qualification status',
    );
  }

  const existing = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
  });
  if (!existing) return noData('No such lead in this tenant.');

  const toStage: LeadStage = input.qualification === 'qualified' ? 'qualified' : existing.stage;

  const row = await db().lead.update({
    where: { id: input.leadId },
    data: {
      qualification: input.qualification as never,
      qualificationNote: input.note,
      stage: toStage as never,
      lastActivityAt: input.occurredAt,
    },
  });

  await db().leadActivity.create({
    data: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      kind: 'qualification',
      summary: `${input.qualification}: ${input.note}`,
      fromStage: existing.stage,
      toStage: toStage as never,
      occurredAt: input.occurredAt,
      recordedBy: input.actor.id,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.lead.qualified',
    actor: input.actor,
    payload: { leadId: input.leadId, qualification: input.qualification, note: input.note },
  });

  return ok(toLead(row));
};

/** Record the Readiness Blueprint being delivered, with the readiness figure at that moment. */
export const recordBlueprintDelivered = async (input: {
  tenantId: string;
  leadId: string;
  readiness: number;
  deliveredOn: Date;
  actor: EventActor;
}): Promise<Outcome<LeadRecord>> => {
  if (!Number.isInteger(input.readiness) || input.readiness < 0 || input.readiness > 100) {
    return refused(
      `A readiness of ${input.readiness} is not a whole number between 0 and 100.`,
      'Blueprint 1.3 - expansion triggers compare readiness across time, and a comparison needs a comparable scale',
    );
  }

  const existing = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
  });
  if (!existing) return noData('No such lead in this tenant.');

  if (existing.qualification !== 'qualified') {
    return refused(
      `Lead '${existing.prospectName}' has not been qualified, so a Readiness Blueprint should not be delivered to it. Qualification is what decides whether the work is worth doing.`,
      'Blueprint 1.3 - the pipeline runs lead -> qualified -> blueprint',
    );
  }

  const row = await db().lead.update({
    where: { id: input.leadId },
    data: {
      stage: 'blueprint_delivered',
      blueprintDeliveredOn: input.deliveredOn,
      blueprintReadiness: input.readiness,
      lastActivityAt: input.deliveredOn,
    },
  });

  await db().leadActivity.create({
    data: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      kind: 'blueprint_delivered',
      summary: `Readiness Blueprint delivered; readiness ${input.readiness}.`,
      fromStage: existing.stage,
      toStage: 'blueprint_delivered',
      occurredAt: input.deliveredOn,
      recordedBy: input.actor.id,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.blueprint.delivered',
    actor: input.actor,
    payload: { leadId: input.leadId, readiness: input.readiness },
  });

  return ok(toLead(row));
};

/**
 * Schedule the Blueprint Review Call.
 *
 * Records that a call is scheduled and when. It does not book anything: a calendar integration is
 * a gated vendor, and a module that claimed to have booked a call it had not would be worse than
 * one that plainly records an intention.
 */
export const scheduleReviewCall = async (input: {
  tenantId: string;
  leadId: string;
  scheduledFor: Date;
  scheduledOn: Date;
  actor: EventActor;
}): Promise<Outcome<LeadRecord>> => {
  const existing = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
  });
  if (!existing) return noData('No such lead in this tenant.');

  if (existing.blueprintDeliveredOn === null) {
    return refused(
      `A Blueprint Review Call reviews the Blueprint, and none has been delivered to '${existing.prospectName}'.`,
      'Blueprint 1.3 - the review call follows the Blueprint',
    );
  }

  const row = await db().lead.update({
    where: { id: input.leadId },
    data: {
      stage: 'review_call_scheduled',
      reviewCallScheduledFor: input.scheduledFor,
      lastActivityAt: input.scheduledOn,
    },
  });

  await db().leadActivity.create({
    data: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      kind: 'review_call_scheduled',
      summary: `Blueprint Review Call scheduled for ${input.scheduledFor.toISOString().slice(0, 10)}.`,
      fromStage: existing.stage,
      toStage: 'review_call_scheduled',
      occurredAt: input.scheduledOn,
      recordedBy: input.actor.id,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.review_call.scheduled',
    actor: input.actor,
    payload: { leadId: input.leadId, scheduledFor: input.scheduledFor.toISOString() },
  });

  return ok(toLead(row));
};

export const pipeline = async (
  tenantId: string,
  stage?: LeadStage,
): Promise<readonly LeadRecord[]> => {
  const rows = await db().lead.findMany({
    where: { tenantId, ...(stage !== undefined ? { stage: stage as never } : {}) },
    orderBy: { lastActivityAt: 'asc' },
  });
  return rows.map(toLead);
};
