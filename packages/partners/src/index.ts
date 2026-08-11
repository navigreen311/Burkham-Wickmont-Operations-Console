/**
 * @bwc/partners - 8.1 Partner & Referrer Portal (Core) and 8.3 Partner Training & Certification.
 *
 * Category 8's V1 scope. 8.2 Partner Agreement & Payout Center and 8.4 Partner Risk Score are
 * both V1.5, and their absence is visible rather than papered over: `payableToPartner` returns
 * `not_built` naming 8.2, and nothing here produces a performance judgement about a partner.
 *
 * Both modules in one slice because 8.3's headline requirement is a gate on 8.1 - "required
 * completion before partner can refer / co-brand / white-label". Built separately, 8.1 would ship
 * a referral path nothing gates, and the gate would arrive later as a change to working code.
 *
 * Two decisions worth knowing before reading further:
 *
 *   "ANONYMIZED" IS A PROPERTY OF A COHORT, NOT OF A RECORD. A partner who referred one client and
 *   is shown "1 client in underwriting" knows exactly whose status that is. Stripping the name
 *   removes nothing, because the partner supplied the client. So aggregates are suppressed below a
 *   minimum cohort, and a NAMED client's status requires that client's own consent.
 *
 *   A LAPSED CERTIFICATION REMOVES THE CAPABILITY. ADR-0013's rule again: staleness moves toward
 *   whichever answer is safe if the stale record is wrong, and here the stale record is "this
 *   partner knows what they may claim".
 */

export * from './tracks.js';
export * from './partners.js';
export * from './curriculum.js';
export * from './certification.js';
export * from './claims.js';
export * from './attributed.js';
export * from './referrals.js';
export * from './visibility.js';
export * from './branding.js';
export * from './risk.js';
export * from './agreements.js';
export * from './payouts.js';
