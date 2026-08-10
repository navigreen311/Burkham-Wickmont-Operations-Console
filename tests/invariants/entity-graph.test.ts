/**
 * Invariants for the Client Household / Entity Graph - 1.2.
 *
 * Pure: every function under test operates on a `Graph` value, so this file needs no database and
 * can build household shapes that would take an operator an afternoon to enter.
 *
 * The scenario most of these run against is the blueprint's own worked example - an operating
 * company, the real-estate entity that leases it premises, and a partner's DBA, with one owner
 * quietly standing behind all three.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTROLLING_OWNERSHIP_PERCENT,
  EDGE_KINDS,
  EDGE_RULES,
  GUARANTOR_CONCENTRATION_THRESHOLD,
  RISK_BANDS,
  componentOf,
  deriveProfile,
  detectRelationships,
  entityDebt,
  findCycles,
  graphRisk,
  guaranteeExposure,
  guarantorConcentration,
  isolatedEntities,
  monthsInBusiness,
  primaryEntity,
  reachableEntities,
  validateEdge,
  type Edge,
  type EntityNode,
  type Graph,
  type OwnerNode,
} from '@bwc/graph';
import type { Provenance } from '@bwc/core';

const PROVENANCE: Provenance = {
  tag: 'client_stated',
  statedBy: 'A. Owner',
  statedAt: '2026-08-01T00:00:00.000Z',
};

const TODAY = new Date('2026-08-10T00:00:00.000Z');

let edgeSeq = 0;

const entity = (id: string, overrides: Partial<EntityNode> = {}): EntityNode => ({
  id,
  clientId: 'client-1',
  legalName: id,
  role: 'operating',
  stateOfFormation: 'TX',
  formationDate: '2022-01-15T00:00:00.000Z',
  industry: 'Professional Services',
  einLast4: '4321',
  statedAnnualRevenue: null,
  statedRevenueBy: null,
  statedRevenueAt: null,
  statedRevenueDocRef: null,
  isPrimary: false,
  ...overrides,
});

const owner = (id: string, fullName = id): OwnerNode => ({
  id,
  clientId: 'client-1',
  fullName,
  ssnLast4: '6789',
});

const edge = (partial: Partial<Edge> & Pick<Edge, 'kind' | 'fromId'>): Edge => {
  edgeSeq += 1;
  return {
    id: `edge-${edgeSeq}`,
    fromKind: 'owner',
    toKind: 'entity',
    toId: null,
    toLabel: null,
    ownershipPercent: null,
    amount: null,
    guaranteeLimit: null,
    provenanceTag: 'client_stated',
    sourceNote: null,
    endedAt: null,
    ...partial,
  };
};

const graph = (partial: Partial<Graph> = {}): Graph => ({
  clientId: 'client-1',
  entities: [],
  owners: [],
  edges: [],
  ...partial,
});

/** The blueprint's worked example: three entities, one owner behind all of them. */
const household = (): Graph =>
  graph({
    entities: [
      entity('op', { legalName: 'Meridian Services LLC', isPrimary: true }),
      entity('re', { legalName: 'Meridian Holdings LLC', role: 'real_estate' }),
      entity('dba', { legalName: 'Partner Trade Co', role: 'dba' }),
    ],
    owners: [owner('o1', 'A. Owner'), owner('o2', 'B. Partner')],
    edges: [
      edge({ kind: 'ownership', fromId: 'o1', toId: 'op', ownershipPercent: 100 }),
      edge({ kind: 'ownership', fromId: 'o1', toId: 're', ownershipPercent: 60 }),
      edge({ kind: 'ownership', fromId: 'o2', toId: 're', ownershipPercent: 40 }),
      edge({ kind: 'ownership', fromId: 'o2', toId: 'dba', ownershipPercent: 100 }),
      edge({ kind: 'guarantee', fromId: 'o1', toId: 'op' }),
      edge({ kind: 'guarantee', fromId: 'o1', toId: 're', guaranteeLimit: 50_000 }),
      edge({ kind: 'guarantee', fromId: 'o1', toId: 'dba' }),
      edge({
        kind: 'debt',
        fromKind: 'entity',
        fromId: 'op',
        toKind: 'external',
        toLabel: 'Chase Business Line',
        amount: 120_000,
      }),
      edge({
        kind: 'debt',
        fromKind: 'entity',
        fromId: 're',
        toKind: 'external',
        toLabel: 'Regional Bank Mortgage',
        amount: 400_000,
      }),
      edge({
        kind: 'debt',
        fromKind: 'entity',
        fromId: 'dba',
        toKind: 'external',
        toLabel: 'Swiftline Advance',
        amount: 60_000,
      }),
    ],
  });

