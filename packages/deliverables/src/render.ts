/**
 * Renderers - blueprint 3.1, "PDF generation with Burkham Wickmont stationery".
 *
 * Two renderers behind one interface. The interface exists because the rendering is deliberately
 * *not* the audit artifact (see `content.ts`): the content document is hashed and anchored in the
 * Ledger, and a rendering is a view of it. That makes the PDF library a swappable detail rather
 * than something the evidence trail depends on.
 *
 * Both renderers go through `renderFigure`, so provenance surfacing is implemented once. Two
 * renderers each deciding how to show an unresearched default would eventually disagree, and the
 * client-facing one is the one that matters.
 */

import PDFDocument from 'pdfkit';
import {
  COMPLIANCE_STATE_LABELS,
  UNVERIFIED_LABEL,
  containsUnverifiedFigures,
  renderFigure,
  type Block,
  type DeliverableDocument,
} from './content.js';

/** Burkham Wickmont stationery. Kept as data so both renderers stay consistent. */
export const BRAND = {
  name: 'Burkham Wickmont',
  ink: '#1a2b3c',
  accent: '#7a6a53',
  muted: '#5b6670',
  rule: '#c8ccd0',
} as const;

/**
 * The notice a document carries when any figure rests on an unresearched default.
 *
 * Document-level as well as per-figure, because a reader who skims the figures still has to be
 * told. Decision D applied to client-facing output, not just to internal recommendation memos.
 */
export const UNVERIFIED_NOTICE =
  'This document contains one or more figures marked as an unverified assumption. Those figures have not been confirmed against the issuer and should not be relied upon as terms.';

export interface Renderer<T> {
  readonly format: string;
  render(document: DeliverableDocument): T;
}

// --- Plain text -----------------------------------------------------------

/**
 * Text renderer. Not a fallback - it is what the tests assert against, because asserting on
 * rendered *text* proves the provenance label actually reaches output, while asserting on the
 * model would only prove the model holds it.
 */
export const textRenderer: Renderer<string> = {
  format: 'text',
  render(document: DeliverableDocument): string {
    const lines: string[] = [
      BRAND.name.toUpperCase(),
      '',
      document.title,
      `Prepared for: ${document.clientLegalName}`,
      `Prepared on: ${document.preparedOn}`,
      '',
    ];

    if (containsUnverifiedFigures(document)) {
      lines.push(UNVERIFIED_NOTICE, '');
    }

    for (const section of document.sections) {
      lines.push(section.heading.toUpperCase(), '');
      for (const block of section.blocks) lines.push(...renderBlockAsText(block), '');
    }

    lines.push(`${BRAND.name} is not a lender, investment adviser, or credit repair organization.`);

    return lines.join('\n');
  },
};

const renderBlockAsText = (block: Block): string[] => {
  switch (block.kind) {
    case 'paragraph':
      return [block.text];

    case 'key_figures':
      return block.figures.flatMap((figure) => {
        const rendered = renderFigure(figure);
        const line = `${rendered.label}: ${rendered.value}`;
        const provenance = rendered.unverified
          ? `    [${UNVERIFIED_LABEL}] ${rendered.provenance}`
          : `    Source: ${rendered.provenance}`;
        return figure.note !== undefined
          ? [line, provenance, `    ${figure.note}`]
          : [line, provenance];
      });

    case 'compliance_state': {
      // Decision E: a category and its findings. No number is available to print.
      const lines = [`Compliance status: ${COMPLIANCE_STATE_LABELS[block.state]}`];
      if (block.findings.length === 0) {
        lines.push('    No open findings.');
      } else {
        for (const finding of block.findings) {
          lines.push(`    ${finding.code}: ${finding.summary}`);
        }
      }
      return lines;
    }

    case 'disclosure':
      return [`DISCLOSURE: ${block.text}`];

    case 'table': {
      const lines = [block.columns.join(' | ')];
      lines.push(block.columns.map(() => '---').join(' | '));
      for (const row of block.rows) lines.push(row.join(' | '));
      return lines;
    }
  }
};

