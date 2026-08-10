/**
 * Invariants for client-facing output — Decision D (provenance visible) and Decision E
 * (compliance state categorical).
 *
 * These assert on **rendered text**, not on the content model. The model holding provenance
 * proves only that the model holds it; Decision D requires it to reach the client, and the only
 * way to know that is to render and look. Same for compliance state: the useful assertion is that
 * no number appears in the output a client reads.
 */

import { describe, expect, it } from 'vitest';
import { sourced, type Provenance } from '@bwc/core';
import {
  COMPLIANCE_STATE_LABELS,
  UNVERIFIED_LABEL,
  UNVERIFIED_NOTICE,
  buildCapitalCommandBrief,
  buildFundingSuitabilityMemo,
  canonicalJson,
  containsUnverifiedFigures,
  figure,
  figures,
  hashContent,
  pdfRenderer,
  scannableText,
  section,
  textRenderer,
  type DeliverableDocument,
} from '@bwc/deliverables';

const ISSUER_RULE: Provenance = {
  tag: 'issuer_rule',
  sourceUrl: 'https://example.invalid/terms',
  lastVerified: '2026-08-01',
  verifiedBy: 'funding_strategy',
};

const UNRESEARCHED: Provenance = {
  tag: 'unresearched_default',
  rationale: 'assumed from product family; not verified against the issuer',
};

const VENDOR_FEED: Provenance = {
  tag: 'vendor_feed',
  vendor: 'plaid',
  retrievedAt: '2026-08-09',
  consentReference: 'consent-123',
};

const memo = (): DeliverableDocument =>
  buildFundingSuitabilityMemo({
    clientLegalName: 'Acme Operating LLC',
    preparedOn: '2026-08-10',
    complianceState: 'pass_with_findings',
    findings: [{ code: 'REV-MISMATCH', summary: 'Stated revenue exceeds deposits by 12%' }],
    assessment: 'A business line of credit fits the stated working-capital need.',
    productFigures: [
      figure('Requested limit', '$50,000', ISSUER_RULE),
      figure('Typical approval window', '7-10 business days', UNRESEARCHED),
      figure('Average monthly deposits', '$82,400', VENDOR_FEED),
    ],
    alternativesConsidered: [['Provider B', 'Term loan', 'Repayment profile mismatched to need']],
  });

describe('provenance is visible in client-facing output (Decision D)', () => {
  it('labels an unresearched default in the rendered text', () => {
    const rendered = textRenderer.render(memo());

    // The specific requirement: an unverified assumption is labelled where a client will see it.
    expect(rendered).toContain(UNVERIFIED_LABEL);
    expect(rendered).toContain('not verified against the issuer');
  });

  it('carries a document-level notice when any figure is unverified', () => {
    const rendered = textRenderer.render(memo());
    expect(rendered).toContain(UNVERIFIED_NOTICE);
  });

  it('omits the notice when every figure is sourced', () => {
    const clean = buildCapitalCommandBrief({
      clientLegalName: 'Acme Operating LLC',
      preparedOn: '2026-08-10',
      complianceState: 'pass',
      narrative: 'Utilisation is within target across the stack.',
      positionFigures: [figure('Total available', '$120,000', ISSUER_RULE)],
    });

    expect(containsUnverifiedFigures(clean)).toBe(false);
    expect(textRenderer.render(clean)).not.toContain(UNVERIFIED_NOTICE);
  });

  it('shows the source for a sourced figure rather than leaving it bare', () => {
    const rendered = textRenderer.render(memo());
    expect(rendered).toMatch(/Source: Issuer rule, verified 2026-08-01/);
    expect(rendered).toMatch(/Source: plaid feed, retrieved 2026-08-09/);
  });

  it('cannot express a figure without provenance', () => {
    // Structural, not conventional: `figure()` requires a Provenance, and `Sourced<T>` cannot be
    // built from a bare value. This test documents the guarantee the types already enforce.
    const built = figure('Requested limit', '$50,000', ISSUER_RULE);
    expect(built.value.provenance).toBeDefined();
    expect(sourced('x', ISSUER_RULE).provenance.tag).toBe('issuer_rule');
  });
});

