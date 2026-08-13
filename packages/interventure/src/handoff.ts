/**
 * Founder Personal Layer handoff to Collingswood - blueprint 10.1's change from v1, and the
 * locked decision behind it.
 *
 * > When Burkham Wickmont identifies personal-side complexity for a client, this module produces
 * > the handoff artifact, captures **per-handoff consent** through Consent & Authorization Center,
 * > and routes to Gardner-governed cross-portfolio commerce.
 *
 * CLAUDE.md, more bluntly: *"Collingswood requires per-handoff consent. No back doors."*
 *
 * **The data subject changes here, and that is the whole reason this is delicate.** Everything
 * else in this system is about a business: its revenue, its statements, its compliance state.
 * Personal-side complexity means the founder's OWN finances - their personal credit, their
 * household, what they earn. A client who authorised us to work on their company's capital
 * position has not authorised us to describe their personal circumstances to another company,
 * however common the ownership.
 *
 * So: per handoff, with the scope named at proposal time so the consent is informed, checked live
 * at the point of transfer, and revocable. The consent kind `cross_portfolio_handoff` has existed
 * in 1.5 since the walking skeleton and is used here for the first time.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { forClient as consentsForClient, type ConsentKind } from '@bwc/consent';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export const HANDOFF_CONSENT_KIND: ConsentKind = 'cross_portfolio_handoff';

export type HandoffState = 'proposed' | 'consented' | 'transferred' | 'declined';

export interface Handoff {
  readonly id: string;
  readonly clientId: string;
  readonly state: HandoffState;
  readonly observation: string;
  readonly scope: string;
  readonly consentId: string | null;
  readonly transferredAt: string | null;
}

interface HandoffRow {
  id: string;
  clientId: string;
  state: string;
  observation: string;
  scope: string;
  consentId: string | null;
  transferredAt: Date | null;
}

const toHandoff = (row: HandoffRow): Handoff => ({
  id: row.id,
  clientId: row.clientId,
  state: row.state as HandoffState,
  observation: row.observation,
  scope: row.scope,
  consentId: row.consentId,
  transferredAt: row.transferredAt?.toISOString() ?? null,
});

/**
 * Propose a handoff.
 *
 * Both `observation` and `scope` are required, and they do different jobs.
 *
 * `observation` is what we noticed that makes a personal-layer referral appropriate. Without it a
 * handoff is a referral looking for a justification, and the pattern of referring every client to
 * a sibling company is exactly what a conflict review would ask about.
 *
 * `scope` is what would actually be shared, named BEFORE the client is asked. A consent given
 * against "a referral to Collingswood" is not informed; a consent given against "your personal
 * credit summary and household composition" is.
 *
 * Proposing shares nothing. It creates the artifact the client is asked to consent to.
 */
export const proposeHandoff = async (input: {
  tenantId: string;
  clientId: string;
  observation: string;
  scope: string;
  proposedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Handoff>> => {
  const now = input.now ?? new Date();

  if (input.observation.trim().length < 20) {
    return refused(
      'A cross-portfolio handoff needs a stated observation - what was noticed that makes a personal-layer referral appropriate. Without one, the handoff is a referral looking for a justification.',
      'Blueprint 10.1 - Founder Personal Layer handoff workflow',
    );
  }
  if (input.scope.trim().length < 20) {
    return refused(
      'A cross-portfolio handoff needs its scope named before the client is asked. Consent to "a referral" is not informed consent; consent to a named set of personal information is.',
      'Blueprint 1.5 - authorization is per-event, never blanket',
    );
  }

  const open = await db().crossPortfolioHandoff.findFirst({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      state: { in: ['proposed', 'consented'] },
    },
  });
  if (open) {
    return refused(
      'A handoff is already open for this client. Two open handoffs would mean two scopes and one consent, and nobody could say afterwards which was agreed to.',
      'Blueprint 10.1 - per-handoff consent',
    );
  }

  const row = await db().crossPortfolioHandoff.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      observation: input.observation,
      scope: input.scope,
      proposedBy: input.proposedBy,
      proposedAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.handoff.proposed',
    actor: input.actor,
    clientId: input.clientId,
    payload: { handoffId: row.id, proposedBy: input.proposedBy },
  });

  return ok(toHandoff(row));
};

/**
 * Record that the client consented.
 *
 * The consent itself is granted through 1.5; this links it. The scope on the consent is checked
 * against the scope on the handoff, because a consent granted against different wording is a
 * consent to something else - and the mismatch is invisible unless somebody compares them.
 */
