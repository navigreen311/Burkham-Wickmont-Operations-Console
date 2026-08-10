/**
 * @bwc/capital — 5.1 Capital Stack & Monitoring and 5.6 Cost of Capital Calculator.
 *
 * Answers the two questions the business exists to answer: what capital does this client have,
 * and what is it actually costing them.
 *
 * The cost side solves the internal rate of return of the real cash flows rather than
 * approximating, because the gap between a "1.4 factor" and its true APR is the single most
 * valuable thing this module surfaces — and an approximation errs in the direction that flatters
 * exactly the products the client most needs to see clearly.
 */

export * from './cost.js';
export * from './positions.js';
export * from './calendar.js';
export * from './health.js';
