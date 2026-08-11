/**
 * The provider catalogue and its rules - blueprint 5.2.
 *
 * Two write paths matter here and both are about provenance.
 *
 * `recordRule` takes a `Provenance` value rather than loose columns, so a caller cannot
 * write a rule without saying where it came from - the type has no shape that omits it.
 * Decision D calls this "provenance tags on every rule"; the guarantee is worth nothing if
 * it depends on the caller remembering.
 *
 * And rules supersede rather than overwrite. A rule that was current in March has to remain
 * explicable when it justifies a March recommendation, and the specification requires every
 * rule change logged with its source and verification method. An UPDATE would satisfy
 * neither.
 */

import { db, Prisma } from '@bwc/db';
import { append } from '@bwc/ledger';
import {
  isUnverified,
  noData,
  ok,
  refused,
  sourced,
  type EventActor,
  type Outcome,
  type Provenance,
  type Sourced,
} from '@bwc/core';
import { fromProvenance, toProvenance, NATIONWIDE } from './profile.js';
import type { ProductKind } from './suitability.js';
import { isWithinV1CreditUnionScope } from './research.js';

export type ProviderKind =
  | 'card_issuer'
  | 'national_bank'
  | 'fintech_loc'
  | 'credit_union'
  | 'mca_provider'
  | 'factor'
  | 'equipment_lessor'
  | 'sba_lender';

export interface ProviderRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly statesServed: readonly string[];
  readonly brokerRulesSummary: string | null;
  readonly disclosureRequirements: readonly string[];
  readonly knownRisks: readonly string[];
  readonly renewalBehavior: string | null;
  readonly active: boolean;
}

interface ProviderRow {
  id: string;
  tenantId: string;
  name: string;
  kind: string;
  statesServed: string[];
  brokerRulesSummary: string | null;
  disclosureRequirements: string[];
  knownRisks: string[];
  renewalBehavior: string | null;
  active: boolean;
}

const toProvider = (row: ProviderRow): ProviderRecord => ({
  id: row.id,
  tenantId: row.tenantId,
  name: row.name,
  kind: row.kind as ProviderKind,
  statesServed: row.statesServed,
  brokerRulesSummary: row.brokerRulesSummary,
  disclosureRequirements: row.disclosureRequirements,
  knownRisks: row.knownRisks,
  renewalBehavior: row.renewalBehavior,
  active: row.active,
});

export interface RegisterProviderInput {
  readonly tenantId: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly statesServed?: readonly string[];
  readonly brokerRulesSummary?: string;
  readonly disclosureRequirements?: readonly string[];
  readonly knownRisks?: readonly string[];
  readonly renewalBehavior?: string;
  readonly actor: EventActor;
}

/**
 * Add or update a provider profile.
 *
 * Registration is deliberately permissive about Decision D: knowing PenFed's rules is the
 * V1.5 research work, and refusing to record what we learned would make the database worse
 * at its stated job of being a "defensible long-term asset". The restriction bites at
 * approval instead - see the governance package - because that is the step that decides
 * whether an agent may recommend the provider, and it is the only step that needs to.
 */
