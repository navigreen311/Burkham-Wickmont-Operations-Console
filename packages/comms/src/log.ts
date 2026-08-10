/**
 * The communication log - blueprint 4.1's "full client comms log preserved for compliance audit".
 *
 * The read the Compliance Evidence Vault consumes, which is what turns 7.1's `communications`
 * source from `not_built` into a real section. Until now every client file carried a note saying a
 * reader "should not treat its absence as evidence that nothing was said."
 *
 * Blocked messages are included. A log holding only what went out would answer the regulator's
 * question with the half that flatters us - and "we tried to reach this client eleven times and
 * every attempt was blocked by their own do-not-call instruction" is a better answer than silence
 * in both directions.
 */

import { db } from '@bwc/db';
import type { Channel } from './windows.js';
import type { CommsStatus } from './send.js';

export interface CommunicationEntry {
  readonly id: string;
  readonly direction: 'outbound' | 'inbound';
  readonly channel: Channel;
  readonly status: CommsStatus;
  readonly templateKey: string | null;
  readonly templateVersion: number | null;
  readonly subject: string | null;
  readonly body: string;
  readonly bodyHash: string;
  readonly blockedReason: string | null;
  readonly urgentReroute: boolean;
  readonly occurredAt: string;
  readonly recordedBy: string;
}

interface CommunicationRow {
  id: string;
  direction: string;
  channel: string;
  status: string;
  templateKey: string | null;
  templateVersion: number | null;
  subject: string | null;
  body: string;
  bodyHash: string;
  blockedReason: string | null;
  urgentReroute: boolean;
  occurredAt: Date;
  recordedBy: string;
}

const toEntry = (row: CommunicationRow): CommunicationEntry => ({
  id: row.id,
  direction: row.direction as 'outbound' | 'inbound',
  channel: row.channel as Channel,
  status: row.status as CommsStatus,
  templateKey: row.templateKey,
  templateVersion: row.templateVersion,
  subject: row.subject,
  body: row.body,
  bodyHash: row.bodyHash,
  blockedReason: row.blockedReason,
  urgentReroute: row.urgentReroute,
  occurredAt: row.occurredAt.toISOString(),
  recordedBy: row.recordedBy,
});

/**
 * Every communication with a client, oldest first.
 *
 * Includes the body. This table **is** the audit record - the Ledger deliberately carries only a
 * hash, so if the body were withheld here it would exist nowhere, and "what were they told" would
 * be unanswerable.
 */
export const communicationsFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly CommunicationEntry[]> => {
  const rows = await db().communication.findMany({
    where: { tenantId, clientId },
    orderBy: { occurredAt: 'asc' },
  });
  return rows.map(toEntry);
};

/**
 * A metadata-only view, for a caller assembling something the body should not travel into.
 *
 * Offered as its own function rather than a flag, so a caller who wants metadata gets metadata
 * without having to remember to strip anything - and one who wants the body has said so.
 */
export const communicationMetadataFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly Omit<CommunicationEntry, 'body' | 'subject'>[]> =>
  (await communicationsFor(tenantId, clientId)).map(({ body, subject, ...rest }) => {
    void body;
    void subject;
    return rest;
  });

export interface ContactAttemptSummary {
  readonly attempted: number;
  readonly approved: number;
  readonly blocked: number;
  readonly inbound: number;
  /** The distinct reasons attempts were blocked, most frequent first. */
  readonly blockReasons: readonly { reason: string; count: number }[];
}

/**
 * What contacting this client has actually looked like.
 *
 * The summary an operator wants before picking up the phone, and the one a reviewer wants when
 * asking why a client was never reached.
 */
export const contactSummary = async (
  tenantId: string,
  clientId: string,
): Promise<ContactAttemptSummary> => {
  const entries = await communicationsFor(tenantId, clientId);
  const outbound = entries.filter((entry) => entry.direction === 'outbound');
  const blocked = outbound.filter((entry) => entry.status === 'blocked');

  const counts = new Map<string, number>();
  for (const entry of blocked) {
    const reason = entry.blockedReason ?? 'unrecorded';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return {
    attempted: outbound.length,
    approved: outbound.filter((entry) => entry.status === 'approved_to_send').length,
    blocked: blocked.length,
    inbound: entries.filter((entry) => entry.direction === 'inbound').length,
    blockReasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
};
