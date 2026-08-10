/**
 * 4.4 Client Notification Preference Center.
 *
 * The gate 4.1 sends through. Two properties matter more than anything else here.
 *
 * **Absence of permission is not permission.** Every channel defaults to `false`, so a client who
 * has said nothing is contactable on nothing until somebody records that they are. The opposite
 * default would make the preference centre a formality: every client would start contactable, and
 * the record would only ever narrow from a state nobody agreed to.
 *
 * **Urgency overrides preference, never prohibition.** Blueprint 4.4 asks for "urgent alert
 * override rules", and the obvious build is a flag that sends anyway. Two kinds of "no" are being
 * conflated there:
 *
 *   "I prefer email over SMS"   - a convenience. Urgency may override it.
 *   "Do not call me"            - a standing instruction with legal force. Nothing overrides it.
 *   Quiet hours                 - TCPA restricts the hours, not the reason.
 *   Channel not permitted       - the client did not agree to that channel.
 *
 * A flag reaching the second group would be a documented mechanism for breaking the law, which is
 * worse than not having the feature.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { isTimeRestricted, withinDeliveryWindow, type Channel } from './windows.js';

export interface PreferenceRecord {
  readonly clientId: string;
  readonly emailAllowed: boolean;
  readonly smsAllowed: boolean;
  readonly voiceAllowed: boolean;
  readonly timezone: string | null;
  readonly preferredChannel: Channel | null;
  readonly doNotCall: boolean;
  readonly doNotCallReason: string | null;
  readonly urgentRouting: string | null;
}

interface PreferenceRow {
  clientId: string;
  emailAllowed: boolean;
  smsAllowed: boolean;
  voiceAllowed: boolean;
  timezone: string | null;
  preferredChannel: string | null;
  doNotCall: boolean;
  doNotCallReason: string | null;
  urgentRouting: string | null;
}

const toPreference = (row: PreferenceRow): PreferenceRecord => ({
  clientId: row.clientId,
  emailAllowed: row.emailAllowed,
  smsAllowed: row.smsAllowed,
  voiceAllowed: row.voiceAllowed,
  timezone: row.timezone,
  preferredChannel: (row.preferredChannel as Channel | null) ?? null,
  doNotCall: row.doNotCall,
  doNotCallReason: row.doNotCallReason,
  urgentRouting: row.urgentRouting,
});

export interface SetPreferencesInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly emailAllowed?: boolean;
  readonly smsAllowed?: boolean;
  readonly voiceAllowed?: boolean;
  /** IANA zone. Required before any SMS or voice may be sent. */
  readonly timezone?: string;
  readonly preferredChannel?: Channel;
  readonly urgentRouting?: string;
  readonly updatedBy: string;
  readonly actor: EventActor;
}

/**
 * Record what a client permits.
 *
 * Deliberately cannot clear do-not-call. Setting it is here; lifting it is `liftDoNotCall`, which
 * requires the client to have asked - a preference update that could quietly clear a standing
 * instruction would let a routine form submission undo a legal one.
 */
export const setPreferences = async (
  input: SetPreferencesInput,
): Promise<Outcome<PreferenceRecord>> => {
  if (input.timezone !== undefined && input.timezone.trim() === '') {
    return refused(
      'A timezone cannot be recorded as blank. Leave it unset rather than empty - unset refuses an SMS, and blank would look like an answer.',
      'Blueprint 4.1 - timezone-aware delivery windows',
    );
  }

  const row = await db().notificationPreference.upsert({
    where: { tenantId_clientId: { tenantId: input.tenantId, clientId: input.clientId } },
    create: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      emailAllowed: input.emailAllowed ?? false,
      smsAllowed: input.smsAllowed ?? false,
      voiceAllowed: input.voiceAllowed ?? false,
      timezone: input.timezone ?? null,
      preferredChannel: (input.preferredChannel ?? null) as never,
      urgentRouting: input.urgentRouting ?? null,
      updatedBy: input.updatedBy,
    },
    update: {
      ...(input.emailAllowed !== undefined ? { emailAllowed: input.emailAllowed } : {}),
      ...(input.smsAllowed !== undefined ? { smsAllowed: input.smsAllowed } : {}),
      ...(input.voiceAllowed !== undefined ? { voiceAllowed: input.voiceAllowed } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.preferredChannel !== undefined
        ? { preferredChannel: input.preferredChannel as never }
        : {}),
      ...(input.urgentRouting !== undefined ? { urgentRouting: input.urgentRouting } : {}),
      updatedBy: input.updatedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'comms.preferences.updated',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      emailAllowed: row.emailAllowed,
      smsAllowed: row.smsAllowed,
      voiceAllowed: row.voiceAllowed,
      hasTimezone: row.timezone !== null,
      updatedBy: input.updatedBy,
    },
  });

  return ok(toPreference(row));
};