describe('edge validity', () => {
  it('rejects an ownership edge pointing from an entity to an owner', () => {
    // The failure this table exists to stop: a reversed edge produces numbers rather than
    // errors, and every exposure figure derived from it means the opposite of what it says.
    const result = validateEdge({
      kind: 'ownership',
      fromKind: 'entity',
      toKind: 'owner',
      toId: 'o1',
      toLabel: null,
      ownershipPercent: 50,
    });

    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/starts at owner, not at entity/);
  });

  it('constrains every declared kind to endpoints it can actually connect', () => {
    // Iterating the table rather than restating it: a kind added without a rule would slip
    // through a hand-written list of cases.
    for (const kind of EDGE_KINDS) {
      const rule = EDGE_RULES[kind];
      expect(rule.from.length).toBeGreaterThan(0);
      expect(rule.to.length).toBeGreaterThan(0);

      const wrongFrom: 'owner' | 'entity' = rule.from.includes('owner') ? 'entity' : 'owner';
      const result = validateEdge({
        kind,
        fromKind: wrongFrom,
        toKind: rule.to[0] as 'owner' | 'entity' | 'external',
        toId: rule.to[0] === 'external' ? null : 'x',
        toLabel: rule.to[0] === 'external' ? 'Counterparty' : null,
        ownershipPercent: 50,
        amount: 1_000,
      });
      expect(result.valid, `${kind} accepted a ${wrongFrom} source`).toBe(false);
    }
  });

  it('requires an external endpoint to be named', () => {
    // There is no id to identify it by, so an unnamed external node cannot be deduplicated,
    // reported, or asked about.
    const result = validateEdge({
      kind: 'debt',
      fromKind: 'entity',
      toKind: 'external',
      toId: null,
      toLabel: '  ',
      amount: 50_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/must be named/);
  });

  it('rejects a debt edge with no amount', () => {
    const result = validateEdge({
      kind: 'debt',
      fromKind: 'entity',
      toKind: 'external',
      toId: null,
      toLabel: 'Chase',
      amount: null,
    });
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/without amount carries no information/);
  });

  it('rejects an ownership percentage outside 0 to 100', () => {
    for (const percent of [0, -5, 101]) {
      const result = validateEdge({
        kind: 'ownership',
        fromKind: 'owner',
        toKind: 'entity',
        toId: 'e1',
        toLabel: null,
        ownershipPercent: percent,
      });
      expect(result.valid, `accepted ${percent}%`).toBe(false);
    }
  });
});

