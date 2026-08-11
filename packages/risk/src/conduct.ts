/**
 * Client Conduct Monitoring - blueprint 6.3.
 *
 * **6.3 detects. 6.4 decides.** The detection layer produces breaches and a graduated response;
 * the determination that a client should not receive further capital stays where it already is,
 * behind a Level 3 human, in 6.4. A second automatic path onto the Do Not Fund list would be the
 * second door ADR-0034 is about, on the most serious determination this system makes.
 *
 * Three rules shape the file, and the second is the one worth reading.
 *
 *  1. **A service pause is automatic; a termination is recommended.** The pause is the reversible
 *     restriction and the safe direction while somebody works out what happened - 6.4's reasoning
 *     for automatic listing on compliance `fail`, applied to a lesser control. Termination ends a
 *     relationship and takes a person, exactly as 8.1 already decided for partners.
 *
 *  2. **Staleness moves toward the safe answer, and the safe answer is not always "stop".**
 *
 *     ADR-0013 established the rule and both of its previous applications happened to point the
 *     same way as intuition: a stale provider approval stops being usable (5.4), a stale Do Not
 *     Fund listing keeps blocking (6.4). Here the kinds disagree with each other, and pretending
 *     they do not would be the mistake ADR-0013 exists to prevent.
 *
 *     A client who applied for capital behind our back while frozen, unreviewed for ninety days, is
 *     still a client who did that. Nothing about elapsed time resolves it, and the pause HARDENS.
 *
 *     A client who stopped answering the phone after funding, unreviewed for ninety days, may be in
 *     difficulty. **Freezing service to somebody in distress is the harm, not the remedy** - the
 *     stale record is most likely wrong in the direction of "this person needs a call", and the
 *     safe answer is a human reaching out rather than a stricter gate. That one SOFTENS.
 *
 *     So the direction is a property of the KIND, declared beside it, and a tenth kind cannot be
 *     added without choosing one.
 *
 *  3. **A conduct breach is not a compliance state.** Decision E's four values describe whether a
 *     client's file passes review; they are 1.1's, they are categorical, and nothing here writes
 *     one. A client can be in `pass` and have paused service, and the two facts are about different
 *     things. Merging them would put conduct into a field the Firewall reads as an assessment.
 *
 * The response level is **worst-of** over open breaches, never a count and never an average. A
 * client with one abuse incident and nine months of perfect payments is a client with an abuse
 * incident.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { SEVERITIES, type Severity } from './classify.js';
import { recordObservation, type ObservationKind } from './observations.js';

export type BreachKind =
  | 'independent_application'
  | 'undisclosed_debt'
  | 'funds_usage_anomaly'
  | 'document_inconsistency'
  | 'payment_alert_non_response'
  | 'staff_pressure_incident'
  | 'post_funding_non_response'
  | 'unfounded_fee_dispute'
  | 'abuse';

/**
 * The graduated response blueprint 6.3 asks for, worst first.
 *
 * `termination_recommended` is a recommendation and says so. 6.3 does not end engagements.
 */
export type ConductResponse =
  'termination_recommended' | 'escalate' | 'service_pause' | 'monitor' | 'none';

export const CONDUCT_RESPONSES = [
  'termination_recommended',
  'escalate',
  'service_pause',
  'monitor',
  'none',
] as const satisfies readonly ConductResponse[];

/**
 * Which way an unreviewed breach moves.
 *
 * `hardens`   the response stands and escalates one step; time does not resolve it
 * `softens`   the response steps DOWN toward outreach; the stale record is most likely wrong in
 *             the direction of "this person needs a call", and a stricter gate is the harm
 */
export type StaleDirection = 'hardens' | 'softens';

export interface KindPolicy {
  readonly response: ConductResponse;
  readonly staleDirection: StaleDirection;
  readonly reviewCadenceDays: number;
  /** Why this kind moves the way it does. Read by the operator in the refusal text. */
  readonly rationale: string;
  /** Which 6.5 timeline entry this breach becomes. */
  readonly observationKind: ObservationKind;
}

