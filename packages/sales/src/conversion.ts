/**
 * Conversion and loss - blueprint 1.3's "conversion event logging with structured outcome data".
 *
 * The interesting property here is the one that is easy to build wrong without noticing: **a sales
 * motion must not be a way around the compliance one.**
 *
 * Conversion creates a client through 1.1's `create`, which starts every client in
 * `pending_assessment` - the state the Funding Ethics Firewall gate already refuses. So a converted
 * client cannot be placed until somebody assesses them, and that holds because conversion has no
 * other path to a client record rather than because a check remembered to run.
 *
 * It is tested rather than asserted in a comment, because the day somebody adds a second path is
 * the day the comment stops being true and nothing else notices.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { create as createClient } from '@bwc/clients';
import { currentOffer, startEngagement } from '@bwc/billing';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export type LostReason =
  | 'price'
  | 'timing'
  | 'not_a_fit'
  | 'went_elsewhere'
  | 'unresponsive'
  | 'compliance_concern'
  | 'client_withdrew'
  | 'other';

export const LOST_REASONS = [
  'price',
  'timing',
  'not_a_fit',
  'went_elsewhere',
  'unresponsive',
  'compliance_concern',
  'client_withdrew',
  'other',
] as const satisfies readonly LostReason[];

export interface ConversionResult {
  readonly leadId: string;
  readonly clientId: string;
  readonly engagementId: string | null;
  /** The compliance state the new client starts in. Always `pending_assessment`. */
  readonly complianceState: string;
}

export interface ConvertInput {
  readonly tenantId: string;
  readonly leadId: string;
  /** When given, an engagement is started on that rung at the same time. */
  readonly offerKey?: string;
  readonly annualPrepay?: boolean;
  readonly convertedBy: string;
  readonly convertedOn: Date;
  readonly actor: EventActor;
}

/**
 * Convert a lead into a client, and optionally into an engagement.
 *
 * Refuses a second conversion rather than creating a second client. A lead converted twice would
 * produce two client records for one business, and every downstream figure - exposure, fees,
 * compliance state - would then be computed over half a picture with nothing indicating the split.
 */
export const convertLead = async (input: ConvertInput): Promise<Outcome<ConversionResult>> => {
  const lead = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
    include: { outcome: true },
  });
  if (!lead) return noData('No such lead in this tenant.');

  if (lead.outcome !== null) {
    return refused(
      `'${lead.prospectName}' already has an outcome recorded (${lead.outcome.converted ? 'converted' : 'closed lost'}) on ${lead.outcome.decidedAt.toISOString().slice(0, 10)}. Converting again would produce a second client record for one business, and every downstream figure would then be computed over half a picture.`,
      'Blueprint 1.3 - a lead converts once',
    );
  }

  if (lead.qualification !== 'qualified') {
    return refused(
      `'${lead.prospectName}' has not been qualified. Qualification is the step that decides whether this is a client the company should take on, and converting past it makes the step decorative.`,
      'Blueprint 1.3 - the pipeline runs lead -> qualified -> converted',
    );
  }

  // Validate the offer BEFORE creating anything.
  //
  // The first version created the client first and refused afterwards if the engagement could not
  // start - which left an orphan client behind and, because no outcome was recorded, allowed a
  // retry to create a second one. A function whose refusal path leaves a partial write is not
  // refusing; it is half-converting and reporting an error. Found by a test named
  // "refuses rather than half-converting" that the code was failing to honour.
  if (input.offerKey !== undefined) {
    const offer = await currentOffer(input.tenantId, input.offerKey);
    if (offer.status !== 'ok') {
      return refused(
        `No offer is published under '${input.offerKey}', so no engagement can be started. Nothing has been created: a half-done conversion is worse than a refused one, because the orphan client it leaves behind is invisible to everyone except the next person who converts this lead.`,
        'Blueprint 1.3 with 1.4 - conversion may start an engagement, and either both happen or neither does',
      );
    }
  }

  // The client is created through 1.1, which starts it in `pending_assessment`. That is the
  // property this module leans on: the sales motion cannot hand a client to placement.
  const client = await createClient(input.tenantId, lead.prospectName, input.actor);

  let engagementId: string | null = null;
  if (input.offerKey !== undefined) {
    const engagement = await startEngagement({
      tenantId: input.tenantId,
      clientId: client.id,
      offerKey: input.offerKey,
      startedOn: input.convertedOn,
      ...(input.annualPrepay !== undefined ? { annualPrepay: input.annualPrepay } : {}),
      actor: input.actor,
    });

    if (engagement.status !== 'ok') {
      // Unreachable given the check above, and left in place rather than removed: the offer could
      // be superseded between the two calls, and a `startEngagement` that fails for a reason
      // nobody anticipated should surface rather than throw away its own outcome.
      return engagement as Outcome<ConversionResult>;
    }
    engagementId = engagement.value.id;
  }

  await db().$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: input.leadId },
      data: { stage: 'converted', lastActivityAt: input.convertedOn },
    });

    await tx.leadOutcome.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        converted: true,
        clientId: client.id,
        engagementId,
        decidedBy: input.convertedBy,
        decidedAt: input.convertedOn,
      },
    });

    await tx.leadActivity.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        kind: 'converted',
        summary: `Converted to client${engagementId !== null ? ` and engaged on ${input.offerKey}` : ''}.`,
        fromStage: lead.stage,
        toStage: 'converted',
        occurredAt: input.convertedOn,
        recordedBy: input.actor.id,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.lead.converted',
    actor: input.actor,
    clientId: client.id,
    payload: {
      leadId: input.leadId,
      clientId: client.id,
      engagementId,
      sourceChannel: lead.sourceChannel,
      referrerName: lead.referrerName,
      convertedBy: input.convertedBy,
    },
  });

  return ok({
    leadId: input.leadId,
    clientId: client.id,
    engagementId,
    complianceState: client.complianceState,
  });
};