// --- PDF ------------------------------------------------------------------

/**
 * PDF renderer (ADR-0005). `pdfkit`: pure JS, no browser, no native dependency - which matters
 * for a process that also handles SSNs and bank data, where bundling Chromium would be a large
 * attack surface for a document that is mostly headed sections and labelled figures.
 */
export const pdfRenderer: Renderer<Promise<Buffer>> = {
  format: 'pdf',
  async render(document: DeliverableDocument): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      info: {
        Title: document.title,
        Author: BRAND.name,
        Subject: `Prepared for ${document.clientLegalName}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // Stationery
    doc.fillColor(BRAND.accent).fontSize(9).text(BRAND.name.toUpperCase(), { characterSpacing: 2 });
    doc.moveDown(0.4);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor(BRAND.rule)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(1.2);

    doc.fillColor(BRAND.ink).fontSize(18).text(document.title);
    doc.moveDown(0.3);
    doc
      .fillColor(BRAND.muted)
      .fontSize(10)
      .text(`Prepared for ${document.clientLegalName}`)
      .text(`Prepared on ${document.preparedOn}`);
    doc.moveDown(1);

    if (containsUnverifiedFigures(document)) {
      doc.fillColor(BRAND.accent).fontSize(9).text(UNVERIFIED_NOTICE, { align: 'left' });
      doc.moveDown(1);
    }

    for (const section of document.sections) {
      doc.fillColor(BRAND.ink).fontSize(12).text(section.heading.toUpperCase(), {
        characterSpacing: 1,
      });
      doc.moveDown(0.5);
      for (const block of section.blocks) renderBlockAsPdf(doc, block);
      doc.moveDown(0.8);
    }

    doc
      .fillColor(BRAND.muted)
      .fontSize(8)
      .text(`${BRAND.name} is not a lender, investment adviser, or credit repair organization.`, {
        align: 'left',
      });

    doc.end();
    return finished;
  },
};

type PdfDoc = InstanceType<typeof PDFDocument>;

const renderBlockAsPdf = (doc: PdfDoc, block: Block): void => {
  switch (block.kind) {
    case 'paragraph':
      doc.fillColor(BRAND.ink).fontSize(10).text(block.text);
      doc.moveDown(0.5);
      return;

    case 'key_figures':
      for (const figure of block.figures) {
        const rendered = renderFigure(figure);
        doc.fillColor(BRAND.ink).fontSize(10).text(`${rendered.label}: ${rendered.value}`);
        doc
          .fillColor(rendered.unverified ? BRAND.accent : BRAND.muted)
          .fontSize(8)
          .text(
            rendered.unverified
              ? `[${UNVERIFIED_LABEL}] ${rendered.provenance}`
              : `Source: ${rendered.provenance}`,
            { indent: 12 },
          );
        if (figure.note !== undefined) {
          doc.fillColor(BRAND.muted).fontSize(8).text(figure.note, { indent: 12 });
        }
        doc.moveDown(0.4);
      }
      return;

    case 'compliance_state':
      doc
        .fillColor(BRAND.ink)
        .fontSize(10)
        .text(`Compliance status: ${COMPLIANCE_STATE_LABELS[block.state]}`);
      if (block.findings.length === 0) {
        doc.fillColor(BRAND.muted).fontSize(9).text('No open findings.', { indent: 12 });
      } else {
        for (const finding of block.findings) {
          doc
            .fillColor(BRAND.muted)
            .fontSize(9)
            .text(`${finding.code}: ${finding.summary}`, { indent: 12 });
        }
      }
      doc.moveDown(0.5);
      return;

    case 'disclosure':
      doc.fillColor(BRAND.muted).fontSize(8).text(`DISCLOSURE: ${block.text}`);
      doc.moveDown(0.5);
      return;

    case 'table': {
      doc.fillColor(BRAND.ink).fontSize(9).text(block.columns.join('   |   '));
      for (const row of block.rows) {
        doc.fillColor(BRAND.muted).fontSize(9).text(row.join('   |   '));
      }
      doc.moveDown(0.5);
      return;
    }
  }
};