/**
 * The per-kind decision, in one table so that adding a kind means making the decision.
 *
 * The `response` here is the response at `serious` severity; `critical` escalates one step and
 * `notable` and `context` step down. See `responseFor`.
 */
export const KIND_POLICY: Readonly<Record<BreachKind, KindPolicy>> = {
  independent_application: {
    response: 'service_pause',
    staleDirection: 'hardens',
    reviewCadenceDays: 90,
    rationale:
      'A client who applied for capital elsewhere while placement was frozen is still that client ninety days later. Nothing about elapsed time resolves it, and the stack we are advising on has changed without us.',
    observationKind: 'new_debt_discovered',
  },
  undisclosed_debt: {
    response: 'service_pause',
    staleDirection: 'hardens',
    reviewCadenceDays: 90,
    rationale:
      'Every figure in the capital stack was computed without this. The analysis stays wrong until somebody redoes it, and time does not redo it.',
    observationKind: 'new_debt_discovered',
  },
  funds_usage_anomaly: {
    response: 'escalate',
    staleDirection: 'hardens',
    reviewCadenceDays: 60,
    rationale:
      'Capital placed for one purpose and used for another changes the suitability case the placement rested on, and the change does not reverse itself.',
    observationKind: 'other',
  },
  document_inconsistency: {
    response: 'escalate',
    staleDirection: 'hardens',
    reviewCadenceDays: 60,
    rationale:
      'Documents that disagree are documents somebody has to reconcile before a lender sees them. An unreconciled inconsistency is the one that reaches an application.',
    observationKind: 'other',
  },
  payment_alert_non_response: {
    response: 'monitor',
    staleDirection: 'softens',
    reviewCadenceDays: 30,
    rationale:
      'A missed alert is most often a missed email. Hardening on silence would pause service to a client whose only offence is not reading their inbox, and the pause is what they would notice.',
    observationKind: 'missed_payment',
  },
  staff_pressure_incident: {
    response: 'escalate',
    staleDirection: 'hardens',
    reviewCadenceDays: 90,
    rationale:
      'Pressure on staff to do something they should not is the conduct the authority system exists to make impossible from the inside. A pattern of it needs a person, and time is not that person.',
    observationKind: 'human_intervention',
  },
  post_funding_non_response: {
    response: 'monitor',
    staleDirection: 'softens',
    reviewCadenceDays: 30,
    rationale:
      'A client who has gone quiet after funding may be in difficulty, and freezing their service is the harm rather than the remedy. The safe direction is a human reaching out, so this steps DOWN toward outreach rather than up toward a gate. ADR-0013: the safe answer is not always "stop".',
    observationKind: 'other',
  },
  unfounded_fee_dispute: {
    response: 'monitor',
    staleDirection: 'softens',
    reviewCadenceDays: 60,
    rationale:
      'A disputed fee the record does not support is usually a client who did not understand an invoice. Escalating on silence turns a billing conversation into a conduct file.',
    observationKind: 'dispute',
  },
  abuse: {
    response: 'termination_recommended',
    staleDirection: 'hardens',
    reviewCadenceDays: 90,
    rationale:
      'Abuse toward staff is the one kind here that is about the relationship rather than about the capital. It does not expire.',
    observationKind: 'complaint',
  },
};

export const BREACH_KINDS = Object.keys(KIND_POLICY) as readonly BreachKind[];

const DAY_MS = 24 * 60 * 60 * 1000;

const rank = (response: ConductResponse): number => CONDUCT_RESPONSES.indexOf(response);

/** One step stricter, saturating at the top. */
const harden = (response: ConductResponse): ConductResponse =>
  CONDUCT_RESPONSES[Math.max(0, rank(response) - 1)] as ConductResponse;

