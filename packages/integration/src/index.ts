/**
 * @bwc/integration - 11.5 Integration Layer / API Gateway.
 *
 * Specification v2 section 5.8: "Direct module-to-external-service integrations are
 * prohibited. All external integrations route through Integration Layer."
 *
 * Every adapter here returns `Outcome`, which means an unbuilt or ungated integration
 * reports `not_built` rather than returning empty data that reads like a real answer.
 * That is the whole point: Specification v2 section 11.4 gates Plaid, the business bureau,
 * and the personal credit provider behind Argus security review, a signed DPA, and verified
 * SOC 2 Type II. Until each gate clears there is no credential to call with, and the honest
 * thing to report is that the capability does not exist yet.
 *
 * The failure this prevents: a stub that returns `[]` for transactions, a readiness score
 * computed from it, and a client-facing deliverable that never mentions the data was absent.
 */

import { notBuilt, type Outcome, type Provenance } from '@bwc/core';
import { activationStanding } from './activation.js';

export type IntegrationMode = 'stub' | 'sandbox' | 'live';

export const mode = (): IntegrationMode => {
  const value = process.env['INTEGRATION_MODE'] ?? 'stub';
  if (value === 'stub' || value === 'sandbox' || value === 'live') return value;
  throw new Error(`INTEGRATION_MODE must be stub | sandbox | live, received '${value}'.`);
};

export const VENDOR_IDS = ['plaid', 'business_bureau', 'personal_credit', 'capitalforge'] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export interface VendorGate {
  readonly vendor: VendorId;
  /** Argus vendor security review complete - Specification v2 section 11.4. */
  readonly argusReviewed: boolean;
  /** Data Processing Agreement signed. */
  readonly dpaSigned: boolean;
  /** SOC 2 Type II, ISO 27001, or equivalent verified. */
  readonly securityAttestationVerified: boolean;
  /** Final vendor selection made - Specification v2 section 12.3 leaves two open. */
  readonly vendorSelected: boolean;
}

/**
 * The FAIL-CLOSED FLOOR, and no longer the source of truth. ADR-0065.
 *
 * Activation used to be these booleans: editing four literals and deploying was what let client
 * bank statements and credit reports leave the firm - no actor, no evidence, no date, no record.
 * It is now derived from `VendorEvidence` rows, each carrying a required document reference
 * accepted by a Level 3 human. See `activation.ts`.
 *
 * This struct stays because three consumers outside this package read it synchronously and this
 * slice does not own them (`@bwc/intelligence`, `apps/api/src/app.ts`, and an invariants test). It
 * now answers one question only: **"activated with no evidence considered"** - which is always no.
 * Every flag is `false`, including CapitalForge's, which the old constant marked cleared on
 * nobody's authority. A sibling venture holding client financial data is still a third party
 * holding client financial data.
 *
 * A synchronous caller therefore always gets the safe answer. The disagreement between this and
 * `activationStanding` can only over-refuse, never over-permit.
 */
export const VENDOR_GATES: Readonly<Record<VendorId, VendorGate>> = {
  plaid: {
    vendor: 'plaid',
    argusReviewed: false,
    dpaSigned: false,
    securityAttestationVerified: false,
    vendorSelected: true,
  },
  business_bureau: {
    vendor: 'business_bureau',
    argusReviewed: false,
    dpaSigned: false,
    securityAttestationVerified: false,
    vendorSelected: false,
  },
  personal_credit: {
    vendor: 'personal_credit',
    argusReviewed: false,
    dpaSigned: false,
    securityAttestationVerified: false,
    vendorSelected: false,
  },
  capitalforge: {
    vendor: 'capitalforge',
    argusReviewed: false,
    dpaSigned: false,
    securityAttestationVerified: false,
    vendorSelected: false,
  },
};

export const outstandingPreconditions = (vendor: VendorId): string[] => {
  const gate = VENDOR_GATES[vendor];
  const outstanding: string[] = [];
  if (!gate.vendorSelected) outstanding.push('vendor selection');
  if (!gate.argusReviewed) outstanding.push('Argus security review');
  if (!gate.dpaSigned) outstanding.push('signed DPA');
  if (!gate.securityAttestationVerified) outstanding.push('SOC 2 Type II verification');
  return outstanding;
};

/**
 * The synchronous answer, which is always `false`.
 *
 * Kept for the three callers this slice does not own. `activationStanding` in `activation.ts` is
 * the authoritative check and the one `gatedAdapter` uses.
 */
export const isActivated = (vendor: VendorId): boolean =>
  outstandingPreconditions(vendor).length === 0;

/**
 * The shape every adapter shares. `call` never throws for an ungated vendor - it reports
 * `not_built` with the outstanding preconditions named, so the caller and the API surface
 * both say the same true thing.
 */
export interface Adapter<TRequest, TResponse> {
  readonly vendor: VendorId;
  readonly capability: string;
  call(request: TRequest): Promise<Outcome<TResponse>>;
}

export const gatedAdapter = <TRequest, TResponse>(
  vendor: VendorId,
  capability: string,
  live: (request: TRequest) => Promise<Outcome<TResponse>>,
): Adapter<TRequest, TResponse> => ({
  vendor,
  capability,
  async call(request: TRequest): Promise<Outcome<TResponse>> {
    // Read at the moment of the call, never cached at module load. ADR-0058 makes the same
    // argument about consent, and for the same reason: a withdrawn DPA has to take effect now
    // rather than at the next deploy.
    const standing = await activationStanding(vendor);
    if (!standing.activated) {
      return notBuilt(`${vendor}.${capability}`, standing.explanation);
    }
    if (mode() === 'stub') {
      return notBuilt(
        `${vendor}.${capability}`,
        'INTEGRATION_MODE is stub. No external call was made and no data was fabricated.',
      );
    }
    return live(request);
  },
});

// --- Adapters -------------------------------------------------------------
// Each declares its contract now so consumers can be written and tested against the
// interface, and each honestly reports not_built until its gate clears.

export interface PlaidTransactionsRequest {
  readonly clientId: string;
  readonly consentReference: string;
  readonly months: number;
}

export interface PlaidTransactionsResponse {
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
  readonly transactionCount: number;
  readonly provenance: Provenance;
}

/** Decision A - Plaid is the V1 bank statement source. */
export const plaidTransactions = gatedAdapter<PlaidTransactionsRequest, PlaidTransactionsResponse>(
  'plaid',
  'transactions',
  () => {
    throw new Error('unreachable: plaid gate is closed');
  },
);

export interface BureauPullRequest {
  readonly clientId: string;
  readonly consentReference: string;
}

export interface BureauPullResponse {
  readonly reportId: string;
  readonly provenance: Provenance;
}

/** Decision B - business bureau. Vendor selection still open (Nav / Experian / D&B). */
export const businessBureauPull = gatedAdapter<BureauPullRequest, BureauPullResponse>(
  'business_bureau',
  'pull',
  () => {
    throw new Error('unreachable: business bureau gate is closed');
  },
);

/** Decision B - personal credit. Vendor selection still open (Array or equivalent). */
export const personalCreditPull = gatedAdapter<BureauPullRequest, BureauPullResponse>(
  'personal_credit',
  'pull',
  () => {
    throw new Error('unreachable: personal credit gate is closed');
  },
);

export * from './activation.js';
