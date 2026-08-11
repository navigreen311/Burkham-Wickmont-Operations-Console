/**
 * Claim proposals - blueprint 4.5's "founder approval queue for new claims" and "new marketing
 * claims route through Compliance Review Board before Marketing Claim Library additions".
 *
 * The intake 7.4 never had. Until now a claim reached the Marketing Claim Library by somebody
 * calling `publish`, which meant the review the blueprint describes existed only as a convention.
 *
 * **A proposal holds text only while it is unapproved.** On approval it publishes into 7.4 and
 * keeps the resulting claim id. It deliberately does not become a second place approved wording
 * lives - the same argument 8.1 makes about per-partner claim libraries, and the same failure it
 * avoids: two copies drift, and the drifted one is the one somebody says out loud.
 *
 * A rejected proposal keeps its phrase, and should. "We considered saying this and decided not to"
 * is the more useful half of the record, and it is the half that would be lost by deleting.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { publish, activeLibrary, type ClaimDisposition } from '@bwc/claims';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export type ProposalStatus = 'submitted' | 'approved' | 'rejected';

/** The Compliance Review Board decides. Level 3, read from the recorded actor. */
export const REVIEW_AUTHORITY_LEVEL = 3;

export interface Proposal {
  readonly id: string;
  readonly phrase: string;
  readonly intendedUse: string;
  readonly jurisdiction: string | null;
  readonly status: ProposalStatus;
  readonly publishedClaimId: string | null;
  readonly decisionReason: string | null;
  readonly submittedAt: string;
}

interface ProposalRow {
  id: string;
  phrase: string;
  intendedUse: string;
  jurisdiction: string | null;
  status: string;
  publishedClaimId: string | null;
  decisionReason: string | null;
  submittedAt: Date;
}

const toProposal = (row: ProposalRow): Proposal => ({
  id: row.id,
  phrase: row.phrase,
  intendedUse: row.intendedUse,
  jurisdiction: row.jurisdiction,
  status: row.status as ProposalStatus,
  publishedClaimId: row.publishedClaimId,
  decisionReason: row.decisionReason,
  submittedAt: row.submittedAt.toISOString(),
});

/**
 * Propose a claim for the Library.
 *
 * `intendedUse` is required and is the point of the form. A phrase on its own gives the Board
 * nothing to review - "we help businesses get funded" is fine on a landing page and a problem in a
 * cold email to a client mid-application, and the Board cannot tell which is being asked without
 * being told.
 *
 * A phrase already in the Library is refused rather than queued. Approving it twice would produce
 * two library entries the scanner treats as separate rules, and the second could later be
 * deprecated while the first stayed live.
 */
