/**
 * Do Not Fund Governance - blueprint 6.4.
 *
 * Blueprint 6.4 opens with "not just a flag", and the rest of the module follows from taking that
 * literally. A flag is a boolean somebody sets; this is a determination with a reason, an author, a
 * review cadence, and an exception mechanism that does not quietly undo it.
 *
 * Three rules shape the file:
 *
 *  1. **An override permits one action; it does not delist.** The obvious build is a switch that
 *     turns the listing off, which conflates "this application may proceed despite the listing"
 *     with "this client should no longer be listed". They are different decisions made on
 *     different evidence, and merging them lets one considered exception become a permanent state
 *     nobody revisits - without the person granting it knowing that is what they did.
 *
 *  2. **An overdue review keeps blocking.** 5.4 made a stale provider approval stop being usable.
 *     This does the opposite, from the same rule: staleness moves toward the safe answer, and the
 *     safe answer is opposite because the direction of harm is. Nothing is risked by continuing to
 *     block; expiring the listing would let the most serious determination here lapse in silence.
 *     ADR-0013 has the argument in full; ADR-0012 has the override one.
 *
 *  3. **Listing, overriding and delisting each need a Level 3 human.** Read from the recorded
 *     actor, not passed in. Compliance `fail` may list automatically per Decision E - but removing
 *     an automatic listing still takes a person, because an automatic listing is not a lesser one.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import {
  noData,
  ok,
  refused,
  type ComplianceState,
  type EventActor,
  type Outcome,
} from '@bwc/core';

export type DoNotFundStatus = 'listed' | 'removed';

export type DoNotFundTrigger =
  | 'compliance_fail'
  | 'fraud_indicator'
  | 'material_misrepresentation'
  | 'repeated_default'
  | 'regulatory_action'
  | 'client_conduct'
  | 'other';

/** The authority a listing decision takes. Level 3 is the human approval tier. */
export const REQUIRED_AUTHORITY_LEVEL = 3;

/** Blueprint 6.4's "periodic review cadence", as a default rather than a ceiling. */
export const DEFAULT_REVIEW_CADENCE_DAYS = 90;

export interface Listing {
  readonly id: string;
  readonly clientId: string;
  readonly status: DoNotFundStatus;
  readonly trigger: DoNotFundTrigger;
  readonly justification: string;
  readonly automatic: boolean;
  readonly listedAt: string;
  readonly listedBy: string | null;
  readonly reviewCadenceDays: number;
  readonly lastReviewedAt: string | null;
  /** Derived, never stored - see `reviewIsOverdue`. */
  readonly reviewOverdue: boolean;
  readonly reviewDueAt: string;
  readonly removedAt: string | null;
  readonly removalJustification: string | null;
}

