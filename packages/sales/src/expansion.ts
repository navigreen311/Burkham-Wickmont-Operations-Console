/**
 * Expansion and renewal - blueprint 1.3's "expansion-path trigger firing based on time-since-
 * Blueprint and readiness-score deltas" and "renewal / save motion status".
 *
 * A signal here is a **prompt to have a conversation**, not an instruction to upsell. That
 * distinction shapes the output: every signal carries what moved and by how much, so the operator
 * has something to say. A trigger that fired without saying why would produce a call that opens
 * "the system suggested I reach out", which is worse than no call.
 *
 * Derived at read time rather than stored, for the reason this codebase has now met five times
 * (ADR-0007, 0009, 0010, 0011): a stored flag needs a job to maintain it, and a job that stops
 * leaves the signal silently absent - which for an expansion prompt means revenue nobody knows was
 * missed.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

/**
 * How much readiness has to move before it is worth a conversation.
 *
 * Ten points. Small movements are noise - a bank feed refreshing, a balance changing - and a
 * trigger that fired on those would train an operator to ignore the queue, which costs more than
 * the calls it would have prompted.
 */
export const READINESS_DELTA_THRESHOLD = 10;

/**
 * How long after the Blueprint an expansion conversation becomes due on time alone.
 *
 * Ninety days: long enough that the Blueprint's recommendations have been acted on or abandoned,
 * short enough that the client still remembers the conversation.
 */
export const BLUEPRINT_AGE_DAYS = 90;

/** A renewal within this many days of the committed window ending is approaching. */
export const RENEWAL_WINDOW_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / DAY_MS);

export interface ReadingRecord {
  readonly readiness: number;
  readonly note: string;
  readonly takenOn: string;
  readonly takenBy: string;
}