/**
 * Close a lead as lost.
 *
 * The reason is **categorical** with optional detail. "Why do we lose leads" is a question somebody
 * will want counted, and a thousand free-text sentences cannot be counted - while a category with
 * no detail loses the specifics that make a pattern actionable. Both, so neither is lost.
 */
export const closeLead = async (input: {
  tenantId: string;
  leadId: string;
  reason: LostReason;
  detail?: string;
  closedBy: string;
  closedOn: Date;
  actor: EventActor;
}): Promise<Outcome<{ leadId: string }>> => {
  const lead = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
    include: { outcome: true },
  });
  if (!lead) return noData('No such lead in this tenant.');

  if (lead.outcome !== null) {
    return refused(
      `'${lead.prospectName}' already has an outcome recorded on ${lead.outcome.decidedAt.toISOString().slice(0, 10)}.`,
      'Blueprint 1.3 - a lead ends once',
    );
  }

  await db().$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: input.leadId },
      data: { stage: 'closed_lost', lastActivityAt: input.closedOn },
    });

    await tx.leadOutcome.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        converted: false,
        lostReason: input.reason as never,
        lostDetail: input.detail ?? null,
        decidedBy: input.closedBy,
        decidedAt: input.closedOn,
      },
    });

    await tx.leadActivity.create({
      data: {
        tenantId: input.tenantId,
        leadId: input.leadId,
        kind: 'closed_lost',
        summary: `Closed lost: ${input.reason}${input.detail !== undefined ? ` - ${input.detail}` : ''}.`,
        fromStage: lead.stage,
        toStage: 'closed_lost',
        occurredAt: input.closedOn,
        recordedBy: input.actor.id,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.lead.closed',
    actor: input.actor,
    payload: {
      leadId: input.leadId,
      reason: input.reason,
      sourceChannel: lead.sourceChannel,
      referrerName: lead.referrerName,
    },
  });

  return ok({ leadId: input.leadId });
};

export interface ConversionStats {
  readonly sourceChannel: string;
  readonly total: number;
  readonly converted: number;
  readonly lost: number;
  readonly open: number;
  /** Null below a minimum sample, for the reason 5.2's approval rate gives. */
  readonly conversionRate: number | null;
  readonly note: string;
}

/**
 * Below this many decided leads, no rate is reported.
 *
 * The same judgement as `MINIMUM_OUTCOMES_FOR_RATE` in 5.2, for the same reason: two conversions
 * out of three is "67%" arithmetically and nothing at all about a channel. A channel report that
 * ranked partners on three leads each would send the company's marketing budget somewhere on noise.
 */
export const MINIMUM_LEADS_FOR_RATE = 10;

/** Conversion by source channel. The report attribution exists for. */
export const conversionByChannel = async (
  tenantId: string,
): Promise<readonly ConversionStats[]> => {
  const leads = await db().lead.findMany({ where: { tenantId }, include: { outcome: true } });
  const byChannel = new Map<string, { converted: number; lost: number; open: number }>();

  for (const lead of leads) {
    const bucket = byChannel.get(lead.sourceChannel) ?? { converted: 0, lost: 0, open: 0 };
    if (lead.outcome === null) bucket.open += 1;
    else if (lead.outcome.converted) bucket.converted += 1;
    else bucket.lost += 1;
    byChannel.set(lead.sourceChannel, bucket);
  }

  return [...byChannel.entries()]
    .map(([sourceChannel, counts]) => {
      const decided = counts.converted + counts.lost;
      const enough = decided >= MINIMUM_LEADS_FOR_RATE;

      return {
        sourceChannel,
        total: decided + counts.open,
        converted: counts.converted,
        lost: counts.lost,
        open: counts.open,
        conversionRate: enough ? counts.converted / decided : null,
        note: enough
          ? `${counts.converted} of ${decided} decided leads converted.`
          : `${decided} decided lead(s); ${MINIMUM_LEADS_FOR_RATE} are needed before a rate says anything about a channel.`,
      };
    })
    .sort((a, b) => b.total - a.total);
};

/** Why leads are lost, counted. The output the categorical reason exists for. */
export const lossReasons = async (
  tenantId: string,
): Promise<readonly { reason: LostReason; count: number }[]> => {
  const rows = await db().leadOutcome.groupBy({
    by: ['lostReason'],
    where: { tenantId, converted: false },
    _count: { _all: true },
  });

  return rows
    .filter((row): row is typeof row & { lostReason: LostReason } => row.lostReason !== null)
    .map((row) => ({ reason: row.lostReason, count: row._count._all }))
    .sort((a, b) => b.count - a.count);
};