interface ListingRow {
  id: string;
  clientId: string;
  status: string;
  trigger: string;
  justification: string;
  automatic: boolean;
  listedAt: Date;
  listedBy: string | null;
  reviewCadenceDays: number;
  lastReviewedAt: Date | null;
  removedAt: Date | null;
  removalJustification: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When this listing is next due for review.
 *
 * Measured from the last review, or from the listing date if it has never been reviewed - so a
 * listing created and forgotten becomes overdue on the same schedule as one reviewed and forgotten.
 */
export const reviewDueAt = (row: {
  listedAt: Date;
  lastReviewedAt: Date | null;
  reviewCadenceDays: number;
}): Date =>
  new Date((row.lastReviewedAt ?? row.listedAt).getTime() + row.reviewCadenceDays * DAY_MS);

/**
 * Whether a listing has outrun its cadence.
 *
 * Derived at read time. A stored flag would need a job to maintain it, and a job that stops
 * leaves every listing reading as freshly reviewed - the most reassuring possible failure.
 */
export const reviewIsOverdue = (
  row: { listedAt: Date; lastReviewedAt: Date | null; reviewCadenceDays: number },
  now: Date,
): boolean => now.getTime() > reviewDueAt(row).getTime();

const toListing = (row: ListingRow, now: Date): Listing => ({
  id: row.id,
  clientId: row.clientId,
  status: row.status as DoNotFundStatus,
  trigger: row.trigger as DoNotFundTrigger,
  justification: row.justification,
  automatic: row.automatic,
  listedAt: row.listedAt.toISOString(),
  listedBy: row.listedBy,
  reviewCadenceDays: row.reviewCadenceDays,
  lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null,
  reviewOverdue: row.status === 'listed' && reviewIsOverdue(row, now),
  reviewDueAt: reviewDueAt(row).toISOString(),
  removedAt: row.removedAt?.toISOString() ?? null,
  removalJustification: row.removalJustification,
});

/** The active listing for a client, if any. */
export const activeListing = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<Listing | null> => {
  const row = await db().doNotFundListing.findFirst({
    where: { tenantId, clientId, status: 'listed' },
    orderBy: { listedAt: 'desc' },
  });
  return row ? toListing(row, now) : null;
};

/** Every listing a client has ever had, oldest first. Removed ones included - see 6.5. */
export const listingHistory = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<readonly Listing[]> => {
  const rows = await db().doNotFundListing.findMany({
    where: { tenantId, clientId },
    orderBy: { listedAt: 'asc' },
  });
  return rows.map((row) => toListing(row, now));
};

/**
 * Require a Level 3 human.
 *
 * Both halves matter and they are separate checks. A Level 3 Village agent would satisfy an
 * authority comparison alone, and blueprint 6.4 asks for "human override", not for sufficient
 * authority - the point of the requirement is that a person is answerable for it.
 */
const requireApprover = async (actorId: string, what: string): Promise<Outcome<{ id: string }>> => {
  const actor = await findActor(actorId);
  if (!actor) {
    return refused(
      `No actor ${actorId} is on record, so ${what} cannot be attributed to anyone.`,
      'Blueprint 6.4 - documented human justification',
    );
  }
  if (actor.kind !== 'human') {
    return refused(
      `${actor.label} is a Village agent. ${what} requires a human.`,
      'Blueprint 6.4 - requires human override with documented justification',
    );
  }
  if (actor.authorityLevel < REQUIRED_AUTHORITY_LEVEL) {
    return refused(
      `${actor.label} holds authority level ${actor.authorityLevel}. ${what} requires level ${REQUIRED_AUTHORITY_LEVEL}.`,
      'Blueprint 2.1 with 6.4 - Level 3 human approval',
    );
  }
  return ok({ id: actor.id });
};

export interface ListInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly trigger: Exclude<DoNotFundTrigger, 'compliance_fail'>;
  readonly justification: string;
  readonly listedBy: string;
  readonly reviewCadenceDays?: number;
  readonly now?: Date;
}

/**
 * List a client.
 *
 * Re-listing an already-listed client is refused rather than treated as an update. Two live
 * listings would give two review clocks and two removal decisions for one determination, and the
 * caller who thought they were adding a reason has instead created an ambiguity.
 */
export const listClient = async (input: ListInput): Promise<Outcome<Listing>> => {
  const now = input.now ?? new Date();

  if (input.justification.trim().length < 10) {
    return refused(
      'A Do Not Fund listing needs a justification somebody can read back. A word is not a reason.',
      'Blueprint 6.4 - documented justification',
    );
  }

  const existing = await activeListing(input.tenantId, input.clientId, now);
  if (existing) {
    return refused(
      `This client is already listed (${existing.trigger}, ${existing.listedAt}). Record the new concern as a review rather than a second listing.`,
      'Blueprint 6.4 - one determination per client',
    );
  }

  const approver = await requireApprover(input.listedBy, 'a Do Not Fund listing');
  if (approver.status !== 'ok') return approver;

  const row = await db().doNotFundListing.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      trigger: input.trigger as never,
      justification: input.justification,
      automatic: false,
      listedAt: now,
      listedBy: input.listedBy,
      reviewCadenceDays: input.reviewCadenceDays ?? DEFAULT_REVIEW_CADENCE_DAYS,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.do_not_fund.listed',
    actor: { id: input.listedBy, kind: 'human' },
    clientId: input.clientId,
    payload: {
      listingId: row.id,
      trigger: input.trigger,
      automatic: false,
      reviewCadenceDays: row.reviewCadenceDays,
    },
  });

  return ok(toListing(row, now));
};