describe('guarantee exposure', () => {
  it('totals what one owner is on the hook for across every entity', () => {
    // The number the client cannot produce themselves, and the one a lender asks for first.
    // 120,000 (op, uncapped) + 50,000 (re, capped at 50k of a 400k mortgage) + 60,000 (dba).
    const exposures = guaranteeExposure(household(), PROVENANCE);
    const primary = exposures.find((exposure) => exposure.ownerName === 'A. Owner');

    expect(primary?.exposureAmount.value).toBe(230_000);
    expect(primary?.entitiesGuaranteed).toBe(3);
    expect(primary?.hasUnlimitedGuarantee).toBe(true);
  });

  it('caps a limited guarantee at its limit, not at the underlying debt', () => {
    const exposures = guaranteeExposure(household(), PROVENANCE);
    const mortgage = exposures[0]?.obligations.find(
      (obligation) => obligation.counterparty === 'Regional Bank Mortgage',
    );
    // 400,000 of debt behind a 50,000 cap is 50,000 of exposure.
    expect(mortgage?.amount).toBe(50_000);
  });

  it('picks up debt an entity signed after the guarantee was given', () => {
    // The distinction that makes the arithmetic right: a guarantee OF AN ENTITY covers
    // everything that entity owes, so a new facility increases the guarantor's exposure without
    // anyone signing anything new.
    const before = guaranteeExposure(household(), PROVENANCE)[0]?.exposureAmount.value ?? 0;

    const withNewDebt = household();
    const after = guaranteeExposure(
      {
        ...withNewDebt,
        edges: [
          ...withNewDebt.edges,
          edge({
            kind: 'debt',
            fromKind: 'entity',
            fromId: 'op',
            toKind: 'external',
            toLabel: 'New Card',
            amount: 25_000,
          }),
        ],
      },
      PROVENANCE,
    )[0]?.exposureAmount.value;

    expect(after).toBe(before + 25_000);
  });

  it('does not sweep an entity-wide guarantee into a facility-specific one', () => {
    // A guarantee of one named facility covers that facility alone. Collapsing the two kinds
    // would overstate this guarantor by the whole of the entity's other debt.
    const facilityOnly = graph({
      entities: [entity('op')],
      owners: [owner('o1')],
      edges: [
        edge({
          kind: 'guarantee',
          fromId: 'o1',
          toKind: 'external',
          toLabel: 'Chase Business Line',
          amount: 120_000,
        }),
        edge({
          kind: 'debt',
          fromKind: 'entity',
          fromId: 'op',
          toKind: 'external',
          toLabel: 'Other Facility',
          amount: 900_000,
        }),
      ],
    });

    expect(guaranteeExposure(facilityOnly, PROVENANCE)[0]?.exposureAmount.value).toBe(120_000);
  });

  it('counts obligations whose amount is unknown instead of treating them as zero', () => {
    // A total computed over a graph with unpriced facilities is a floor, and the caller has to
    // be able to say so rather than presenting it as a figure.
    const partial = graph({
      entities: [entity('op')],
      owners: [owner('o1')],
      edges: [edge({ kind: 'guarantee', fromId: 'o1', toId: 'op' })],
    });

    const exposure = guaranteeExposure(partial, PROVENANCE)[0];
    expect(exposure?.obligationsWithUnknownAmount).toBe(1);
    expect(exposure?.exposureAmount.value).toBe(0);
  });

  it('ignores a released guarantee for today, though the edge is still on file', () => {
    const released = household();
    const exposures = guaranteeExposure(
      {
        ...released,
        edges: released.edges.map((candidate) =>
          candidate.kind === 'guarantee' && candidate.toId === 'op'
            ? { ...candidate, endedAt: '2026-07-01T00:00:00.000Z' }
            : candidate,
        ),
      },
      PROVENANCE,
    );

    expect(exposures[0]?.exposureAmount.value).toBe(110_000);
    expect(exposures[0]?.entitiesGuaranteed).toBe(2);
  });

  it('reports concentration as null when nothing is guaranteed', () => {
    // Zero would read as "no concentration", which is true the way an empty room is quiet.
    expect(guarantorConcentration([])).toBeNull();
  });

  it('summarises what each entity owes and how many people stand behind it', () => {
    const debts = entityDebt(household());
    expect(debts[0]?.entityName).toBe('Meridian Holdings LLC');
    expect(debts[0]?.totalDebt).toBe(400_000);
    expect(debts[0]?.guarantorCount).toBe(1);
  });
});

describe('traversal terminates on the structure it exists to find', () => {
  const ring = (): Graph =>
    graph({
      entities: [entity('a'), entity('b'), entity('c')],
      edges: [
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'a', toId: 'b' }),
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'b', toId: 'c' }),
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'c', toId: 'a' }),
      ],
    });

  it('finds a cross-guarantee ring without hanging', () => {
    // Code written assuming a tree would loop forever on precisely the input this module exists
    // to detect.
    const cycles = findCycles(ring(), ['cross_guarantee']);
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0]?.members ?? [])].sort()).toEqual(['a', 'b', 'c']);
  });

  it('reports the same ring once however many entry points it has', () => {
    // Three reports of one ring reads as three problems and gets discounted as noise.
    expect(findCycles(ring(), ['cross_guarantee'])).toHaveLength(1);
  });

  it('finds no cycle in a chain', () => {
    const chain = graph({
      entities: [entity('a'), entity('b')],
      edges: [edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'a', toId: 'b' })],
    });
    expect(findCycles(chain, ['cross_guarantee'])).toHaveLength(0);
  });

  it('walks reachability without revisiting', () => {
    expect([...reachableEntities(ring(), 'a', ['cross_guarantee'])].sort()).toEqual(['b', 'c']);
  });

  it('finds a parent from a subsidiary, ignoring edge direction', () => {
    // A subgraph that followed direction would show a holding company's subsidiaries but never,
    // from a subsidiary, its parent - and the household is the same household either way.
    const holdco = graph({
      entities: [entity('hold', { role: 'holding' }), entity('op')],
      edges: [edge({ kind: 'control', fromKind: 'entity', fromId: 'hold', toId: 'op' })],
    });
    expect(componentOf(holdco, 'op', ['control'])).toEqual(['hold']);
  });
});

