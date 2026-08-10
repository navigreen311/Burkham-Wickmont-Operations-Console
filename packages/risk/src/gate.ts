/**
 * The Do Not Fund placement check - blueprint 6.4, "blocks placement workflows entirely".
 *
 * Kept in its own file so the Firewall can call it without depending on the whole of 6.4, and so
 * the precedence argument sits next to the code that implements it.
 *
 * **Do Not Fund is checked before the Firewall, which is checked before compliance state.**
 *
 * The existing gate already puts the Firewall first, on the reasoning that reporting a compliance
 * reason when the Firewall is triggered would misdescribe why placement stopped. The same argument
 * carries one step further. A triggered Firewall is a condition somebody expects to clear. A Do Not
 * Fund listing is a standing determination that this client should not receive further capital -
 * and telling an operator "the Firewall is triggered" when the real answer is "we decided in March
 * that this client should not be funded" sends them to resolve the wrong thing.
 *
 * The precedence is about which true statement to lead with, not about which check is stricter.
 */

import { ok, refused, type Outcome } from '@bwc/core';
import { activeListing, findUnconsumedOverride, type Listing } from './listings.js';

/**
 * The actions a listed client may still be subject to.
 *
 * An allow-list rather than a block-list, and the direction is the decision. A block-list would
 * let an action added next year - `submit_renewal_packet`, say - move capital toward a listed
 * client because nobody remembered to add it here. That is exactly the failure this module exists
 * to prevent. Over-blocking produces a visible complaint from an operator; under-blocking produces
 * a funded client the company decided should not be funded, and nobody notices until later.
 *
 * What is on the list is there for a reason:
 *
 *   reading and analysis    - reviewing the file is how somebody decides whether to lift the listing
 *   drafting and sending    - a listed client has to be reachable, and telling them is often the
 *                             point; blocking communications would make the determination unsayable
 *   document requests       - a review usually needs documents
 *
 * `send_partner_followup` is deliberately absent. It is sometimes "we are not proceeding" and
 * sometimes "here is the file", and the gate cannot tell which from the action name. An override
 * is the right route for the first.
 */
export const DO_NOT_FUND_PERMITTED_ACTIONS: readonly string[] = [
  'read_document',
  'analyze_file',
  'generate_internal_report',
  'draft_communication',
  'send_client_communication',
  'send_document_request',
];

export const isPermittedWhileListed = (action: string): boolean =>
  DO_NOT_FUND_PERMITTED_ACTIONS.includes(action);

export interface DoNotFundClearance {
  readonly listed: boolean;
  /** Present when a listing exists, whether or not an override lets this action through. */
  readonly listing: Listing | null;
  /** Set when an unspent override permits this action. The caller must consume it if it proceeds. */
  readonly overrideId: string | null;
  readonly detail: string;
}

/**
 * Whether a named action may proceed for this client.
 *
 * Does **not** consume an override. A caller that checks and then abandons the action for an
 * unrelated reason would otherwise have burned an exception a Level 3 human granted - and the
 * next attempt would need a second approval for work that never happened. `consumeOverride` is
 * called by whoever actually proceeds.
 */
export const checkDoNotFund = async (
  tenantId: string,
  clientId: string,
  action: string,
  now: Date = new Date(),
): Promise<Outcome<DoNotFundClearance>> => {
  const listing = await activeListing(tenantId, clientId, now);

  if (!listing) {
    return ok({
      listed: false,
      listing: null,
      overrideId: null,
      detail: 'This client is not on the Do Not Fund list.',
    });
  }

  if (isPermittedWhileListed(action)) {
    return ok({
      listed: true,
      listing,
      overrideId: null,
      detail: `This client is on the Do Not Fund list (${listing.trigger}), and '${action}' is one of the actions that remain available while listed.`,
    });
  }

  const override = await findUnconsumedOverride(tenantId, listing.id, action);

  if (override) {
    return ok({
      listed: true,
      listing,
      overrideId: override.id,
      detail: `This client is on the Do Not Fund list (${listing.trigger}). A single-use override for '${action}' was approved: ${override.justification}. The listing remains in force after this action.`,
    });
  }

  // The overdue review is mentioned but does not change the verdict. It tells the operator this
  // determination is older than the cadence somebody set, which is worth knowing when they decide
  // whether to seek an override - and it is not a reason to let the action through.
  const staleness = listing.reviewOverdue
    ? ` This listing was due for review on ${listing.reviewDueAt.slice(0, 10)} and has not been reviewed; it continues to block until somebody reviews or removes it.`
    : '';

  return refused(
    `This client is on the Do Not Fund list (${listing.trigger}, listed ${listing.listedAt.slice(0, 10)}): ${listing.justification} Proceeding with '${action}' requires a documented single-use override from a Level 3 human.${staleness}`,
    'Blueprint 6.4 - Do Not Fund blocks placement workflows entirely',
  );
};
