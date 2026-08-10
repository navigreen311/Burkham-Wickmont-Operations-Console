/**
 * Relationship detection - blueprint 1.2's "hidden-relationship detection".
 *
 * The blueprint's phrase, taken literally, invites a feature that tells an operator their client
 * concealed something. Every signal available here has an innocent explanation that is usually the
 * true one: a shared owner between two entities is a second business, a guarantee without
 * ownership is a spouse, an intercompany transfer is a management fee.
 *
 * So a `RelationshipFinding` carries **the question to put to the client** and the observation
 * that prompted it, and the type has no field in which a verdict could be recorded. Nothing here
 * concludes anything.
 *
 * The value is real and identical either way. An underwriter reviewing a file *will* find these,
 * because they run the same checks against the same public records - and the client should hear
 * the question from us, in a preparation conversation, rather than from a lender in a decline.
 */

import { CONTROLLING_OWNERSHIP_PERCENT, activeEdges, nodeName, type Graph } from './model.js';
import { findCycles } from './traverse.js';

export type FindingKind =
  | 'undeclared_common_control'
  | 'guarantee_without_ownership'
  | 'cross_guarantee_cycle'
  | 'undeclared_intercompany_transfer'
  | 'guarantor_concentration'
  | 'ownership_does_not_total';

/**
 * How much attention a finding warrants - not how likely wrongdoing is.
 *
 * `informational` covers things worth knowing; `ask_before_applying` covers things a lender will
 * raise, so the answer should exist before an application goes out. There is deliberately no
 * severity above that: a graph observation cannot warrant an accusation.
 */
export type FindingWeight = 'informational' | 'ask_before_applying';

export interface RelationshipFinding {
  readonly kind: FindingKind;
  readonly weight: FindingWeight;
  /** What was observed. Facts only. */
  readonly observation: string;
  /** What to ask the client. The whole point of the finding. */
  readonly question: string;
  /** Why a lender would care, so an operator can explain the question. */
  readonly whyItMatters: string;
  /** Node ids involved, for a UI to highlight. */
  readonly nodeIds: readonly string[];
}

/**
 * Two entities sharing a controlling owner with no edge between them.
 *
 * The most common real finding, and almost always innocent - the client simply did not think of
 * their other company as related. It is also the first thing a lender's KYC finds, because 25% is
 * the beneficial-ownership threshold their own process uses.
 */
const undeclaredCommonControl = (graph: Graph): RelationshipFinding[] => {
  const ownership = activeEdges(graph, 'ownership');
  const linked = new Set<string>();

  for (const edge of activeEdges(graph)) {
    if (edge.fromKind !== 'entity' || edge.toKind !== 'entity' || edge.toId === null) continue;
    if (edge.kind !== 'control' && edge.kind !== 'cross_guarantee') continue;
    linked.add(pairKey(edge.fromId, edge.toId));
  }

  const findings: RelationshipFinding[] = [];

  for (const owner of graph.owners) {
    const controlled = ownership
      .filter(
        (edge) =>
          edge.fromId === owner.id &&
          (edge.ownershipPercent ?? 0) >= CONTROLLING_OWNERSHIP_PERCENT &&
          edge.toId !== null,
      )
      .map((edge) => edge.toId as string);

    for (let i = 0; i < controlled.length; i += 1) {
      for (let j = i + 1; j < controlled.length; j += 1) {
        const a = controlled[i] as string;
        const b = controlled[j] as string;
        if (linked.has(pairKey(a, b))) continue;

        findings.push({
          kind: 'undeclared_common_control',
          weight: 'ask_before_applying',
          observation: `${owner.fullName} holds ${CONTROLLING_OWNERSHIP_PERCENT}% or more of both ${nodeName(graph, 'entity', a)} and ${nodeName(graph, 'entity', b)}, and no control or cross-guarantee relationship is recorded between them.`,
          question: `Are ${nodeName(graph, 'entity', a)} and ${nodeName(graph, 'entity', b)} related in any way beyond sharing ${owner.fullName} as an owner - a management agreement, a lease, shared staff, or an intercompany loan?`,
          whyItMatters:
            'Lenders apply beneficial-ownership rules at 25% and will treat both companies as affiliates whether or not they were declared as such. An affiliate found by the lender rather than disclosed by the client changes the tone of an underwriting conversation.',
          nodeIds: [owner.id, a, b],
        });
      }
    }
  }

  return findings;
};

/**
 * Someone guaranteeing an entity they do not own.
 *
 * Usually a spouse, a parent or a business partner, and entirely legitimate. It is worth surfacing
 * because it is exposure that appears in no ownership view: the guarantor is not on the cap table,
 * so nothing about the entity's structure reveals that they are on the hook.
 */
