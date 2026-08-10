/**
 * Graph-level Risk Rating - blueprint 1.2.
 *
 * **Categorical, with no number at all**, and this deliberately does not follow the precedent set
 * by the Capital Stack Health Score (5.1).
 *
 * The difference is what sits underneath. A health score summarises measured quantities: balances,
 * rates, days remaining. Every input is a real number and the weighted total means something. A
 * graph risk rating summarises *structural* facts - whether guarantees concentrate on one person,
 * whether cross-guarantees close into a ring, whether the cap table adds up. There is no
 * measurement underneath, so a number would be arithmetic performed on judgements and would read
 * as far more precise than the thing it describes.
 *
 * Bands and components. The consistency preserved is with Decision E's reasoning rather than with
 * 5.1's shape.
 */

import { activeEdges, type Graph } from './model.js';
import { guarantorConcentration, type OwnerExposure } from './exposure.js';
import { isolatedEntities, type RelationshipFinding } from './detect.js';

export type RiskBand = 'low' | 'elevated' | 'high' | 'severe';

/** Ordered weakest to strongest, so a band can be compared without exporting a number. */
export const RISK_BANDS = [
  'low',
  'elevated',
  'high',
  'severe',
] as const satisfies readonly RiskBand[];

export type RiskComponentName =
  'guarantor_concentration' | 'structural_contagion' | 'graph_completeness' | 'unlimited_exposure';

export interface RiskComponent {
  readonly name: RiskComponentName;
  readonly band: RiskBand;
  /** What produced this band, in a sentence an operator can act on. */
  readonly rationale: string;
}

export interface GraphRisk {
  readonly band: RiskBand;
  readonly components: readonly RiskComponent[];
  /** The single most consequential thing to address, or null when the band is low. */
  readonly leadingConcern: string | null;
}

const rank = (band: RiskBand): number => RISK_BANDS.indexOf(band);

const worst = (bands: readonly RiskBand[]): RiskBand =>
  bands.reduce((highest, band) => (rank(band) > rank(highest) ? band : highest), 'low');

/**
 * Concentration of guaranteed exposure on one person.
 *
 * Concentration alone is not risk - a single-owner business *should* have one guarantor, and
 * reporting that as elevated would flag every sole proprietor in the portfolio. What raises the
 * band is concentration **across multiple entities**: one person holding the guarantees for a
 * household of companies is the case where one bad year reaches everything.
 */
const concentrationComponent = (exposures: readonly OwnerExposure[]): RiskComponent => {
  const share = guarantorConcentration(exposures);

  if (share === null) {
    return {
      name: 'guarantor_concentration',
      band: 'low',
      rationale: 'No guaranteed exposure is recorded in the graph.',
    };
  }

  const largest = exposures[0];
  const entities = largest?.entitiesGuaranteed ?? 0;

  const band: RiskBand =
    share > 0.9 && entities >= 3
      ? 'high'
      : share > 0.9 && entities >= 2
        ? 'elevated'
        : share > 0.6 && entities >= 3
          ? 'elevated'
          : 'low';

  return {
    name: 'guarantor_concentration',
    band,
    rationale:
      entities <= 1
        ? `${largest?.ownerName ?? 'One guarantor'} carries the guarantees, across a single entity - the ordinary shape of an owner-operated business.`
        : `${Math.round(share * 100)}% of guaranteed exposure rests on ${largest?.ownerName ?? 'one guarantor'}, across ${entities} entities.`,
  };
};

/**
 * Whether the structure spreads a single default.
 *
 * A cross-guarantee ring is the sharpest form: it makes four lenders into one credit. Cross-
 * guarantees that do not close into a ring still spread risk, but they spread it in a direction
 * somebody chose.
 */
