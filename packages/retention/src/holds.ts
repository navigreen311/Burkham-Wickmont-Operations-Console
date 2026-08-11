/**
 * Legal holds - blueprint 7.5.
 *
 * **A hold is a matter, not a flag on a document.** That sentence decides everything else in this
 * file, and the alternative is worth stating because it is the obvious build and it is wrong.
 *
 * The obvious build sets `legalHold = true` on the documents in scope when a hold is placed. It
 * works, it is fast to query, and a client's bank statement uploaded the following morning is
 * silently outside the hold - because nothing re-runs the propagation. That is the classic way an
 * organisation destroys evidence while believing it preserved it, and the failure is invisible from
 * every direction: the hold exists, the document exists, and no row connects them.
 *
 * So holds are **evaluated at the moment of the decision**. `holdsCovering` is asked by the vault
 * when somebody tries to delete or export, and a document uploaded after the hold was placed is
 * covered without anybody doing anything. It is the same reasoning that made 1.3's inactivity
 * derived rather than scheduled, and 6.4's overdue review derived rather than stored - and it
 * matters more here, because the stored version of this one loses evidence rather than freshness.
 *
 * Two more rules:
 *
 *  - **An overdue review keeps holding.** ADR-0013 says staleness moves toward the answer that is
 *    safe if the stale record is wrong, and the direction of harm here is the same as 6.4's: a hold
 *    that outlives its matter inconveniences the company, and a hold that lapses in silence
 *    destroys records somebody was entitled to see. A third cadenced record has to decide
 *    explicitly, and this is the decision.
 *
 *  - **Placing and releasing both take a Level 3 human.** Releasing obviously. Placing too, and
 *    that is the asymmetry against 6.4, where compliance `fail` lists a client automatically. The
 *    difference is which direction is safe by default: a Do Not Fund listing has to be automatic
 *    because the safe state is blocked and nobody should have to be awake for it, whereas nothing
 *    is preserved by a hold that a machine invented and no lawyer can explain.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type Outcome } from '@bwc/core';

export type HoldKind = 'litigation' | 'complaint' | 'regulator_request' | 'client_dispute';
export type HoldScope = 'tenant' | 'client' | 'document_kind';

/** The authority a hold decision takes. Level 3 is the human approval tier, as in 6.4. */
export const HOLD_AUTHORITY_LEVEL = 3;

/**
 * Default review cadence, in days.
 *
 * Six months, which is longer than 6.4's ninety. A Do Not Fund listing blocks a live client from
 * being served and deserves to be looked at quarterly; a litigation hold tracks a matter that moves
 * on court time, and a queue that filled every quarter with holds nobody could yet release would be
 * ignored within a year - which is worse than a longer cadence honestly kept.
 */
export const DEFAULT_REVIEW_CADENCE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Hold {
  readonly id: string;
  readonly kind: HoldKind;
  readonly scope: HoldScope;
  readonly clientId: string | null;
  readonly documentKind: string | null;
  readonly matterReference: string;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly reviewCadenceDays: number;
  readonly lastReviewedAt: string | null;
  /** Derived, never stored - a stored flag needs a job, and a job that stops reads as "fresh". */
  readonly reviewOverdue: boolean;
  readonly reviewDueAt: string;
  readonly releasedAt: string | null;
  readonly releaseReason: string | null;
  readonly active: boolean;
}

interface HoldRow {
  id: string;
  kind: string;
  scope: string;
  clientId: string | null;
  documentKind: string | null;
  matterReference: string;
  reason: string;
  placedBy: string;
  placedAt: Date;
  reviewCadenceDays: number;
  lastReviewedAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
}

export const reviewDueAt = (row: {
  placedAt: Date;
  lastReviewedAt: Date | null;
  reviewCadenceDays: number;
}): Date =>
  new Date((row.lastReviewedAt ?? row.placedAt).getTime() + row.reviewCadenceDays * DAY_MS);

const toHold = (row: HoldRow, now: Date): Hold => ({
  id: row.id,
  kind: row.kind as HoldKind,
  scope: row.scope as HoldScope,
  clientId: row.clientId,
  documentKind: row.documentKind,
  matterReference: row.matterReference,
  reason: row.reason,
  placedBy: row.placedBy,
  placedAt: row.placedAt.toISOString(),
  reviewCadenceDays: row.reviewCadenceDays,
  lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
  reviewOverdue: row.releasedAt === null && now.getTime() > reviewDueAt(row).getTime(),
  reviewDueAt: reviewDueAt(row).toISOString(),
  releasedAt: row.releasedAt?.toISOString() ?? null,
  releaseReason: row.releaseReason,
  active: row.releasedAt === null,
});

/**
 * Require a Level 3 human, exactly as 6.4 does.
 *
 * Both halves are separate checks and both matter. A Level 3 Village agent would satisfy an
 * authority comparison; what a court asks for is a person who is answerable.
 */
