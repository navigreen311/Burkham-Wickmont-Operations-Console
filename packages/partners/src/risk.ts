/**
 * Partner risk - blueprint 8.4.
 *
 * **Blueprint 8.4 asks for a score, and this module does not produce one.** That is the whole
 * design decision and it is worth the paragraph.
 *
 * The dimensions 8.4 lists are two different kinds of thing wearing one name. *Claim compliance*,
 * *unauthorized promises detected* and *documentation quality* are conduct: a partner either
 * promised a client an approval or they did not. *Conversion rate*, *complaint rate*, *refund rate*
 * and *revenue contribution* are performance: numeric, and meaningless below a sample.
 *
 * Combining them produces a number in which **revenue contribution offsets an unauthorized
 * promise**. That is exactly the trade design principle 1 forbids - compliance shape first, dollars
 * second - and a single figure would make it invisibly, because the arithmetic gives no sign that
 * one of its inputs was a compliance breach. It is also Decision E's argument transplanted: the
 * reason compliance state is categorical is that a number invites an average, and an average of a
 * breach and a success is a smaller breach.
 *
 * So:
 *
 *   `standing`   categorical, WORST-OF over open conduct findings. Never averaged, never counted
 *                against anything good the partner did.
 *   `measures`   the numeric dimensions, each with its denominator, each `null` below a minimum
 *                sample - the same refusal 5.2, 1.3, 9.1 and 5.5 all make.
 *
 * Nothing here reduces the two to one figure, and nothing here should.
 *
 * **This module surfaces; it does not act** - with one exception, and the exception is the part
 * that makes it a control rather than a report.
 *
 * 8.1 already recorded the reasoning for the general rule: "a trigger that fired on its own would
 * end a commercial relationship - and cut off the referred clients' visibility - with nobody
 * answerable for it. Triggers surface; a person terminates." Termination and decertification stay
 * that way.
 *
 * The exception is a **critical** finding, which suspends the partner immediately and from inside
 * `recordFinding`. An unauthorized promise is a Level 4 prohibited action performed by somebody
 * outside the authority system, and leaving one to wait for Monday is 6.4's Friday problem with a
 * client on the other end of it. Automatic in, human out: reinstatement takes a person. And it is
 * written inside the recording function rather than beside it, because ADR-0034 is what happens to
 * a control a caller can reach past.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { findPartner, suspendPartner } from './partners.js';
import { leadsAttributedTo } from './attributed.js';

export type FindingKind =
  | 'unauthorized_promise'
  | 'unapproved_claim'
  | 'client_complaint'
  | 'documentation_gap'
  | 'brand_misuse'
  | 'other';

export type FindingSeverity = 'critical' | 'serious' | 'notable' | 'context';

/** Worst first, so `indexOf` is a rank. Same order and same words as 6.5's. */
export const FINDING_SEVERITIES = ['critical', 'serious', 'notable', 'context'] as const;

export type PartnerStanding =
  'good_standing' | 'watch' | 'review_required' | 'decertification_recommended';

/**
 * Standings, worst first.
 *
 * `decertification_recommended` is a recommendation and says so in its name. Nothing in this module
 * decertifies: 8.3 owns certification and 8.1 owns the relationship, and a second path into either
 * would be the second door ADR-0034 is about.
 */
export const PARTNER_STANDINGS = [
  'decertification_recommended',
  'review_required',
  'watch',
  'good_standing',
] as const;

/** Below this many decided referrals, no rate is reported. Ten, matching 1.3, 5.2, 5.5 and 9.1. */
export const MINIMUM_REFERRALS_FOR_RATE = 10;

/**
 * Open findings of each severity that move the standing.
 *
 * Thresholds are per dimension, never against a composite. Blueprint 8.4 asks for "threshold-based
 * escalation", and a threshold on a combined score is a threshold a good quarter can hide.
 */