const contagionComponent = (
  graph: Graph,
  findings: readonly RelationshipFinding[],
): RiskComponent => {
  const cycles = findings.filter((finding) => finding.kind === 'cross_guarantee_cycle');
  const crossGuarantees = activeEdges(graph, 'cross_guarantee').length;

  if (cycles.length > 0) {
    return {
      name: 'structural_contagion',
      band: cycles.length > 1 ? 'severe' : 'high',
      rationale: `${cycles.length} cross-guarantee ring(s) present: a default at any member reaches every other member, so facilities that look independent are one credit.`,
    };
  }

  return {
    name: 'structural_contagion',
    band: crossGuarantees >= 3 ? 'elevated' : 'low',
    rationale:
      crossGuarantees === 0
        ? 'No cross-guarantees between entities.'
        : `${crossGuarantees} cross-guarantee(s) between entities, none forming a ring.`,
  };
};

/**
 * Whether the graph is complete enough for the rest of the rating to mean anything.
 *
 * This is the component that stops a thin graph reading as a safe one. A household with one entity
 * and no edges recorded scores well on every other dimension for the same reason an empty room is
 * quiet, and an operator seeing `low` would reasonably conclude the structure had been reviewed.
 */
const completenessComponent = (
  graph: Graph,
  findings: readonly RelationshipFinding[],
): RiskComponent => {
  const gaps = findings.filter(
    (finding) =>
      finding.kind === 'ownership_does_not_total' ||
      finding.kind === 'undeclared_common_control' ||
      finding.kind === 'undeclared_intercompany_transfer',
  );
  const isolated = isolatedEntities(graph).length;

  if (graph.entities.length > 0 && activeEdges(graph).length === 0) {
    return {
      name: 'graph_completeness',
      band: 'elevated',
      rationale:
        'Entities are recorded but no relationships are. The rest of this rating describes an empty structure rather than a safe one.',
    };
  }

  const band: RiskBand =
    gaps.length >= 3 ? 'high' : gaps.length > 0 || isolated > 0 ? 'elevated' : 'low';

  return {
    name: 'graph_completeness',
    band,
    rationale:
      gaps.length === 0 && isolated === 0
        ? 'Ownership totals reconcile and every entity is connected.'
        : `${gaps.length} unanswered structural question(s)${isolated > 0 ? ` and ${isolated} entity(ies) with no recorded relationships` : ''}.`,
  };
};

/**
 * Guarantees with no cap.
 *
 * Separated from concentration because it behaves differently: an uncapped guarantee grows with
 * draws the guarantor has not yet made, so today's exposure figure is a floor rather than a total.
 */
const unlimitedComponent = (exposures: readonly OwnerExposure[]): RiskComponent => {
  const unlimited = exposures.filter((exposure) => exposure.hasUnlimitedGuarantee);
  const unknown = exposures.reduce(
    (sum, exposure) => sum + exposure.obligationsWithUnknownAmount,
    0,
  );

  if (unlimited.length === 0 && unknown === 0) {
    return {
      name: 'unlimited_exposure',
      band: 'low',
      rationale: 'Every recorded guarantee is capped and priced.',
    };
  }

  return {
    name: 'unlimited_exposure',
    band: unlimited.length > 1 ? 'high' : unlimited.length === 1 ? 'elevated' : 'elevated',
    rationale:
      unlimited.length > 0
        ? `${unlimited.length} guarantor(s) carry at least one uncapped guarantee, so their exposure grows with draws they have not yet made.`
        : `${unknown} guaranteed obligation(s) have no recorded amount, so the exposure total is a floor rather than a figure.`,
  };
};

/**
 * The rating.
 *
 * The overall band is the **worst** component, not an average. Averaging is what lets a cross-
 * guarantee ring be diluted by three tidy components into "elevated", and the ring is precisely
 * the thing somebody needs to see.
 */
export const graphRisk = (
  graph: Graph,
  exposures: readonly OwnerExposure[],
  findings: readonly RelationshipFinding[],
): GraphRisk => {
  const components: RiskComponent[] = [
    concentrationComponent(exposures),
    contagionComponent(graph, findings),
    completenessComponent(graph, findings),
    unlimitedComponent(exposures),
  ];

  const band = worst(components.map((component) => component.band));
  const leading = components
    .filter((component) => component.band === band)
    .sort((a, b) => rank(b.band) - rank(a.band))[0];

  return {
    band,
    components,
    leadingConcern: band === 'low' ? null : (leading?.rationale ?? null),
  };
};