export const registerProvider = async (
  input: RegisterProviderInput,
): Promise<Outcome<ProviderRecord>> => {
  const statesServed = [...(input.statesServed ?? [NATIONWIDE])];
  if (statesServed.length === 0) {
    return refused(
      `Provider '${input.name}' was registered with an empty state list. Use the '${NATIONWIDE}' sentinel for nationwide; an empty array is indistinguishable from an unfilled field.`,
      'Blueprint 5.2 - states served is part of the provider profile, not an optional annotation',
    );
  }

  const row = await db().provider.upsert({
    where: { tenantId_name: { tenantId: input.tenantId, name: input.name } },
    create: {
      tenantId: input.tenantId,
      name: input.name,
      kind: input.kind as never,
      statesServed,
      brokerRulesSummary: input.brokerRulesSummary ?? null,
      disclosureRequirements: [...(input.disclosureRequirements ?? [])],
      knownRisks: [...(input.knownRisks ?? [])],
      renewalBehavior: input.renewalBehavior ?? null,
    },
    update: {
      kind: input.kind as never,
      statesServed,
      brokerRulesSummary: input.brokerRulesSummary ?? null,
      disclosureRequirements: [...(input.disclosureRequirements ?? [])],
      knownRisks: [...(input.knownRisks ?? [])],
      renewalBehavior: input.renewalBehavior ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.provider.registered',
    actor: input.actor,
    payload: {
      providerId: row.id,
      name: input.name,
      kind: input.kind,
      withinV1CreditUnionScope: isWithinV1CreditUnionScope(input.kind, input.name),
    },
  });

  return ok(toProvider(row));
};

export const findProvider = async (
  tenantId: string,
  name: string,
): Promise<ProviderRecord | null> => {
  const row = await db().provider.findFirst({ where: { tenantId, name } });
  return row ? toProvider(row) : null;
};

export const listProviders = async (
  tenantId: string,
  filter?: { kind?: ProviderKind; state?: string },
): Promise<readonly ProviderRecord[]> => {
  const rows = await db().provider.findMany({
    where: {
      tenantId,
      active: true,
      ...(filter?.kind !== undefined ? { kind: filter.kind as never } : {}),
      // A provider serving `*` serves every state, so state filtering has to admit both.
      ...(filter?.state !== undefined
        ? { statesServed: { hasSome: [filter.state, NATIONWIDE] } }
        : {}),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toProvider);
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface LenderRuleRecord {
  readonly id: string;
  readonly providerId: string;
  readonly ruleKey: string;
  readonly value: Sourced<string>;
  readonly version: number;
  readonly supersededAt: string | null;
}

export interface RecordRuleInput {
  readonly tenantId: string;
  readonly providerId: string;
  readonly ruleKey: string;
  readonly ruleValue: string;
  /**
   * Required, and required as a whole value rather than as loose columns. There is no
   * overload without it - Decision D, made structural.
   */
  readonly provenance: Provenance;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Write a rule, superseding any current version of the same key.
 *
 * The supersede and the insert run in one transaction. Split, a crash between them leaves
 * either two current versions of a velocity rule - and a reader with no way to know which
 * governs - or none at all, which silently removes a researched constraint from every
 * subsequent recommendation.
 */
export const recordRule = async (input: RecordRuleInput): Promise<Outcome<LenderRuleRecord>> => {
  if (input.ruleValue.trim() === '') {
    return refused(
      `Rule '${input.ruleKey}' was written with an empty value.`,
      'Blueprint 5.2 - a rule with no content cannot be applied or argued with',
    );
  }

  const stored = fromProvenance(input.provenance);
  const now = input.now ?? new Date();

  const row = await db().$transaction(async (tx) => {
    const current = await tx.lenderRule.findFirst({
      where: { providerId: input.providerId, ruleKey: input.ruleKey, supersededAt: null },
      orderBy: [{ version: 'desc' }, { id: 'asc' }],
    });

    if (current) {
      await tx.lenderRule.update({ where: { id: current.id }, data: { supersededAt: now } });
    }

    return tx.lenderRule.create({
      data: {
        tenantId: input.tenantId,
        providerId: input.providerId,
        ruleKey: input.ruleKey,
        ruleValue: input.ruleValue,
        version: (current?.version ?? 0) + 1,
        provenanceTag: stored.provenanceTag as never,
        sourceUrl: stored.sourceUrl,
        lastVerified: stored.lastVerified,
        verifiedBy: stored.verifiedBy,
        rationale: stored.rationale,
        vendor: stored.vendor ?? null,
        retrievedAt: stored.retrievedAt ?? null,
      },
    });
  });

  // Specification: "every rule change in Lender Intelligence Database logged with source,
  // verification method, lastVerified timestamp." The ledger entry is that log.
  await append({
    tenantId: input.tenantId,
    type: 'lender.rule.recorded',
    actor: input.actor,
    payload: {
      providerId: input.providerId,
      ruleKey: input.ruleKey,
      version: row.version,
      provenanceTag: input.provenance.tag,
      unverified: isUnverified(input.provenance),
    },
  });

  return ok(toRule(row));
};

interface RuleRow {
  id: string;
  providerId: string;
  ruleKey: string;
  ruleValue: string;
  version: number;
  supersededAt: Date | null;
  provenanceTag: string;
  sourceUrl: string | null;
  lastVerified: Date | null;
  verifiedBy: string | null;
  rationale: string | null;
  vendor: string | null;
  retrievedAt: Date | null;
}

const toRule = (row: RuleRow): LenderRuleRecord => ({
  id: row.id,
  providerId: row.providerId,
  ruleKey: row.ruleKey,
  value: sourced(
    row.ruleValue,
    toProvenance({
      provenanceTag: row.provenanceTag as 'issuer_rule' | 'unresearched_default' | 'vendor_feed',
      sourceUrl: row.sourceUrl,
      lastVerified: row.lastVerified,
      verifiedBy: row.verifiedBy,
      rationale: row.rationale,
      vendor: row.vendor,
      retrievedAt: row.retrievedAt,
    }),
  ),
  version: row.version,
  supersededAt: row.supersededAt?.toISOString() ?? null,
});

/** The rules in force now. */
export const currentRules = async (
  tenantId: string,
  providerId: string,
): Promise<readonly LenderRuleRecord[]> => {
  const rows = await db().lenderRule.findMany({
    where: { tenantId, providerId, supersededAt: null },
    orderBy: [{ ruleKey: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toRule);
};

/** Every version of one rule, newest first - the audit view. */
export const ruleHistory = async (
  tenantId: string,
  providerId: string,
  ruleKey: string,
): Promise<readonly LenderRuleRecord[]> => {
  const rows = await db().lenderRule.findMany({
    where: { tenantId, providerId, ruleKey },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toRule);
};

/**
 * Every rule in the tenant currently resting on an assumption.
 *
 * The query a compliance officer runs before a review, and the reason provenance is stored
 * as a column rather than inside a JSON blob: "what are we telling clients that nobody has
 * verified" has to be answerable in one statement.
 */
export const unresearchedRules = async (tenantId: string): Promise<readonly LenderRuleRecord[]> => {
  const rows = await db().lenderRule.findMany({
    where: { tenantId, supersededAt: null, provenanceTag: 'unresearched_default' },
    orderBy: [{ providerId: 'asc' }, { ruleKey: 'asc' }],
  });
  return rows.map(toRule);
};

// ---------------------------------------------------------------------------
// Product offerings
// ---------------------------------------------------------------------------

export interface OfferingRecord {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly productKind: ProductKind;
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly minTimeInBusinessMonths: number | null;
  readonly minAnnualRevenue: number | null;
  readonly minPersonalCreditScore: number | null;
  readonly excludedIndustries: readonly string[];
  readonly repaymentStructure: string;
  readonly feeModel: string;
  readonly typicalAnnualRate: number | null;
  readonly typicalFactorRate: number | null;
  readonly provenance: Provenance;
  readonly active: boolean;
}

export interface AddOfferingInput {
  readonly tenantId: string;
  readonly providerId: string;
  readonly name: string;
  readonly productKind: ProductKind;
  readonly minAmount: number;
  readonly maxAmount: number;
  readonly minTimeInBusinessMonths?: number;
  readonly minAnnualRevenue?: number;
  readonly minPersonalCreditScore?: number;
  readonly excludedIndustries?: readonly string[];
  readonly repaymentStructure: string;
  readonly feeModel: string;
  readonly typicalAnnualRate?: number;
  readonly typicalFactorRate?: number;
  readonly provenance: Provenance;
  readonly actor: EventActor;
}

const decimal = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

export const addOffering = async (input: AddOfferingInput): Promise<Outcome<OfferingRecord>> => {
  if (input.minAmount > input.maxAmount) {
    return refused(
      `Offering '${input.name}' has a minimum of ${input.minAmount} above its maximum of ${input.maxAmount}.`,
      'Blueprint 5.2 - an underwriting box that excludes every amount cannot be evaluated',
    );
  }
  // A factor rate is not a rate. Carrying both would make 5.6 pick one, and whichever it
  // picked would be wrong for some caller - the exact confusion the Cost of Capital
  // Calculator exists to remove.
  if (input.typicalAnnualRate !== undefined && input.typicalFactorRate !== undefined) {
    return refused(
      `Offering '${input.name}' was given both an annual rate and a factor rate. A factor rate is not a rate; one product cannot be quoted as both.`,
      'Blueprint 5.6 - factor rate and APR are separately named because the two are routinely confused',
    );
  }

  const stored = fromProvenance(input.provenance);

  const row = await db().productOffering.upsert({
    where: { providerId_name: { providerId: input.providerId, name: input.name } },
    create: {
      tenantId: input.tenantId,
      providerId: input.providerId,
      name: input.name,
      productKind: input.productKind as never,
      minAmount: decimal(input.minAmount),
      maxAmount: decimal(input.maxAmount),
      minTimeInBusinessMonths: input.minTimeInBusinessMonths ?? null,
      minAnnualRevenue:
        input.minAnnualRevenue !== undefined ? decimal(input.minAnnualRevenue) : null,
      minPersonalCreditScore: input.minPersonalCreditScore ?? null,
      excludedIndustries: [...(input.excludedIndustries ?? [])],
      repaymentStructure: input.repaymentStructure,
      feeModel: input.feeModel,
      typicalAnnualRate:
        input.typicalAnnualRate !== undefined ? decimal(input.typicalAnnualRate) : null,
      typicalFactorRate:
        input.typicalFactorRate !== undefined ? decimal(input.typicalFactorRate) : null,
      provenanceTag: stored.provenanceTag as never,
      sourceUrl: stored.sourceUrl,
      lastVerified: stored.lastVerified,
      verifiedBy: stored.verifiedBy,
      rationale: stored.rationale,
    },
    update: {
      productKind: input.productKind as never,
      minAmount: decimal(input.minAmount),
      maxAmount: decimal(input.maxAmount),
      minTimeInBusinessMonths: input.minTimeInBusinessMonths ?? null,
      minAnnualRevenue:
        input.minAnnualRevenue !== undefined ? decimal(input.minAnnualRevenue) : null,
      minPersonalCreditScore: input.minPersonalCreditScore ?? null,
      excludedIndustries: [...(input.excludedIndustries ?? [])],
      repaymentStructure: input.repaymentStructure,
      feeModel: input.feeModel,
      typicalAnnualRate:
        input.typicalAnnualRate !== undefined ? decimal(input.typicalAnnualRate) : null,
      typicalFactorRate:
        input.typicalFactorRate !== undefined ? decimal(input.typicalFactorRate) : null,
      provenanceTag: stored.provenanceTag as never,
      sourceUrl: stored.sourceUrl,
      lastVerified: stored.lastVerified,
      verifiedBy: stored.verifiedBy,
      rationale: stored.rationale,
      active: true,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'lender.offering.recorded',
    actor: input.actor,
    payload: {
      providerId: input.providerId,
      offeringId: row.id,
      name: input.name,
      productKind: input.productKind,
      provenanceTag: input.provenance.tag,
    },
  });

  return ok(toOffering(row));
};

interface OfferingRow {
  id: string;
  providerId: string;
  name: string;
  productKind: string;
  minAmount: Prisma.Decimal;
  maxAmount: Prisma.Decimal;
  minTimeInBusinessMonths: number | null;
  minAnnualRevenue: Prisma.Decimal | null;
  minPersonalCreditScore: number | null;
  excludedIndustries: string[];
  repaymentStructure: string;
  feeModel: string;
  typicalAnnualRate: Prisma.Decimal | null;
  typicalFactorRate: Prisma.Decimal | null;
  provenanceTag: string;
  sourceUrl: string | null;
  lastVerified: Date | null;
  verifiedBy: string | null;
  rationale: string | null;
  active: boolean;
}

const toOffering = (row: OfferingRow): OfferingRecord => ({
  id: row.id,
  providerId: row.providerId,
  name: row.name,
  productKind: row.productKind as ProductKind,
  minAmount: row.minAmount.toNumber(),
  maxAmount: row.maxAmount.toNumber(),
  minTimeInBusinessMonths: row.minTimeInBusinessMonths,
  minAnnualRevenue: row.minAnnualRevenue?.toNumber() ?? null,
  minPersonalCreditScore: row.minPersonalCreditScore,
  excludedIndustries: row.excludedIndustries,
  repaymentStructure: row.repaymentStructure,
  feeModel: row.feeModel,
  typicalAnnualRate: row.typicalAnnualRate?.toNumber() ?? null,
  typicalFactorRate: row.typicalFactorRate?.toNumber() ?? null,
  provenance: toProvenance({
    provenanceTag: row.provenanceTag as 'issuer_rule' | 'unresearched_default' | 'vendor_feed',
    sourceUrl: row.sourceUrl,
    lastVerified: row.lastVerified,
    verifiedBy: row.verifiedBy,
    rationale: row.rationale,
  }),
  active: row.active,
});

/** Active offerings for a provider. */
export const offeringsOf = async (
  tenantId: string,
  providerId: string,
): Promise<readonly OfferingRecord[]> => {
  const rows = await db().productOffering.findMany({
    where: { tenantId, providerId, active: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toOffering);
};

export interface CatalogueEntry {
  readonly provider: ProviderRecord;
  readonly offering: OfferingRecord;
}

/**
 * Every active offering in the tenant, with its provider.
 *
 * Returns an array rather than an `Outcome`: the caller is 5.3, which has richer things to
 * say about an empty catalogue than this function does, and wrapping here would make it
 * unwrap and rewrap to say them. Nothing about an empty list is ambiguous - there are no
 * offerings.
 */
export const catalogue = async (tenantId: string): Promise<readonly CatalogueEntry[]> => {
  const rows = await db().productOffering.findMany({
    where: { tenantId, active: true, provider: { active: true } },
    include: { provider: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => ({
    provider: toProvider(row.provider),
    offering: toOffering(row),
  }));
};

export const providerById = async (
  tenantId: string,
  providerId: string,
): Promise<Outcome<ProviderRecord>> => {
  const row = await db().provider.findFirst({ where: { tenantId, id: providerId } });
  return row ? ok(toProvider(row)) : noData(`No provider ${providerId} in this tenant.`);
};