describe('relationship findings are questions, not conclusions', () => {
  it('carries a question and no verdict on every finding', () => {
    // The type has no field in which a conclusion could be recorded, and this asserts the
    // instances match: every finding has something to ask.
    const findings = detectRelationships(household());
    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      expect(finding.question.length, finding.kind).toBeGreaterThan(20);
      expect(finding.whyItMatters.length, finding.kind).toBeGreaterThan(20);
      expect(finding.question).toMatch(/\?/);
      expect(Object.keys(finding)).not.toContain('verdict');
      expect(finding.weight === 'informational' || finding.weight === 'ask_before_applying').toBe(
        true,
      );
    }
  });

  it('asks about two entities sharing a controlling owner with nothing linking them', () => {
    const findings = detectRelationships(household());
    const finding = findings.find((entry) => entry.kind === 'undeclared_common_control');

    expect(finding?.observation).toMatch(/A\. Owner holds 25% or more of both/);
    expect(finding?.question).toMatch(/related in any way beyond sharing/);
  });

  it('stops asking about a pair once that pair is declared, and only that pair', () => {
    // Written expecting zero findings, which was wrong about the fixture rather than about the
    // code: B. Partner controls the real-estate entity and the DBA too, so declaring the
    // operating-to-real-estate relationship leaves a second, genuinely separate question open.
    // The stronger property is this one - answering one question must not silence another.
    const declared = household();
    const before = detectRelationships(declared).filter(
      (entry) => entry.kind === 'undeclared_common_control',
    );
    expect(before).toHaveLength(2);

    const withControl = {
      ...declared,
      edges: [
        ...declared.edges,
        edge({ kind: 'control', fromKind: 'entity', fromId: 'op', toId: 're' }),
      ],
    };

    const after = detectRelationships(withControl).filter(
      (entry) => entry.kind === 'undeclared_common_control',
    );

    expect(after).toHaveLength(1);
    expect(after[0]?.observation).toMatch(/B\. Partner/);
    expect(after.some((entry) => entry.observation.includes('A. Owner'))).toBe(false);
  });

  it('respects the beneficial-ownership threshold rather than any shared ownership', () => {
    // 25% is the FinCEN customer due-diligence line, which is the number a lender's own KYC
    // uses - so a relationship flagged here is one an underwriter would independently find.
    const minority = graph({
      entities: [entity('a'), entity('b')],
      owners: [owner('o1')],
      edges: [
        edge({ kind: 'ownership', fromId: 'o1', toId: 'a', ownershipPercent: 100 }),
        edge({
          kind: 'ownership',
          fromId: 'o1',
          toId: 'b',
          ownershipPercent: CONTROLLING_OWNERSHIP_PERCENT - 5,
        }),
      ],
    });

    expect(
      detectRelationships(minority).filter((entry) => entry.kind === 'undeclared_common_control'),
    ).toHaveLength(0);
  });

  it('asks about a guarantee given by someone with no ownership', () => {
    const findings = detectRelationships(household());
    const finding = findings.find((entry) => entry.kind === 'guarantee_without_ownership');
    // A. Owner guarantees the partner's DBA without owning any of it.
    expect(finding?.observation).toMatch(/A\. Owner guarantees obligations of Partner Trade Co/);
    expect(finding?.question).toMatch(/spouse or a partner/);
  });

  it('does not ask about ownership without a guarantee', () => {
    const ownedOnly = graph({
      entities: [entity('a')],
      owners: [owner('o1')],
      edges: [edge({ kind: 'ownership', fromId: 'o1', toId: 'a', ownershipPercent: 100 })],
    });
    expect(
      detectRelationships(ownedOnly).filter(
        (entry) => entry.kind === 'guarantee_without_ownership',
      ),
    ).toHaveLength(0);
  });

  it('explains why a ring matters in terms of what a lender does', () => {
    const ring = graph({
      entities: [entity('a'), entity('b')],
      edges: [
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'a', toId: 'b' }),
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'b', toId: 'a' }),
      ],
    });

    const finding = detectRelationships(ring).find(
      (entry) => entry.kind === 'cross_guarantee_cycle',
    );
    expect(finding?.whyItMatters).toMatch(/single point of failure/);
    expect(finding?.weight).toBe('ask_before_applying');
  });

  it('asks who holds the rest when a cap table does not total 100%', () => {
    const partial = graph({
      entities: [entity('a', { legalName: 'Partial Co' })],
      owners: [owner('o1')],
      edges: [edge({ kind: 'ownership', fromId: 'o1', toId: 'a', ownershipPercent: 70 })],
    });

    const finding = detectRelationships(partial).find(
      (entry) => entry.kind === 'ownership_does_not_total',
    );
    expect(finding?.question).toMatch(/Who holds the remaining 30\.0% of Partial Co/);
    expect(finding?.whyItMatters).toMatch(/missing guarantor/);
  });

  it('asks a different question when ownership exceeds 100%', () => {
    const doubled = graph({
      entities: [entity('a')],
      owners: [owner('o1'), owner('o2')],
      edges: [
        edge({ kind: 'ownership', fromId: 'o1', toId: 'a', ownershipPercent: 100 }),
        edge({ kind: 'ownership', fromId: 'o2', toId: 'a', ownershipPercent: 30 }),
      ],
    });

    const finding = detectRelationships(doubled).find(
      (entry) => entry.kind === 'ownership_does_not_total',
    );
    expect(finding?.question).toMatch(/entered twice/);
  });

  it('notes a guarantor carrying several entities', () => {
    const finding = detectRelationships(household()).find(
      (entry) => entry.kind === 'guarantor_concentration',
    );
    expect(GUARANTOR_CONCENTRATION_THRESHOLD).toBe(3);
    expect(finding?.observation).toMatch(/guarantees obligations of 3 entities/);
  });

  it('orders the ones needing an answer before an application first', () => {
    const findings = detectRelationships(household());
    const firstInformational = findings.findIndex((entry) => entry.weight === 'informational');
    const lastBlocking = findings.map((entry) => entry.weight).lastIndexOf('ask_before_applying');
    expect(firstInformational).toBeGreaterThan(lastBlocking);
  });

  it('reports an entity no edge touches as a data-quality signal, not a finding', () => {
    // There is no relationship to ask about, so it is not a RelationshipFinding.
    const orphan = graph({ entities: [entity('a'), entity('lonely')], edges: [] });
    expect(isolatedEntities(orphan)).toEqual(['a', 'lonely']);
  });
});