/** Record a readiness reading taken after the Blueprint. */
export const recordReadiness = async (input: {
  tenantId: string;
  leadId: string;
  readiness: number;
  note: string;
  takenOn: Date;
  takenBy: string;
  actor: EventActor;
}): Promise<Outcome<ReadingRecord>> => {
  if (!Number.isInteger(input.readiness) || input.readiness < 0 || input.readiness > 100) {
    return refused(
      `A readiness of ${input.readiness} is not a whole number between 0 and 100, so it cannot be compared with the Blueprint figure.`,
      'Blueprint 1.3 - expansion triggers compare readiness across time',
    );
  }
  if (input.note.trim() === '') {
    return refused(
      'A readiness reading needs a note saying what moved. A delta with no explanation tells an operator to act without telling them what to say.',
      'Blueprint 1.3 - expansion-path trigger firing',
    );
  }

  const lead = await db().lead.findFirst({
    where: { tenantId: input.tenantId, id: input.leadId },
  });
  if (!lead) return noData('No such lead in this tenant.');

  const row = await db().readinessReading.create({
    data: {
      tenantId: input.tenantId,
      leadId: input.leadId,
      readiness: input.readiness,
      note: input.note,
      takenOn: input.takenOn,
      takenBy: input.takenBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'sales.readiness.recorded',
    actor: input.actor,
    payload: { leadId: input.leadId, readiness: input.readiness, takenBy: input.takenBy },
  });

  return ok({
    readiness: row.readiness,
    note: row.note,
    takenOn: row.takenOn.toISOString(),
    takenBy: row.takenBy,
  });
};

export const readingsFor = async (
  tenantId: string,
  leadId: string,
): Promise<readonly ReadingRecord[]> => {
  const rows = await db().readinessReading.findMany({
    where: { tenantId, leadId },
    orderBy: [{ takenOn: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    readiness: row.readiness,
    note: row.note,
    takenOn: row.takenOn.toISOString(),
    takenBy: row.takenBy,
  }));
};

export type ExpansionTrigger = 'readiness_improved' | 'blueprint_aged';

export interface ExpansionSignal {
  readonly leadId: string;
  readonly clientId: string;
  readonly prospectName: string;
  readonly trigger: ExpansionTrigger;
  /** What moved and by how much, so the operator has something to open with. */
  readonly basis: string;
  readonly readinessAtBlueprint: number | null;
  readonly readinessNow: number | null;
  readonly daysSinceBlueprint: number;
}

/**
 * Expansion prompts for converted clients.
 *
 * Only converted leads: an expansion conversation is with a client, and prompting one for a
 * prospect who never signed would put the sales motion and the expansion motion in the same queue
 * saying different things about the same person.
 *
 * A readiness improvement and an aged Blueprint are reported separately rather than collapsed into
 * one signal. They call for different conversations - "your position has improved, here is what
 * that opens" versus "it has been three months, shall we look again" - and merging them would
 * force the operator to work out which they were being handed.
 */
export const expansionSignals = async (
  tenantId: string,
  today: Date = new Date(),
): Promise<readonly ExpansionSignal[]> => {
  const leads = await db().lead.findMany({
    where: { tenantId, stage: 'converted', blueprintDeliveredOn: { not: null } },
    include: { outcome: true },
  });

  const signals: ExpansionSignal[] = [];

  for (const lead of leads) {
    const clientId = lead.outcome?.clientId;
    if (clientId === null || clientId === undefined) continue;
    if (lead.blueprintDeliveredOn === null) continue;

    const daysSince = daysBetween(lead.blueprintDeliveredOn, today);

    const latest = await db().readinessReading.findFirst({
      where: { tenantId, leadId: lead.id, takenOn: { lte: today } },
      orderBy: [{ takenOn: 'desc' }, { id: 'asc' }],
    });

    const base = lead.blueprintReadiness;

    if (latest !== null && base !== null && latest.readiness - base >= READINESS_DELTA_THRESHOLD) {
      signals.push({
        leadId: lead.id,
        clientId,
        prospectName: lead.prospectName,
        trigger: 'readiness_improved',
        basis: `Readiness has moved from ${base} at the Blueprint to ${latest.readiness} on ${latest.takenOn.toISOString().slice(0, 10)}: ${latest.note}`,
        readinessAtBlueprint: base,
        readinessNow: latest.readiness,
        daysSinceBlueprint: daysSince,
      });
    }

    if (daysSince >= BLUEPRINT_AGE_DAYS) {
      signals.push({
        leadId: lead.id,
        clientId,
        prospectName: lead.prospectName,
        trigger: 'blueprint_aged',
        basis: `The Readiness Blueprint was delivered ${daysSince} days ago. Its recommendations have either been acted on or overtaken.`,
        readinessAtBlueprint: base,
        readinessNow: latest?.readiness ?? null,
        daysSinceBlueprint: daysSince,
      });
    }
  }

  return signals.sort((a, b) => b.daysSinceBlueprint - a.daysSinceBlueprint);
};

export type RenewalStatus = 'not_due' | 'approaching' | 'at_risk' | 'renewed' | 'lapsed';

export interface RenewalState {
  readonly engagementId: string;
  readonly clientId: string;
  readonly status: RenewalStatus;
  readonly committedThrough: string | null;
  readonly daysRemaining: number | null;
  readonly explanation: string;
}

/**
 * Where each engagement stands against its committed window - the "renewal / save motion status".
 *
 * `at_risk` is the save motion: the window has closed and nothing has replaced it. Reported
 * separately from `lapsed` because the two are different conversations, and the difference is
 * whether anybody is still in time to have one.
 *
 * A cancelled engagement is `lapsed` regardless of its dates. It ended for a reason somebody
 * recorded, and presenting it as "approaching renewal" would put a client who left at the top of a
 * retention queue.
 */
export const renewalStates = async (
  tenantId: string,
  today: Date = new Date(),
): Promise<readonly RenewalState[]> => {
  const engagements = await db().engagement.findMany({ where: { tenantId } });

  return engagements.map((engagement) => {
    const base = {
      engagementId: engagement.id,
      clientId: engagement.clientId,
      committedThrough: engagement.committedThrough?.toISOString() ?? null,
    };

    if (engagement.status === 'cancelled') {
      return {
        ...base,
        status: 'lapsed' as const,
        daysRemaining: null,
        explanation: `Cancelled on ${engagement.cancelledOn?.toISOString().slice(0, 10) ?? 'an unrecorded date'}. Not a renewal conversation.`,
      };
    }

    if (engagement.committedThrough === null) {
      return {
        ...base,
        status: 'not_due' as const,
        daysRemaining: null,
        explanation: 'No committed window, so there is no renewal date to be approaching.',
      };
    }

    const daysRemaining = daysBetween(today, engagement.committedThrough);

    if (daysRemaining < 0) {
      return {
        ...base,
        status: 'at_risk' as const,
        daysRemaining,
        explanation: `The committed window closed ${Math.abs(daysRemaining)} days ago and nothing has replaced it. This is the save motion, and it is still in time to have.`,
      };
    }

    return {
      ...base,
      status:
        daysRemaining <= RENEWAL_WINDOW_DAYS ? ('approaching' as const) : ('not_due' as const),
      daysRemaining,
      explanation:
        daysRemaining <= RENEWAL_WINDOW_DAYS
          ? `${daysRemaining} days remain on the committed window. A renewal conversation is due.`
          : `${daysRemaining} days remain on the committed window.`,
    };
  });
};