export const STANDING_THRESHOLDS = {
  /** One is enough. A promise of approval to a client is not a frequency question. */
  criticalFindings: 1,
  /** Three open serious findings is a pattern rather than an incident. */
  seriousFindings: 3,
  /** Any open serious finding is worth a look before it is worth a review. */
  notableFindings: 5,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Finding {
  readonly id: string;
  readonly partnerId: string;
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly source: string;
  readonly clientId: string | null;
  readonly occurredAt: string;
  readonly recordedBy: string;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly upheld: boolean | null;
  readonly open: boolean;
}

interface FindingRow {
  id: string;
  partnerId: string;
  kind: string;
  severity: string;
  summary: string;
  source: string;
  clientId: string | null;
  occurredAt: Date;
  recordedBy: string;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  upheld: boolean | null;
}

const toFinding = (row: FindingRow): Finding => ({
  id: row.id,
  partnerId: row.partnerId,
  kind: row.kind as FindingKind,
  severity: row.severity as FindingSeverity,
  summary: row.summary,
  source: row.source,
  clientId: row.clientId,
  occurredAt: row.occurredAt.toISOString(),
  recordedBy: row.recordedBy,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  resolutionNote: row.resolutionNote,
  upheld: row.upheld,
  open: row.resolvedAt === null,
});

export interface RecordFindingInput {
  readonly tenantId: string;
  readonly partnerId: string;
  readonly kind: FindingKind;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly source: string;
  readonly clientId?: string;
  readonly occurredAt: Date;
  readonly recordedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

export interface RecordedFinding {
  readonly finding: Finding;
  /** True when this finding suspended the partner. See the module header. */
  readonly suspendedPartner: boolean;
}

/**
 * Record a finding, and suspend the partner if it is critical.
 *
 * The suspension happens **here**, synchronously, and there is no way to record a critical finding
 * without it. Four places could have composed the two calls and three of them leave the same hole
 * ADR-0034 found: a Console route leaves every other caller unsuspended, a scheduled job makes a
 * safety decision eventually-consistent on a queue that can stop, and a `recordAndSuspend` wrapper
 * leaves the plain function reachable and better-named.
 *
 * **If the suspension cannot be written, this returns `failed` and says the partner is not
 * suspended.** The finding row and its Ledger event are already written and the Ledger is
 * append-only, so nothing can be rolled back. What must not happen is a caller receiving `ok` and
 * believing a partner is stopped who is not.
 */
export const recordFinding = async (
  input: RecordFindingInput,
): Promise<Outcome<RecordedFinding>> => {
  const now = input.now ?? new Date();

  if (input.summary.trim().length < 10) {
    return refused(
      'A partner finding needs a summary somebody can read back to the partner. This is the record a decertification would rest on.',
      'Blueprint 8.4 - conduct monitoring with an audit trail',
    );
  }
  if (input.source.trim() === '') {
    return refused(
      'A partner finding needs a source. A finding with no provenance is a rumour, and a standing built on rumours ends a commercial relationship on the recollection of whoever spoke last.',
      'Design principle 8 - provenance on output',
    );
  }
  if (!(FINDING_SEVERITIES as readonly string[]).includes(input.severity)) {
    return refused(
      `'${input.severity}' is not a severity. Use one of: ${FINDING_SEVERITIES.join(', ')}.`,
      'Blueprint 8.4 - severity is categorical',
    );
  }
  if (input.occurredAt.getTime() > now.getTime()) {
    return refused(
      'A finding cannot have occurred in the future. Check the date.',
      'Blueprint 8.4 - conduct monitoring',
    );
  }

  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  const row = await db().partnerConductFinding.create({
    data: {
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      kind: input.kind as never,
      severity: input.severity as never,
      summary: input.summary,
      source: input.source,
      clientId: input.clientId ?? null,
      occurredAt: input.occurredAt,
      recordedAt: now,
      recordedBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.finding.recorded',
    actor: input.actor,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    // The summary stays in the row. It is free text about a named partner and, often, a named
    // client, and the Ledger is the one store here that cannot be corrected.
    payload: {
      findingId: row.id,
      partnerId: input.partnerId,
      kind: input.kind,
      severity: input.severity,
    },
  });

  if (input.severity !== 'critical') {
    return ok({ finding: toFinding(row), suspendedPartner: false });
  }

  // Already suspended or terminated: nothing to do, and re-suspending would restamp `suspendedAt`
  // and lose when the relationship actually stopped.
  if (!partner.value.engageable) {
    return ok({ finding: toFinding(row), suspendedPartner: false });
  }

  const suspended = await suspendPartner({
    tenantId: input.tenantId,
    partnerId: input.partnerId,
    reason: `Critical conduct finding (${input.kind}): ${input.summary}`,
    suspendedBy: input.recordedBy,
    actor: input.actor,
    now,
  });

  if (suspended.status !== 'ok') {
    return {
      status: 'failed',
      reason:
        'The finding was recorded and the partner was NOT suspended. They can still refer clients. Suspend them by hand and find out why this failed before deciding it is minor.',
      cause: suspended.status,
    };
  }

  return ok({ finding: toFinding(row), suspendedPartner: true });
};

/**
 * Close a finding.
 *
 * A dismissed finding is resolved, not deleted. A pattern of dismissed complaints about one partner
 * is itself a signal, and it is invisible if dismissal erases the row - which is the same reasoning
 * that keeps a released legal hold and a removed Do Not Fund listing on the record.
 */
export const resolveFinding = async (input: {
  tenantId: string;
  findingId: string;
  upheld: boolean;
  note: string;
  resolvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Finding>> => {
  const now = input.now ?? new Date();

  if (input.note.trim().length < 10) {
    return refused(
      'Resolving a finding needs a note somebody can read back - what was looked into and what was concluded.',
      'Blueprint 8.4 - audit trail on every decision',
    );
  }

  const existing = await db().partnerConductFinding.findFirst({
    where: { tenantId: input.tenantId, id: input.findingId },
  });
  if (!existing) return noData('No such partner finding in this tenant.');
  if (existing.resolvedAt !== null) {
    return refused(
      `This finding was already resolved on ${existing.resolvedAt.toISOString().slice(0, 10)}.`,
      'Blueprint 8.4 - one resolution per finding',
    );
  }

  const actor = await findActor(input.resolvedBy);
  if (!actor || actor.kind !== 'human') {
    return refused(
      'Resolving a partner finding requires a human. It is the decision that stops it counting toward the standing.',
      'Blueprint 8.4 - escalation to Channel Partnerships review',
    );
  }

  const row = await db().partnerConductFinding.update({
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
    type: 'partner.finding.resolved',
    actor: input.actor,
    payload: { findingId: existing.id, partnerId: existing.partnerId, upheld: input.upheld },
  });

  return ok(toFinding(row));
};

/** Findings for a partner, newest first. Resolved ones included - they are the record. */
export const findingsFor = async (
  tenantId: string,
  partnerId: string,
): Promise<readonly Finding[]> => {
  const rows = await db().partnerConductFinding.findMany({
    where: { tenantId, partnerId },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toFinding);
};

/**
 * A numeric dimension, with what it was computed from.
 *
 * The same shape 9.1's `Metric` takes and deliberately not an import of it: 9.1 is a dashboard
 * module and a dependency from 8.4 on it would put partner assessment downstream of reporting.
 * The discipline is shared; the type is not.
 */
export interface Measure {
  readonly key: string;
  readonly label: string;
  /** Null below the minimum sample, or when the input is not built. Never a zero standing in. */
  readonly value: number | null;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly note: string;
}

const rateMeasure = (input: {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  whatCounts: string;
}): Measure =>
  input.denominator < MINIMUM_REFERRALS_FOR_RATE
    ? {
        key: input.key,
        label: input.label,
        value: null,
        numerator: input.numerator,
        denominator: input.denominator,
        note: `${input.denominator} ${input.whatCounts}; ${MINIMUM_REFERRALS_FOR_RATE} are needed before a rate means anything. ${input.numerator} of ${input.denominator} so far - the counts are real and are shown, the rate is not and is withheld.`,
      }
    : {
        key: input.key,
        label: input.label,
        value: input.numerator / input.denominator,
        numerator: input.numerator,
        denominator: input.denominator,
        note: `${input.numerator} of ${input.denominator} ${input.whatCounts}.`,
      };

export interface StandingTrigger {
  readonly dimension: string;
  readonly threshold: number;
  readonly observed: number;
  readonly standing: PartnerStanding;
  readonly note: string;
}

export interface PartnerAssessment {
  readonly partnerId: string;
  /** Categorical. Worst-of over open findings, never averaged with anything below. */
  readonly standing: PartnerStanding;
  /** Which thresholds fired, so the standing is explicable rather than merely asserted. */
  readonly triggers: readonly StandingTrigger[];
  readonly openFindings: readonly Finding[];
  /** Numeric dimensions. Reported beside the standing and NEVER combined with it. */
  readonly measures: readonly Measure[];
  /** Dimensions blueprint 8.4 names that no module can currently answer. */
  readonly unmeasured: readonly string[];
  readonly assessedAt: string;
  readonly note: string;
}

const worstOf = (findings: readonly Finding[]): StandingTrigger[] => {
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    serious: findings.filter((f) => f.severity === 'serious').length,
    notable: findings.filter((f) => f.severity === 'notable').length,
  };

  const triggers: StandingTrigger[] = [];

  if (counts.critical >= STANDING_THRESHOLDS.criticalFindings) {
    triggers.push({
      dimension: 'critical_findings',
      threshold: STANDING_THRESHOLDS.criticalFindings,
      observed: counts.critical,
      standing: 'decertification_recommended',
      note: `${counts.critical} open critical finding(s). One is enough: a promise of approval to a client is not a frequency question, and it is a Level 4 prohibited action performed by somebody outside the authority system.`,
    });
  }
  if (counts.serious >= STANDING_THRESHOLDS.seriousFindings) {
    triggers.push({
      dimension: 'serious_findings',
      threshold: STANDING_THRESHOLDS.seriousFindings,
      observed: counts.serious,
      standing: 'review_required',
      note: `${counts.serious} open serious finding(s), at or over the threshold of ${STANDING_THRESHOLDS.seriousFindings}. A pattern rather than an incident.`,
    });
  } else if (counts.serious > 0) {
    triggers.push({
      dimension: 'serious_findings',
      threshold: 1,
      observed: counts.serious,
      standing: 'watch',
      note: `${counts.serious} open serious finding(s). Below the review threshold and worth watching.`,
    });
  }
  if (counts.notable >= STANDING_THRESHOLDS.notableFindings) {
    triggers.push({
      dimension: 'notable_findings',
      threshold: STANDING_THRESHOLDS.notableFindings,
      observed: counts.notable,
      standing: 'watch',
      note: `${counts.notable} open notable finding(s), at or over ${STANDING_THRESHOLDS.notableFindings}.`,
    });
  }

  return triggers;
};

/**
 * The standing, as the worst thing that is true.
 *
 * **Worst-of, never a mean.** A partner with one unauthorized promise and ninety clean referrals is
 * a partner with an unauthorized promise; any function that let the ninety soften the one would be
 * doing the arithmetic design principle 1 forbids.
 */
export const standingFromTriggers = (triggers: readonly StandingTrigger[]): PartnerStanding => {
  for (const standing of PARTNER_STANDINGS) {
    if (triggers.some((trigger) => trigger.standing === standing)) return standing;
  }
  return 'good_standing';
};

/**
 * Assess a partner.
 *
 * Returns a standing and a set of measures, and deliberately no single figure combining them. See
 * the module header, and ADR-0043 for the argument in full.
 */
export const assessPartner = async (
  tenantId: string,
  partnerId: string,
  now: Date = new Date(),
): Promise<Outcome<PartnerAssessment>> => {
  const partner = await findPartner(tenantId, partnerId);
  if (partner.status !== 'ok') return partner;

  const rows = await db().partnerConductFinding.findMany({
    where: { tenantId, partnerId, resolvedAt: null },
    orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
  });
  const openFindings = rows.map(toFinding);

  const triggers = worstOf(openFindings);
  const standing = standingFromTriggers(triggers);

  const leads = await leadsAttributedTo(tenantId, partnerId);
  const decided = leads.filter((lead) => lead.converted !== null);
  const converted = decided.filter((lead) => lead.converted === true);

  const complaints = await db().partnerConductFinding.count({
    where: { tenantId, partnerId, kind: 'client_complaint' },
  });
  const documentationGaps = await db().partnerConductFinding.count({
    where: { tenantId, partnerId, kind: 'documentation_gap' },
  });

  const measures: Measure[] = [
    rateMeasure({
      key: 'conversion_rate',
      label: 'Referral conversion rate',
      numerator: converted.length,
      denominator: decided.length,
      whatCounts: 'decided referral(s)',
    }),
    rateMeasure({
      key: 'complaint_rate',
      label: 'Complaint rate per referral',
      numerator: complaints,
      denominator: leads.length,
      whatCounts: 'referral(s)',
    }),
    rateMeasure({
      key: 'documentation_gap_rate',
      label: 'Documentation gaps per referral',
      numerator: documentationGaps,
      denominator: leads.length,
      whatCounts: 'referral(s)',
    }),
    {
      key: 'referrals_open',
      label: 'Referrals still open',
      value: leads.length - decided.length,
      numerator: leads.length - decided.length,
      denominator: leads.length,
      note: `${leads.length - decided.length} of ${leads.length} referral(s) have not been decided. A count, not a rate - an open referral is not evidence about the partner in either direction.`,
    },
  ];

  return ok({
    partnerId,
    standing,
    triggers,
    openFindings,
    measures,
    // Named rather than silently absent. Blueprint 8.4 lists these and nothing can answer them yet.
    unmeasured: [
      'refund rate and revenue contribution - 8.2 Partner Agreement & Payout Center owns referral fee terms, the state restrictions on them, and clawback on refunds. A contribution figure computed without those looks payable and may name money it is unlawful to pay (see `payableToPartner`).',
      'high-risk client rate - requires reading 6.4 Do Not Fund listings per referred client, which crosses from the partner network into client risk governance. Left out until somebody decides that is a link the partner surface should have.',
    ],
    assessedAt: now.toISOString(),
    note:
      standing === 'good_standing'
        ? 'No open finding moves this partner off good standing. The measures below describe performance and are reported separately: nothing here combines them with the standing, because a number that let revenue offset a compliance breach would make that trade invisibly.'
        : `${standing.replace(/_/g, ' ')}: ${triggers.map((trigger) => trigger.note).join(' ')} The measures below are reported separately and do not soften this - worst-of, not mean.`,
  });
};

/**
 * The weekly queue - blueprint 8.4's "weekly score updates" and "threshold-based escalation".
 *
 * Derived on read rather than written by a job. A stored standing needs something to maintain it,
 * and a job that stops leaves every partner reading as freshly assessed - which is the most
 * reassuring possible failure and the fifth time this codebase has made the same call (ADR-0007,
 * 0009, 0010, 0011, 1.3's inactivity).
 */
export const partnersNeedingReview = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly PartnerAssessment[]> => {
  const partners = await db().partner.findMany({
    where: { tenantId, status: { notIn: ['terminated'] } },
    orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  const assessments: PartnerAssessment[] = [];
  for (const partner of partners) {
    const assessment = await assessPartner(tenantId, partner.id, now);
    if (assessment.status !== 'ok') continue;
    if (assessment.value.standing === 'good_standing' || assessment.value.standing === 'watch') {
      continue;
    }
    assessments.push(assessment.value);
  }
  return assessments;
};

/** How long a critical finding has been open, for an escalation note. */
export const daysOpen = (finding: Finding, now: Date): number =>
  Math.floor((now.getTime() - new Date(finding.occurredAt).getTime()) / DAY_MS);