/**
 * Record a do-not-call instruction.
 *
 * Its own function rather than a field on `setPreferences`, so it cannot be set or cleared as a
 * side effect of a routine preference update. A reason is required because a standing instruction
 * that nobody can explain cannot be honoured confidently or lifted safely.
 */
export const setDoNotCall = async (input: {
  tenantId: string;
  clientId: string;
  reason: string;
  setOn: Date;
  updatedBy: string;
  actor: EventActor;
}): Promise<Outcome<PreferenceRecord>> => {
  if (input.reason.trim() === '') {
    return refused(
      'A do-not-call instruction needs a reason. It is a standing instruction with legal force, and one nobody can explain cannot be honoured confidently or lifted safely.',
      'Blueprint 4.4 - do-not-call list synchronization',
    );
  }

  const row = await db().notificationPreference.upsert({
    where: { tenantId_clientId: { tenantId: input.tenantId, clientId: input.clientId } },
    create: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      doNotCall: true,
      doNotCallSetOn: input.setOn,
      doNotCallReason: input.reason,
      updatedBy: input.updatedBy,
    },
    update: {
      doNotCall: true,
      doNotCallSetOn: input.setOn,
      doNotCallReason: input.reason,
      updatedBy: input.updatedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'comms.do_not_call.set',
    actor: input.actor,
    clientId: input.clientId,
    payload: { reason: input.reason, setBy: input.updatedBy },
  });

  return ok(toPreference(row));
};

/**
 * Lift a do-not-call instruction.
 *
 * Requires a record of the client having asked. The system cannot verify that a client really
 * asked, and this does not pretend to - what it does is make the claim explicit and attributable,
 * so lifting one is a statement somebody made rather than a checkbox somebody cleared.
 */
export const liftDoNotCall = async (input: {
  tenantId: string;
  clientId: string;
  clientRequestReference: string;
  liftedBy: string;
  actor: EventActor;
}): Promise<Outcome<PreferenceRecord>> => {
  if (input.clientRequestReference.trim() === '') {
    return refused(
      'Lifting a do-not-call instruction requires a reference to the client asking for it to be lifted. The system cannot verify the request, but it can make the claim explicit and attributable.',
      'Blueprint 4.4 - do-not-call list synchronization',
    );
  }

  const existing = await db().notificationPreference.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });
  if (!existing) return noData('No preference record for this client.');

  const row = await db().notificationPreference.update({
    where: { id: existing.id },
    data: {
      doNotCall: false,
      doNotCallSetOn: null,
      doNotCallReason: null,
      updatedBy: input.liftedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'comms.do_not_call.lifted',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      clientRequestReference: input.clientRequestReference,
      liftedBy: input.liftedBy,
      previousReason: existing.doNotCallReason,
    },
  });

  return ok(toPreference(row));
};

/**
 * A client's preferences, or the safe default.
 *
 * `no_data` would be the obvious return for a client nobody has recorded preferences for, and it
 * would push the "absent means not permitted" decision onto every caller. Returning a record with
 * everything false puts it in one place, and the record says plainly that nothing is permitted.
 */
export const preferencesFor = async (
  tenantId: string,
  clientId: string,
): Promise<PreferenceRecord> => {
  const row = await db().notificationPreference.findFirst({ where: { tenantId, clientId } });

  return row === null
    ? {
        clientId,
        emailAllowed: false,
        smsAllowed: false,
        voiceAllowed: false,
        timezone: null,
        preferredChannel: null,
        doNotCall: false,
        doNotCallReason: null,
        urgentRouting: null,
      }
    : toPreference(row);
};