/**
 * List a client because their compliance state reached `fail` - Decision E.
 *
 * Written by the system, so it takes no approver. That is the one asymmetry in this file, and it
 * is deliberate: the safe direction is toward blocking. Requiring a human to *start* blocking
 * would mean a client whose compliance failed on a Friday stayed fundable until Monday.
 *
 * Removing it still takes a person. Automatic in, human out.
 *
 * Idempotent: a client already listed is left as they are, and the existing listing is returned.
 * A second `fail` transition is common and should not produce a second determination.
 */
export const autoListForComplianceFail = async (input: {
  tenantId: string;
  clientId: string;
  complianceState: ComplianceState;
  reason: string;
  /** Whoever's action produced the transition. Attribution for the event, not for the listing. */
  triggeredBy: EventActor;
  now?: Date;
}): Promise<Outcome<Listing>> => {
  const now = input.now ?? new Date();

  if (input.complianceState !== 'fail') {
    return refused(
      `Automatic listing applies to compliance state 'fail'. This client is '${input.complianceState}'.`,
      'Decision E - Fail routes to Do Not Fund Governance (blueprint 6.2, 6.4)',
    );
  }

  const existing = await activeListing(input.tenantId, input.clientId, now);
  if (existing) return ok(existing);

  const row = await db().doNotFundListing.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      trigger: 'compliance_fail' as never,
      justification: `Compliance state reached Fail. ${input.reason}`,
      automatic: true,
      listedAt: now,
      // Null, and deliberately. Naming an approver here would put a fiction in the field a
      // reviewer reads to find out who decided - and nothing downstream could tell it from a
      // real approval. The Ledger event below carries what actually happened.
      listedBy: null,
      reviewCadenceDays: DEFAULT_REVIEW_CADENCE_DAYS,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.do_not_fund.listed',
    actor: input.triggeredBy,
    clientId: input.clientId,
    payload: {
      listingId: row.id,
      trigger: 'compliance_fail',
      automatic: true,
      reason: input.reason,
    },
  });

  return ok(toListing(row, now));
};

/**
 * Record a review.
 *
 * Reviewing restarts the cadence and changes nothing else. A review that concluded the listing
 * should end is a removal, and says so.
 */
