/**
 * Conflict-of-interest disclosures - blueprint 10.1's "conflict-of-interest disclosures
 * auto-generated and filed".
 *
 * Read as one step, that sentence describes the conflicted party writing a document, putting it in
 * its own file, and proceeding. **That is not a control; it is a record of a control that did not
 * happen.**
 *
 * So the two halves are separated:
 *
 *   the ARTIFACT is generated automatically, and should be - a hand-written conflict disclosure
 *   varies with how the writer feels about the conflict, and the version written by somebody keen
 *   to proceed is the one that understates it
 *
 *   the DISCLOSURE is complete only when acknowledged by somebody who is not us: the venture's own
 *   representative, who is the party the conflict is against, and Gardner, who governs both sides
 *   and is the only party positioned to permit it
 *
 * Until both exist, `mayProceed` refuses. Same shape as 6.4's Do Not Fund gate - a determination
 * that blocks work, with a documented human route through it.
 *
 * The generated body is stored AS GENERATED and hashed. A later template change cannot rewrite
 * what was acknowledged; 7.3's frozen-contract rule applied to a disclosure, for the same reason -
 * somebody signed the version that existed on the day.
 */

import { createHash } from 'node:crypto';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { ventureByKey, type Venture, type VentureKey } from './ventures.js';

export type DisclosureState =
  'drafted' | 'venture_acknowledged' | 'fully_acknowledged' | 'withdrawn';

/** Gardner's acknowledgement is a Level 3 human decision. */
export const GARDNER_AUTHORITY_LEVEL = 3;

export interface Disclosure {
  readonly id: string;
  readonly engagementId: string;
  readonly state: DisclosureState;
  readonly body: string;
  readonly contentHash: string;
  readonly ventureAcknowledgedAt: string | null;
  readonly gardnerAcknowledgedAt: string | null;
  readonly complete: boolean;
}

interface DisclosureRow {
  id: string;
  engagementId: string;
  state: string;
  body: string;
  contentHash: string;
  ventureAcknowledgedAt: Date | null;
  gardnerAcknowledgedAt: Date | null;
}

const toDisclosure = (row: DisclosureRow): Disclosure => ({
  id: row.id,
  engagementId: row.engagementId,
  state: row.state as DisclosureState,
  body: row.body,
  contentHash: row.contentHash,
  ventureAcknowledgedAt: row.ventureAcknowledgedAt?.toISOString() ?? null,
  gardnerAcknowledgedAt: row.gardnerAcknowledgedAt?.toISOString() ?? null,
  complete: row.state === 'fully_acknowledged',
});

/**
 * The disclosure text.
 *
 * Pure and exported, so what a venture is asked to acknowledge can be read and reviewed without a
 * database - and so counsel can argue with the wording in one place rather than finding it in a
 * string concatenation.
 *
 * It states the conflict, the specific basis for THIS venture, what we are not, and what the
 * venture may do about it. The last part matters: a disclosure that describes a conflict without
 * saying the reader may decline is a notification.
 */
export const disclosureBody = (input: {
  venture: Venture;
  clientLegalName: string;
  engagementDescription: string;
  generatedOn: Date;
}): string =>
  [
    `CONFLICT OF INTEREST DISCLOSURE`,
    ``,
    `Date: ${input.generatedOn.toISOString().slice(0, 10)}`,
    `Client: ${input.clientLegalName}`,
    `Engagement: ${input.engagementDescription}`,
    ``,
    `Burkham Wickmont and ${input.venture.displayName} are both Green Companies ventures under common ownership. This engagement is a related-party transaction.`,
    ``,
    `Basis of the conflict:`,
    input.venture.conflictBasis,
    ``,
    `What this means in practice:`,
    `- Our advice to you is given by a party with a financial interest in the same ownership group as you.`,
    `- Fees charged under this engagement move money between entities with a common beneficial owner.`,
    `- Any deviation from our published pricing requires Gardner approval and is recorded, in either direction.`,
    `- Gardner has visibility of this engagement, which it does not have for unrelated clients.`,
    ``,
    `What we are not:`,
    `- We are not a lender and do not make credit decisions.`,
    `- We do not provide legal or tax advice. You should take independent advice on this engagement, including on whether to proceed with a related party at all.`,
    ``,
    `You may decline this engagement, or ask that it be performed by an unrelated provider, without prejudice to any other relationship between our companies.`,
    ``,
    `Acknowledgement of this disclosure is required from ${input.venture.displayName} and from Gardner before work begins.`,
  ].join('\n');

export const hashDisclosure = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * Generate the disclosure for an intercompany engagement.
 *
 * One per engagement, never a standing one. A blanket conflict waiver covering "all future work"
 * is the thing this module exists to prevent: the conflict differs per engagement, and a waiver
 * signed once is acknowledged by somebody who did not know what they were agreeing to.
 */
