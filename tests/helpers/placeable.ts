/**
 * A client a placement can actually succeed for.
 *
 * Getting one takes five modules to agree, which is the point of 5.3 and the reason this lives in a
 * helper rather than in two test files:
 *
 *   5.2  an approved provider with an offering whose box the client fits
 *   6.1  the Governance Board has approved that provider, and the approval is not stale
 *   1.2  the Entity Graph knows which company is applying, and what it earns
 *   1.1  the compliance state is `pass`
 *   1.5  the client has authorised THIS application by reference
 *
 * **Shared by the transport test and the browser harness on purpose.** Two hand-built worlds drift,
 * and the one that drifts is the one nobody is looking at - so the browser would end up asserting
 * against a catalogue that no longer resembles the one the API tests use.
 */

import { addOffering, registerProvider } from '@bwc/lenders';
import { approve, submitForReview } from '@bwc/governance';
import { recordStatedRevenue, setPrimaryEntity, upsertEntity } from '@bwc/graph';
import { transitionComplianceState } from '@bwc/clients';
import { grant as grantConsent } from '@bwc/consent';
import type { EventActor, Provenance } from '@bwc/core';

/**
 * Terms taken from a published source, with a date and a person against them.
 *
 * `unresearched_default` is the other option and it is not interchangeable: an offering built on
 * one carries `containsUnverifiedInputs` into every recommendation, which is a different thing for
 * a page to render.
 */
const ISSUER: Provenance = {
  tag: 'issuer_rule',
  sourceUrl: 'https://example.test/terms',
  lastVerified: '2026-08-01T00:00:00.000Z',
  verifiedBy: 'compliance@burkhamwickmont.test',
};

export interface PlaceableInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly actor: EventActor;
  /** The reference the consent is scoped to. A placement for any other reference is refused. */
  readonly applicationRef: string;
  /** When the Board approved. Left in the past so the approval is not stale by default. */
  readonly approvedAt?: Date;
}

/** The amount and purpose this world is built to satisfy. A request outside it is refused. */
export const PLACEABLE_AMOUNT = 100_000;
export const PLACEABLE_NEED = 'working_capital' as const;
export const PLACEABLE_PROVIDER = 'Meridian National Bank';

/**
 * Build the world.
 *
 * Idempotent in the only sense that matters here: the provider is registered per call with a name
 * made unique by the caller's tenant, so two harnesses in one database do not collide.
 */
export const makePlaceable = async (input: PlaceableInput): Promise<void> => {
  const provider = await registerProvider({
    tenantId: input.tenantId,
    name: PLACEABLE_PROVIDER,
    kind: 'national_bank',
    statesServed: ['*'],
    actor: input.actor,
  });
  if (provider.status !== 'ok') throw new Error(`placeable: provider ${provider.status}`);

  const offering = await addOffering({
    tenantId: input.tenantId,
    providerId: provider.value.id,
    name: 'Business Line of Credit',
    productKind: 'line_of_credit',
    minAmount: 25_000,
    maxAmount: 250_000,
    minTimeInBusinessMonths: 24,
    minAnnualRevenue: 500_000,
    repaymentStructure: 'revolving; interest on the drawn balance',
    feeModel: 'no annual fee',
    typicalAnnualRate: 0.1149,
    provenance: ISSUER,
    actor: input.actor,
  });
  if (offering.status !== 'ok') throw new Error(`placeable: offering ${offering.status}`);

  await submitForReview({
    tenantId: input.tenantId,
    providerId: provider.value.id,
    submittedBy: 'funding-strategy',
    rationale: 'Published terms and an existing broker agreement.',
    actor: input.actor,
  });

  // **No personal credit score is required by this offering**, deliberately. The bureau vendor is
  // ungated (Decision B), so a file carries no score - and an offering that asked for one would
  // resolve to `unknown` rather than eligible, which is the three-valued eligibility working
  // correctly and a confusing thing for a fixture to hinge on.
  const approved = await approve({
    tenantId: input.tenantId,
    providerId: provider.value.id,
    approvedBy: 'compliance@burkhamwickmont.test',
    rationale: 'Terms verified; no open complaints.',
    requiredDisclosures: ['Burkham Wickmont is not a lender and does not make credit decisions.'],
    actor: input.actor,
    ...(input.approvedAt !== undefined ? { now: input.approvedAt } : {}),
  });
  if (approved.status !== 'ok') throw new Error(`placeable: approval ${approved.status}`);

  const entity = await upsertEntity({
    tenantId: input.tenantId,
    clientId: input.clientId,
    legalName: 'Placeable Operating LLC',
    role: 'operating',
    stateOfFormation: 'TX',
    // Well past the 24-month minimum, so the fixture does not expire as the calendar moves.
    formationDate: new Date('2019-02-10T00:00:00.000Z'),
    industry: 'Professional Services',
    actor: input.actor,
  });
  if (entity.status !== 'ok') throw new Error(`placeable: entity ${entity.status}`);

  await setPrimaryEntity({
    tenantId: input.tenantId,
    clientId: input.clientId,
    entityId: entity.value.id,
    actor: input.actor,
  });

  await recordStatedRevenue({
    tenantId: input.tenantId,
    clientId: input.clientId,
    entityId: entity.value.id,
    annualRevenue: 1_200_000,
    statedBy: 'A. Owner',
    statedAt: new Date('2026-07-01T00:00:00.000Z'),
    actor: input.actor,
  });

  const passed = await transitionComplianceState({
    tenantId: input.tenantId,
    clientId: input.clientId,
    to: 'pass',
    reason: 'Assessed and clear.',
    actor: input.actor,
  });
  if (passed.status !== 'ok') throw new Error(`placeable: compliance ${passed.status}`);

  // Scoped to this reference and no other. A placement quoting a different one is refused for the
  // missing authorisation, which is the check 18 USC 1014/1344 is behind.
  const consent = await grantConsent({
    tenantId: input.tenantId,
    clientId: input.clientId,
    kind: 'application',
    scope: input.applicationRef,
    actor: input.actor,
  });
  if (consent.status !== 'ok') throw new Error(`placeable: consent ${consent.status}`);
};