/** One step gentler, saturating at `none`. */
const soften = (response: ConductResponse): ConductResponse =>
  CONDUCT_RESPONSES[Math.min(CONDUCT_RESPONSES.length - 1, rank(response) + 1)] as ConductResponse;

/**
 * The response one breach calls for, before staleness.
 *
 * Severity shifts the kind's baseline by one step in each direction. It is not a weighting and it
 * is not summed with anything: two `notable` breaches are two notable breaches, not one serious
 * one. Counting them would be the averaging Decision E's reasoning forbids, arriving through
 * addition instead of division.
 */
export const responseFor = (kind: BreachKind, severity: Severity): ConductResponse => {
  const base = KIND_POLICY[kind].response;
  if (severity === 'critical') return harden(base);
  if (severity === 'notable') return soften(base);
  if (severity === 'context') return soften(soften(base));
  return base;
};

export interface Breach {
  readonly id: string;
  readonly clientId: string;
  readonly kind: BreachKind;
  readonly severity: Severity;
  readonly summary: string;
  readonly source: string;
  readonly occurredAt: string;
  readonly detectedAt: string;
  readonly detectedBy: string;
  readonly reviewCadenceDays: number;
  readonly lastReviewedAt: string | null;
  /** Derived, never stored. A stored flag needs a job, and a job that stops reads as "fresh". */
  readonly reviewOverdue: boolean;
  readonly reviewDueAt: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly upheld: boolean | null;
  readonly open: boolean;
  /** What this one breach calls for, with staleness already applied. */
  readonly response: ConductResponse;
  /** Present when staleness moved the response, so the shift is never silent. */
  readonly staleNote: string | null;
}

interface BreachRow {
  id: string;
  clientId: string;
  kind: string;
  severity: string;
  summary: string;
  source: string;
  occurredAt: Date;
  detectedAt: Date;
  detectedBy: string;
  reviewCadenceDays: number;
  lastReviewedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  upheld: boolean | null;
}

const reviewDueAt = (row: {
  detectedAt: Date;
  lastReviewedAt: Date | null;
  reviewCadenceDays: number;
}): Date =>
  new Date((row.lastReviewedAt ?? row.detectedAt).getTime() + row.reviewCadenceDays * DAY_MS);

const toBreach = (row: BreachRow, now: Date): Breach => {
  const kind = row.kind as BreachKind;
  const policy = KIND_POLICY[kind];
  const overdue = row.resolvedAt === null && now.getTime() > reviewDueAt(row).getTime();
  const base = responseFor(kind, row.severity as Severity);

  const response = !overdue
    ? base
    : policy.staleDirection === 'hardens'
      ? harden(base)
      : soften(base);

  return {
    id: row.id,
    clientId: row.clientId,
    kind,
    severity: row.severity as Severity,
    summary: row.summary,
    source: row.source,
    occurredAt: row.occurredAt.toISOString(),
    detectedAt: row.detectedAt.toISOString(),
    detectedBy: row.detectedBy,
    reviewCadenceDays: row.reviewCadenceDays,
    lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
    reviewOverdue: overdue,
    reviewDueAt: reviewDueAt(row).toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolutionNote: row.resolutionNote,
    upheld: row.upheld,
    open: row.resolvedAt === null,
    response,
    staleNote:
      overdue && response !== base
        ? `Review overdue, so this ${policy.staleDirection === 'hardens' ? 'hardened' : 'softened'} from ${base} to ${response}. ${policy.rationale}`
        : overdue
          ? `Review overdue. ${policy.rationale}`
          : null,
  };
};

export interface DetectInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: BreachKind;
  readonly severity: Severity;
  readonly summary: string;
  /** Where the detection came from. Required - see the refusal. */
  readonly source: string;
  readonly occurredAt: Date;
  readonly detectedBy: string;
  readonly actor: EventActor;
  readonly reviewCadenceDays?: number;
  readonly now?: Date;
}