export const generateDisclosure = async (input: {
  tenantId: string;
  clientId: string;
  engagementId: string;
  engagementDescription: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Disclosure>> => {
  const now = input.now ?? new Date();

  const relationship = await db().ventureRelationship.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });
  if (!relationship) {
    return refused(
      'This client is not tagged as a Green Companies venture, so there is no related-party conflict to disclose. If they are a venture, tag the relationship first - a disclosure generated against no relationship would name a conflict nobody could describe.',
      'Blueprint 10.1 - automatic tagging when client entity is a Green Companies venture',
    );
  }

  const existing = await db().conflictDisclosure.findFirst({
    where: { tenantId: input.tenantId, engagementId: input.engagementId },
  });
  if (existing) return ok(toDisclosure(existing));

  const client = await db().client.findFirst({
    where: { tenantId: input.tenantId, id: input.clientId },
  });
  if (!client) return noData(`No client ${input.clientId} is on record.`);

  const body = disclosureBody({
    venture: ventureByKey(relationship.ventureKey as VentureKey),
    clientLegalName: client.legalName,
    engagementDescription: input.engagementDescription,
    generatedOn: now,
  });

  const row = await db().conflictDisclosure.create({
    data: {
      tenantId: input.tenantId,
      relationshipId: relationship.id,
      engagementId: input.engagementId,
      body,
      contentHash: hashDisclosure(body),
      generatedAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.disclosure.generated',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      disclosureId: row.id,
      engagementId: input.engagementId,
      ventureKey: relationship.ventureKey,
      contentHash: row.contentHash,
    },
  });

  return ok(toDisclosure(row));
};

/**
 * The venture acknowledges.
 *
 * `representative` is a name, not an actor id, and deliberately so. The person acknowledging is on
 * the OTHER side - a MedLink officer, not a Burkham Wickmont actor - and inventing an actor record
 * for them would put a party we do not control inside our identity system, where their
 * acknowledgement would then look like an internal approval.
 *
 * The content hash is required and checked. Acknowledging a disclosure means acknowledging a
 * specific text, and if the stored body has changed since they read it, the acknowledgement is of
 * something else.
 */
