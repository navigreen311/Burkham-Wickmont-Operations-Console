/**
 * Document classification and missing-document detection - blueprint 3.3, "automatic
 * classification; missing document detection".
 *
 * Detection over what the Secure Document Vault actually holds. The useful output is not "here is
 * what you have" but "here is what this phase needs and you do not have", because the second is
 * what stalls a Phase 0 intake and the first is already visible.
 */

import { forClient, type DocumentKind } from '@bwc/vault';
import type { Finding } from './analyze.js';

/**
 * What each phase requires before it can proceed.
 *
 * Deliberately short. A requirement list that demands everything gets ignored wholesale, and the
 * point of this is to name the specific thing blocking progress.
 */
export const PHASE_REQUIREMENTS: Readonly<Record<number, readonly DocumentKind[]>> = {
  0: ['bank_statement', 'entity_document', 'government_id'],
  1: ['bank_statement', 'entity_document', 'government_id', 'profit_and_loss', 'debt_schedule'],
  2: ['bank_statement', 'debt_schedule'],
};

/** Filename hints, used only when an uploader did not classify. Never overrides a stated kind. */
const FILENAME_HINTS: readonly { readonly pattern: RegExp; readonly kind: DocumentKind }[] = [
  { pattern: /\b(bank|stmt|statement|checking|savings)\b/i, kind: 'bank_statement' },
  // IRS form numbers carry a letter suffix in practice - 1120S, 1065B, 1040EZ - and `\b1120\b`
  // fails on every one of them, because the boundary needs a non-word character after the 0.
  {
    pattern: /\b(1120|1065|1040)[a-z]{0,2}\b|\b(schedule\s*c|tax\s*return)\b/i,
    kind: 'tax_return',
  },
  { pattern: /\b(driver|licen[cs]e|passport|id\s*card)\b/i, kind: 'government_id' },
  {
    pattern: /\b(articles|operating\s*agreement|formation|ein\s*letter)\b/i,
    kind: 'entity_document',
  },
  { pattern: /\b(p&l|profit|income\s*statement)\b/i, kind: 'profit_and_loss' },
  { pattern: /\b(balance\s*sheet)\b/i, kind: 'balance_sheet' },
  { pattern: /\b(debt\s*schedule|liabilit)\b/i, kind: 'debt_schedule' },
  { pattern: /\b(credit\s*report|bureau)\b/i, kind: 'credit_report' },
];

/**
 * Guess a kind from a filename.
 *
 * Returns null rather than `other` when nothing matches, so a caller can tell "we could not
 * classify this" from "we classified this as miscellaneous". Those are different states, and
 * conflating them is how an unclassified tax return ends up filed as `other`.
 */
export const classifyByFilename = (filename: string): DocumentKind | null =>
  FILENAME_HINTS.find((hint) => hint.pattern.test(filename))?.kind ?? null;

export interface DocumentCoverage {
  readonly phase: number;
  readonly required: readonly DocumentKind[];
  readonly present: readonly DocumentKind[];
  readonly missing: readonly DocumentKind[];
  readonly complete: boolean;
}

export const assessCoverage = async (
  tenantId: string,
  clientId: string,
  phase: number,
): Promise<DocumentCoverage> => {
  const required = PHASE_REQUIREMENTS[phase] ?? [];
  const documents = await forClient(tenantId, clientId);
  const held = new Set(documents.map((document) => document.kind));

  const present = required.filter((kind) => held.has(kind));
  const missing = required.filter((kind) => !held.has(kind));

  return { phase, required, present, missing, complete: missing.length === 0 };
};

/**
 * One finding per missing document.
 *
 * One each rather than a single combined finding, because each is independently actionable: a
 * client can supply a debt schedule while a government ID is still outstanding, and a combined
 * finding would stay open until the last one arrived.
 */
export const missingDocumentFindings = (coverage: DocumentCoverage): Finding[] =>
  coverage.missing.map((kind) => ({
    kind: 'missing_document' as const,
    severity: 'attention' as const,
    summary: `Phase ${coverage.phase} requires a ${kind.replace(/_/g, ' ')}, which is not in the vault.`,
    detail: {
      value: {
        phase: coverage.phase,
        documentKind: kind,
        requiredForPhase: coverage.required,
        stillMissing: coverage.missing,
      },
      provenance: {
        tag: 'unresearched_default' as const,
        rationale:
          'Derived from the phase requirement list and the documents currently in the vault, not from a vendor feed.',
      },
    },
  }));
