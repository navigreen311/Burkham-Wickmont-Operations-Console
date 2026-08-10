/**
 * Personal-guarantee exposure across the whole graph - blueprint 1.2.
 *
 * The question this answers is the one the client cannot answer themselves: *what am I personally
 * on the hook for, in total?* Each guarantee was reasonable when signed. Nobody holds the sum.
 *
 * The distinction that makes the arithmetic right or wrong:
 *
 *   - a guarantee **of an entity** covers everything that entity owes, so it picks up debt signed
 *     after the guarantee was given;
 *   - a guarantee **of a named facility** covers that facility alone.
 *
 * Collapsing the two either overstates a guarantor's exposure by sweeping in unrelated debt, or
 * hides most of it by pinning an entity-wide guarantee to one line. Both produce a confident
 * number, which is worse than producing none.
 *
 * Note the relationship to `pgExposureMap` in `@bwc/capital`. That one aggregates over *observed*
 * positions from a Plaid feed; this one aggregates over *declared* relationships in the graph.
 * They answer the same question from different sources, and a disagreement between them is itself
 * a signal worth surfacing - see the note in `detect.ts`.
 */

import type { Provenance, Sourced } from '@bwc/core';
import { activeEdges, nodeName, type Graph } from './model.js';

export interface GuaranteedObligation {
  /** The debt edge, or the external facility named directly by the guarantee. */
  readonly counterparty: string;
  readonly amount: number;
  /** Which entity owes it, when the guarantee is entity-wide. */
  readonly obligorName: string | null;
  readonly viaEntityGuarantee: boolean;
  /** True when the amount is unknown - a named facility with no debt edge recorded. */
  readonly amountUnknown: boolean;
}

export interface OwnerExposure {
  readonly ownerId: string;
  readonly ownerName: string;
  /** Sum of what is known. Never presented without `obligationsWithUnknownAmount`. */
  readonly exposureAmount: Sourced<number>;
  readonly entitiesGuaranteed: number;
  readonly obligations: readonly GuaranteedObligation[];
  /**
   * Count of guaranteed obligations whose amount is not recorded. A total computed over a graph
   * with three unpriced facilities is a floor, not a figure, and the caller must be able to say so.
   */
  readonly obligationsWithUnknownAmount: number;
  /** Any guarantee with no cap. Exposure grows with draws the guarantor has not yet made. */
  readonly hasUnlimitedGuarantee: boolean;
}

/**
 * Exposure per owner, largest first.
 *
 * A guarantee limit caps the *owner's* contribution from that guarantee, not the underlying debt:
 * a $50k cap on a $200k obligation is $50k of exposure. Applied per guarantee rather than to the
 * total, because two capped guarantees are two caps.
 */
export const guaranteeExposure = (graph: Graph, provenance: Provenance): OwnerExposure[] => {
  const debts = activeEdges(graph, 'debt');
  const exposures: OwnerExposure[] = [];

  for (const owner of graph.owners) {
    const guarantees = activeEdges(graph, 'guarantee').filter(
      (edge) => edge.fromKind === 'owner' && edge.fromId === owner.id,
    );
    if (guarantees.length === 0) continue;

    const obligations: GuaranteedObligation[] = [];
    const entitiesGuaranteed = new Set<string>();
    let hasUnlimited = false;
    let total = 0;
    let unknownCount = 0;

    for (const guarantee of guarantees) {
      if (guarantee.guaranteeLimit === null) hasUnlimited = true;

      if (guarantee.toKind === 'entity' && guarantee.toId !== null) {
        // Entity-wide: everything that entity owes, including debt signed after the guarantee.
        entitiesGuaranteed.add(guarantee.toId);
        const entityDebts = debts.filter((debt) => debt.fromId === guarantee.toId);

        if (entityDebts.length === 0) {
          obligations.push({
            counterparty: 'no debt recorded for this entity',
            amount: 0,
            obligorName: nodeName(graph, 'entity', guarantee.toId),
            viaEntityGuarantee: true,
            amountUnknown: true,
          });
          unknownCount += 1;
          continue;
        }

        for (const debt of entityDebts) {
          const amount = debt.amount ?? 0;
          const contribution =
            guarantee.guaranteeLimit === null ? amount : Math.min(guarantee.guaranteeLimit, amount);
          total += contribution;
          obligations.push({
            counterparty: debt.toLabel ?? 'an external counterparty',
            amount: contribution,
            obligorName: nodeName(graph, 'entity', guarantee.toId),
            viaEntityGuarantee: true,
            amountUnknown: debt.amount === null,
          });
          if (debt.amount === null) unknownCount += 1;
        }
        continue;
      }

      // A named facility. Its amount comes from the guarantee edge itself, since there is no
      // entity whose debts we could look up.
      const amount = guarantee.amount;
      if (amount === null) {
        obligations.push({
          counterparty: guarantee.toLabel ?? 'an external counterparty',
          amount: 0,
          obligorName: null,
          viaEntityGuarantee: false,
          amountUnknown: true,
        });
        unknownCount += 1;
        continue;
      }

      const contribution =
        guarantee.guaranteeLimit === null ? amount : Math.min(guarantee.guaranteeLimit, amount);
      total += contribution;
      obligations.push({
        counterparty: guarantee.toLabel ?? 'an external counterparty',
        amount: contribution,
        obligorName: null,
        viaEntityGuarantee: false,
        amountUnknown: false,
      });
    }

    exposures.push({
      ownerId: owner.id,
      ownerName: owner.fullName,
      exposureAmount: { value: total, provenance },
      entitiesGuaranteed: entitiesGuaranteed.size,
      obligations,
      obligationsWithUnknownAmount: unknownCount,
      hasUnlimitedGuarantee: hasUnlimited,
    });
  }

  return exposures.sort((a, b) => b.exposureAmount.value - a.exposureAmount.value);
};

export interface EntityDebtSummary {
  readonly entityId: string;
  readonly entityName: string;
  readonly totalDebt: number;
  readonly facilityCount: number;
  readonly guarantorCount: number;
}

/** What each entity owes and how many people stand behind it. */
export const entityDebt = (graph: Graph): readonly EntityDebtSummary[] => {
  const debts = activeEdges(graph, 'debt');
  const guarantees = activeEdges(graph, 'guarantee');

  return graph.entities
    .map((entity) => {
      const own = debts.filter((debt) => debt.fromId === entity.id);
      const guarantors = new Set(
        guarantees
          .filter((edge) => edge.toKind === 'entity' && edge.toId === entity.id)
          .map((edge) => edge.fromId),
      );

      return {
        entityId: entity.id,
        entityName: entity.legalName,
        totalDebt: own.reduce((sum, debt) => sum + (debt.amount ?? 0), 0),
        facilityCount: own.length,
        guarantorCount: guarantors.size,
      };
    })
    .sort((a, b) => b.totalDebt - a.totalDebt);
};

/**
 * The share of guaranteed exposure resting on the single largest guarantor.
 *
 * Returns `null` rather than 0 when there is nothing guaranteed. Zero would read as "no
 * concentration", which is true in the same way that an empty room is quiet - it describes an
 * absence of data, not a good state, and the risk rating must not treat them alike.
 */
export const guarantorConcentration = (exposures: readonly OwnerExposure[]): number | null => {
  const total = exposures.reduce((sum, exposure) => sum + exposure.exposureAmount.value, 0);
  if (total === 0) return null;
  const largest = exposures[0]?.exposureAmount.value ?? 0;
  return largest / total;
};
