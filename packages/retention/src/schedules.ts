/**
 * Retention schedules - blueprint 7.5.
 *
 * **A schedule is an authorisation to destroy, and that is why its absence blocks.**
 *
 * The vault has refused to delete an unscheduled document since it was built, and its comment says
 * exactly why: over-retention is a liability, and destroying a record a regulator was entitled to
 * see is the irreversible one. This module supplies the schedules; it does not weaken the refusal.
 *
 * The asymmetry with `holds.ts` is worth naming because the two look like the same rule and are
 * opposite. **Absence of a hold means not held. Absence of a schedule means not permitted.** Both
 * are ADR-0007 and ADR-0009's "absence is not permission", read carefully enough to notice which
 * side each record sits on: a hold restricts, a schedule permits, and the safe reading of silence
 * is therefore different for each.
 *
 * Two consequences follow.
 *
 *  1. **Provenance is required.** A retention period is the number that decides whether a document
 *     is destroyed. One nobody researched, presented with the same confidence as one read out of a
 *     statute, is precisely the failure principle 8 exists to prevent - and here it is measured in
 *     shredded records rather than in a client's disappointment. The tag rides on every resolution
 *     so a caller cannot use the figure without seeing where it came from.
 *
 *  2. **A stale `issuer_rule` is reported as stale rather than silently trusted.** ADR-0013's
 *     question is "if this record is stale and wrong, which way is safe", and for a retention
 *     period the honest answer is that a stale one is not evidence for destruction. It is surfaced
 *     rather than enforced here, because refusing on it outright would make every schedule expire
 *     into a permanent block; the caller that destroys is where the decision belongs, and it has
 *     what it needs to make it.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import {
  noData,
  ok,
  refused,
  toIso,
  type EventActor,
  type IssuerRuleProvenance,
  type Outcome,
  type Provenance,
  type UnresearchedDefaultProvenance,
} from '@bwc/core';

/**
 * How long an `issuer_rule` schedule is trusted before it is flagged.
 *
 * A year. Statutory retention periods move slowly, and 5.2's fourteen-day appetite window would be
 * absurd here - but "somebody checked this at some point" is not the same claim as "this is
 * current", and after a year it should stop being presented as one.
 */
export const VERIFICATION_STALE_AFTER_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Schedule {
  readonly id: string;
  readonly documentKind: string;
  /** Null means the default that applies where no state rule is recorded. */
  readonly stateCode: string | null;
  readonly retainMonths: number;
  readonly provenance: LegalProvenance;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly supersededAt: string | null;
}

interface ScheduleRow {
  id: string;
  documentKind: string;
  stateCode: string | null;
  retainMonths: number;
  provenanceTag: string;
  sourceUrl: string | null;
  lastVerified: Date | null;
  verifiedBy: string | null;
  rationale: string | null;
  recordedBy: string;
  createdAt: Date;
  supersededAt: Date | null;
}

/**
 * The two tags a retention period may carry.
 *
 * Narrower than `Provenance` on purpose. A vendor feed and a client statement are not sources of
 * law, and typing this as the full union would let a caller read `sourceUrl` off something that has
 * none - which the compiler catches here and would not catch there.
 */
type LegalProvenance = IssuerRuleProvenance | UnresearchedDefaultProvenance;

const provenanceOf = (row: ScheduleRow): LegalProvenance =>
  row.provenanceTag === 'issuer_rule'
    ? {
        tag: 'issuer_rule',
        sourceUrl: row.sourceUrl ?? '',
        lastVerified: toIso(row.lastVerified ?? row.createdAt),
        verifiedBy: row.verifiedBy ?? '',
      }
    : { tag: 'unresearched_default', rationale: row.rationale ?? '' };

const toSchedule = (row: ScheduleRow): Schedule => ({
  id: row.id,
  documentKind: row.documentKind,
  stateCode: row.stateCode,
  retainMonths: row.retainMonths,
  provenance: provenanceOf(row),
  recordedBy: row.recordedBy,
  recordedAt: row.createdAt.toISOString(),
  supersededAt: row.supersededAt?.toISOString() ?? null,
});

