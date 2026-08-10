/**
 * Which leads are attributed to a partner RIGHT NOW - the read every partner-facing surface uses.
 *
 * The obvious query is `lead.findMany({ where: { referrerPartnerId } })`, and it is wrong.
 *
 * 1.3's attribution columns on `Lead` are what was believed at first contact, and they are never
 * updated - that is the design, and a good one, because a payout dispute asks what was originally
 * recorded. Corrections live in their own table. So a referral reattributed from one partner to
 * another still carries the FIRST partner's id on the lead row, and a portal reading that column
 * would show a partner a client that is no longer theirs, and hide one that now is.
 *
 * Both failures are bad and they are bad in different directions. The first is a disclosure to
 * somebody with no relationship to the client; the second makes the correction look like it did
 * not happen.
 *
 * So current attribution is resolved the way 1.3 resolves it - latest correction wins, original
 * otherwise - and resolved in bulk rather than per lead, because the aggregate surface asks about
 * a whole book at once.
 */

import { db } from '@bwc/db';

export interface AttributedLead {
  readonly leadId: string;
  readonly stage: string;
  readonly clientId: string | null;
  readonly converted: boolean | null;
}

/**
 * Every lead currently attributed to this partner.
 *
 * Candidates come from two places - leads originally attributed to the partner, and leads
 * corrected TO them - and each candidate is then resolved to its current attribution, which is
 * what removes the ones corrected AWAY.
 */
export const leadsAttributedTo = async (
  tenantId: string,
  partnerId: string,
): Promise<readonly AttributedLead[]> => {
  const [originals, correctedTo] = await Promise.all([
    db().lead.findMany({
      where: { tenantId, referrerPartnerId: partnerId },
      select: { id: true },
    }),
    db().attributionCorrection.findMany({
      where: { tenantId, toReferrerPartnerId: partnerId },
      select: { leadId: true },
    }),
  ]);

  const candidates = new Set<string>([
    ...originals.map((lead) => lead.id),
    ...correctedTo.map((correction) => correction.leadId),
  ]);
  if (candidates.size === 0) return [];

  const ids = [...candidates];

  const [leads, corrections] = await Promise.all([
    db().lead.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        stage: true,
        referrerPartnerId: true,
        outcome: { select: { clientId: true, converted: true } },
      },
    }),
    db().attributionCorrection.findMany({
      where: { tenantId, leadId: { in: ids } },
      orderBy: { correctedAt: 'asc' },
      select: { leadId: true, toReferrerPartnerId: true },
    }),
  ]);

  // Ascending order, so the last write for a lead is its latest correction.
  const latest = new Map<string, string | null>();
  for (const correction of corrections)
    latest.set(correction.leadId, correction.toReferrerPartnerId);

  return leads
    .filter(
      (lead) => (latest.has(lead.id) ? latest.get(lead.id) : lead.referrerPartnerId) === partnerId,
    )
    .map((lead) => ({
      leadId: lead.id,
      stage: lead.stage,
      clientId: lead.outcome?.clientId ?? null,
      converted: lead.outcome?.converted ?? null,
    }));
};