export const acknowledgeByVenture = async (input: {
  tenantId: string;
  disclosureId: string;
  representative: string;
  acknowledgedContentHash: string;
  recordedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Disclosure>> => {
  const now = input.now ?? new Date();

  if (input.representative.trim().length < 3) {
    return refused(
      'A venture acknowledgement needs the name of the person acknowledging it. "The venture acknowledged" is not something anybody can be asked about later.',
      'Blueprint 10.1 - conflict-of-interest disclosures filed per engagement',
    );
  }

  const row = await db().conflictDisclosure.findFirst({
    where: { tenantId: input.tenantId, id: input.disclosureId },
  });
  if (!row) return noData(`No conflict disclosure ${input.disclosureId} is on record.`);
  if (row.state === 'withdrawn') {
    return refused(
      'This disclosure was withdrawn. Generate a new one for the engagement rather than acknowledging a withdrawn text.',
      'Blueprint 10.1 - one disclosure per engagement',
    );
  }

  if (input.acknowledgedContentHash !== row.contentHash) {
    return refused(
      'The acknowledged text does not match the disclosure on record. An acknowledgement is of a specific document, and if the text has changed since it was read then what was acknowledged is something else.',
      'Blueprint 7.3 with 10.1 - an acknowledged document is frozen',
    );
  }

  const updated = await db().conflictDisclosure.update({
    where: { id: row.id },
    data: {
      state: row.gardnerAcknowledgedAt !== null ? 'fully_acknowledged' : 'venture_acknowledged',
      ventureAcknowledgedAt: now,
      ventureAcknowledgedBy: input.recordedBy,
      ventureRepresentative: input.representative,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.disclosure.acknowledged',
    actor: input.actor,
    payload: {
      disclosureId: row.id,
      engagementId: row.engagementId,
      by: 'venture',
      representative: input.representative,
    },
  });

  return ok(toDisclosure(updated));
};

/**
 * Gardner acknowledges.
 *
 * A Level 3 human, read from the recorded actor. Gardner governs both sides of the transaction and
 * is the only party positioned to permit it; an agent acknowledging on Gardner's behalf would mean
 * the portfolio owner's approval was produced by software the portfolio owns.
 */
export const acknowledgeByGardner = async (input: {
  tenantId: string;
  disclosureId: string;
  acknowledgedBy: string;
  acknowledgedContentHash: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Disclosure>> => {
  const now = input.now ?? new Date();

  const row = await db().conflictDisclosure.findFirst({
    where: { tenantId: input.tenantId, id: input.disclosureId },
  });
  if (!row) return noData(`No conflict disclosure ${input.disclosureId} is on record.`);
  if (row.state === 'withdrawn') {
    return refused(
      'This disclosure was withdrawn.',
      'Blueprint 10.1 - one disclosure per engagement',
    );
  }
  if (input.acknowledgedContentHash !== row.contentHash) {
    return refused(
      'The acknowledged text does not match the disclosure on record.',
      'Blueprint 7.3 with 10.1 - an acknowledged document is frozen',
    );
  }

  const actor = await findActor(input.acknowledgedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < GARDNER_AUTHORITY_LEVEL) {
    return refused(
      `Gardner acknowledgement requires a human at Authority Level ${GARDNER_AUTHORITY_LEVEL}. It permits a related-party transaction between two entities the same owner controls.`,
      'Blueprint 2.1 with 10.1 - Gardner-governed intercompany commerce',
    );
  }

  const updated = await db().conflictDisclosure.update({
    where: { id: row.id },
    data: {
      state: row.ventureAcknowledgedAt !== null ? 'fully_acknowledged' : 'drafted',
      gardnerAcknowledgedAt: now,
      gardnerAcknowledgedBy: input.acknowledgedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.disclosure.acknowledged',
    actor: input.actor,
    payload: { disclosureId: row.id, engagementId: row.engagementId, by: 'gardner' },
  });

  return ok(toDisclosure(updated));
};

export interface ProceedVerdict {
  readonly intercompany: boolean;
  readonly disclosure: Disclosure | null;
  readonly detail: string;
}

/**
 * May work proceed on this engagement?
 *
 * `ok` for an engagement with no venture relationship - most engagements. For an intercompany one,
 * `ok` only when a disclosure exists and BOTH acknowledgements are in. One is not enough, and the
 * refusal says which is missing so somebody can chase the right party.
 */
export const mayProceed = async (
  tenantId: string,
  clientId: string,
  engagementId: string,
): Promise<Outcome<ProceedVerdict>> => {
  const relationship = await db().ventureRelationship.findFirst({
    where: { tenantId, clientId },
  });

  if (!relationship) {
    return ok({
      intercompany: false,
      disclosure: null,
      detail: 'This client is not a Green Companies venture; no related-party disclosure applies.',
    });
  }

  const row = await db().conflictDisclosure.findFirst({
    where: { tenantId, engagementId },
  });

  if (!row) {
    return refused(
      `This is an intercompany engagement with ${relationship.displayName} and no conflict-of-interest disclosure has been generated for it. Work cannot begin on an undisclosed related-party transaction.`,
      'Blueprint 10.1 - conflict-of-interest disclosures per engagement',
    );
  }

  const disclosure = toDisclosure(row);

  if (disclosure.state === 'withdrawn') {
    return refused(
      `The conflict disclosure for this engagement was withdrawn. ${row.withdrawnReason ?? ''}`.trim(),
      'Blueprint 10.1 - conflict-of-interest disclosures per engagement',
    );
  }

  if (!disclosure.complete) {
    const missing: string[] = [];
    if (disclosure.ventureAcknowledgedAt === null) missing.push(relationship.displayName);
    if (disclosure.gardnerAcknowledgedAt === null) missing.push('Gardner');

    return refused(
      `The conflict-of-interest disclosure for this engagement has not been acknowledged by: ${missing.join(' and ')}. Generating a disclosure is not disclosing it - the acknowledgement by a party that is not us is the control, and the document is only its record.`,
      'Blueprint 10.1 - conflict-of-interest disclosures auto-generated and filed',
    );
  }

  return ok({
    intercompany: true,
    disclosure,
    detail: `Intercompany engagement with ${relationship.displayName}, disclosed and acknowledged by both the venture and Gardner.`,
  });
};

/**
 * Withdraw a disclosure.
 *
 * For the case where the engagement scope changed enough that what was acknowledged no longer
 * describes it. Withdrawing does not delete: the acknowledged text stays, because the question
 * "what did they agree to in March" survives the engagement changing in April.
 */
export const withdrawDisclosure = async (input: {
  tenantId: string;
  disclosureId: string;
  reason: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Disclosure>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 10) {
    return refused(
      'Withdrawing a conflict disclosure needs a reason somebody can read back.',
      'Blueprint 10.1 - audit trail per intercompany engagement',
    );
  }

  const row = await db().conflictDisclosure.findFirst({
    where: { tenantId: input.tenantId, id: input.disclosureId },
  });
  if (!row) return noData(`No conflict disclosure ${input.disclosureId} is on record.`);

  const updated = await db().conflictDisclosure.update({
    where: { id: row.id },
    data: { state: 'withdrawn', withdrawnAt: now, withdrawnReason: input.reason },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.disclosure.withdrawn',
    actor: input.actor,
    payload: { disclosureId: row.id, engagementId: row.engagementId, reason: input.reason },
  });

  return ok(toDisclosure(updated));
};