/**
 * Record a detected breach, and write it to the 6.5 timeline.
 *
 * The timeline entry is written **here**, inside the detection, and there is no way to record a
 * breach without it. 6.5 calls itself the chronological record of every risk-relevant event per
 * client, and a conduct breach that never reached it would leave the timeline claiming completeness
 * it does not have - which is worse than an obviously partial timeline, because nobody would know
 * to look elsewhere.
 *
 * **If the observation cannot be written, this returns `failed` and says the timeline is short one
 * entry.** The breach row and its Ledger event are already written; the Ledger is append-only and
 * nothing can be rolled back. What must not happen is a caller receiving `ok` and believing 6.5 is
 * complete.
 */
export const detectBreach = async (input: DetectInput): Promise<Outcome<Breach>> => {
  const now = input.now ?? new Date();
  const policy = KIND_POLICY[input.kind];

  if (policy === undefined) {
    return refused(
      `'${input.kind}' is not a conduct breach kind. Adding one means deciding its response and which way staleness moves it - see KIND_POLICY.`,
      'Blueprint 6.3 with ADR-0013 - a cadenced record decides its own staleness direction',
    );
  }
  if (!SEVERITIES.includes(input.severity)) {
    return refused(
      `'${input.severity}' is not a severity. Use one of: ${SEVERITIES.join(', ')}.`,
      'Blueprint 6.3 - severity is categorical',
    );
  }
  if (input.summary.trim().length < 10) {
    return refused(
      'A conduct breach needs a summary somebody can read back to the client. This is the record a service pause rests on.',
      'Blueprint 6.3 - audit trail for every flag',
    );
  }
  if (input.source.trim() === '') {
    return refused(
      'A conduct breach needs a source. A breach with no provenance is an accusation, and a service pause built on accusations cuts a client off on a rumour.',
      'Design principle 8 - provenance on output',
    );
  }
  if (input.occurredAt.getTime() > now.getTime()) {
    return refused(
      'A conduct breach cannot have occurred in the future. Check the date.',
      'Blueprint 6.3 - audit trail for every flag',
    );
  }

  const row = await db().clientConductBreach.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind as never,
      severity: input.severity,
      summary: input.summary,
      source: input.source,
      occurredAt: input.occurredAt,
      detectedAt: now,
      detectedBy: input.detectedBy,
      reviewCadenceDays: input.reviewCadenceDays ?? policy.reviewCadenceDays,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.conduct.detected',
    actor: input.actor,
    clientId: input.clientId,
    // The summary stays in the row. It is free text about a named client, and the Ledger cannot be
    // corrected.
    payload: {
      breachId: row.id,
      kind: input.kind,
      severity: input.severity,
      response: responseFor(input.kind, input.severity),
    },
  });

  const observation = await recordObservation({
    tenantId: input.tenantId,
    clientId: input.clientId,
    kind: policy.observationKind,
    severity: input.severity,
    summary: input.summary,
    source: input.source,
    occurredAt: input.occurredAt,
    recordedBy: input.detectedBy,
    actor: input.actor,
    now,
  });

  if (observation.status !== 'ok') {
    return {
      status: 'failed',
      reason:
        'The breach was recorded and the 6.5 timeline was not updated, so the timeline is short one entry and does not know it. Replay the observation before anybody reads the timeline as complete.',
      cause: observation.status,
    };
  }

  await db().clientConductBreach.update({
    where: { id: row.id },
    data: { observationId: observation.value.id },
  });

  return ok(toBreach(row, now));
};

/**
 * Close a breach.
 *
 * A dismissed breach is resolved, not deleted. A run of dismissed detections against one client is
 * a signal about the detector, and it is invisible if dismissal erases the row - the same reasoning
 * that keeps a released hold, a removed listing and a dismissed partner finding on the record.
 */