const guaranteeWithoutOwnership = (graph: Graph): RelationshipFinding[] => {
  const ownership = activeEdges(graph, 'ownership');

  return activeEdges(graph, 'guarantee')
    .filter((edge) => edge.toKind === 'entity' && edge.toId !== null)
    .filter(
      (edge) =>
        !ownership.some((owned) => owned.fromId === edge.fromId && owned.toId === edge.toId),
    )
    .map((edge) => {
      const entityName = nodeName(graph, 'entity', edge.toId);
      const ownerName = nodeName(graph, 'owner', edge.fromId);
      return {
        kind: 'guarantee_without_ownership' as const,
        weight: 'informational' as const,
        observation: `${ownerName} guarantees obligations of ${entityName} but holds no recorded ownership in it.`,
        question: `What is ${ownerName}'s relationship to ${entityName}? A guarantee without ownership is common - a spouse or a partner - and lenders ask about it.`,
        whyItMatters:
          'This exposure appears in no ownership view. It affects the guarantor personally and will not be visible to anyone reading the cap table.',
        nodeIds: [edge.fromId, edge.toId as string],
      };
    });
};

/**
 * A cross-guarantee ring.
 *
 * The finding that most changes how a capital stack should be read: a client with facilities at
 * four lenders looks diversified, and if the entities guarantee each other in a ring, a single
 * default reaches all four. The structure converts independent risks into one.
 */
const crossGuaranteeCycles = (graph: Graph): RelationshipFinding[] =>
  findCycles(graph, ['cross_guarantee']).map((cycle) => {
    const names = cycle.members.map((id) => nodeName(graph, 'entity', id));
    return {
      kind: 'cross_guarantee_cycle' as const,
      weight: 'ask_before_applying' as const,
      observation: `${names.join(' guarantees ')} guarantees ${names[0] as string} - a closed ring of ${cycle.members.length} entities.`,
      question: `Were these cross-guarantees intended to be circular? If any one of these entities defaults, every other entity in the ring is liable.`,
      whyItMatters:
        'A ring converts what looks like a diversified stack into a single point of failure. One default reaches every facility in the ring, and a lender who spots it will price the whole group as one credit.',
      nodeIds: [...cycle.members],
    };
  });

/**
 * Money moving between entities with no declared relationship.
 *
 * Almost always a management fee, a shared-services charge or an owner draw routed through the
 * wrong company. It is also the pattern an underwriter is trained to look at twice, which is
 * exactly why the client should have an answer ready.
 */
const undeclaredTransfers = (graph: Graph): RelationshipFinding[] => {
  const declared = new Set<string>();
  for (const edge of activeEdges(graph)) {
    if (edge.kind !== 'control' && edge.kind !== 'cross_guarantee') continue;
    if (edge.toId === null) continue;
    declared.add(pairKey(edge.fromId, edge.toId));
  }

  return activeEdges(graph, 'intercompany_transfer')
    .filter((edge) => edge.toId !== null && !declared.has(pairKey(edge.fromId, edge.toId)))
    .map((edge) => ({
      kind: 'undeclared_intercompany_transfer' as const,
      weight: 'ask_before_applying' as const,
      observation: `Funds moved from ${nodeName(graph, 'entity', edge.fromId)} to ${nodeName(graph, 'entity', edge.toId)}, and no control or cross-guarantee relationship is recorded between them.`,
      question: `What was the transfer between ${nodeName(graph, 'entity', edge.fromId)} and ${nodeName(graph, 'entity', edge.toId)} for - a management fee, a shared cost, or a loan? If it is a loan, are there terms in writing?`,
      whyItMatters:
        'Transfers between companies with no documented relationship are one of the first things an underwriter questions on a bank statement review, and an unprepared answer reads worse than the transfer itself.',
      nodeIds: [edge.fromId, edge.toId as string],
    }));
};

/**
 * Ownership that does not total 100%.
 *
 * A gap means an owner is missing from the graph, and a missing owner is a missing guarantor, a
 * missing KYC subject and a missing signature. Over 100% means someone was recorded twice, which
 * inflates every concentration figure computed from it.
 */
