/**
 * Invariants for delivery windows and the preference gate - 4.1 and 4.4.
 *
 * Pure, so every case is cheap. These are the rules with legal force behind them, and the one
 * property worth stating up front: **urgency overrides preference, never prohibition.** A flag
 * that reached do-not-call or quiet hours would be a documented mechanism for breaking the law.
 */

import { describe, expect, it } from 'vitest';
import {
  QUIET_HOURS_END_HOUR,
  QUIET_HOURS_START_HOUR,
  TIME_RESTRICTED_CHANNELS,
  isTimeRestricted,
  localHourIn,
  mayContact,
  nextWindowOpening,
  routeUrgent,
  withinDeliveryWindow,
  type PreferenceRecord,
} from '@bwc/comms';

const preferences = (overrides: Partial<PreferenceRecord> = {}): PreferenceRecord => ({
  clientId: 'client-1',
  emailAllowed: true,
  smsAllowed: true,
  voiceAllowed: true,
  timezone: 'America/Chicago',
  preferredChannel: 'email',
  doNotCall: false,
  doNotCallReason: null,
  urgentRouting: null,
  ...overrides,
});

/** 15:00 UTC is 09:00 in Chicago (CDT) and 08:00 in Denver (MDT) in August. */
const MID_MORNING_UTC = new Date('2026-08-10T15:00:00.000Z');
/** 12:00 UTC is 07:00 in Chicago - before the window opens. */
const EARLY_UTC = new Date('2026-08-10T12:00:00.000Z');