export interface RecordScheduleInput {
  readonly tenantId: string;
  readonly documentKind: string;
  /** Omit for the default that applies where no state rule is recorded. */
  readonly stateCode?: string;
  readonly retainMonths: number;
  readonly provenance: Provenance;
  readonly recordedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Record a schedule, superseding any it replaces.
 *
 * Superseded rather than updated: what the schedule said on the day a document was destroyed is the
 * question an audit asks, and an overwritten row cannot answer it. Same discipline as 5.2's rule
 * versions and 7.3's contract templates.
 */
export const recordSchedule = async (input: RecordScheduleInput): Promise<Outcome<Schedule>> => {
  const now = input.now ?? new Date();

  if (!Number.isInteger(input.retainMonths) || input.retainMonths <= 0) {
    return refused(
      'A retention period is a whole number of months above zero. A period of zero authorises immediate destruction, which is a decision that should be written as one rather than arrived at by arithmetic.',
      'Blueprint 7.5 - retention schedule per document type',
    );
  }
  if (input.provenance.tag !== 'issuer_rule' && input.provenance.tag !== 'unresearched_default') {
    return refused(
      `A retention period comes from a statute or it is an assumption. '${input.provenance.tag}' is neither - a vendor feed and a client statement are not sources of law.`,
      'Design principle 8 - provenance on output, Decision D portfolio-wide',
    );
  }
  if (input.provenance.tag === 'issuer_rule' && input.provenance.sourceUrl.trim() === '') {
    return refused(
      'A statutory retention period needs its citation. Without one it is an assumption wearing the confidence of a statute.',
      'Design principle 8 - provenance on output',
    );
  }
  if (
    input.provenance.tag === 'unresearched_default' &&
    input.provenance.rationale.trim().length < 10
  ) {
    return refused(
      'An unresearched retention period needs the reasoning behind the assumption, because somebody will destroy records on it.',
      'Design principle 8 - provenance on output',
    );
  }
  if (input.stateCode !== undefined && !/^[A-Z]{2}$/.test(input.stateCode)) {
    return refused(
      `'${input.stateCode}' is not a two-letter state code. A malformed one matches nothing and silently falls back to the default.`,
      'Blueprint 7.2 with 7.5 - state-specific retention rule variants',
    );
  }

  await db().retentionSchedule.updateMany({
    where: {
      tenantId: input.tenantId,
      documentKind: input.documentKind as never,
      stateCode: input.stateCode ?? null,
      supersededAt: null,
    },
    data: { supersededAt: now, supersededBy: input.recordedBy },
  });

  const row = await db().retentionSchedule.create({
    data: {
      tenantId: input.tenantId,
      documentKind: input.documentKind as never,
      stateCode: input.stateCode ?? null,
      retainMonths: input.retainMonths,
      provenanceTag: input.provenance.tag as never,
      sourceUrl: input.provenance.tag === 'issuer_rule' ? input.provenance.sourceUrl : null,
      lastVerified:
        input.provenance.tag === 'issuer_rule' ? new Date(input.provenance.lastVerified) : null,
      verifiedBy: input.provenance.tag === 'issuer_rule' ? input.provenance.verifiedBy : null,
      rationale:
        input.provenance.tag === 'unresearched_default' ? input.provenance.rationale : null,
      recordedBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'retention.schedule.recorded',
    actor: input.actor,
    payload: {
      scheduleId: row.id,
      documentKind: input.documentKind,
      stateCode: input.stateCode ?? null,
      retainMonths: input.retainMonths,
      provenanceTag: input.provenance.tag,
    },
  });

  return ok(toSchedule(row));
};

export interface ResolvedRetention {
  readonly documentKind: string;
  /** The state whose rule was applied, or null when the default was. */
  readonly appliedStateCode: string | null;
  readonly retainMonths: number;
  /** The date the document may be destroyed on or after. */
  readonly retainUntil: string;
  readonly provenance: LegalProvenance;
  /**
   * True when the schedule rests on an assumption or on a citation nobody has checked in a year.
   *
   * Reported, not enforced. Refusing outright would turn every schedule into a permanent block a
   * year after it was written; the module that actually destroys something is where that decision
   * belongs, and this is what it needs to make it.
   */
  readonly unverified: boolean;
  readonly note: string;
}

const addMonths = (from: Date, months: number): Date => {
  const result = new Date(from.getTime());
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
};

/**
 * Resolve the schedule for one document.
 *
 * A state-specific rule beats the default, which is the whole reason `stateCode` is a nullable
 * column on one table rather than a second table: "what applies in Texas" is one query and an
 * ordering, not two queries and a merge somebody will get wrong in one direction only.
 *
 * `no_data` - never a default - when nothing is recorded. **A fallback period invented here would
 * be indistinguishable from a researched one at the point of deletion**, which is the exact shape
 * of the failure Decision D exists to prevent, with records rather than recommendations at stake.
 */
export const resolveRetention = async (input: {
  tenantId: string;
  documentKind: string;
  /** The client's state, where it is known. Omit when it is not. */
  stateCode?: string;
  /** The document's own date - retention runs from the record, not from today. */
  documentDate: Date;
  now?: Date;
}): Promise<Outcome<ResolvedRetention>> => {
  const now = input.now ?? new Date();

  const candidates = await db().retentionSchedule.findMany({
    where: {
      tenantId: input.tenantId,
      documentKind: input.documentKind as never,
      supersededAt: null,
      OR: [
        { stateCode: null },
        ...(input.stateCode !== undefined ? [{ stateCode: input.stateCode }] : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });

  if (candidates.length === 0) {
    return noData(
      `No retention schedule is recorded for ${input.documentKind}${
        input.stateCode !== undefined ? ` in ${input.stateCode}` : ''
      }, and none is assumed. A period invented here would be indistinguishable from a researched one at the moment somebody destroys the record.`,
    );
  }

  // State-specific beats default. Deliberately not "longest wins": a state rule that is SHORTER
  // than the default is still the rule that applies there, and picking the longer one would look
  // conservative while being wrong about the law.
  const chosen =
    candidates.find((row) => row.stateCode !== null) ??
    (candidates[0] as (typeof candidates)[number]);

  const provenance = provenanceOf(chosen);
  const verificationAgeDays =
    chosen.lastVerified === null
      ? null
      : Math.floor((now.getTime() - chosen.lastVerified.getTime()) / DAY_MS);
  const stale = verificationAgeDays !== null && verificationAgeDays > VERIFICATION_STALE_AFTER_DAYS;
  const unverified = provenance.tag !== 'issuer_rule' || stale;

  const retainUntil = addMonths(input.documentDate, chosen.retainMonths);

  return ok({
    documentKind: input.documentKind,
    appliedStateCode: chosen.stateCode,
    retainMonths: chosen.retainMonths,
    retainUntil: retainUntil.toISOString(),
    provenance,
    unverified,
    note:
      provenance.tag === 'unresearched_default'
        ? `${chosen.retainMonths} months, from an unresearched default: ${provenance.rationale}`
        : stale
          ? `${chosen.retainMonths} months, from ${provenance.sourceUrl}, last verified ${verificationAgeDays} days ago - past the ${VERIFICATION_STALE_AFTER_DAYS}-day window, so it is not current evidence for destroying anything.`
          : `${chosen.retainMonths} months, from ${provenance.sourceUrl}, verified ${provenance.lastVerified.slice(0, 10)}${
              chosen.stateCode === null ? ' (default)' : ` (${chosen.stateCode})`
            }.`,
  });
};

/** Every live schedule, for a compliance officer's review. */
export const schedules = async (tenantId: string): Promise<readonly Schedule[]> => {
  const rows = await db().retentionSchedule.findMany({
    where: { tenantId, supersededAt: null },
    orderBy: [{ documentKind: 'asc' }, { stateCode: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toSchedule);
};

/**
 * Schedules resting on an assumption or an unchecked citation.
 *
 * The queue that turns "we have retention rules" into "we have retention rules somebody stands
 * behind". The same list 5.2's `unresearchedRules` produces, for the same reason.
 */
export const unverifiedSchedules = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Schedule[]> => {
  const rows = await db().retentionSchedule.findMany({
    where: { tenantId, supersededAt: null },
    orderBy: [{ documentKind: 'asc' }, { stateCode: 'asc' }, { id: 'asc' }],
  });
  return rows
    .filter((row) => {
      if (row.provenanceTag !== 'issuer_rule') return true;
      if (row.lastVerified === null) return true;
      return (now.getTime() - row.lastVerified.getTime()) / DAY_MS > VERIFICATION_STALE_AFTER_DAYS;
    })
    .map(toSchedule);
};
