/**
 * The deliverable content model - blueprint 3.1.
 *
 * A deliverable is evidence. Blueprint 7.1 builds regulator-ready files from it, and 3.1 requires
 * every deliverable "version-controlled and audit-logged; signed and dated". So the artifact of
 * record is this **structured document**, not the rendered PDF: bytes change when a font is
 * substituted or a library is upgraded, and the evidence must not.
 *
 * Two v2 requirements shape the types rather than the renderer:
 *
 *   - **Decision D / principle 8** - a figure derived from a lender rule or a vendor feed must
 *     ship how it was derived, and an `unresearched_default` must be *labelled as such in
 *     client-facing output*. `KeyFigure` therefore holds `Sourced<T>`; there is no way to add a
 *     figure without provenance, so the renderer cannot omit what was never optional.
 *   - **Decision E** - compliance state is a category with findings. `ComplianceStateBlock` has no
 *     numeric field, so no renderer can emit a score even by accident.
 */

import { describeProvenance, isUnverified, type ComplianceState, type Sourced } from '@bwc/core';

export interface Paragraph {
  readonly kind: 'paragraph';
  readonly text: string;
}

/**
 * A labelled figure that carries its own provenance.
 *
 * `Sourced<T>` is the point. A caller cannot construct one of these from a bare number, which
 * makes "we forgot to attach provenance" unrepresentable rather than merely discouraged.
 */
export interface KeyFigure {
  readonly label: string;
  readonly value: Sourced<string>;
  readonly note?: string;
}

export interface KeyFigures {
  readonly kind: 'key_figures';
  readonly figures: readonly KeyFigure[];
}

/** Decision E. Category plus findings; deliberately no numeric field. */
export interface ComplianceStateBlock {
  readonly kind: 'compliance_state';
  readonly state: ComplianceState;
  readonly findings: readonly { readonly code: string; readonly summary: string }[];
}

export interface Disclosure {
  readonly kind: 'disclosure';
  readonly text: string;
}

export interface Table {
  readonly kind: 'table';
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type Block = Paragraph | KeyFigures | ComplianceStateBlock | Disclosure | Table;

export interface Section {
  readonly heading: string;
  readonly blocks: readonly Block[];
}

export interface DeliverableDocument {
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly title: string;
  readonly clientLegalName: string;
  /** ISO date only. A deliverable is "signed and dated" (3.1), not timestamped to the second. */
  readonly preparedOn: string;
  readonly sections: readonly Section[];
}

/** Human-readable label for a compliance state. Never a number, never a percentage. */
export const COMPLIANCE_STATE_LABELS: Record<ComplianceState, string> = {
  pending_assessment: 'Pending Assessment',
  pass: 'Pass',
  pass_with_findings: 'Pass with Findings',
  needs_review: 'Needs Review',
  fail: 'Fail',
};

/**
 * The label attached to any figure resting on an unresearched default.
 *
 * Exported and asserted on in tests, so the wording cannot drift silently into something a client
 * would skim past. Decision D requires this to be visible in client-facing output, which means it
 * is content, not styling.
 */
export const UNVERIFIED_LABEL = 'Unverified assumption';

export interface RenderedFigure {
  readonly label: string;
  readonly value: string;
  readonly provenance: string;
  readonly unverified: boolean;
}

/**
 * Flatten a figure for rendering. Every renderer goes through this, so provenance surfacing is
 * implemented once rather than per output format - two renderers that each decide how to show
 * provenance will eventually disagree, and the client-facing one is the one that matters.
 */
export const renderFigure = (figure: KeyFigure): RenderedFigure => ({
  label: figure.label,
  value: figure.value.value,
  provenance: describeProvenance(figure.value.provenance),
  unverified: isUnverified(figure.value.provenance),
});

/** Does this document rest on any unresearched default? Drives the document-level notice. */
export const containsUnverifiedFigures = (document: DeliverableDocument): boolean =>
  document.sections.some((section) =>
    section.blocks.some(
      (block) =>
        block.kind === 'key_figures' &&
        block.figures.some((figure) => isUnverified(figure.value.provenance)),
    ),
  );

/**
 * Every piece of prose a client would read, concatenated.
 *
 * This is what the Compliance Scanner scans. Scanning the *content model* rather than the rendered
 * output means banned language cannot slip in through a rendering step, and scanning it rather
 * than the template means a phrase interpolated from client data is checked too.
 *
 * Provenance descriptions are included: "Unresearched default - not verified against the issuer"
 * is text a client reads, and text a client reads is text the Scanner checks.
 */
export const scannableText = (document: DeliverableDocument): string => {
  const parts: string[] = [document.title];

  for (const section of document.sections) {
    parts.push(section.heading);
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'paragraph':
          parts.push(block.text);
          break;
        case 'key_figures':
          for (const figure of block.figures) {
            const rendered = renderFigure(figure);
            parts.push(rendered.label, rendered.value, rendered.provenance);
            if (figure.note !== undefined) parts.push(figure.note);
          }
          break;
        case 'compliance_state':
          parts.push(COMPLIANCE_STATE_LABELS[block.state]);
          for (const finding of block.findings) parts.push(finding.code, finding.summary);
          break;
        case 'disclosure':
          parts.push(block.text);
          break;
        case 'table':
          parts.push(...block.columns);
          for (const row of block.rows) parts.push(...row);
          break;
      }
    }
  }

  return parts.join('\n');
};

/**
 * Deterministic JSON for hashing: object keys sorted at every depth.
 *
 * Same discipline as the Event Ledger signature, and for the same reason - key order is an
 * implementation detail, and a hash that depends on it changes for no visible cause.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};
