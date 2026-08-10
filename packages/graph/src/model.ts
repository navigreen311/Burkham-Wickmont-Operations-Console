/**
 * The Graph value, and the table saying which edges may connect what.
 *
 * A single edge type with a `kind` discriminant is flexible enough to be dangerous: nothing in
 * the shape stops an `ownership` edge pointing from an entity to an owner, which reverses the
 * meaning of every exposure calculation downstream and produces numbers rather than errors.
 *
 * `EDGE_RULES` is the recovered type safety. It is data rather than a chain of conditionals so
 * that a test can iterate it, and so that adding a kind is one entry rather than an edit in five
 * places that someone will make in four.
 */

export type EntityRole = 'operating' | 'holding' | 'real_estate' | 'dba' | 'trust' | 'other';

export const ENTITY_ROLES = [
  'operating',
  'holding',
  'real_estate',
  'dba',
  'trust',
  'other',
] as const satisfies readonly EntityRole[];

export type NodeKind = 'owner' | 'entity' | 'external';

export type EdgeKind =
  'ownership' | 'control' | 'guarantee' | 'cross_guarantee' | 'debt' | 'intercompany_transfer';

export const EDGE_KINDS = [
  'ownership',
  'control',
  'guarantee',
  'cross_guarantee',
  'debt',
  'intercompany_transfer',
] as const satisfies readonly EdgeKind[];

export interface EntityNode {
  readonly id: string;
  readonly clientId: string;
  readonly legalName: string;
  readonly role: EntityRole;
  readonly stateOfFormation: string | null;
  readonly formationDate: string | null;
  readonly industry: string | null;
  /** Display only. The EIN itself never leaves the store. */
  readonly einLast4: string | null;
  readonly statedAnnualRevenue: number | null;
  readonly statedRevenueBy: string | null;
  readonly statedRevenueAt: string | null;
  readonly statedRevenueDocRef: string | null;
  readonly isPrimary: boolean;
}

export interface OwnerNode {
  readonly id: string;
  readonly clientId: string;
  readonly fullName: string;
  /** Display only. */
  readonly ssnLast4: string | null;
}

export interface Edge {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly fromKind: NodeKind;
  readonly fromId: string;
  readonly toKind: NodeKind;
  readonly toId: string | null;
  readonly toLabel: string | null;
  readonly ownershipPercent: number | null;
  readonly amount: number | null;
  /** Null means unlimited - a different condition from a very large cap. */
  readonly guaranteeLimit: number | null;
  readonly provenanceTag: string;
  readonly sourceNote: string | null;
  readonly endedAt: string | null;
}

export interface Graph {
  readonly clientId: string;
  readonly entities: readonly EntityNode[];
  readonly owners: readonly OwnerNode[];
  readonly edges: readonly Edge[];
}

export interface EdgeRule {
  readonly from: readonly NodeKind[];
  readonly to: readonly NodeKind[];
  /** Fields without which the edge means nothing. */
  readonly requires: readonly ('ownershipPercent' | 'amount' | 'toLabel')[];
}

/**
 * Which endpoints each kind may connect, and what it must carry to be meaningful.
 *
 * `guarantee` accepts both an entity and an external target, and the difference matters: a
 * guarantee **of an entity** covers everything that entity owes, while a guarantee **of a named
 * facility** covers only that one. Collapsing them would either overstate a guarantor's exposure
 * or hide most of it, depending which way it collapsed.
 */
export const EDGE_RULES: Readonly<Record<EdgeKind, EdgeRule>> = {
  ownership: { from: ['owner'], to: ['entity'], requires: ['ownershipPercent'] },
  control: { from: ['entity'], to: ['entity'], requires: [] },
  guarantee: { from: ['owner'], to: ['entity', 'external'], requires: [] },
  cross_guarantee: { from: ['entity'], to: ['entity'], requires: [] },
  debt: { from: ['entity'], to: ['external'], requires: ['amount', 'toLabel'] },
  intercompany_transfer: { from: ['entity'], to: ['entity'], requires: ['amount'] },
};

export interface EdgeValidation {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/** Validate an edge against the rules. Called on every write; `store.ts` refuses on failure. */
export const validateEdge = (edge: {
  kind: EdgeKind;
  fromKind: NodeKind;
  toKind: NodeKind;
  toId: string | null;
  toLabel: string | null;
  ownershipPercent?: number | null;
  amount?: number | null;
}): EdgeValidation => {
  const rule = EDGE_RULES[edge.kind];
  const reasons: string[] = [];

  if (!rule.from.includes(edge.fromKind)) {
    reasons.push(
      `A ${edge.kind} edge starts at ${rule.from.join(' or ')}, not at ${edge.fromKind}.`,
    );
  }
  if (!rule.to.includes(edge.toKind)) {
    reasons.push(`A ${edge.kind} edge ends at ${rule.to.join(' or ')}, not at ${edge.toKind}.`);
  }

  // An external endpoint is named rather than linked, so the name is the only thing making it
  // identifiable at all - an unnamed external node cannot be deduplicated, reported or asked about.
  if (edge.toKind === 'external' && (edge.toLabel === null || edge.toLabel.trim() === '')) {
    reasons.push('An external endpoint must be named; there is no id to identify it by.');
  }
  if (edge.toKind !== 'external' && edge.toId === null) {
    reasons.push(`A ${edge.toKind} endpoint needs an id.`);
  }

  for (const field of rule.requires) {
    if (field === 'toLabel') continue; // covered above
    const value = field === 'ownershipPercent' ? edge.ownershipPercent : edge.amount;
    if (value === undefined || value === null) {
      reasons.push(`A ${edge.kind} edge without ${field} carries no information.`);
    }
  }

  if (
    edge.ownershipPercent !== undefined &&
    edge.ownershipPercent !== null &&
    (edge.ownershipPercent <= 0 || edge.ownershipPercent > 100)
  ) {
    reasons.push('Ownership percentage must be above 0 and at most 100.');
  }

  return { valid: reasons.length === 0, reasons };
};

/** Edges still in force. A released guarantee still explains the exposure it once created. */
export const activeEdges = (graph: Graph, kind?: EdgeKind): readonly Edge[] =>
  graph.edges.filter((edge) => edge.endedAt === null && (kind === undefined || edge.kind === kind));

export const entityById = (graph: Graph, id: string): EntityNode | undefined =>
  graph.entities.find((entity) => entity.id === id);

export const ownerById = (graph: Graph, id: string): OwnerNode | undefined =>
  graph.owners.find((owner) => owner.id === id);

/** A readable name for either node kind, for use in findings and rationales. */
export const nodeName = (graph: Graph, kind: NodeKind, id: string | null): string => {
  if (kind === 'external' || id === null) return 'an external counterparty';
  return entityById(graph, id)?.legalName ?? ownerById(graph, id)?.fullName ?? 'an unrecorded node';
};

/**
 * The threshold at which an owner is treated as controlling an entity.
 *
 * 25% is the beneficial-ownership line under the FinCEN customer due-diligence rule, which is
 * also the number lenders' own KYC processes use. Picking the same threshold means a relationship
 * this module flags is one an underwriter would independently find, which is the point.
 */
export const CONTROLLING_OWNERSHIP_PERCENT = 25;