export type ContactBlocker =
  'channel_not_permitted' | 'do_not_call' | 'outside_delivery_window' | 'no_timezone';

export interface ContactVerdict {
  readonly permitted: boolean;
  readonly blockers: readonly ContactBlocker[];
  /** Written for the blocked-send log entry a compliance reviewer will read. */
  readonly detail: string;
  /** True when a blocker is one urgency could never override. Always true today, and stated. */
  readonly legalProhibition: boolean;
}

/**
 * Whether this client may be contacted on this channel, at this instant.
 *
 * The urgency flag is accepted and deliberately changes nothing here. It belongs to routing - see
 * `routeUrgent` - and having it as a parameter that does not weaken the verdict is the point: a
 * reader looking for the override finds it, and finds that it does not reach this function.
 */
export const mayContact = (
  preferences: PreferenceRecord,
  channel: Channel,
  instant: Date,
): ContactVerdict => {
  const blockers: ContactBlocker[] = [];
  const notes: string[] = [];

  const allowed =
    channel === 'email'
      ? preferences.emailAllowed
      : channel === 'sms'
        ? preferences.smsAllowed
        : preferences.voiceAllowed;

  if (!allowed) {
    blockers.push('channel_not_permitted');
    notes.push(
      `The client has not permitted ${channel}. Absence of permission is not permission, so a client who has said nothing is contactable on nothing.`,
    );
  }

  // Do-not-call covers the channels a person is interrupted on. Email is excluded because a
  // do-not-call instruction is about calls and texts; treating it as a blanket communications ban
  // would also stop the statements and disclosures a client is entitled to receive.
  if (preferences.doNotCall && isTimeRestricted(channel)) {
    blockers.push('do_not_call');
    notes.push(
      `The client is on do-not-call${preferences.doNotCallReason !== null ? ` (${preferences.doNotCallReason})` : ''}. No urgency overrides this.`,
    );
  }

  const window = withinDeliveryWindow(channel, instant, preferences.timezone);
  if (!window.permitted) {
    blockers.push(preferences.timezone === null ? 'no_timezone' : 'outside_delivery_window');
    notes.push(window.detail);
  }

  return {
    permitted: blockers.length === 0,
    blockers,
    detail:
      blockers.length === 0
        ? `${channel} is permitted for this client. ${window.detail}`
        : notes.join(' '),
    legalProhibition: blockers.some(
      (blocker) => blocker === 'do_not_call' || blocker === 'outside_delivery_window',
    ),
  };
};

export interface UrgentRoute {
  readonly channel: Channel | null;
  readonly rerouted: boolean;
  readonly detail: string;
}

/**
 * Pick a channel for an urgent message.
 *
 * This is the whole of the "urgent override": it may move a message from a preferred channel to a
 * different **permitted** one. It cannot make an unpermitted channel permitted, cannot reach past
 * do-not-call, and cannot move a message into quiet hours - `mayContact` is consulted for each
 * candidate and its verdict is final.
 *
 * Returns `null` when nothing is available, rather than falling back to a channel that would be
 * refused a moment later at the send gate. A route that produced a channel the gate then blocked
 * would put the contradiction in front of an operator instead of an answer.
 */
export const routeUrgent = (
  preferences: PreferenceRecord,
  instant: Date,
  preferred?: Channel,
): UrgentRoute => {
  const first = preferred ?? preferences.preferredChannel ?? 'email';
  const order: Channel[] = [first, 'email', 'sms', 'voice'].filter(
    (channel, index, all): channel is Channel => all.indexOf(channel) === index,
  );

  for (const channel of order) {
    if (mayContact(preferences, channel, instant).permitted) {
      return {
        channel,
        rerouted: channel !== first,
        detail:
          channel === first
            ? `${channel} is available and is the preferred channel.`
            : `${first} is unavailable, so the message routes to ${channel}, which the client permits.`,
      };
    }
  }

  return {
    channel: null,
    rerouted: false,
    detail:
      'No channel is available for this client. Urgency reroutes between permitted channels; it does not create permission, reach past do-not-call, or move a message into quiet hours.',
  };
};
