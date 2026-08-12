/**
 * @bwc/comms - 4.1 Communications Hub, with 4.4 Client Notification Preference Center.
 *
 * Both in one package because the preference record is the GATE, not a convenience. A send path
 * that accepted `smsAllowed: true` from its caller would let code assert consent the client never
 * gave, which is the failure TCPA exists about.
 *
 * The distinction that shapes everything here: URGENCY OVERRIDES PREFERENCE, NEVER PROHIBITION.
 * "I prefer email" is a convenience an urgent alert may override. "Do not call me", quiet hours,
 * and a channel the client never permitted are not - and a flag that reached them would be a
 * documented mechanism for breaking the law, which is worse than not having the feature.
 *
 * A blocked send is still logged. "We tried to contact this client and could not" is evidence, and
 * a log holding only what went out would answer a regulator with the half that flatters us.
 */

export * from './windows.js';
export * from './preferences.js';
export * from './templates.js';
export * from './send.js';
export * from './log.js';
export * from './seed.js';