const ownershipTotals = (graph: Graph): RelationshipFinding[] => {
  const ownership = activeEdges(graph, 'ownership');

  // An entity nothing else touches is caught by `isolatedEntities` as a data-quality signal, and
  // asking "who owns this?" the instant somebody creates a record would fire on every half-entered
  // household. An entity with *debt or guarantees* and no cap table is a different thing entirely:
  // it is a real company in the household that nobody owns on file, and "who owns this company?"
  // is the first question a lender asks. Found by a test over a persisted household where exactly
  // that case produced no question at all.
  const engaged = new Set<string>();
  for (const edge of activeEdges(graph)) {
    if (edge.kind === 'ownership') continue;
    engaged.add(edge.fromId);
    if (edge.toId !== null) engaged.add(edge.toId);
  }

  return graph.entities
    .map((entity) => {
      const total = ownership
        .filter((edge) => edge.toId === entity.id)
        .reduce((sum, edge) => sum + (edge.ownershipPercent ?? 0), 0);
      return { entity, total };
    })
    .filter(
      ({ entity, total }) => (total > 0 || engaged.has(entity.id)) && Math.abs(total - 100) > 0.5,
    )
    .map(({ entity, total }) => ({
      kind: 'ownership_does_not_total' as const,
      weight: 'ask_before_applying' as const,
      observation:
        total === 0
          ? `${entity.legalName} carries obligations or relationships in this household, and no ownership is recorded for it at all.`
          : `Recorded ownership of ${entity.legalName} totals ${total.toFixed(1)}%, not 100%.`,
      question:
        total === 0
          ? `Who owns ${entity.legalName}?`
          : total < 100
            ? `Who holds the remaining ${(100 - total).toFixed(1)}% of ${entity.legalName}?`
            : `Ownership of ${entity.legalName} is recorded above 100% - has an owner been entered twice, or has a stake changed hands?`,
      whyItMatters:
        total <= 100
          ? 'A missing owner is a missing guarantor and a missing KYC subject. Lenders require a full cap table before funding.'
          : 'Every concentration figure derived from this cap table is inflated while the total is above 100%.',
      nodeIds: [entity.id],
    }));
};

/**
 * One person carrying the guarantees for the whole household.
 *
 * Not a defect - it is the normal shape of a small business - but it is the fact that decides
 * whether the household survives one bad year, and it is rarely stated out loud.
 */
const guarantorConcentrationFinding = (
  graph: Graph,
  entitiesGuaranteedThreshold: number,
): RelationshipFinding[] => {
  const guarantees = activeEdges(graph, 'guarantee');

  return graph.owners
    .map((owner) => {
      const targets = new Set(
        guarantees
          .filter((edge) => edge.fromId === owner.id && edge.toKind === 'entity')
          .map((edge) => edge.toId as string),
      );
      return { owner, count: targets.size };
    })
    .filter(({ count }) => count >= entitiesGuaranteedThreshold)
    .map(({ owner, count }) => ({
      kind: 'guarantor_concentration' as const,
      weight: 'informational' as const,
      observation: `${owner.fullName} personally guarantees obligations of ${count} entities.`,
      question: `Does ${owner.fullName} know the combined total they have guaranteed across all ${count} entities, and is any of it capped?`,
      whyItMatters:
        'Each guarantee was reasonable when signed. The total is what a lender underwrites against, and it is the number clients most often do not have.',
      nodeIds: [owner.id],
    }));
};

/** Three entities: enough that the total has stopped being obvious to the person who signed. */
export const GUARANTOR_CONCENTRATION_THRESHOLD = 3;

/**
 * Every finding, ordered so the ones needing an answer before an application come first.
 *
 * Deliberately not filtered by weight. An operator preparing a client for underwriting wants the
 * whole list; deciding which questions to ask is their judgement, not this function's.
 */
export const detectRelationships = (graph: Graph): readonly RelationshipFinding[] => {
  const findings = [
    ...crossGuaranteeCycles(graph),
    ...undeclaredCommonControl(graph),
    ...undeclaredTransfers(graph),
    ...ownershipTotals(graph),
    ...guaranteeWithoutOwnership(graph),
    ...guarantorConcentrationFinding(graph, GUARANTOR_CONCENTRATION_THRESHOLD),
  ];

  return findings.sort((a, b) => weightRank(b.weight) - weightRank(a.weight));
};

const weightRank = (weight: FindingWeight): number => (weight === 'ask_before_applying' ? 1 : 0);

/** Order-independent key for an unordered pair. */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Entities in the graph that no edge touches.
 *
 * Not a `RelationshipFinding` - there is no relationship to ask about. It is a data-quality
 * signal: an entity recorded with no ownership, no debt and no relationship is either incomplete
 * or should not be in the household at all.
 */
export const isolatedEntities = (graph: Graph): readonly string[] => {
  const touched = new Set<string>();
  for (const edge of activeEdges(graph)) {
    touched.add(edge.fromId);
    if (edge.toId !== null) touched.add(edge.toId);
  }
  return graph.entities.filter((entity) => !touched.has(entity.id)).map((entity) => entity.id);
};
