/**
 * Partner records and onboarding - blueprint 8.1.
 *
 * The record 1.3 has been referring to by name since it shipped. 1.3's attribution deliberately
 * stores `referrerName` as free text and exposes no update path, because attribution is a
 * financial fact; this module gives that name a typed identity without touching the rule.
 *
 * Onboarding completes only when every qualification for the track has been produced. The
 * requirements are per-track data in `tracks.ts` and the comparison is exact-string, which is
 * unforgiving on purpose: a qualification satisfied by something close enough is a judgement, and
 * the record should show a person made it rather than that a matcher accepted it.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import {
  isPartnerTrack,
  outstandingQualifications,
  requirementsFor,
  type PartnerTrack,
} from './tracks.js';

export type PartnerStatus = 'applied' | 'onboarding' | 'active' | 'suspended' | 'terminated';

/** Terminating a partner relationship takes a Level 3 human, as suspending does not. */
export const TERMINATION_AUTHORITY_LEVEL = 3;

export interface Partner {
  readonly id: string;
  readonly legalName: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly track: PartnerTrack;
  readonly status: PartnerStatus;
  readonly qualificationsRecorded: readonly string[];
  readonly outstandingQualifications: readonly string[];
  readonly onboardedAt: string | null;
  readonly terminationReason: string | null;
  /** Derived: whether this partner may be used at all, before certification is even consulted. */
  readonly engageable: boolean;
}

interface PartnerRow {
  id: string;
  legalName: string;
  contactName: string;
  contactEmail: string;
  track: string;
  status: string;
  qualificationsRecorded: string[];
  onboardedAt: Date | null;
  terminationReason: string | null;
}

const toPartner = (row: PartnerRow): Partner => {
  const track = row.track as PartnerTrack;
  return {
    id: row.id,
    legalName: row.legalName,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    track,
    status: row.status as PartnerStatus,
    qualificationsRecorded: row.qualificationsRecorded,
    outstandingQualifications: outstandingQualifications(track, row.qualificationsRecorded),
    onboardedAt: row.onboardedAt?.toISOString() ?? null,
    terminationReason: row.terminationReason,
    engageable: row.status === 'active',
  };
};

export const findPartner = async (
  tenantId: string,
  partnerId: string,
): Promise<Outcome<Partner>> => {
  const row = await db().partner.findFirst({ where: { tenantId, id: partnerId } });
  return row ? ok(toPartner(row)) : noData(`No partner ${partnerId} is on record.`);
};