const requireApprover = async (actorId: string, what: string): Promise<Outcome<{ id: string }>> => {
  const actor = await findActor(actorId);
  if (!actor) {
    return refused(
      `No actor ${actorId} is on record, so ${what} cannot be attributed to anyone.`,
      'Blueprint 7.5 - a hold is a legal act with a named author',
    );
  }
  if (actor.kind !== 'human') {
    return refused(
      `${actor.label} is a Village agent. ${what} requires a human.`,
      'Blueprint 7.5 - legal hold is a governance act, not an automated one',
    );
  }
  if (actor.authorityLevel < HOLD_AUTHORITY_LEVEL) {
    return refused(
      `${actor.label} holds authority level ${actor.authorityLevel}. ${what} requires level ${HOLD_AUTHORITY_LEVEL}.`,
      'Blueprint 2.1 with 7.5 - Level 3 human approval',
    );
  }
  return ok({ id: actor.id });
};

export interface PlaceHoldInput {
  readonly tenantId: string;
  readonly kind: HoldKind;
  readonly scope: HoldScope;
  /** Required when `scope` is `client`, and refused otherwise - see below. */
  readonly clientId?: string;
  /** Required when `scope` is `document_kind`. */
  readonly documentKind?: string;
  readonly matterReference: string;
  readonly reason: string;
  readonly placedBy: string;
  readonly reviewCadenceDays?: number;
  readonly now?: Date;
}

/**
 * Place a hold.
 *
 * The scope arguments are checked against the scope in both directions. A `client` hold with no
 * client would fall back to the tenant-wide branch of `holdsCovering` and quietly hold everything;
 * a `tenant` hold that carried a client id would look narrower in a listing than it actually is.
 * Both are silent, and both are the kind of thing somebody discovers during discovery.
 */
export const placeHold = async (input: PlaceHoldInput): Promise<Outcome<Hold>> => {
  const now = input.now ?? new Date();

  if (input.matterReference.trim() === '') {
    return refused(
      'A hold needs a matter reference - a case number, a complaint id, a regulator request. A hold nobody can trace to a matter is one nobody will ever dare release.',
      'Blueprint 7.5 - litigation, complaint and regulator request holds',
    );
  }
  if (input.reason.trim().length < 10) {
    return refused(
      'A hold needs a reason somebody can read back, potentially to a court.',
      'Blueprint 7.5 - documented hold',
    );
  }
  if (input.scope === 'client' && input.clientId === undefined) {
    return refused(
      'A client-scoped hold needs a client. Without one it would fall through to the tenant-wide branch and hold every client silently.',
      'Blueprint 7.5 - hold scope',
    );
  }
  if (input.scope !== 'client' && input.clientId !== undefined) {
    return refused(
      `A ${input.scope}-scoped hold must not carry a client id: it would read as narrower in a listing than it actually is.`,
      'Blueprint 7.5 - hold scope',
    );
  }
  if (input.scope === 'document_kind' && input.documentKind === undefined) {
    return refused('A kind-scoped hold needs a document kind.', 'Blueprint 7.5 - hold scope');
  }
  if (input.scope !== 'document_kind' && input.documentKind !== undefined) {
    return refused(
      `A ${input.scope}-scoped hold must not carry a document kind.`,
      'Blueprint 7.5 - hold scope',
    );
  }

  const approver = await requireApprover(input.placedBy, 'placing a legal hold');
  if (approver.status !== 'ok') return approver;

  const row = await db().legalHold.create({
    data: {
      tenantId: input.tenantId,
      kind: input.kind as never,
      scope: input.scope as never,
      clientId: input.clientId ?? null,
      documentKind: (input.documentKind ?? null) as never,
      matterReference: input.matterReference,
      reason: input.reason,
      placedBy: input.placedBy,
      placedAt: now,
      reviewCadenceDays: input.reviewCadenceDays ?? DEFAULT_REVIEW_CADENCE_DAYS,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'retention.hold.placed',
    actor: { id: input.placedBy, kind: 'human' },
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    payload: {
      holdId: row.id,
      kind: input.kind,
      scope: input.scope,
      matterReference: input.matterReference,
      documentKind: input.documentKind ?? null,
    },
  });

  return ok(toHold(row, now));
};

/**
 * Release a hold.
 *
 * Takes its own Level 3 human and its own reason, and the row survives: which hold was in force
 * when a document was destroyed is the question a spoliation claim turns on, and a deleted row
 * cannot answer it.
 */
export const releaseHold = async (input: {
  tenantId: string;
  holdId: string;
  releasedBy: string;
  reason: string;
  now?: Date;
}): Promise<Outcome<Hold>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 10) {
    return refused(
      'Releasing a hold needs a reason somebody can read back. This is the record that explains why preservation stopped.',
      'Blueprint 7.5 - documented release',
    );
  }

  const existing = await db().legalHold.findFirst({
    where: { tenantId: input.tenantId, id: input.holdId },
  });
  if (!existing) return noData('No such legal hold in this tenant.');
  if (existing.releasedAt !== null) {
    return refused(
      `This hold was already released on ${existing.releasedAt.toISOString().slice(0, 10)}.`,
      'Blueprint 7.5 - a hold is released once',
    );
  }

  const approver = await requireApprover(input.releasedBy, 'releasing a legal hold');
  if (approver.status !== 'ok') return approver;

  const row = await db().legalHold.update({
    where: { id: existing.id },
    data: { releasedAt: now, releasedBy: input.releasedBy, releaseReason: input.reason },
  });

  await append({
    tenantId: input.tenantId,
    type: 'retention.hold.released',
    actor: { id: input.releasedBy, kind: 'human' },
    ...(existing.clientId !== null ? { clientId: existing.clientId } : {}),
    payload: {
      holdId: existing.id,
      kind: existing.kind,
      scope: existing.scope,
      matterReference: existing.matterReference,
      daysHeld: Math.floor((now.getTime() - existing.placedAt.getTime()) / DAY_MS),
    },
  });

  return ok(toHold(row, now));
};