export const resolveBreach = async (input: {
  tenantId: string;
  breachId: string;
  upheld: boolean;
  note: string;
  resolvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Breach>> => {
  const now = input.now ?? new Date();

  if (input.note.trim().length < 10) {
    return refused(
      'Resolving a conduct breach needs a note somebody can read back - what was looked into and what was concluded.',
      'Blueprint 6.3 - audit trail for every flag',
    );
  }

  const existing = await db().clientConductBreach.findFirst({
    where: { tenantId: input.tenantId, id: input.breachId },
  });
  if (!existing) return noData('No such conduct breach in this tenant.');
  if (existing.resolvedAt !== null) {
    return refused(
      `This breach was already resolved on ${existing.resolvedAt.toISOString().slice(0, 10)}.`,
      'Blueprint 6.3 - one resolution per breach',
    );
  }

  const actor = await findActor(input.resolvedBy);
  if (!actor || actor.kind !== 'human') {
    return refused(
      'Resolving a conduct breach requires a human. It is the decision that lifts a service pause.',
      'ADR-0012 with ADR-0013 - automatic in, human out',
    );
  }

  const row = await db().clientConductBreach.update({
    where: { id: existing.id },
    data: {
      resolvedAt: now,
      resolvedBy: input.resolvedBy,
      resolutionNote: input.note,
      upheld: input.upheld,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.conduct.resolved',
    actor: input.actor,
    clientId: existing.clientId,
    payload: { breachId: existing.id, kind: existing.kind, upheld: input.upheld },
  });

  return ok(toBreach(row, now));
};

/** Record a review, restarting the cadence and changing nothing else. */
export const reviewBreach = async (input: {
  tenantId: string;
  breachId: string;
  reviewedBy: string;
  notes: string;
  now?: Date;
}): Promise<Outcome<Breach>> => {
  const now = input.now ?? new Date();

  const existing = await db().clientConductBreach.findFirst({
    where: { tenantId: input.tenantId, id: input.breachId, resolvedAt: null },
  });
  if (!existing) return noData('No such open conduct breach in this tenant.');

  const actor = await findActor(input.reviewedBy);
  if (!actor || actor.kind !== 'human') {
    return refused(
      'Reviewing a conduct breach requires a human.',
      'ADR-0012 with ADR-0013 - automatic in, human out',
    );
  }

  const wasOverdue = toBreach(existing, now).reviewOverdue;

  const row = await db().clientConductBreach.update({
    where: { id: existing.id },
    data: { lastReviewedAt: now, lastReviewedBy: input.reviewedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.conduct.reviewed',
    actor: { id: input.reviewedBy, kind: 'human' },
    clientId: existing.clientId,
    payload: { breachId: existing.id, notes: input.notes, wasOverdue },
  });

  return ok(toBreach(row, now));
};

/** Every breach for a client, newest first. Resolved ones included - they are the record. */
export const breachesFor = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<readonly Breach[]> => {
  const rows = await db().clientConductBreach.findMany({
    where: { tenantId, clientId },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map((row) => toBreach(row, now));
};

export interface ConductStanding {
  readonly clientId: string;
  /** Worst-of over open breaches. Never a count, never an average. */
  readonly response: ConductResponse;
  readonly openBreaches: readonly Breach[];
  /** True when the response is `service_pause` or worse. What the middleware asks. */
  readonly servicePaused: boolean;
  readonly note: string;
}

/**
 * The client's conduct standing.
 *
 * **Worst-of.** A client with one abuse incident and nine months of perfect payments is a client
 * with an abuse incident; any function that let the nine months soften the one would be doing the
 * arithmetic Decision E's reasoning forbids - arriving at it through counting rather than dividing,
 * which is the form it usually takes.
 *
 * Derived on read. Sixth appearance of that call in this codebase, and the reason is the same each
 * time: a stored standing needs a job to maintain it, and a job that stops leaves every client
 * reading as clear.
 */
export const conductStanding = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<ConductStanding> => {
  const rows = await db().clientConductBreach.findMany({
    where: { tenantId, clientId, resolvedAt: null },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
  });
  const openBreaches = rows.map((row) => toBreach(row, now));

  const response =
    openBreaches.length === 0
      ? 'none'
      : (CONDUCT_RESPONSES.find((candidate) =>
          openBreaches.some((breach) => breach.response === candidate),
        ) ?? 'none');

  const paused = rank(response) <= rank('service_pause');

  return {
    clientId,
    response,
    openBreaches,
    servicePaused: paused,
    note:
      openBreaches.length === 0
        ? 'No open conduct breach is recorded for this client.'
        : `${openBreaches.length} open breach(es); the response is the worst of them, which is ${response}. ${openBreaches
            .filter((breach) => breach.response === response)
            .map(
              (breach) =>
                `${breach.kind}${breach.staleNote !== null ? ` - ${breach.staleNote}` : ''}`,
            )
            .join('; ')}`,
  };
};

/**
 * Actions a client with paused service may still be subject to.
 *
 * An allow-list rather than a block-list, copied deliberately from 6.4's `DO_NOT_FUND_PERMITTED_ACTIONS`
 * and for the same reason: a block-list lets an action added next year move capital toward a paused
 * client because nobody remembered to add it. Over-blocking produces a complaint from an operator;
 * under-blocking produces a client the company decided to pause being served anyway.
 *
 * Communication is on the list, and that is the point of a *pause* rather than a freeze. The reason
 * a client is paused is usually a conversation somebody needs to have with them, and a control that
 * made the conversation impossible would make the pause permanent by accident.
 */
export const CONDUCT_PERMITTED_ACTIONS: readonly string[] = [
  'read_document',
  'analyze_file',
  'generate_internal_report',
  'draft_communication',
  'send_client_communication',
  'send_document_request',
];

export const isPermittedWhilePaused = (action: string): boolean =>
  CONDUCT_PERMITTED_ACTIONS.includes(action);

export interface ConductClearance {
  readonly paused: boolean;
  readonly response: ConductResponse;
  readonly detail: string;
}

/**
 * Whether a named action may proceed given this client's conduct.
 *
 * Called by the middleware chain at step 4, beside `checkDoNotFund`. **An assessment nothing
 * consults is a report, not a control** - 6.3 would otherwise compute `service_pause` for a client
 * who applied behind our back and that client would go on being placed, which is the state
 * ADR-0034 found `autoListForComplianceFail` in.
 *
 * Do Not Fund is checked before this, and the precedence is about which true statement to lead
 * with: a standing determination not to fund somebody outranks "their service is paused while we
 * look into something", and telling an operator the second when the first is true sends them to
 * resolve the wrong thing.
 */
export const checkConduct = async (
  tenantId: string,
  clientId: string,
  action: string,
  now: Date = new Date(),
): Promise<Outcome<ConductClearance>> => {
  const standing = await conductStanding(tenantId, clientId, now);

  if (!standing.servicePaused) {
    return ok({
      paused: false,
      response: standing.response,
      detail: standing.note,
    });
  }

  if (isPermittedWhilePaused(action)) {
    return ok({
      paused: true,
      response: standing.response,
      detail: `Service is paused (${standing.response}) and '${action}' is permitted while paused - reviewing and talking to the client is how a pause gets lifted. ${standing.note}`,
    });
  }

  return refused(
    `Service is paused for this client pending conduct review. ${standing.note} Lifting it takes a human resolving the open breach.`,
    'Blueprint 6.3 - triggers service pause based on defined thresholds',
  );
};

/**
 * Open breaches whose review has outrun its cadence.
 *
 * The queue the cadence produces. **Every entry carries which way it moved**, because half of them
 * hardened and half softened, and a queue that presented them alike would teach its reader that
 * overdue means stricter - which is true of most of this system and false here.
 */
export const breachesDueForReview = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Breach[]> => {
  const rows = await db().clientConductBreach.findMany({
    where: { tenantId, resolvedAt: null },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toBreach(row, now)).filter((breach) => breach.reviewOverdue);
};
