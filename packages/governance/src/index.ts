/**
 * @bwc/governance - 5.4 Capital Product Governance Board.
 *
 * The approval workflow every provider passes before an agent may recommend it, and the
 * only module that can say a provider is usable. The Lender Intelligence Database (5.2)
 * describes providers; it has no field with which to approve one.
 *
 * Two things here are derived rather than stored, for the same reason: a stored value needs
 * a job to keep it true, and a job that stops leaves the value confidently wrong. Standing
 * (is this provider recommendable?) and state restrictions (where?) are both computed at the
 * moment of asking.
 */

export * from './standing.js';
export * from './board.js';
export * from './complaints.js';
export * from './restrictions.js';
