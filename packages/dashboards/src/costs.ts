/**
 * Per-client vendor costs - blueprint 9.2's change from v1.
 *
 * > **Change from v1:** Now tracks per-client vendor costs (Plaid, bureau data providers) as
 * > **COGS lines feeding gross margin calculation**.
 *
 * Neither vendor is gated in. Decision A puts Plaid behind an Argus security review, a signed DPA
 * and SOC 2 Type II; Decision B does the same for the business bureaus. Nothing in this system has
 * ever called either, so nothing has ever been charged for either, and there is no cost to read.
 *
 * The whole of this file is therefore one honest `not_built` and the reasoning for why the absence
 * matters more here than in most places it appears.
 *
 * **A gross margin missing its COGS is not a gross margin.** It is a number that is wrong in a
 * KNOWN DIRECTION by an UNKNOWN AMOUNT - overstated, by however much the vendors turn out to
 * cost - on the dashboard the founder uses to decide whether the service model works. Publishing
 * it and adding a footnote would not help: the footnote is read once and the number is read every
 * month.
 *
 * So `economics.ts` reports `marginBeforeUnmeasuredCosts` and names what it excludes. The
 * awkwardness of that name is deliberate; a caller cannot use it while believing it is a margin.
 */

import { notBuilt, type Outcome } from '@bwc/core';
import type { Cents } from '@bwc/billing';

/** The COGS lines blueprint 9.2 requires, and the gate each is behind. */
export const UNMEASURED_COST_LINES: readonly { readonly line: string; readonly gate: string }[] = [
  {
    line: 'Plaid subscription cost per client',
    gate: 'Decision A - Plaid is the statement source, and no client onboards before Plaid clears Argus security review, a signed DPA and SOC 2 Type II.',
  },
  {
    line: 'Business bureau pull cost per client',
    gate: 'Decision B - per-pull authorization, and the bureau integration is behind the same review.',
  },
  {
    line: 'Personal credit pull cost per client',
    gate: 'Decision B - same review, and per-pull consent is required before any pull happens.',
  },
];

/** Names only, for a caller that wants to list the gaps without the reasoning. */
export const unmeasuredCostLineNames = (): readonly string[] =>
  UNMEASURED_COST_LINES.map((entry) => entry.line);

/**
 * What this client has cost us in vendor fees.
 *
 * `not_built`, and it will stay that way until the integrations are gated in. Returning `0` would
 * be the worst available answer: zero is a measurement, it flows straight into a margin, and it
 * makes every engagement look more profitable than it is by exactly the amount nobody has counted.
 */
export const vendorCostForClient = async (clientId: string): Promise<Outcome<Cents>> =>
  notBuilt(
    '11.5 Integration Layer - Plaid and bureau vendors (Decisions A and B)',
    `No vendor cost can be computed for client ${clientId}. Neither Plaid nor the business bureaus is gated in, so nothing has been called and nothing has been billed. Reporting zero would flow into gross margin as a measurement and overstate every engagement by whatever these turn out to cost: ${unmeasuredCostLineNames().join(', ')}.`,
  );

/** The same for a whole tenant, over a period. Same answer, same reason. */
export const vendorCostForTenant = async (tenantId: string): Promise<Outcome<Cents>> =>
  notBuilt(
    '11.5 Integration Layer - Plaid and bureau vendors (Decisions A and B)',
    `No vendor cost can be computed for tenant ${tenantId}. See 9.2's margin, which is reported as margin BEFORE unmeasured costs rather than as a margin.`,
  );