export const proposeClaim = async (input: {
  tenantId: string;
  phrase: string;
  intendedUse: string;
  jurisdiction?: string;
  submittedBy: string;
  actor: EventActor;
}): Promise<Outcome<Proposal>> => {
  if (input.phrase.trim() === '') {
    return refused(
      'A claim proposal needs the phrase itself.',
      'Blueprint 4.5 - founder approval queue for new claims',
    );
  }
  if (input.intendedUse.trim().length < 15) {
    return refused(
      'A claim proposal needs its intended use. The same sentence can be fine on a landing page and a problem in a mid-application email, and the Compliance Review Board cannot tell which is being asked without being told.',
      'Blueprint 4.5 - new claims route through the Compliance Review Board',
    );
  }

  const library = await activeLibrary({ tenantId: input.tenantId });
  const clash = library.find(
    (claim) => claim.phrase.toLowerCase() === input.phrase.trim().toLowerCase(),
  );
  if (clash) {
    return refused(
      `'${clash.phrase}' is already in the Marketing Claim Library as ${clash.disposition}. Proposing it again would produce a second entry the scanner treats as a separate rule.`,
      'Blueprint 7.4 - one entry per phrase per jurisdiction',
    );
  }

  const pending = await db().claimProposal.findFirst({
    where: { tenantId: input.tenantId, phrase: input.phrase.trim(), status: 'submitted' },
  });
  if (pending) return ok(toProposal(pending));

  const row = await db().claimProposal.create({
    data: {
      tenantId: input.tenantId,
      phrase: input.phrase.trim(),
      intendedUse: input.intendedUse,
      jurisdiction: input.jurisdiction ?? null,
      submittedBy: input.submittedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.claim.proposed',
    actor: input.actor,
    payload: { proposalId: row.id, jurisdiction: input.jurisdiction ?? null },
  });

  return ok(toProposal(row));
};

/**
 * Approve a proposal, publishing it into 7.4.
 *
 * The publish and the decision happen together, so there is no window in which a proposal reads
 * approved and the Library does not have it - which is the window in which somebody would say the
 * claim on the strength of the approval and the scanner would block it.
 *
 * Approving as `banned` is a legitimate and common outcome: somebody asked whether we may say
 * this, and the answer is that nobody may. That belongs in the Library as a banned entry, which is
 * strictly more useful than a rejected proposal nobody will find.
 */
export const approveProposal = async (input: {
  tenantId: string;
  proposalId: string;
  disposition: ClaimDisposition;
  rationale: string;
  requiredDisclosure?: string;
  approvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Proposal>> => {
  const now = input.now ?? new Date();

  if (input.rationale.trim().length < 20) {
    return refused(
      "A Compliance Review Board decision needs a rationale. It becomes the Library entry's own rationale, which is what the next person reads when they wonder why this wording and not another.",
      'Blueprint 7.4 - every claim carries its reasoning',
    );
  }
  if (
    input.disposition === 'requires_disclaimer' &&
    (input.requiredDisclosure ?? '').trim() === ''
  ) {
    return refused(
      'A claim approved as requiring a disclaimer must carry the disclaimer. Without it the scanner would flag the phrase and be unable to say what has to accompany it.',
      'Blueprint 7.4 - a required disclosure travels with the claim',
    );
  }

  const row = await db().claimProposal.findFirst({
    where: { tenantId: input.tenantId, id: input.proposalId },
  });
  if (!row) return noData(`No claim proposal ${input.proposalId} is on record.`);
  if (row.status !== 'submitted') {
    return refused(
      `This proposal was already ${row.status}.`,
      'Blueprint 4.5 - a proposal is decided once',
    );
  }

  const reviewer = await findActor(input.approvedBy);
  if (!reviewer || reviewer.kind !== 'human' || reviewer.authorityLevel < REVIEW_AUTHORITY_LEVEL) {
    return refused(
      `Deciding a claim proposal requires a human at Authority Level ${REVIEW_AUTHORITY_LEVEL}. It decides what the company may say.`,
      'Blueprint 4.5 with 2.1 - Compliance Review Board decision',
    );
  }

  const published = await publish({
    tenantId: input.tenantId,
    phrase: row.phrase,
    disposition: input.disposition,
    rationale: input.rationale,
    approvedBy: input.approvedBy,
    actor: input.actor,
    ...(row.jurisdiction !== null ? { jurisdiction: row.jurisdiction } : {}),
    ...(input.requiredDisclosure !== undefined
      ? { requiredDisclosure: input.requiredDisclosure }
      : {}),
  });
  if (published.status !== 'ok') return published as Outcome<never>;

  const updated = await db().claimProposal.update({
    where: { id: row.id },
    data: {
      status: 'approved',
      publishedClaimId: published.value.id,
      decidedBy: input.approvedBy,
      decidedAt: now,
      decisionReason: input.rationale,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.claim.approved',
    actor: input.actor,
    payload: {
      proposalId: row.id,
      claimId: published.value.id,
      disposition: input.disposition,
      decidedBy: input.approvedBy,
    },
  });

  return ok(toProposal(updated));
};

/** Reject a proposal. The phrase is kept - "we considered saying this and decided not to". */
export const rejectProposal = async (input: {
  tenantId: string;
  proposalId: string;
  reason: string;
  rejectedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Proposal>> => {
  const now = input.now ?? new Date();

  if (input.reason.trim().length < 20) {
    return refused(
      'Rejecting a claim proposal needs a reason. Without one the same phrase comes back next quarter and nobody can say why it was turned down.',
      'Blueprint 4.5 - founder approval queue for new claims',
    );
  }

  const row = await db().claimProposal.findFirst({
    where: { tenantId: input.tenantId, id: input.proposalId },
  });
  if (!row) return noData(`No claim proposal ${input.proposalId} is on record.`);
  if (row.status !== 'submitted') {
    return refused(
      `This proposal was already ${row.status}.`,
      'Blueprint 4.5 - a proposal is decided once',
    );
  }

  const reviewer = await findActor(input.rejectedBy);
  if (!reviewer || reviewer.kind !== 'human' || reviewer.authorityLevel < REVIEW_AUTHORITY_LEVEL) {
    return refused(
      `Deciding a claim proposal requires a human at Authority Level ${REVIEW_AUTHORITY_LEVEL}.`,
      'Blueprint 4.5 with 2.1 - Compliance Review Board decision',
    );
  }

  const updated = await db().claimProposal.update({
    where: { id: row.id },
    data: {
      status: 'rejected',
      decidedBy: input.rejectedBy,
      decidedAt: now,
      decisionReason: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.claim.rejected',
    actor: input.actor,
    payload: { proposalId: row.id, reason: input.reason, decidedBy: input.rejectedBy },
  });

  return ok(toProposal(updated));
};

/** The Board's queue. */
export const pendingProposals = async (tenantId: string): Promise<readonly Proposal[]> => {
  const rows = await db().claimProposal.findMany({
    where: { tenantId, status: 'submitted' },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toProposal);
};
