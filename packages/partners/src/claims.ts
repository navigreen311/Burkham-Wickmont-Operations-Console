/**
 * Which claims a partner is approved to make - blueprint 8.1's "approved-claims library per
 * partner".
 *
 * Read literally, "library per partner" is a second claim store. It would hold the wording a
 * partner may use, and it would drift from 7.4 the first time the Compliance Review Board changed
 * a claim - **and the drifted copy is the one the partner would actually say out loud.**
 *
 * So this holds IDs. A partner approval names a claim in the Marketing Claim Library and nothing
 * else; the text, the jurisdiction and the disposition are resolved from 7.4 on every read. A
 * partner approved for a claim that 7.4 later bans or deprecates loses it without anybody
 * remembering to come here.
 *
 * The approval itself is real work: it says Channel Partnerships decided this partner, on this
 * track, may say this thing. That decision is worth recording. What is not worth recording is a
 * second copy of the sentence.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { activeLibrary, type MarketingClaim } from '@bwc/claims';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';

export interface ApprovedClaim {
  readonly claimId: string;
  readonly phrase: string;
  readonly disposition: MarketingClaim['disposition'];
  readonly jurisdiction: string;
  readonly requiredDisclosure: string | null;
  readonly approvedAt: string;
}

/**
 * Approve a partner to use a claim.
 *
 * Refuses a claim that is not in the tenant's live library, and refuses one that is `banned`.
 * Approving a banned claim would be a contradiction the system could hold quite comfortably - the
 * approval row would exist and the scanner would block anything containing it, so the partner
 * would be told they may say something that is blocked whenever they say it.
 */
export const approveClaim = async (input: {
  tenantId: string;
  partnerId: string;
  claimId: string;
  approvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ApprovedClaim>> => {
  const now = input.now ?? new Date();

  const library = await activeLibrary({ tenantId: input.tenantId });
  const claim = library.find((entry) => entry.id === input.claimId);

  if (!claim) {
    return refused(
      `Claim ${input.claimId} is not in this tenant's live Marketing Claim Library. A partner cannot be approved for wording that does not exist here, because there would be nothing to check what they said against.`,
      'Blueprint 8.1 with 7.4 - approved claims resolve to the library',
    );
  }

  if (claim.disposition === 'banned') {
    return refused(
      `Claim '${claim.phrase}' is banned. Approving a partner to use it would produce a record saying they may say something the Compliance Scanner blocks every time they say it.`,
      'Blueprint 7.4 - banned language is not approvable',
    );
  }

  const row = await db().partnerClaimApproval.upsert({
    where: {
      partnerId_claimId: { partnerId: input.partnerId, claimId: input.claimId },
    },
    create: {
      tenantId: input.tenantId,
      partnerId: input.partnerId,
      claimId: input.claimId,
      approvedAt: now,
      approvedBy: input.approvedBy,
    },
    update: { withdrawnAt: null, approvedAt: now, approvedBy: input.approvedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.claim.approved',
    actor: input.actor,
    payload: {
      partnerId: input.partnerId,
      claimId: input.claimId,
      disposition: claim.disposition,
    },
  });

  return ok({
    claimId: claim.id,
    phrase: claim.phrase,
    disposition: claim.disposition,
    jurisdiction: claim.jurisdiction,
    requiredDisclosure: claim.requiredDisclosure ?? null,
    approvedAt: row.approvedAt.toISOString(),
  });
};

export const withdrawClaim = async (input: {
  tenantId: string;
  partnerId: string;
  claimId: string;
  reason: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ claimId: string }>> => {
  const now = input.now ?? new Date();

  const existing = await db().partnerClaimApproval.findFirst({
    where: { tenantId: input.tenantId, partnerId: input.partnerId, claimId: input.claimId },
  });
  if (!existing || existing.withdrawnAt !== null) {
    return refused(
      'This partner does not hold an active approval for that claim.',
      'Blueprint 8.1 - approved-claims library per partner',
    );
  }

  await db().partnerClaimApproval.update({
    where: { id: existing.id },
    data: { withdrawnAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'partner.claim.withdrawn',
    actor: input.actor,
    payload: { partnerId: input.partnerId, claimId: input.claimId, reason: input.reason },
  });

  return ok({ claimId: input.claimId });
};

/**
 * What this partner may currently say.
 *
 * Resolved against the live library every time. An approval whose claim has since been deprecated
 * or banned simply does not appear - the approval row is still there, and it grants nothing.
 * Deleting the row instead would lose the fact that the approval was once made, which is what a
 * complaint about something a partner said in March would need.
 */
export const approvedClaimsFor = async (
  tenantId: string,
  partnerId: string,
  jurisdiction?: string,
): Promise<readonly ApprovedClaim[]> => {
  const [approvals, library] = await Promise.all([
    db().partnerClaimApproval.findMany({
      where: { tenantId, partnerId, withdrawnAt: null },
    }),
    activeLibrary({ tenantId, ...(jurisdiction !== undefined ? { jurisdiction } : {}) }),
  ]);

  const byId = new Map(library.map((claim) => [claim.id, claim]));

  const resolved: ApprovedClaim[] = [];
  for (const approval of approvals) {
    const claim = byId.get(approval.claimId);
    // A claim deprecated or banned since approval simply does not appear. The approval row stays,
    // because a complaint about something a partner said in March needs to show it was approved.
    if (!claim || claim.disposition === 'banned') continue;
    resolved.push({
      claimId: claim.id,
      phrase: claim.phrase,
      disposition: claim.disposition,
      jurisdiction: claim.jurisdiction,
      requiredDisclosure: claim.requiredDisclosure ?? null,
      approvedAt: approval.approvedAt.toISOString(),
    });
  }

  return resolved.sort((a, b) => a.phrase.localeCompare(b.phrase));
};
