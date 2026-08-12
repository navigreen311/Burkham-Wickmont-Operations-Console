/**
 * The templates the Phase 0-2 playbooks produce, and the function that registers them.
 *
 * **A scaffold for the people who sign these documents, not approved wording.** Everything here is
 * a draft of what a Burkham Wickmont deliverable says; the standing disclosures are the only part
 * that comes from the specification rather than from an inference about how this firm writes.
 *
 * ## What is here and what is deliberately not
 *
 * `templates.ts` already ships the Capital Command Brief and the Funding Suitability Memo, and its
 * header explains the restraint this file inherits:
 *
 * > Blueprint 3.1 calls for "15+ required templates" ... Shipping thirteen stubs would make the
 * > count look complete while the content was invented, which is the failure mode principle 9
 * > exists to prevent.
 *
 * So this adds **one** template: the Readiness Blueprint, which Phase 0 produces and which nothing
 * in the repository could draft before. The other two the playbooks name already exist. The count is
 * still three of fifteen-plus, and the remaining dozen are authoring work for a person who knows
 * what this firm says - not something to generate to make a number look right.
 *
 * ## Why the builder is here rather than in `templates.ts`
 *
 * `templates.ts` holds the two templates that came with the template *system* and exercise every
 * part of it. This file holds what the playbook seed needs, so the two additions this slice makes -
 * a document and the registration of it - are one file a reviewer can read end to end. If a later
 * slice adds templates for their own sake rather than for a playbook, `templates.ts` is where they
 * belong.
 *
 * **Nothing here runs on import.** `seedV1DeliverableTemplates` is an exported function.
 *
 * @see docs/adr/0068-one-template-because-the-playbook-produces-one.md
 */

import type { ComplianceState } from '@bwc/core';
// `KeyFigure` is the deliverables content model's, not core's: a figure here is a label plus a
// `Sourced` value, and core owns only the provenance half of that.
import type { DeliverableDocument, KeyFigure } from './content.js';
import { registerTemplate, type TemplateInput } from './approval.js';
import {
  CAPITAL_COMMAND_BRIEF,
  FUNDING_SUITABILITY_MEMO,
  NOT_A_LENDER_DISCLOSURE,
  NO_GUARANTEE_DISCLOSURE,
  complianceState,
  disclosure,
  figures,
  paragraph,
  section,
} from './templates.js';

// --- Template: Readiness Blueprint ----------------------------------------

/**
 * What Phase 0 delivers.
 *
 * 1.3 tracks "Readiness Blueprint status" and 5.1 ends with "Client Portal (Blueprint delivered)",
 * so the artifact is named in the blueprint even though its contents are not. The section list
 * below is therefore an **inference** from what Phase 0 computes: a readiness score with provenance
 * on each component, a compliance state, an entity picture, and the gaps that would have to close
 * before a placement could be attempted.
 *
 * `requiresHumanReview` is true, and not as a default: this document carries a categorical
 * compliance state and figures a client will plan around.
 */
export const READINESS_BLUEPRINT = {
  key: 'readiness-blueprint',
  version: 1,
  title: 'Readiness Blueprint',
  description:
    'Phase 0 assessment: funding readiness with provenance, compliance state, entity picture, and what has to close before placement.',
  requiresHumanReview: true,
} as const;

export interface ReadinessBlueprintInput {
  readonly clientLegalName: string;
  readonly preparedOn: string;
  readonly complianceState: ComplianceState;
  readonly findings?: readonly { code: string; summary: string }[];
  /** What the assessment found, in the words an operator would use with the client. */
  readonly assessment: string;
  /** Readiness components. Each carries provenance; there is no overload that omits it. */
  readonly readinessFigures: readonly KeyFigure[];
  /** The entities, owners and guarantees the graph recorded. */
  readonly entitySummary: string;
  /**
   * What has to be true before a placement is worth attempting.
   *
   * A list rather than prose, because the client is going to work through it - and an empty list is
   * rendered as a sentence saying nothing is outstanding rather than as an empty block, which
   * would read as an unfinished document.
   */
  readonly gapsToClose: readonly string[];
}

export const buildReadinessBlueprint = (input: ReadinessBlueprintInput): DeliverableDocument => ({
  templateKey: READINESS_BLUEPRINT.key,
  templateVersion: READINESS_BLUEPRINT.version,
  title: READINESS_BLUEPRINT.title,
  clientLegalName: input.clientLegalName,
  preparedOn: input.preparedOn,
  sections: [
    section('What we found', [paragraph(input.assessment)]),
    section('Funding readiness', [figures(input.readinessFigures)]),
    section('Your entities', [paragraph(input.entitySummary)]),
    section('Before a placement', [
      input.gapsToClose.length === 0
        ? paragraph('Nothing is outstanding from this assessment.')
        : {
            kind: 'table',
            columns: ['What has to close'],
            rows: input.gapsToClose.map((gap) => [gap]),
          },
    ]),
    section('Compliance status', [complianceState(input.complianceState, input.findings ?? [])]),
    section('Important information', [
      disclosure(NOT_A_LENDER_DISCLOSURE),
      disclosure(NO_GUARANTEE_DISCLOSURE),
    ]),
  ],
});

// --- The seed -------------------------------------------------------------

/**
 * Which template each seeded playbook draws on, so the two seeds can be checked against each other.
 *
 * A playbook that drafts a template nobody registered fails at the moment a person is waiting for
 * the document. An invariant test walks this map and asserts every key is registered by the
 * function below.
 */
export const TEMPLATES_BY_PLAYBOOK: Readonly<Record<string, readonly string[]>> = {
  'phase-0-capital-readiness': [READINESS_BLUEPRINT.key],
  'phase-1-placement': [FUNDING_SUITABILITY_MEMO.key],
  'phase-2-stack-management': [CAPITAL_COMMAND_BRIEF.key],
};

/** Everything the V1 playbooks can draft. */
export const V1_TEMPLATE_SEEDS: readonly TemplateInput[] = [
  READINESS_BLUEPRINT,
  FUNDING_SUITABILITY_MEMO,
  CAPITAL_COMMAND_BRIEF,
];

/**
 * Register the templates the V1 playbooks produce.
 *
 * **Idempotent by construction:** `registerTemplate` upserts on (key, version), so a second run
 * rewrites the same row with the same values. Re-registering does not bump a version, which is
 * correct - a template version is what a generated document pins itself to, and moving it because
 * somebody ran a seed twice would make every issued document look stale.
 *
 * Templates are firm-wide rather than per-tenant, which is why this takes no tenant: the row has no
 * tenant column, and the wording of a Burkham Wickmont deliverable is the firm's rather than a
 * client's.
 *
 * Returns the keys registered, so a caller can log what it did without this function deciding to.
 */
export const seedV1DeliverableTemplates = async (): Promise<readonly string[]> => {
  const registered: string[] = [];

  for (const template of V1_TEMPLATE_SEEDS) {
    await registerTemplate(template);
    registered.push(template.key);
  }

  return registered;
};