describe('quiet hours are computed in the recipient timezone', () => {
  it('reads the local hour from the IANA zone, not the server', () => {
    // The same instant is a different hour in two zones, which is the whole reason this is not a
    // comparison against the server clock.
    expect(localHourIn(MID_MORNING_UTC, 'America/Chicago')).toBe(10);
    expect(localHourIn(MID_MORNING_UTC, 'America/Los_Angeles')).toBe(8);
    expect(localHourIn(MID_MORNING_UTC, 'Europe/London')).toBe(16);
  });

  it('permits an SMS inside the window and refuses one before it', () => {
    const inside = withinDeliveryWindow('sms', MID_MORNING_UTC, 'America/Chicago');
    expect(inside.permitted).toBe(true);
    expect(inside.localHour).toBe(10);

    const early = withinDeliveryWindow('sms', EARLY_UTC, 'America/Chicago');
    expect(early.permitted).toBe(false);
    expect(early.localHour).toBe(7);
    expect(early.detail).toMatch(/outside the 8:00-21:00 window/);
  });

  it('refuses the same instant in a zone where it is too early', () => {
    // 13:00 UTC is 08:00 in Chicago - just open - and 06:00 in Los Angeles.
    const instant = new Date('2026-08-10T13:00:00.000Z');
    expect(withinDeliveryWindow('sms', instant, 'America/Chicago').permitted).toBe(true);
    expect(withinDeliveryWindow('sms', instant, 'America/Los_Angeles').permitted).toBe(false);
  });

  it('restricts SMS and voice but not email', () => {
    // TCPA covers calls and texts. An email at 3am is a nuisance rather than a violation, and
    // restricting it would delay the status updates clients actually want.
    expect([...TIME_RESTRICTED_CHANNELS].sort()).toEqual(['sms', 'voice']);
    expect(isTimeRestricted('email')).toBe(false);
    expect(withinDeliveryWindow('email', EARLY_UTC, 'America/Chicago').permitted).toBe(true);
  });

  it('refuses when no timezone is recorded rather than defaulting to one', () => {
    // Defaulting would send at the wrong hour for exactly the clients furthest away, and the
    // failure is invisible from the sending side.
    const verdict = withinDeliveryWindow('sms', MID_MORNING_UTC, null);
    expect(verdict.permitted).toBe(false);
    expect(verdict.detail).toMatch(/guessing at somebody's sleep/);
  });

  it('refuses an unrecognised timezone rather than falling back', () => {
    const verdict = withinDeliveryWindow('sms', MID_MORNING_UTC, 'Mars/Olympus_Mons');
    expect(verdict.permitted).toBe(false);
    expect(verdict.detail).toMatch(/not a timezone this system recognises/);
  });

  it('names the window the blueprint and TCPA use', () => {
    expect(QUIET_HOURS_START_HOUR).toBe(8);
    expect(QUIET_HOURS_END_HOUR).toBe(21);
    // 21:00 local is closed: "8am to 9pm" ends at 9pm.
    expect(
      withinDeliveryWindow('sms', new Date('2026-08-11T02:00:00.000Z'), 'America/Chicago')
        .permitted,
    ).toBe(false);
  });

  it('finds the next opening by stepping, not by adding a day', () => {
    // A day is not always 24 hours in a zone that observes daylight saving, and arithmetic that
    // assumes it is produces an opening an hour wrong twice a year.
    const opening = nextWindowOpening('sms', EARLY_UTC, 'America/Chicago');
    expect(opening).not.toBeNull();
    expect(withinDeliveryWindow('sms', opening as Date, 'America/Chicago').permitted).toBe(true);

    expect(nextWindowOpening('email', EARLY_UTC, 'America/Chicago')).toBeNull();
  });
});

describe('absence of permission is not permission', () => {
  it('refuses a channel the client has not permitted', () => {
    const verdict = mayContact(preferences({ smsAllowed: false }), 'sms', MID_MORNING_UTC);
    expect(verdict.permitted).toBe(false);
    expect(verdict.blockers).toContain('channel_not_permitted');
    expect(verdict.detail).toMatch(/Absence of permission is not permission/);
  });

  it('permits a channel the client has permitted, inside the window', () => {
    expect(mayContact(preferences(), 'sms', MID_MORNING_UTC).permitted).toBe(true);
  });

  it('reports every blocker rather than the first', () => {
    // An operator fixing one and finding another is worse than being told both at once.
    const verdict = mayContact(
      preferences({ smsAllowed: false, doNotCall: true, timezone: null }),
      'sms',
      MID_MORNING_UTC,
    );
    expect([...verdict.blockers].sort()).toEqual([
      'channel_not_permitted',
      'do_not_call',
      'no_timezone',
    ]);
  });

  it('applies do-not-call to calls and texts, not to email', () => {
    // A do-not-call instruction is about calls and texts. Treating it as a blanket ban would also
    // stop the statements and disclosures a client is entitled to receive.
    const dnc = preferences({ doNotCall: true, doNotCallReason: 'Client asked on 2026-07-04.' });

    expect(mayContact(dnc, 'sms', MID_MORNING_UTC).permitted).toBe(false);
    expect(mayContact(dnc, 'voice', MID_MORNING_UTC).permitted).toBe(false);
    expect(mayContact(dnc, 'email', MID_MORNING_UTC).permitted).toBe(true);
  });

  it('marks a legal prohibition distinctly from a preference', () => {
    const legal = mayContact(preferences({ doNotCall: true }), 'sms', MID_MORNING_UTC);
    expect(legal.legalProhibition).toBe(true);

    const merePreference = mayContact(preferences({ smsAllowed: false }), 'sms', MID_MORNING_UTC);
    expect(merePreference.legalProhibition).toBe(false);
  });
});

describe('urgency overrides preference, never prohibition', () => {
  it('reroutes from an unavailable preferred channel to a permitted one', () => {
    // The whole of the override: it moves a message between channels the client permits.
    const route = routeUrgent(
      preferences({ smsAllowed: false, preferredChannel: 'sms' }),
      MID_MORNING_UTC,
      'sms',
    );

    expect(route.channel).toBe('email');
    expect(route.rerouted).toBe(true);
    expect(route.detail).toMatch(/routes to email, which the client permits/);
  });

  it('cannot reach past do-not-call', () => {
    const route = routeUrgent(
      preferences({ emailAllowed: false, doNotCall: true }),
      MID_MORNING_UTC,
      'sms',
    );

    expect(route.channel).toBeNull();
    expect(route.detail).toMatch(/does not create permission, reach past do-not-call/);
  });

  it('cannot move a message into quiet hours', () => {
    // Every remaining channel is time-restricted and it is 07:00 local, so there is nowhere to go.
    const route = routeUrgent(preferences({ emailAllowed: false }), EARLY_UTC, 'sms');
    expect(route.channel).toBeNull();
  });

  it('cannot make an unpermitted channel permitted', () => {
    const route = routeUrgent(
      preferences({ emailAllowed: false, smsAllowed: false, voiceAllowed: false }),
      MID_MORNING_UTC,
    );
    expect(route.channel).toBeNull();
  });

  it('returns email at 3am, because email is not time-restricted', () => {
    // The case that shows the rule is about the CHANNEL rather than about urgency: an urgent
    // message at 3am goes by email and stays out of the restricted channels entirely.
    const route = routeUrgent(preferences(), EARLY_UTC, 'sms');
    expect(route.channel).toBe('email');
    expect(route.rerouted).toBe(true);
  });
});