/**
 * Record a review.
 *
 * Restarts the cadence and changes nothing else, exactly as 6.4's does. A review that concluded the
 * hold should end is a release, and says so.
 */
export const recordReview = async (input: {
  tenantId: string;
  holdId: string;
  reviewedBy: string;
  notes: string;
  now?: Date;
}): Promise<Outcome<Hold>> => {
  const now = input.now ?? new Date();

  const existing = await db().legalHold.findFirst({
    where: { tenantId: input.tenantId, id: input.holdId, releasedAt: null },
  });
  if (!existing) return noData('No such active legal hold in this tenant.');

  const approver = await requireApprover(input.reviewedBy, 'reviewing a legal hold');
  if (approver.status !== 'ok') return approver;

  const wasOverdue = toHold(existing, now).reviewOverdue;

  const row = await db().legalHold.update({
    where: { id: existing.id },
    data: { lastReviewedAt: now, lastReviewedBy: input.reviewedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'retention.hold.reviewed',
    actor: { id: input.reviewedBy, kind: 'human' },
    ...(existing.clientId !== null ? { clientId: existing.clientId } : {}),
    payload: { holdId: existing.id, notes: input.notes, wasOverdue },
  });

  return ok(toHold(row, now));
};

export interface HoldTarget {
  readonly tenantId: string;
  /** The client the document belongs to. */
  readonly clientId: string;
  /** The vault's `DocumentKind`, as a string - this module does not import the vault. */
  readonly documentKind: string;
}

/**
 * Every hold in force over a given document.
 *
 * **The function this module exists for**, and the one the vault asks before it destroys anything.
 * Note what it does not take: a document id, or an upload date. A hold covers a *category* of
 * record, so a statement uploaded this morning is inside a hold placed last year without anything
 * having been re-run - which is the whole reason holds are not a boolean on the row.
 *
 * An overdue review does not narrow the result. ADR-0013: staleness moves toward the safe answer,
 * and here the safe answer is to keep holding. The overdue flag rides along on each hold so the
 * caller can say so.
 */
export const holdsCovering = async (
  target: HoldTarget,
  now: Date = new Date(),
): Promise<readonly Hold[]> => {
  const rows = await db().legalHold.findMany({
    where: {
      tenantId: target.tenantId,
      releasedAt: null,
      OR: [
        { scope: 'tenant' },
        { scope: 'client', clientId: target.clientId },
        { scope: 'document_kind', documentKind: target.documentKind as never },
      ],
    },
    orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toHold(row, now));
};

/** Whether anything at all is holding this document. The cheap question the gate actually asks. */
export const isHeld = async (target: HoldTarget, now: Date = new Date()): Promise<boolean> =>
  (await holdsCovering(target, now)).length > 0;

/**
 * A sentence naming what is holding a document, for a refusal a person will read.
 *
 * Names the matter rather than the hold's own id, because the operator's next action is to go and
 * ask somebody about the matter. Returns null when nothing holds it.
 */
export interface HoldSummary {
  readonly kind: string;
  readonly matterReference: string;
  readonly reviewOverdue: boolean;
}

export const describeHolds = (holds: readonly HoldSummary[]): string | null => {
  if (holds.length === 0) return null;
  const parts = holds.map(
    (hold) =>
      `${hold.kind.replace(/_/g, ' ')} hold ${hold.matterReference}${
        hold.reviewOverdue ? ' (review overdue)' : ''
      }`,
  );
  return parts.join('; ');
};

/** Active holds, newest first, for an operator's queue. */
export const activeHolds = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Hold[]> => {
  const rows = await db().legalHold.findMany({
    where: { tenantId, releasedAt: null },
    orderBy: [{ placedAt: 'desc' }, { id: 'asc' }],
  });
  return rows.map((row) => toHold(row, now));
};

/**
 * Holds whose review has outrun its cadence.
 *
 * The queue the cadence exists to produce. They are all still holding - see the module header and
 * ADR-0013 - and this is how somebody finds out that they are.
 */
export const holdsDueForReview = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Hold[]> =>
  (await activeHolds(tenantId, now)).filter((hold) => hold.reviewOverdue);
