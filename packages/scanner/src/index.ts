/**
 * @bwc/scanner - 4.2 Communication Compliance Scanner.
 *
 * "Scans every outbound message before send; blocks banned language ... flags requires-disclaimer
 * content; escalates novel language for Compliance Review Board review" - blueprint 4.2.
 *
 * This is a **blocking** control, not an advisory one. A scanner that warns is a scanner whose
 * warnings get dismissed under deadline, and the thing it is protecting against - a client
 * receiving "guaranteed approval" in writing - is not recoverable once sent.
 *
 * Matching is on word boundaries, never substrings. That distinction is the whole difficulty of
 * this module: "guaranteed approval" must block, while "no guarantee of approval is expressed or
 * implied" - which contains neither phrase intact but is close enough to trip a naive matcher -
 * must pass. A scanner with false positives gets routed around, and then it protects nothing.
 */

import { activeLibrary, type MarketingClaim } from '@bwc/claims';
import { append } from '@bwc/ledger';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';

export type ScanVerdict = 'clean' | 'requires_disclosure' | 'blocked';

export interface ScanFinding {
  readonly phrase: string;
  readonly disposition: 'banned' | 'requires_disclaimer';
  readonly rationale: string;
  /** Where in the scanned text, so a reviewer can find it rather than hunt for it. */
  readonly offset: number;
  readonly excerpt: string;
  readonly requiredDisclosure?: string;
}

export interface ScanResult {
  readonly verdict: ScanVerdict;
  readonly findings: readonly ScanFinding[];
  /** Disclosures the content must carry before it may be sent. */
  readonly requiredDisclosures: readonly string[];
  readonly scannedCharacters: number;
  readonly libraryEntriesChecked: number;
}

/**
 * Escape a phrase for use in a regex, then bind it at word boundaries.
 *
 * `\b` on each end is what separates "guaranteed approval" from "no guarantee of approval": the
 * latter contains "guarantee" but never the bounded phrase. Whitespace inside a phrase is matched
 * flexibly (`\s+`) so a line break between the words does not defeat the check - the most obvious
 * accidental bypass, and one that would look like a passing scan.
 */
const phrasePattern = (phrase: string): RegExp => {
  const escaped = phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
};

const excerptAround = (text: string, offset: number, length: number): string => {
  const start = Math.max(0, offset - 30);
  const end = Math.min(text.length, offset + length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
};

/**
 * Scan text against a supplied library.
 *
 * Pure and synchronous, so it is testable without a database and callable from anywhere in a
 * request path. `scanForTenant` below is the version that loads the library.
 */
export const scanText = (text: string, library: readonly MarketingClaim[]): ScanResult => {
  const findings: ScanFinding[] = [];
  const requiredDisclosures = new Set<string>();

  for (const claim of library) {
    if (claim.disposition === 'approved') continue;

    const pattern = phrasePattern(claim.phrase);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      findings.push({
        phrase: claim.phrase,
        disposition: claim.disposition,
        rationale: claim.rationale,
        offset: match.index,
        excerpt: excerptAround(text, match.index, match[0].length),
        ...(claim.requiredDisclosure !== null
          ? { requiredDisclosure: claim.requiredDisclosure }
          : {}),
      });

      if (claim.disposition === 'requires_disclaimer' && claim.requiredDisclosure !== null) {
        requiredDisclosures.add(claim.requiredDisclosure);
      }

      // Zero-length matches cannot occur with bounded phrases, but a malformed library entry
      // should not spin the loop forever.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  const blocked = findings.some((finding) => finding.disposition === 'banned');

  return {
    verdict: blocked ? 'blocked' : findings.length > 0 ? 'requires_disclosure' : 'clean',
    findings,
    requiredDisclosures: [...requiredDisclosures],
    scannedCharacters: text.length,
    libraryEntriesChecked: library.length,
  };
};

export interface ScanInput {
  readonly tenantId: string;
  readonly text: string;
  readonly actor: EventActor;
  readonly clientId?: string;
  readonly jurisdiction?: string;
  /** What is being scanned, for the ledger record. */
  readonly context: string;
}

/**
 * Scan for a tenant, loading the active Marketing Claim Library.
 *
 * A block writes a ledger event. Blueprint 4.2 feeds scan history back into the Claim Library and
 * the Compliance Review Board reviews it weekly - which requires the blocks to have been recorded,
 * not merely to have happened.
 *
 * Refuses outright when the library is empty. An empty library scans clean, and "clean" from a
 * scanner that checked nothing is the most dangerous possible result: it looks like a pass. This
 * is the same distinction `verifyIntegrity` draws by reporting how many entries it checked.
 */
export const scanForTenant = async (input: ScanInput): Promise<Outcome<ScanResult>> => {
  const library = await activeLibrary({
    tenantId: input.tenantId,
    ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
  });

  if (library.length === 0) {
    return refused(
      'The Marketing Claim Library is empty for this tenant, so a scan would report clean without having checked anything. Seed the library before sending client-facing content.',
      'Principle 9 - a check that examined nothing must not report a pass',
    );
  }

  const result = scanText(input.text, library);

  if (result.verdict === 'blocked') {
    await append({
      tenantId: input.tenantId,
      type: 'scanner.blocked_content',
      actor: input.actor,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      payload: {
        context: input.context,
        // Phrases and rationales only. The offending text is client content and does not belong
        // in an append-only store retained indefinitely.
        blockedPhrases: result.findings
          .filter((finding) => finding.disposition === 'banned')
          .map((finding) => finding.phrase),
        libraryEntriesChecked: result.libraryEntriesChecked,
      },
    });
  }

  return ok(result);
};

/**
 * Record language a human judged novel enough for Compliance Review Board attention.
 *
 * Blueprint 4.2 escalates "novel language" for review. The Scanner cannot detect novelty on its
 * own - that is a judgement about whether a claim is new, not whether a string appears - so this
 * is the seam a reviewer uses, rather than a heuristic pretending to make the judgement.
 */
export const escalateNovelLanguage = async (
  tenantId: string,
  phrase: string,
  reason: string,
  actor: EventActor,
): Promise<void> => {
  await append({
    tenantId,
    type: 'scanner.novel_language',
    actor,
    payload: { phrase, reason },
  });
};