describe('graph risk is categorical and takes the worst component', () => {
  it('does not average a ring away', () => {
    // Averaging is what lets three tidy components dilute a cross-guarantee ring into
    // "elevated", and the ring is precisely the thing somebody needs to see.
    const ring = graph({
      entities: [entity('a'), entity('b')],
      owners: [owner('o1')],
      edges: [
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'a', toId: 'b' }),
        edge({ kind: 'cross_guarantee', fromKind: 'entity', fromId: 'b', toId: 'a' }),
      ],
    });

    const risk = graphRisk(ring, guaranteeExposure(ring, PROVENANCE), detectRelationships(ring));
    expect(risk.band).toBe('high');
    expect(risk.leadingConcern).toMatch(/ring/);
  });

  it('carries a component for every dimension, each with a rationale', () => {
    const g = household();
    const risk = graphRisk(g, guaranteeExposure(g, PROVENANCE), detectRelationships(g));

    expect(risk.components).toHaveLength(4);
    for (const component of risk.components) {
      expect(component.rationale.length).toBeGreaterThan(20);
      expect(RISK_BANDS).toContain(component.band);
    }
  });

  it('exposes no numeric score anywhere', () => {
    // The deliberate departure from 5.1's health score: there is no measured quantity under a
    // structural rating, so a number would be arithmetic performed on judgements.
    const g = household();
    const risk = graphRisk(g, guaranteeExposure(g, PROVENANCE), detectRelationships(g));
    const serialized = JSON.stringify(risk);
    expect(Object.keys(risk)).not.toContain('score');
    expect(serialized).not.toMatch(/"score"/);
  });

  it('does not rate an empty structure as safe', () => {
    // A household with entities and no relationships scores well on every other dimension for
    // the same reason an empty room is quiet.
    const bare = graph({ entities: [entity('a')], owners: [], edges: [] });
    const risk = graphRisk(bare, [], detectRelationships(bare));

    const completeness = risk.components.find((c) => c.name === 'graph_completeness');
    expect(completeness?.band).toBe('elevated');
    expect(completeness?.rationale).toMatch(/empty structure rather than a safe one/);
  });

  it('treats a sole owner-operator as the ordinary shape it is', () => {
    // Concentration alone is not risk. Flagging it would flag every sole proprietor.
    const solo = graph({
      entities: [entity('a')],
      owners: [owner('o1')],
      edges: [
        edge({ kind: 'ownership', fromId: 'o1', toId: 'a', ownershipPercent: 100 }),
        edge({ kind: 'guarantee', fromId: 'o1', toId: 'a', guaranteeLimit: 100_000 }),
        edge({
          kind: 'debt',
          fromKind: 'entity',
          fromId: 'a',
          toKind: 'external',
          toLabel: 'Chase',
          amount: 50_000,
        }),
      ],
    });

    const risk = graphRisk(solo, guaranteeExposure(solo, PROVENANCE), detectRelationships(solo));
    const concentration = risk.components.find((c) => c.name === 'guarantor_concentration');
    expect(concentration?.band).toBe('low');
    expect(concentration?.rationale).toMatch(/ordinary shape of an owner-operated business/);
  });

  it('flags an uncapped guarantee separately from concentration', () => {
    const g = household();
    const risk = graphRisk(g, guaranteeExposure(g, PROVENANCE), detectRelationships(g));
    const unlimited = risk.components.find((c) => c.name === 'unlimited_exposure');
    expect(unlimited?.rationale).toMatch(/grows with draws they have not yet made/);
  });
});

