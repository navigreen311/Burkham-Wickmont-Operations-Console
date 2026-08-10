/**
 * Deriving the underwriting profile 5.3 needs - blueprint 1.2 feeding blueprint 5.3.
 *
 * This is what closes the last `not_built` in the funding path. 5.3's refusal named this module
 * because the Console held a client's legal name and compliance state and nothing an underwriting
 * box could be evaluated against.
 *
 * Two disciplines carry through:
 *
 * **Derived, not stored.** Time in business comes from the formation date every time it is asked
 * for. A stored month count is wrong the day after it is written, and wrong silently.
 *
 * **What the graph cannot know is `null`, never a default.** Personal credit score needs an
 * authorized bureau pull, which is an ungated vendor; annual revenue needs Plaid or the client's
 * own statement. A zero or an optimistic guess in either field would flow straight into an
 * eligibility verdict, and 5.2's three-valued eligibility exists precisely so that `null` produces
 * "unknown - record this field" rather than a fabricated pass or a spurious rejection.
 */

import type { ClientProfile, CapitalNeed } from '@bwc/lenders';
import { noData, type Outcome, type Provenance } from '@bwc/core';
import type { EntityNode, Graph } from './model.js';

/** Where each field of a derived profile came from, so a memo can say. */
export interface ProfileSource {
  readonly field: keyof ClientProfile;
  readonly available: boolean;
  /** Present when the field has a value with a stated origin. */
  readonly provenance?: Provenance;
  /** Present when the field is null: what would have to happen to fill it. */
  readonly blockedBy?: string;
  readonly note: string;
}

export interface DerivedProfile {
  readonly profile: ClientProfile;
  readonly sources: readonly ProfileSource[];
  readonly primaryEntityName: string;
}

const MONTHS_PER_YEAR = 12;

/**
 * Whole months between a formation date and today.
 *
 * Counts a month only once the day-of-month has been reached, so an entity formed on the 20th is
 * not credited with the month on the 3rd. Lenders count the same way, and a month of overstated
 * tenure is enough to cross a 24-month underwriting threshold that the client has not actually met.
 */
export const monthsInBusiness = (formationDate: string, today: Date): number => {
  const from = new Date(formationDate);
  if (Number.isNaN(from.getTime())) return 0;

  let months =
    (today.getUTCFullYear() - from.getUTCFullYear()) * MONTHS_PER_YEAR +
    (today.getUTCMonth() - from.getUTCMonth());

  if (today.getUTCDate() < from.getUTCDate()) months -= 1;

  return Math.max(0, months);
};

/** The entity a funding application is for. */
export const primaryEntity = (graph: Graph): EntityNode | null =>
  graph.entities.find((entity) => entity.isPrimary) ?? null;

export interface DeriveInput {
  readonly graph: Graph;
  readonly need: CapitalNeed;
  readonly requestedAmount: number;
  readonly today?: Date;
}

/**
 * Build the profile.
 *
 * Returns `no_data` rather than a profile of nulls when no primary operating entity is designated.
 * A profile with every field empty would be evaluated against every underwriting box and produce a
 * list of "unknown" verdicts, which reads as a data-gathering problem when the actual problem is
 * that nobody has said which company is applying.
 */
export const deriveProfile = (input: DeriveInput): Outcome<DerivedProfile> => {
  const entity = primaryEntity(input.graph);

  if (entity === null) {
    return noData(
      `No primary entity is designated for this client, so there is no company to underwrite. ${input.graph.entities.length} entity(ies) are recorded; designate one as primary.`,
    );
  }

  const today = input.today ?? new Date();
  const sources: ProfileSource[] = [];

  const timeInBusinessMonths =
    entity.formationDate === null ? null : monthsInBusiness(entity.formationDate, today);

  sources.push(
    timeInBusinessMonths === null
      ? {
          field: 'timeInBusinessMonths',
          available: false,
          blockedBy: `No formation date on file for ${entity.legalName}.`,
          note: 'Time in business is derived from the formation date and cannot be estimated.',
        }
      : {
          field: 'timeInBusinessMonths',
          available: true,
          note: `Derived from ${entity.legalName}'s formation date of ${entity.formationDate?.slice(0, 10)}, as at ${today.toISOString().slice(0, 10)}.`,
        },
  );

  sources.push(
    entity.stateOfFormation === null
      ? {
          field: 'state',
          available: false,
          blockedBy: `No state of formation on file for ${entity.legalName}.`,
          note: 'Lender state coverage cannot be checked without it.',
        }
      : {
          field: 'state',
          available: true,
          note: `${entity.legalName} is formed in ${entity.stateOfFormation}.`,
        },
  );

  sources.push(
    entity.industry === null
      ? {
          field: 'industry',
          available: false,
          blockedBy: `No industry recorded for ${entity.legalName}.`,
          note: 'Industry exclusions cannot be checked without it.',
        }
      : { field: 'industry', available: true, note: `Recorded as ${entity.industry}.` },
  );

  // Revenue, when present, is what the client told us - its own provenance tag, because
  // presenting a self-reported figure identically to a Plaid-derived one is Decision D's failure
  // in different clothing.
  const revenueProvenance: Provenance | null =
    entity.statedAnnualRevenue !== null && entity.statedRevenueBy !== null
      ? {
          tag: 'client_stated',
          statedBy: entity.statedRevenueBy,
          statedAt: entity.statedRevenueAt ?? today.toISOString(),
          ...(entity.statedRevenueDocRef !== null
            ? { documentReference: entity.statedRevenueDocRef }
            : {}),
        }
      : null;

  sources.push(
    revenueProvenance === null
      ? {
          field: 'annualRevenue',
          available: false,
          blockedBy:
            'No revenue on file. A Plaid connection or a client statement would provide it; both require the client to act.',
          note: 'Reported as unavailable rather than estimated - an estimate here decides eligibility.',
        }
      : {
          field: 'annualRevenue',
          available: true,
          provenance: revenueProvenance,
          note: `Stated by ${entity.statedRevenueBy}${entity.statedRevenueDocRef !== null ? `, supported by ${entity.statedRevenueDocRef}` : ' and not independently verified'}.`,
        },
  );

  // The graph deliberately holds no credit score. A score requires an authorized bureau pull, and
  // the vendor is ungated pending the security review and signed DPA every V2 vendor needs.
  sources.push({
    field: 'personalCreditScore',
    available: false,
    blockedBy:
      'A personal credit score requires an authorized bureau pull. The bureau vendor is not gated in, so no score can exist on file.',
    note: 'Left null so eligibility reports it as unknown rather than assuming a passing score.',
  });

  return {
    status: 'ok',
    value: {
      profile: {
        clientId: input.graph.clientId,
        state: entity.stateOfFormation,
        timeInBusinessMonths,
        annualRevenue: entity.statedAnnualRevenue,
        personalCreditScore: null,
        industry: entity.industry,
        need: input.need,
        requestedAmount: input.requestedAmount,
      },
      sources,
      primaryEntityName: entity.legalName,
    },
  };
};

/** The fields a client or an operator would have to supply to complete the profile. */
export const unavailableFields = (derived: DerivedProfile): readonly string[] =>
  derived.sources
    .filter((source) => !source.available)
    .map((source) => source.blockedBy ?? String(source.field));
