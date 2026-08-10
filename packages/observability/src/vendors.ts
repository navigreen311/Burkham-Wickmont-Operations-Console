/**
 * Vendor API health - blueprint 11.8's "Plaid API health, bureau provider API health".
 *
 * Neither vendor is gated in. Decision A puts Plaid behind an Argus security review, a signed DPA
 * and SOC 2 Type II; Decision B does the same for the bureaus. Nothing here has ever called either,
 * so there is no availability to report.
 *
 * The interesting question is what a health dashboard should say about a vendor that is not
 * connected, and the answer is **not** "healthy". A green Plaid row on a system that has never
 * called Plaid is the most confidently wrong thing this module could produce - and it would be
 * green for the same reason a naive implementation shows green for everything: zero errors divided
 * by zero calls.
 *
 * So each ungated vendor is `unmonitored`, naming the Decision that gates it. The row is present
 * rather than omitted, because a dashboard silently missing Plaid asserts there is nothing to
 * report about Plaid.
 */

import { notBuilt, type Outcome } from '@bwc/core';
import { unmonitored, type ComponentHealth } from './probes.js';

export interface GatedVendor {
  readonly key: string;
  readonly label: string;
  readonly gate: string;
}

export const GATED_VENDORS: readonly GatedVendor[] = [
  {
    key: 'plaid',
    label: 'Plaid API',
    gate: 'Decision A - Plaid is the bank statement source, and no client onboards before it clears Argus security review, a signed DPA and SOC 2 Type II.',
  },
  {
    key: 'business_bureau',
    label: 'Business bureau API',
    gate: 'Decision B - per-pull authorization, and the integration is behind the same security review.',
  },
  {
    key: 'personal_credit',
    label: 'Personal credit provider API',
    gate: 'Decision B - per-pull authorization, behind the same security review.',
  },
];

/**
 * Health rows for each gated vendor.
 *
 * All `unmonitored`. A vendor with no calls has no error rate, and a naive availability
 * calculation over zero calls is exactly the arithmetic that produces a green tick for something
 * that has never run.
 */
export const vendorProbes = (): readonly ComponentHealth[] =>
  GATED_VENDORS.map((vendor) =>
    unmonitored({
      key: `vendor_${vendor.key}`,
      label: vendor.label,
      wouldRequire: `${vendor.gate} Once gated in, health would come from call outcomes recorded by the Integration Layer (11.5). Zero calls is not zero errors, and reporting it as healthy would be a green tick for something that has never run.`,
    }),
  );

/**
 * Probe a vendor directly.
 *
 * `not_built`, and it names the gate rather than the absence. A caller asking "is Plaid up" is
 * asking a question this system is not in a position to answer, and the reason is a decision
 * somebody made rather than a feature nobody wrote.
 */
export const probeVendor = async (key: string): Promise<Outcome<never>> => {
  const vendor = GATED_VENDORS.find((entry) => entry.key === key);

  return notBuilt(
    '11.5 Integration Layer - vendor health probes',
    vendor
      ? `${vendor.label} cannot be probed: it is not gated in. ${vendor.gate}`
      : `'${key}' is not a known vendor. The gated vendors are: ${GATED_VENDORS.map((entry) => entry.key).join(', ')}.`,
  );
};