describe('profile derivation', () => {
  it('derives whole months from the formation date, counting the way a lender does', () => {
    // An entity formed on the 20th is not credited with the month on the 3rd. A month of
    // overstated tenure is enough to cross a 24-month underwriting threshold the client has
    // not actually met.
    expect(monthsInBusiness('2024-08-20T00:00:00.000Z', new Date('2026-08-03T00:00:00.000Z'))).toBe(
      23,
    );
    expect(monthsInBusiness('2024-08-20T00:00:00.000Z', new Date('2026-08-20T00:00:00.000Z'))).toBe(
      24,
    );
  });

  it('never reports a negative tenure for a future formation date', () => {
    expect(monthsInBusiness('2027-01-01T00:00:00.000Z', TODAY)).toBe(0);
  });

  it('reports no_data when nobody has said which company is applying', () => {
    // A profile of nulls would be evaluated against every underwriting box and produce a list
    // of "unknown" verdicts, reading as a data-gathering problem when the actual problem is
    // that no applicant was designated.
    const undesignated = graph({ entities: [entity('a'), entity('b')] });
    const result = deriveProfile({
      graph: undesignated,
      need: 'working_capital',
      requestedAmount: 100_000,
      today: TODAY,
    });

    expect(result.status).toBe('no_data');
    if (result.status === 'no_data') expect(result.reason).toMatch(/designate one as primary/);
  });

  it('fills what the graph knows and leaves the rest null with a reason', () => {
    const result = deriveProfile({
      graph: household(),
      need: 'working_capital',
      requestedAmount: 100_000,
      today: TODAY,
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.value.primaryEntityName).toBe('Meridian Services LLC');
    expect(result.value.profile.state).toBe('TX');
    expect(result.value.profile.timeInBusinessMonths).toBe(54);
    expect(result.value.profile.industry).toBe('Professional Services');

    // Left null on purpose: a score needs an authorized bureau pull, and that vendor is ungated.
    expect(result.value.profile.personalCreditScore).toBeNull();
    const score = result.value.sources.find((s) => s.field === 'personalCreditScore');
    expect(score?.available).toBe(false);
    expect(score?.blockedBy).toMatch(/authorized bureau pull/);
  });

  it('labels a client-stated revenue as stated, not measured', () => {
    // Decision D in a different costume: a self-reported figure presented identically to a
    // Plaid-derived one is the failure the provenance discipline exists to prevent.
    const stated = household();
    const result = deriveProfile({
      graph: {
        ...stated,
        entities: stated.entities.map((candidate) =>
          candidate.id === 'op'
            ? {
                ...candidate,
                statedAnnualRevenue: 1_400_000,
                statedRevenueBy: 'A. Owner',
                statedRevenueAt: '2026-07-01T00:00:00.000Z',
              }
            : candidate,
        ),
      },
      need: 'working_capital',
      requestedAmount: 100_000,
      today: TODAY,
    });

    if (result.status !== 'ok') throw new Error('expected a derived profile');
    expect(result.value.profile.annualRevenue).toBe(1_400_000);

    const revenue = result.value.sources.find((s) => s.field === 'annualRevenue');
    expect(revenue?.provenance?.tag).toBe('client_stated');
    expect(revenue?.note).toMatch(/not independently verified/);
  });

  it('finds the designated primary entity', () => {
    expect(primaryEntity(household())?.legalName).toBe('Meridian Services LLC');
    expect(primaryEntity(graph({ entities: [entity('a')] }))).toBeNull();
  });
});
