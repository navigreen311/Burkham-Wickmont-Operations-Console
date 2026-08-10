/**
 * What a partner may see about the clients they referred - blueprint 8.1's "anonymized client
 * status sharing" and "partner-facing portal for referred-client status".
 *
 * This is the file to read carefully.
 *
 * Blueprint 8.1 asks for anonymized status sharing. Taken as written, the build is: take the
 * status rows for a partner's referrals, remove the client's name, show them to the partner.
 *
 * **That is not anonymous.** A partner who referred one client and is shown "1 client in
 * underwriting" knows exactly whose status that is - they supplied the client. Removing the name
 * removes nothing. The same holds at two and at three. Anonymity is not a property of a row you
 * can strip a field from; it is a property of a COHORT large enough that a row could be several
 * people.
 *
 * So there are two surfaces here and they are deliberately not one:
 *
 *   `aggregateStatus`   counts by stage across the partner's referrals, SUPPRESSED ENTIRELY
 *                       below MINIMUM_COHORT, with the suppression stated
 *   `identifiedStatus`  one named client's status, which requires that CLIENT's own consent
 *
 * Below the threshold the aggregate returns nothing rather than zeros or a "fewer than five"
 * band. Zeros would be a false statement about the partner's book. A band still leaks, because the
 * partner knows their own referral count - "fewer than five, of which some are in underwriting"
 * plus "I referred two" is most of the way to an answer.
 *
 * The identified surface exists because the honest version of what a partner usually wants is not
 * anonymity at all: they want to know how their client is doing. That is a reasonable thing to
 * want and an unreasonable thing to take. So it is available, and it is the client's to give -
 * recorded in 1.5 as a consent, revocable there, and checked live on every read.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { forClient as consentsForClient, type ConsentKind } from '@bwc/consent';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { leadsAttributedTo } from './attributed.js';

/**
 * The smallest cohort an aggregate may describe.
 *
 * Five is a convention borrowed from statistical disclosure control rather than a derived number,
 * and it is stated here so it can be argued with. What matters is that a threshold exists and that
 * falling below it produces silence rather than a smaller number.
 */
export const MINIMUM_COHORT = 5;

/** The consent kind a client grants to let a partner see their named status. */
export const PARTNER_VISIBILITY_CONSENT_KIND: ConsentKind = 'partner_status_visibility';

export interface AggregateStatus {
  readonly partnerId: string;
  readonly released: boolean;
  /** Populated only when `released`. */
  readonly countsByStage: Readonly<Record<string, number>>;
  readonly totalReferrals: number;
  readonly detail: string;
}

/**
 * Counts by lead stage across everything this partner referred.
 *
 * `totalReferrals` is released even when the breakdown is not: the partner already knows how many
 * clients they sent us, so withholding it protects nobody and makes the suppression look like an
 * error rather than a rule.
 */
export const aggregateStatus = async (
  tenantId: string,
  partnerId: string,
): Promise<AggregateStatus> => {
  // Current attribution, not the lead's original column - see attributed.ts.
  const leads = await leadsAttributedTo(tenantId, partnerId);

  if (leads.length < MINIMUM_COHORT) {
    return {
      partnerId,
      released: false,
      countsByStage: {},
      totalReferrals: leads.length,
      detail: `A stage breakdown is withheld below ${MINIMUM_COHORT} referrals. With ${leads.length} on record, a count by stage would identify individual clients to the partner who referred them - removing the name does not make it anonymous when the partner supplied the client.`,
    };
  }

  const countsByStage: Record<string, number> = {};
  for (const lead of leads) {
    countsByStage[lead.stage] = (countsByStage[lead.stage] ?? 0) + 1;
  }

  return {
    partnerId,
    released: true,
    countsByStage,
    totalReferrals: leads.length,
    detail: `${leads.length} referrals, broken down by stage.`,
  };
};

export interface IdentifiedStatus {
  readonly clientId: string;
  readonly clientLegalName: string;
  readonly complianceState: string;
  readonly consentScope: string;
  readonly detail: string;
}

/**
 * One named client's status, for the partner who referred them.
 *
 * Three things must all hold, and each failure is reported as itself:
 *
 *   1. the partner actually referred this client - checked against 1.3's attribution, not against
 *      anything the caller supplied
 *   2. the client granted `partner_status_visibility` consent, and has not revoked it
 *   3. the consent is not expired
 *
 * What comes back is narrow: legal name and compliance state. Not findings, not documents, not
 * the funding recommendation. A partner asking "is my client progressing" is answered by the
 * state; everything else would be us disclosing our assessment of a client's affairs to a third
 * party because the client agreed to a status update.
 *
 * The read is logged. A client who consented to a partner seeing their status is entitled to know
 * when the partner looked.
 */
export const identifiedStatus = async (input: {
  tenantId: string;
  partnerId: string;
  clientId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<IdentifiedStatus>> => {
  const now = input.now ?? new Date();

  // Through 1.3's attribution and its corrections, and through the OUTCOME for the client id -
  // asking the caller which lead to look at would let a partner name any client they liked.
  const attributed = await leadsAttributedTo(input.tenantId, input.partnerId);
  const referral = attributed.find(
    (lead) => lead.clientId === input.clientId && lead.converted === true,
  );
  if (!referral) {
    return refused(
      'This partner is not currently the referrer of record for this client, so there is no relationship that could support a status disclosure. A referral corrected to another partner stops being visible here on the next read.',
      'Blueprint 8.1 - partner-facing portal for REFERRED-client status',
    );
  }

  const consents = await consentsForClient(input.tenantId, input.clientId);
  const visibility = consents.filter((consent) => consent.kind === PARTNER_VISIBILITY_CONSENT_KIND);

  if (visibility.length === 0) {
    return refused(
      'This client has not authorized their status to be shared with the partner who referred them. The client consented to work with us, which is not consent to be reported on.',
      'Blueprint 1.5 with 8.1 - authorization is per-event, never blanket',
    );
  }

  const live = visibility.find(
    (consent) =>
      consent.revokedAt === null &&
      (consent.expiresAt === null || consent.expiresAt.getTime() > now.getTime()),
  );

  if (!live) {
    const revoked = visibility.some((consent) => consent.revokedAt !== null);
    return refused(
      revoked
        ? 'This client revoked their authorization for partner status sharing. Access ends when they say so, not at the end of a cache window.'
        : "This client's authorization for partner status sharing has expired.",
      'Blueprint 1.5 - consent is checked live on every read',
    );
  }

  const client = await db().client.findFirst({
    where: { tenantId: input.tenantId, id: input.clientId },
  });
  if (!client) return noData(`No client ${input.clientId} is on record.`);

  await append({
    tenantId: input.tenantId,
    type: 'partner.client_status.viewed',
    actor: input.actor,
    clientId: input.clientId,
    payload: { partnerId: input.partnerId, consentId: live.id },
  });

  return ok({
    clientId: client.id,
    clientLegalName: client.legalName,
    complianceState: client.complianceState,
    consentScope: live.scope,
    detail:
      "Released under the client's own partner-visibility authorization. Compliance state only - findings, documents and funding recommendations are not disclosed to a referrer.",
  });
};
