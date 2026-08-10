/**
 * @bwc/sales - 1.3 Sales Motion & Engagement Tracking.
 *
 * Two properties shape this package.
 *
 * ATTRIBUTION IS A FINANCIAL FACT. A referral fee is owed to whoever introduced a client, so the
 * attribution columns are written once at creation and this package exposes no path that updates
 * them. A correction is a separate row with the original intact, because the question that has to
 * stay answerable is "who was this attributed to when the fee was calculated".
 *
 * A SALES MOTION IS NOT A WAY AROUND THE COMPLIANCE ONE. Conversion creates a client through 1.1,
 * which starts every client in `pending_assessment` - the state the Funding Ethics Firewall gate
 * already refuses. That holds because conversion has no other path to a client record, and it is
 * tested rather than asserted, since the day somebody adds a second path is the day a comment
 * saying otherwise stops being true.
 */

export * from './leads.js';
export * from './activity.js';
export * from './attribution.js';
export * from './conversion.js';
export * from './expansion.js';
