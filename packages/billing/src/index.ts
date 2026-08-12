/**
 * @bwc/billing - 1.4 Pricing, Billing & Offer Management.
 *
 * Every amount here is an integer number of cents. See `money.ts` for the three concrete failures
 * that motivates; the shortest is that `paid - earned` in floating point can produce a refund of
 * -0.001, and a negative refund is nonsense.
 *
 * The module's shape follows from one word in blueprint 1.4: refunds are driven by OBJECTIVE
 * triggers. Objective means computable, so entitlement is derived from the record rather than
 * requested by a client - and the asymmetry that follows is that granting a refund needs nobody's
 * approval while declining one needs a Level 3 human and a recorded reason.
 */

export * from './money.js';
export * from './engagements.js';
export * from './credit.js';
export * from './refunds.js';
export * from './exhibit.js';
export * from './seed.js';