describe('compliance state renders as a category (Decision E)', () => {
  it('prints the category label and its findings', () => {
    const rendered = textRenderer.render(memo());
    expect(rendered).toContain(COMPLIANCE_STATE_LABELS.pass_with_findings);
    expect(rendered).toContain('REV-MISMATCH');
  });

  it('prints no numeric score anywhere near the compliance section', () => {
    const rendered = textRenderer.render(
      buildCapitalCommandBrief({
        clientLegalName: 'Acme Operating LLC',
        preparedOn: '2026-08-10',
        complianceState: 'needs_review',
        findings: [{ code: 'DOC-MISSING', summary: 'Two bank statements outstanding' }],
        narrative: 'Position unchanged this month.',
        positionFigures: [],
      }),
    );

    const complianceLine = rendered
      .split('\n')
      .find((line) => line.startsWith('Compliance status:'));

    expect(complianceLine).toBe(`Compliance status: ${COMPLIANCE_STATE_LABELS.needs_review}`);
    // No digits, no percentage, no "out of" - the shapes a score would take.
    expect(complianceLine).not.toMatch(/\d/);
    expect(complianceLine).not.toMatch(/%|\/\s*\d|out of/i);
  });

  it('says so explicitly when there are no findings, rather than printing nothing', () => {
    const rendered = textRenderer.render(
      buildCapitalCommandBrief({
        clientLegalName: 'Acme Operating LLC',
        preparedOn: '2026-08-10',
        complianceState: 'pass',
        narrative: 'Position unchanged.',
        positionFigures: [],
      }),
    );
    expect(rendered).toContain('No open findings.');
  });

  it('has a label for every compliance state, none of them numeric', () => {
    for (const [state, label] of Object.entries(COMPLIANCE_STATE_LABELS)) {
      expect(label.length, `${state} needs a label`).toBeGreaterThan(0);
      expect(label).not.toMatch(/\d/);
    }
  });
});

describe('the content hash is the audit artifact', () => {
  it('is stable across repeated hashing of the same document', () => {
    const document = memo();
    expect(hashContent(document)).toBe(hashContent(memo()));
  });

  it('is independent of key order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('changes when a figure or its provenance changes', () => {
    const base = memo();
    const baseHash = hashContent(base);

    const differentValue: DeliverableDocument = {
      ...base,
      sections: [
        section('Product terms considered', [
          figures([figure('Requested limit', '$60,000', ISSUER_RULE)]),
        ]),
      ],
    };
    expect(hashContent(differentValue)).not.toBe(baseHash);

    // Provenance is part of the content, so downgrading a sourced figure to an assumption must
    // change the hash - otherwise the evidence could not distinguish the two documents.
    const sourcedDoc: DeliverableDocument = {
      ...base,
      sections: [section('Terms', [figures([figure('Limit', '$50,000', ISSUER_RULE)])])],
    };
    const assumedDoc: DeliverableDocument = {
      ...base,
      sections: [section('Terms', [figures([figure('Limit', '$50,000', UNRESEARCHED)])])],
    };
    expect(hashContent(sourcedDoc)).not.toBe(hashContent(assumedDoc));
  });
});

describe('scannable text covers what a client reads', () => {
  it('includes headings, prose, figures, provenance, findings and disclosures', () => {
    const text = scannableText(memo());

    expect(text).toContain('Funding Suitability Memo');
    expect(text).toContain('A business line of credit fits');
    expect(text).toContain('Requested limit');
    expect(text).toContain('REV-MISMATCH');
    expect(text).toContain('not a lender');
    // Provenance descriptions are text a client reads, so the Scanner must see them too.
    expect(text).toContain('Unresearched default');
  });

  it('includes table contents, which would otherwise be an unscanned channel', () => {
    expect(scannableText(memo())).toContain('Repayment profile mismatched to need');
  });
});

describe('the PDF renderer produces a real PDF', () => {
  it('emits bytes with a PDF header, from the same content model', async () => {
    const bytes = await pdfRenderer.render(memo());
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('is a rendering, not the artifact: the hash comes from the content', async () => {
    const document = memo();
    const before = hashContent(document);
    await pdfRenderer.render(document);
    // Rendering must not mutate the document or the evidence anchor.
    expect(hashContent(document)).toBe(before);
  });
});
