/**
 * Attribution corrections - blueprint 1.3's "source attribution".
 *
 * A referral fee is owed to whoever introduced a client. That makes attribution a **financial
 * fact**, and a financial fact that can be edited after the money is at stake is not a record - it
 * is an opinion with a timestamp.
 *
 * So `leads.ts` exposes no path that updates the attribution columns, and a correction lands here:
 * a new row carrying who changed it, when, and why, with the original left untouched on the Lead.
 * The question that stays answerable is **"who was this attributed to when the fee was
 * calculated"**, and overwriting the original destroys the only evidence of it.
 *
 * The correction is what the payout process reads. The Lead's own columns remain the record of
 * what was believed at first contact.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export interface AttributionState {
  readonly sourceChannel: string;
  readonly referrerName: string | null;
  /** True when a correction has been recorded, so a reader knows to look at the history. */
  readonly corrected: boolean;
  readonly asAt: string;
}

export interface CorrectionRecord {
  readonly id: string;
  readonly fromSourceChannel: string;
  readonly toSourceChannel: string;
  readonly fromReferrerName: string | null;
  readonly toReferrerName: string | null;
  readonly reason: string;
  readonly correctedBy: string;
  readonly correctedAt: string;
}

/**
 * Correct a lead's attribution.
 *
 * Requires a Level 3 human and a reason. Changing who a referral fee is owed to is a decision with
 * money on the end of it, and the two things that make it reviewable later are a name and a reason
 * - both read from the recorded actor rather than trusted from the caller.
 */
export const correctAttribution = async (input: {
  tenantId: string;
  leadId: string;
  toSourceChannel: string;
  toReferrerName?: string | null;
  reason: string;
  actor: EventActor;
  correctedBy: string;
  correctedAt: Date;
}): Promise<Outcome<CorrectionRecord>> => {
  if (input.reason.trim() === '') {
    return refused(
      'An attribution correction needs a reason. It changes who a referral fee is owed to, and an unexplained change to that is indistinguishable from an error nobody caught.',
      'Blueprint 1.3 - source attribution',
    );
  }
  if (input.toSourceChannel.trim() === '') {
    return refused(
      'A correction must state the corrected source channel.',
      'Blueprint 1.3 - source attribution',
    );
  }

  const actor = await findActor(input.actor.id);
  if (actor === null || actor.kind !== 'human' || actor.authorityLevel < 3) {
    return refused(
      'Correcting attribution requires a human at Authority Level 3. It moves money between partners, and an agent able to do it would make the record unreliable in exactly the place it needs to be trusted.',
      'Design principle 4 with blueprint 1.3',
    );
  }

  const lead = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
  });
  if (!lead) return noData('No such lead in this tenant.');

  const current = await currentAttribution(input.tenantId, input.leadId);
  if (current.status !== 'ok') return current as Outcome<CorrectionRecord>;

  const row = await db().attributionCorrection.create({
    data: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      fromSourceChannel: current.value.sourceChannel,
      toSourceChannel: input.toSourceChannel,
      fromReferrerName: current.value.referrerName,
      toReferrerName: input.toReferrerName ?? null,
      reason: input.reason,
      correctedBy: input.correctedBy,
      correctedAt: input.correctedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.attribution.corrected',
    actor: input.actor,
    payload: {
      leadId: input.leadId,
      fromSourceChannel: current.value.sourceChannel,
      toSourceChannel: input.toSourceChannel,
      fromReferrerName: current.value.referrerName,
      toReferrerName: input.toReferrerName ?? null,
      reason: input.reason,
      correctedBy: actor.label,
    },
  });

  return ok(toCorrection(row));
};

interface CorrectionRow {
  id: string;
  fromSourceChannel: string;
  toSourceChannel: string;
  fromReferrerName: string | null;
  toReferrerName: string | null;
  reason: string;
  correctedBy: string;
  correctedAt: Date;
}

const toCorrection = (row: CorrectionRow): CorrectionRecord => ({
  id: row.id,
  fromSourceChannel: row.fromSourceChannel,
  toSourceChannel: row.toSourceChannel,
  fromReferrerName: row.fromReferrerName,
  toReferrerName: row.toReferrerName,
  reason: row.reason,
  correctedBy: row.correctedBy,
  correctedAt: row.correctedAt.toISOString(),
});

/**
 * Attribution as it stands now - the original, or the latest correction if there is one.
 *
 * What a payout process should read. The Lead's own columns are what was believed at first
 * contact, and both remain available because they answer different questions.
 */
export const currentAttribution = async (
  tenantId: string,
  leadId: string,
): Promise<Outcome<AttributionState>> => {
  const lead = await db().lead.findFirst({ where: { tenantId, id: leadId } });
  if (!lead) return noData('No such lead in this tenant.');

  const latest = await db().attributionCorrection.findFirst({
    where: { tenantId, leadId },
    orderBy: { correctedAt: 'desc' },
  });

  return ok(
    latest === null
      ? {
          sourceChannel: lead.sourceChannel,
          referrerName: lead.referrerName,
          corrected: false,
          asAt: lead.attributedAt.toISOString(),
        }
      : {
          sourceChannel: latest.toSourceChannel,
          referrerName: latest.toReferrerName,
          corrected: true,
          asAt: latest.correctedAt.toISOString(),
        },
  );
};

/**
 * Attribution as originally recorded, whatever has happened since.
 *
 * Kept as its own function rather than left implicit in the Lead row: a payout dispute is asking
 * exactly this question, and the answer should not depend on somebody knowing which columns were
 * never updated.
 */
export const originalAttribution = async (
  tenantId: string,
  leadId: string,
): Promise<Outcome<AttributionState>> => {
  const lead = await db().lead.findFirst({ where: { tenantId, id: leadId } });
  if (!lead) return noData('No such lead in this tenant.');

  return ok({
    sourceChannel: lead.sourceChannel,
    referrerName: lead.referrerName,
    corrected: false,
    asAt: lead.attributedAt.toISOString(),
  });
};

/** Every correction, newest first. */
export const correctionHistory = async (
  tenantId: string,
  leadId: string,
): Promise<readonly CorrectionRecord[]> => {
  const rows = await db().attributionCorrection.findMany({
    where: { tenantId, leadId },
    orderBy: { correctedAt: 'desc' },
  });
  return rows.map(toCorrection);
};
