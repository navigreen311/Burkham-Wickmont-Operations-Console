/**
 * The send path - blueprint 4.1.
 *
 * Four gates, in this order, and the order is the design:
 *
 *   1. the preference gate   - may we contact this client, on this channel, at this hour
 *   2. the middleware chain  - authority, firewall, the state gate (7.2), the scanner (4.2)
 *   3. the log               - what was approved to send, or what was blocked and why
 *   4. the provider seam     - reported as `not_built`, because no provider is gated in
 *
 * The preference gate runs first because its refusals are about the client rather than the message.
 * "This client is on do-not-call" is true whatever the text says, and scanning a message we may not
 * send would be work done to produce an answer nobody can act on.
 *
 * **A blocked send is still logged.** "We tried to contact this client and could not" is evidence,
 * and a log holding only what went out would answer a regulator's question with the half that
 * flatters us.
 */

import { createHash } from 'node:crypto';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { chain } from '@bwc/middleware';
import { notBuilt, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { mayContact, preferencesFor, routeUrgent } from './preferences.js';
import type { Channel } from './windows.js';

export type CommsStatus = 'approved_to_send' | 'blocked' | 'received';

export interface SendResult {
  readonly communicationId: string;
  readonly channel: Channel;
  readonly status: CommsStatus;
  readonly rerouted: boolean;
  readonly detail: string;
  /** Set when a gate refused it. */
  readonly blockedReason: string | null;
}

export interface SendInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly actorId: string;
  readonly channel: Channel;
  readonly subject?: string;
  readonly body: string;
  /** Two-letter state code. The chain's step 5 refuses without one. */
  readonly jurisdiction: string;
  readonly templateKey?: string;
  readonly templateVersion?: number;
  /**
   * Permits rerouting between **permitted** channels. It cannot create permission, reach past
   * do-not-call, or move a message into quiet hours - see `routeUrgent`.
   */
  readonly urgent?: boolean;
  readonly sentBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

export const hashBody = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * Attempt to send.
 *
 * Returns `not_built` on the provider seam once every gate has passed, rather than `ok`: the
 * message was approved and nothing delivered it. Reporting success would be the most misleading
 * answer available - a compliance log saying a client was told something they never received.
 */
export const send = async (input: SendInput): Promise<Outcome<SendResult>> => {
  const now = input.now ?? new Date();

  if (input.body.trim() === '') {
    return refused(
      'An empty message cannot be sent or logged usefully.',
      'Blueprint 4.1 - the communication log is the audit record',
    );
  }

  const preferences = await preferencesFor(input.tenantId, input.clientId);

  // 1. The preference gate. Urgency may move the channel; it may not weaken the verdict.
  let channel = input.channel;
  let rerouted = false;

  if (input.urgent === true) {
    const route = routeUrgent(preferences, now, input.channel);
    if (route.channel === null) {
      return logBlocked(input, channel, route.detail, now, false);
    }
    channel = route.channel;
    rerouted = route.rerouted;
  }

  const verdict = mayContact(preferences, channel, now);
  if (!verdict.permitted) {
    return logBlocked(input, channel, verdict.detail, now, rerouted);
  }

  // 2. The chain. Step 5 is the Regulatory Engine's state gate and step 7 the compliance scanner,
  // so a message to a client in an unactivated state, or one containing banned language, is
  // refused here rather than after it has gone out.
  const { result } = await chain({
    actorId: input.actorId,
    tenantId: input.tenantId,
    action: 'send_client_communication',
    clientId: input.clientId,
    eventType: 'comms.message.sent',
    eventPayload: {
      channel,
      templateKey: input.templateKey ?? null,
      bodyHash: hashBody(input.body),
    },
    clientFacingContent: input.body,
    jurisdiction: input.jurisdiction,
  });

  if (result.status !== 'ok') {
    const reason =
      result.status === 'refused'
        ? result.reason
        : `The middleware chain did not pass: ${result.status}.`;
    return logBlocked(input, channel, reason, now, rerouted);
  }

  // 3. The log.
  const row = await db().communication.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      direction: 'outbound',
      channel: channel as never,
      status: 'approved_to_send',
      templateKey: input.templateKey ?? null,
      templateVersion: input.templateVersion ?? null,
      subject: input.subject ?? null,
      body: input.body,
      bodyHash: hashBody(input.body),
      urgentReroute: rerouted,
      occurredAt: now,
      recordedBy: input.sentBy,
    },
  });

  // 4. The provider seam. Nothing is gated in, so nothing was delivered - and saying otherwise
  // would put "the client was told" in a compliance log when they were not.
  return notBuilt(
    '11.5 Integration Layer - email and SMS providers',
    `The message passed every gate and was logged as approved to send (${row.id}), but no delivery provider is gated in, so it has not been delivered. ${verdict.detail}`,
  );
};

/** Log a refusal, then return it. The log entry is the point; the return value is the caller's. */
const logBlocked = async (
  input: SendInput,
  channel: Channel,
  reason: string,
  now: Date,
  rerouted: boolean,
): Promise<Outcome<SendResult>> => {
  const row = await db().communication.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      direction: 'outbound',
      channel: channel as never,
      status: 'blocked',
      templateKey: input.templateKey ?? null,
      templateVersion: input.templateVersion ?? null,
      subject: input.subject ?? null,
      body: input.body,
      bodyHash: hashBody(input.body),
      blockedReason: reason,
      urgentReroute: rerouted,
      occurredAt: now,
      recordedBy: input.sentBy,
    },
  });

  // The Ledger carries the hash and the reason, never the body.
  await append({
    tenantId: input.tenantId,
    type: 'comms.message.blocked',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      communicationId: row.id,
      channel,
      reason,
      bodyHash: hashBody(input.body),
    },
  });

  return refused(reason, 'Blueprint 4.1 with 4.4 - nothing sends without a live permission check');
};

/**
 * Record an inbound message.
 *
 * No gates: a client contacting us is not something to permit or refuse, and a system that dropped
 * inbound messages from a do-not-call client would lose the one where they asked to be called.
 */
export const recordInbound = async (input: {
  tenantId: string;
  clientId: string;
  channel: Channel;
  subject?: string;
  body: string;
  receivedAt: Date;
  recordedBy: string;
  actor: EventActor;
}): Promise<Outcome<{ communicationId: string }>> => {
  const row = await db().communication.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      direction: 'inbound',
      channel: input.channel as never,
      status: 'received',
      subject: input.subject ?? null,
      body: input.body,
      bodyHash: hashBody(input.body),
      occurredAt: input.receivedAt,
      recordedBy: input.recordedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'comms.message.received',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      communicationId: row.id,
      channel: input.channel,
      bodyHash: hashBody(input.body),
    },
  });

  return ok({ communicationId: row.id });
};