export const partnersFor = async (
  tenantId: string,
  filter: { track?: PartnerTrack; status?: PartnerStatus } = {},
): Promise<readonly Partner[]> => {
  const rows = await db().partner.findMany({
    where: {
      tenantId,
      ...(filter.track !== undefined ? { track: filter.track } : {}),
      ...(filter.status !== undefined ? { status: filter.status as never } : {}),
    },
    orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toPartner);
};

export const registerPartner = async (input: {
  tenantId: string;
  legalName: string;
  contactName: string;
  contactEmail: string;
  track: string;
  actor: EventActor;
}): Promise<Outcome<Partner>> => {
  if (!isPartnerTrack(input.track)) {
    return refused(
      `'${input.track}' is not one of the seven partner tracks. A partner outside the tracks has no qualification requirements, and would onboard against nothing.`,
      'Blueprint 8.1 - channel management for the seven partner tracks',
    );
  }
  if (input.legalName.trim() === '' || input.contactName.trim() === '') {
    return refused(
      'A partner record needs a legal name and a contact. A referral relationship with an unnamed counterparty is not a relationship anybody can audit.',
      'Blueprint 8.1 - partner records',
    );
  }

  const row = await db().partner.create({
    data: {
      tenantId: input.tenantId,
      legalName: input.legalName,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      track: input.track,
      qualificationsRecorded: [],
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.registered',
    actor: input.actor,
    payload: { partnerId: row.id, track: input.track, legalName: input.legalName },
  });

  return ok(toPartner(row));
};

/**
 * Record a qualification the partner produced.
 *
 * Takes the exact requirement string from `TRACK_REQUIREMENTS`, and refuses anything else. A
 * free-text qualification would satisfy nothing and look like it satisfied something.
 */
export const recordQualification = async (input: {
  tenantId: string;
  partnerId: string;
  qualification: string;
  recordedBy: string;
  actor: EventActor;
}): Promise<Outcome<Partner>> => {
  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  const required = requirementsFor(partner.value.track).qualifications;
  if (!required.includes(input.qualification)) {
    return refused(
      `'${input.qualification}' is not a qualification the ${requirementsFor(partner.value.track).label} track asks for. The track requires: ${required.join('; ')}.`,
      'Blueprint 8.1 - per-partner-track qualification requirements',
    );
  }

  if (partner.value.qualificationsRecorded.includes(input.qualification)) {
    return ok(partner.value);
  }

  const row = await db().partner.update({
    where: { id: input.partnerId },
    data: {
      qualificationsRecorded: { push: input.qualification },
      // Recording the first qualification moves an applicant into onboarding. Later ones leave
      // the status alone, so a qualification recorded against a suspended partner does not
      // quietly reactivate them.
      ...(partner.value.status === 'applied' ? { status: 'onboarding' as const } : {}),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.qualification.recorded',
    actor: input.actor,
    payload: {
      partnerId: input.partnerId,
      qualification: input.qualification,
      recordedBy: input.recordedBy,
    },
  });

  return ok(toPartner(row));
};

/**
 * Complete onboarding.
 *
 * Refuses while anything is outstanding, and names what. Activating a partner whose insurance
 * certificate never arrived is exactly the kind of gap that is invisible afterwards, because the
 * record shows an active partner and nothing shows what was skipped.
 *
 * Note what this does NOT check: certification. Onboarding makes a partner a real counterparty;
 * certification decides what they may do. Merging them would mean a partner who let their training
 * lapse reverts to `onboarding`, which reads as an administrative state and would send somebody
 * chasing an insurance certificate they already have.
 */
export const completeOnboarding = async (input: {
  tenantId: string;
  partnerId: string;
  completedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Partner>> => {
  const now = input.now ?? new Date();
  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  if (partner.value.status === 'terminated') {
    return refused(
      'This partner relationship was terminated. Re-engaging is a new decision and a new record, not a resumption.',
      'Blueprint 8.1 - termination triggers',
    );
  }

  if (partner.value.outstandingQualifications.length > 0) {
    return refused(
      `Onboarding is incomplete. Outstanding: ${partner.value.outstandingQualifications.join('; ')}.`,
      'Blueprint 8.1 - per-partner-track qualification requirements',
    );
  }

  const row = await db().partner.update({
    where: { id: input.partnerId },
    data: { status: 'active', onboardedAt: now, suspendedAt: null },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.onboarded',
    actor: input.actor,
    payload: {
      partnerId: input.partnerId,
      track: partner.value.track,
      completedBy: input.completedBy,
      disclosureSensitivity: requirementsFor(partner.value.track).disclosureSensitivity,
    },
  });

  return ok(toPartner(row));
};

/** Suspend a partner. Reversible by completing onboarding again; the record keeps both events. */
export const suspendPartner = async (input: {
  tenantId: string;
  partnerId: string;
  reason: string;
  suspendedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Partner>> => {
  const now = input.now ?? new Date();
  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  if (input.reason.trim().length < 5) {
    return refused(
      'Suspending a partner needs a reason somebody can read back.',
      'Blueprint 8.1 - conduct monitoring',
    );
  }

  const row = await db().partner.update({
    where: { id: input.partnerId },
    data: { status: 'suspended', suspendedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.suspended',
    actor: input.actor,
    payload: { partnerId: input.partnerId, reason: input.reason, suspendedBy: input.suspendedBy },
  });

  return ok(toPartner(row));
};

/**
 * Terminate a partner relationship.
 *
 * A Level 3 human, read from the recorded actor. Blueprint 8.1 lists "termination triggers", and a
 * trigger that fired on its own would end a commercial relationship - and cut off the referred
 * clients' visibility - with nobody answerable for it. Triggers surface; a person terminates.
 */
export const terminatePartner = async (input: {
  tenantId: string;
  partnerId: string;
  reason: string;
  terminatedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Partner>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 10) {
    return refused(
      'Terminating a partner needs a reason somebody can read back. It ends a commercial relationship and may affect referral fees already owed.',
      'Blueprint 8.1 - termination triggers',
    );
  }

  const partner = await findPartner(input.tenantId, input.partnerId);
  if (partner.status !== 'ok') return partner;

  const actor = await findActor(input.terminatedBy);
  if (!actor) {
    return refused(
      `No actor ${input.terminatedBy} is on record, so the termination cannot be attributed.`,
      'Blueprint 8.1 - termination is a human decision',
    );
  }
  if (actor.kind !== 'human' || actor.authorityLevel < TERMINATION_AUTHORITY_LEVEL) {
    return refused(
      `${actor.label} cannot terminate a partner. Termination requires a human at Authority Level ${TERMINATION_AUTHORITY_LEVEL}.`,
      'Blueprint 2.1 with 8.1 - termination is a human decision',
    );
  }

  const row = await db().partner.update({
    where: { id: input.partnerId },
    data: {
      status: 'terminated',
      terminatedAt: now,
      terminatedBy: input.terminatedBy,
      terminationReason: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.terminated',
    actor: input.actor,
    payload: { partnerId: input.partnerId, reason: input.reason, terminatedBy: input.terminatedBy },
  });

  return ok(toPartner(row));
};
