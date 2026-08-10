/**
 * @bwc/portal - 11.10 Client Portal (Secure Client Delivery Room).
 *
 * The first surface where the CLIENT acts rather than us.
 *
 * THE DECISION: the portal decides nothing. The tempting build is a portal-specific permission
 * model - a list of what clients may see and do. That list would drift from 3.2's document
 * classes, 11.1's access model and 1.5's consent records, and the drifted copy is the one that
 * would actually be enforced.
 *
 * So every view asks the module that owns the fact, and every action calls the module that owns
 * the gate: upload goes to 3.2 (which holds the document unreadable until it scans), signing to
 * 1.5, messaging to 4.1's deliberately-ungated inbound path, Plaid Link to a `not_built` naming
 * Decision A.
 *
 * The one rule the portal enforces itself is the one no other module can: a client acts on their
 * own file, checked against the resolved principal rather than an id the caller supplied.
 */

export * from './views.js';
export * from './actions.js';
