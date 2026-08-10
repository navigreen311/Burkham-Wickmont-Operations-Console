/**
 * Two real templates, plus the builders they share.
 *
 * Blueprint 3.1 calls for "15+ required templates". The template *system* is what this slice
 * builds; these two exercise every part of it that matters — provenance-carrying figures,
 * categorical compliance state, disclosures — and the remaining dozen are authoring work rather
 * than engineering. Shipping thirteen stubs would make the count look complete while the content
 * was invented, which is the failure mode principle 9 exists to prevent.
 */

import { sourced, type ComplianceState, type Provenance } from '@bwc/core';
import type { Block, DeliverableDocument, KeyFigure, Section } from './content.js';

export const paragraph = (text: string): Block => ({ kind: 'paragraph', text });

export const disclosure = (text: string): Block => ({ kind: 'disclosure', text });

/** A figure and where it came from. There is no overload that omits provenance. */
export const figure = (
  label: string,
  value: string,
  provenance: Provenance,
  note?: string,
): KeyFigure =>
  note === undefined
    ? { label, value: sourced(value, provenance) }
    : { label, value: sourced(value, provenance), note };

export const figures = (items: readonly KeyFigure[]): Block => ({
  kind: 'key_figures',
  figures: items,
});

export const complianceState = (
  state: ComplianceState,
  findings: readonly { code: string; summary: string }[] = [],
): Block => ({ kind: 'compliance_state', state, findings });

export const section = (heading: string, blocks: readonly Block[]): Section => ({
  heading,
  blocks,
});

/** Standing disclosures. Principle 1 - nothing may recharacterize what the company is. */
export const NOT_A_LENDER_DISCLOSURE =
  'Burkham Wickmont is not a lender, investment adviser, or credit repair organization. We do not make credit decisions and cannot promise any outcome.';

export const NO_GUARANTEE_DISCLOSURE =
  'Nothing in this document is an offer or commitment of credit. Approval decisions rest solely with the applicable provider.';

// --- Template: Capital Command Brief (monthly, Stack Management tier) ------

export const CAPITAL_COMMAND_BRIEF = {
  key: 'capital-command-brief',
  version: 1,
  title: 'Capital Command Brief',
  description: 'Monthly capital position, utilisation, and upcoming obligations.',
  requiresHumanReview: true,
} as const;

export interface CapitalCommandBriefInput {
  readonly clientLegalName: string;
  readonly preparedOn: string;
  readonly complianceState: ComplianceState;
  readonly findings?: readonly { code: string; summary: string }[];
  readonly positionFigures: readonly KeyFigure[];
  readonly narrative: string;
}

export const buildCapitalCommandBrief = (input: CapitalCommandBriefInput): DeliverableDocument => ({
  templateKey: CAPITAL_COMMAND_BRIEF.key,
  templateVersion: CAPITAL_COMMAND_BRIEF.version,
  title: CAPITAL_COMMAND_BRIEF.title,
  clientLegalName: input.clientLegalName,
  preparedOn: input.preparedOn,
  sections: [
    section('Position this month', [paragraph(input.narrative), figures(input.positionFigures)]),
    section('Compliance status', [complianceState(input.complianceState, input.findings ?? [])]),
    section('Important information', [
      disclosure(NOT_A_LENDER_DISCLOSURE),
      disclosure(NO_GUARANTEE_DISCLOSURE),
    ]),
  ],
});

// --- Template: Funding Suitability Memo -----------------------------------

export const FUNDING_SUITABILITY_MEMO = {
  key: 'funding-suitability-memo',
  version: 1,
  title: 'Funding Suitability Memo',
  description: 'Product and provider suitability assessment for a specific capital need.',
  requiresHumanReview: true,
} as const;

export interface FundingSuitabilityMemoInput {
  readonly clientLegalName: string;
  readonly preparedOn: string;
  readonly complianceState: ComplianceState;
  readonly findings?: readonly { code: string; summary: string }[];
  readonly assessment: string;
  /** Each figure carries provenance; unresearched defaults are labelled in the output. */
  readonly productFigures: readonly KeyFigure[];
  readonly alternativesConsidered: readonly (readonly string[])[];
}

export const buildFundingSuitabilityMemo = (
  input: FundingSuitabilityMemoInput,
): DeliverableDocument => ({
  templateKey: FUNDING_SUITABILITY_MEMO.key,
  templateVersion: FUNDING_SUITABILITY_MEMO.version,
  title: FUNDING_SUITABILITY_MEMO.title,
  clientLegalName: input.clientLegalName,
  preparedOn: input.preparedOn,
  sections: [
    section('Assessment', [paragraph(input.assessment)]),
    section('Product terms considered', [figures(input.productFigures)]),
    section('Alternatives considered', [
      {
        kind: 'table',
        columns: ['Provider', 'Product', 'Why not selected'],
        rows: input.alternativesConsidered,
      },
    ]),
    section('Compliance status', [complianceState(input.complianceState, input.findings ?? [])]),
    section('Important information', [
      disclosure(NOT_A_LENDER_DISCLOSURE),
      disclosure(NO_GUARANTEE_DISCLOSURE),
    ]),
  ],
});

/** Every template shipped in this slice, for registration. */
export const SHIPPED_TEMPLATES = [CAPITAL_COMMAND_BRIEF, FUNDING_SUITABILITY_MEMO] as const;