export const recordConsent = async (input: {
  tenantId: string;
  handoffId: string;
  consentId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Handoff>> => {
  const now = input.now ?? new Date();

  const row = await db().crossPortfolioHandoff.findFirst({
    where: { tenantId: input.tenantId, id: input.handoffId },
  });
  if (!row) return noData(`No handoff ${input.handoffId} is on record.`);
  if (row.state !== 'proposed') {
    return refused(`This handoff is ${row.state}.`, 'Blueprint 10.1 - per-handoff consent');
  }

  const consents = await consentsForClient(input.tenantId, row.clientId);
  const consent = consents.find(
    (entry) => entry.id === input.consentId && entry.kind === HANDOFF_CONSENT_KIND,
  );

  if (!consent) {
    return refused(
      `No ${HANDOFF_CONSENT_KIND} consent with that id exists for this client. The consent is granted through 1.5 and linked here; it is not created by recording it.`,
      'Blueprint 1.5 - the Consent & Authorization Center owns consent',
    );
  }

  if (consent.scope.trim() !== row.scope.trim()) {
    return refused(
      'The consent scope does not match the handoff scope. A consent granted against different wording is a consent to something else, and the difference is invisible unless somebody compares them.',
      'Blueprint 1.5 with 10.1 - informed, per-handoff consent',
    );
  }

  const updated = await db().crossPortfolioHandoff.update({
    where: { id: row.id },
    data: { state: 'consented', consentId: input.consentId },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.handoff.consented',
    actor: input.actor,
    clientId: row.clientId,
    payload: { handoffId: row.id, consentId: input.consentId },
  });

  void now;
  return ok(toHandoff(updated));
};

/**
 * Transfer the handoff to Collingswood.
 *
 * **Consent is re-checked here, live.** It was checked when it was recorded, and a client may have
 * revoked it since - people change their minds about personal financial information more often
 * than about most things, and the gap between consenting and transferring is exactly where they do
 * it. Trusting the state field would mean a revocation took effect only for handoffs that had not
 * yet been recorded.
 */
export const transferHandoff = async (input: {
  tenantId: string;
  handoffId: string;
  transferredBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Handoff>> => {
  const now = input.now ?? new Date();

  const row = await db().crossPortfolioHandoff.findFirst({
    where: { tenantId: input.tenantId, id: input.handoffId },
  });
  if (!row) return noData(`No handoff ${input.handoffId} is on record.`);
  if (row.state !== 'consented') {
    return refused(
      `This handoff is ${row.state}, not consented. Nothing is transferred to Collingswood without the client's own authorization for this handoff.`,
      'CLAUDE.md - Collingswood requires per-handoff consent, no back doors',
    );
  }

  const consents = await consentsForClient(input.tenantId, row.clientId);
  const live = consents.find(
    (entry) =>
      entry.id === row.consentId &&
      entry.revokedAt === null &&
      (entry.expiresAt === null || entry.expiresAt.getTime() > now.getTime()),
  );

  if (!live) {
    const revoked = consents.some(
      (entry) => entry.id === row.consentId && entry.revokedAt !== null,
    );
    return refused(
      revoked
        ? 'The client revoked their authorization for this handoff. Nothing transfers, and the revocation takes effect now rather than at the end of a window.'
        : 'The authorization for this handoff has expired.',
      'Blueprint 1.5 - consent is checked live at the point of use',
    );
  }

  const updated = await db().crossPortfolioHandoff.update({
    where: { id: row.id },
    data: { state: 'transferred', transferredAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.handoff.transferred',
    actor: input.actor,
    clientId: row.clientId,
    payload: {
      handoffId: row.id,
      consentId: row.consentId,
      transferredBy: input.transferredBy,
      scope: row.scope,
    },
  });

  return ok(toHandoff(updated));
};

/** The client said no, or we withdrew it. Kept, because a declined referral is worth seeing. */
export const declineHandoff = async (input: {
  tenantId: string;
  handoffId: string;
  reason: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Handoff>> => {
  const now = input.now ?? new Date();

  const row = await db().crossPortfolioHandoff.findFirst({
    where: { tenantId: input.tenantId, id: input.handoffId },
  });
  if (!row) return noData(`No handoff ${input.handoffId} is on record.`);

  const updated = await db().crossPortfolioHandoff.update({
    where: { id: row.id },
    data: { state: 'declined', declinedAt: now, declinedReason: input.reason },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.handoff.declined',
    actor: input.actor,
    clientId: row.clientId,
    payload: { handoffId: row.id, reason: input.reason },
  });

  return ok(toHandoff(updated));
};

/**
 * Every handoff in the tenant, grouped by where it has got to.
 *
 * **The counts a compliance officer needs, and no total.** A handoff awaiting the client's consent
 * and one already transferred to Collingswood are different obligations - the first is somebody to
 * chase, the second is data that has left. Adding them together produces a number that describes
 * neither.
 *
 * `handoffsFor` answers for one client, which is the right shape for a client file and the wrong
 * one for an Overview: an operator asking "is anything waiting on me" cannot ask it per client.
 *
 * Per-handoff consent is the rule this counts against (ADR-0058). A client who agreed to be
 * introduced to Collingswood once has not agreed to be introduced again, so `awaitingConsent` is
 * the queue that matters and it never empties by inference.
 */
export const handoffStanding = async (
  tenantId: string,
): Promise<{
  readonly awaitingConsent: readonly Handoff[];
  readonly withCollingswood: readonly Handoff[];
  readonly declined: readonly Handoff[];
}> => {
  const rows = await db().crossPortfolioHandoff.findMany({
    where: { tenantId },
    orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
  });
  const all = rows.map(toHandoff);

  return {
    // Proposed, and nobody has consented yet. Nothing may be shared.
    awaitingConsent: all.filter((h) => h.consentId === null && h.transferredAt === null),
    // Consented and sent. The data has left the firm.
    withCollingswood: all.filter((h) => h.transferredAt !== null),
    declined: all.filter((h) => h.state === 'declined'),
  };
};

export const handoffsFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly Handoff[]> => {
  const rows = await db().crossPortfolioHandoff.findMany({
    where: { tenantId, clientId },
    orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toHandoff);
};
