/**
 * Timezone-aware delivery windows - blueprint 4.1, and the TCPA rule 4.4 exists to honour.
 *
 * Pure, so every case is cheap to state and none of them needs a database.
 *
 * The rule is that calls and texts are restricted to 8am-9pm **local to the recipient**. Local
 * means the client's zone - not the server's, and not the company's. A system that used its own
 * clock would send at the wrong hour for exactly the clients furthest away, and the failure is
 * invisible from the sending side because there it looks like a normal afternoon.
 *
 * Email is not restricted. TCPA covers calls and texts; an email arriving at 3am is a nuisance
 * rather than a violation, and restricting it would delay the status updates clients actually want.
 */

export type Channel = 'email' | 'sms' | 'voice';

/** TCPA's window, local to the recipient. */
export const QUIET_HOURS_START_HOUR = 8;
export const QUIET_HOURS_END_HOUR = 21;

/** The channels the window applies to. Email is deliberately absent. */
export const TIME_RESTRICTED_CHANNELS: readonly Channel[] = ['sms', 'voice'];

export const isTimeRestricted = (channel: Channel): boolean =>
  TIME_RESTRICTED_CHANNELS.includes(channel);

export interface WindowVerdict {
  readonly permitted: boolean;
  /** The recipient's local hour, 0-23, when it could be computed. */
  readonly localHour: number | null;
  /** One sentence, in the words a blocked-send log entry should carry. */
  readonly detail: string;
}

/**
 * The recipient's local hour at a given instant.
 *
 * Uses `Intl.DateTimeFormat` with the IANA zone rather than a fixed offset, so daylight saving is
 * handled by the platform's tz database. An offset stored per client would be correct for half the
 * year and quietly wrong for the other half - and the wrong half is the one where an 8am send
 * becomes a 7am one.
 *
 * Throws on an unknown zone rather than falling back. A fallback would be a silent decision about
 * somebody's sleep.
 */
export const localHourIn = (instant: Date, timezone: string): number => {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).format(instant);

  const hour = Number.parseInt(formatted, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) {
    throw new Error(`Could not determine the local hour in '${timezone}'.`);
  }
  // Some locales render midnight as 24; normalise so the comparison below is total.
  return hour === 24 ? 0 : hour;
};

/**
 * Whether a channel may be used at this instant for a recipient in this zone.
 *
 * A missing timezone is **not permitted**, and the detail says so. Defaulting to the sender's zone
 * is the failure this function exists to prevent.
 */
export const withinDeliveryWindow = (
  channel: Channel,
  instant: Date,
  timezone: string | null,
): WindowVerdict => {
  if (!isTimeRestricted(channel)) {
    return {
      permitted: true,
      localHour: null,
      detail: `${channel} is not restricted by delivery hours.`,
    };
  }

  if (timezone === null || timezone.trim() === '') {
    return {
      permitted: false,
      localHour: null,
      detail: `No timezone is recorded for this client, so the local hour cannot be computed. ${channel} is restricted to ${QUIET_HOURS_START_HOUR}:00-${QUIET_HOURS_END_HOUR}:00 local time, and guessing the zone would mean guessing at somebody's sleep.`,
    };
  }

  let localHour: number;
  try {
    localHour = localHourIn(instant, timezone);
  } catch {
    return {
      permitted: false,
      localHour: null,
      detail: `'${timezone}' is not a timezone this system recognises, so the local hour cannot be computed.`,
    };
  }

  const permitted = localHour >= QUIET_HOURS_START_HOUR && localHour < QUIET_HOURS_END_HOUR;

  return {
    permitted,
    localHour,
    detail: permitted
      ? `Local time in ${timezone} is ${String(localHour).padStart(2, '0')}:00, inside the ${QUIET_HOURS_START_HOUR}:00-${QUIET_HOURS_END_HOUR}:00 window.`
      : `Local time in ${timezone} is ${String(localHour).padStart(2, '0')}:00, outside the ${QUIET_HOURS_START_HOUR}:00-${QUIET_HOURS_END_HOUR}:00 window that ${channel} is restricted to.`,
  };
};

/**
 * The next instant at which a restricted channel becomes permitted.
 *
 * For the caller who wants to schedule rather than abandon. Returns `null` for an unrestricted
 * channel or an unusable timezone - `null` meaning "there is nothing to wait for" in the first
 * case and "we cannot say" in the second, which the caller distinguishes by asking
 * `withinDeliveryWindow` rather than by inspecting this.
 */
export const nextWindowOpening = (
  channel: Channel,
  instant: Date,
  timezone: string | null,
): Date | null => {
  if (!isTimeRestricted(channel) || timezone === null) return null;

  // Step forward an hour at a time rather than computing an offset. A day is not always 24 hours
  // long in a zone that observes daylight saving, and the arithmetic that assumes it is produces
  // an opening time an hour wrong twice a year.
  for (let hours = 1; hours <= 48; hours += 1) {
    const candidate = new Date(instant.getTime() + hours * 60 * 60 * 1000);
    if (withinDeliveryWindow(channel, candidate, timezone).permitted) return candidate;
  }
  return null;
};