export const recordReview = async (input: {
  tenantId: string;
  clientId: string;
  reviewedBy: string;
  notes: string;
  now?: Date;
}): Promise<Outcome<Listing>> => {
  const now = input.now ?? new Date();

  const existing = await activeListing(input.tenantId, input.clientId, now);
  if (!existing) {
    return noData('This client has no active Do Not Fund listing to review.');
  }

  const approver = await requireApprover(input.reviewedBy, 'a Do Not Fund review');
  if (approver.status !== 'ok') return approver;

  const row = await db().doNotFundListing.update({
    where: { id: existing.id },
    data: { lastReviewedAt: now, lastReviewedBy: input.reviewedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.do_not_fund.reviewed',
    actor: { id: input.reviewedBy, kind: 'human' },
    clientId: input.clientId,
    payload: { listingId: existing.id, notes: input.notes, wasOverdue: existing.reviewOverdue },
  });

  return ok(toListing(row, now));
};

/**
 * Remove a listing.
 *
 * The deliberate act an override is not. Takes its own Level 3 human and its own justification,
 * because "we let this one application through" and "we no longer believe this client should be
 * blocked" are different conclusions and only the second belongs here.
 */
export const removeListing = async (input: {
  tenantId: string;
  clientId: string;
  removedBy: string;
  justification: string;
  now?: Date;
}): Promise<Outcome<Listing>> => {
  const now = input.now ?? new Date();

  if (input.justification.trim().length < 10) {
    return refused(
      'Removing a Do Not Fund listing needs a justification somebody can read back.',
      'Blueprint 6.4 - documented justification',
    );
  }

  const existing = await activeListing(input.tenantId, input.clientId, now);
  if (!existing) {
    return noData('This client has no active Do Not Fund listing to remove.');
  }

  const approver = await requireApprover(input.removedBy, 'removing a Do Not Fund listing');
  if (approver.status !== 'ok') return approver;

  const row = await db().doNotFundListing.update({
    where: { id: existing.id },
    data: {
      status: 'removed' as never,
      removedAt: now,
      removedBy: input.removedBy,
      removalJustification: input.justification,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.do_not_fund.removed',
    actor: { id: input.removedBy, kind: 'human' },
    clientId: input.clientId,
    payload: {
      listingId: existing.id,
      trigger: existing.trigger,
      wasAutomatic: existing.automatic,
      daysListed: Math.floor((now.getTime() - new Date(existing.listedAt).getTime()) / DAY_MS),
    },
  });

  return ok(toListing(row, now));
};

export interface Override {
  readonly id: string;
  readonly listingId: string;
  readonly action: string;
  readonly justification: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly consumedAt: string | null;
}

/**
 * Grant a single-use exception for one named action.
 *
 * The listing stays in force. The next action - even the same kind of action - is blocked again
 * unless somebody grants another exception and writes down why.
 */
export const grantOverride = async (input: {
  tenantId: string;
  clientId: string;
  action: string;
  justification: string;
  approvedBy: string;
  now?: Date;
}): Promise<Outcome<Override>> => {
  const now = input.now ?? new Date();

  if (input.justification.trim().length < 10) {
    return refused(
      'A Do Not Fund override needs a justification somebody can read back. This is the record that explains why a blocked client was funded anyway.',
      'Blueprint 6.4 - requires human override with documented justification',
    );
  }

  const existing = await activeListing(input.tenantId, input.clientId, now);
  if (!existing) {
    return noData(
      'This client has no active Do Not Fund listing, so there is nothing to override.',
    );
  }

  const approver = await requireApprover(input.approvedBy, 'a Do Not Fund override');
  if (approver.status !== 'ok') return approver;

  const row = await db().doNotFundOverride.create({
    data: {
      tenantId: input.tenantId,
      listingId: existing.id,
      action: input.action,
      justification: input.justification,
      approvedBy: input.approvedBy,
      approvedAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.do_not_fund.override_granted',
    actor: { id: input.approvedBy, kind: 'human' },
    clientId: input.clientId,
    payload: { listingId: existing.id, overrideId: row.id, action: input.action },
  });

  return ok({
    id: row.id,
    listingId: row.listingId,
    action: row.action,
    justification: row.justification,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt.toISOString(),
    consumedAt: null,
  });
};

/** An unspent override for this exact action, if one has been granted. */
export const findUnconsumedOverride = async (
  tenantId: string,
  listingId: string,
  action: string,
): Promise<{ id: string; justification: string; approvedBy: string } | null> => {
  const row = await db().doNotFundOverride.findFirst({
    where: { tenantId, listingId, action, consumedAt: null },
    orderBy: { approvedAt: 'asc' },
  });
  return row ? { id: row.id, justification: row.justification, approvedBy: row.approvedBy } : null;
};

/**
 * Spend an override.
 *
 * Separate from finding one so a caller can check whether an action would be permitted without
 * burning the exception. `gate.ts` finds; the module that actually proceeds consumes.
 */
export const consumeOverride = async (input: {
  tenantId: string;
  clientId: string;
  overrideId: string;
  usedFor: string;
  actorId: string;
  now?: Date;
}): Promise<Outcome<{ overrideId: string }>> => {
  const now = input.now ?? new Date();

  const row = await db().doNotFundOverride.findFirst({
    where: { tenantId: input.tenantId, id: input.overrideId },
  });
  if (!row) return noData(`No override ${input.overrideId} is on record.`);
  if (row.consumedAt !== null) {
    return refused(
      `Override ${input.overrideId} was already used on ${row.consumedAt.toISOString()}. An override permits one action.`,
      'Blueprint 6.4 - an override is an exception, not a delisting',
    );
  }

  await db().doNotFundOverride.update({
    where: { id: row.id },
    data: { consumedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.do_not_fund.override_consumed',
    actor: { id: input.actorId, kind: 'human' },
    clientId: input.clientId,
    payload: { overrideId: row.id, action: row.action, usedFor: input.usedFor },
  });

  return ok({ overrideId: row.id });
};

/** Every listing whose review has outrun its cadence. The queue 6.4's review cadence produces. */
export const listingsDueForReview = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<readonly Listing[]> => {
  const rows = await db().doNotFundListing.findMany({
    where: { tenantId, status: 'listed' },
    orderBy: { listedAt: 'asc' },
  });
  return rows.map((row) => toListing(row, now)).filter((listing) => listing.reviewOverdue);
};
