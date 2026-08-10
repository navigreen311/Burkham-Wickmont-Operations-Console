/**
 * Watermarking on export - Specification v2 §6.2: "every document viewed or exported from the
 * Secure Document Vault is watermarked with viewer identity and timestamp".
 *
 * That is a property of the bytes the viewer receives, so it is implemented on the bytes. A
 * watermark that existed only as a log entry would be a watermark in name: the point is that a
 * document which later turns up somewhere it should not be can be traced to who took it out.
 *
 * `pdf-lib` rather than `pdfkit`: pdfkit creates PDFs and cannot modify an existing one, and
 * these are documents a client uploaded.
 */

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';

export interface WatermarkContext {
  readonly viewer: string;
  readonly at: Date;
  readonly documentId: string;
  readonly contentType: string;
}

export interface WatermarkResult {
  readonly watermarked: boolean;
  readonly content: Buffer;
  readonly reason?: string;
}

const PDF_MAGIC = '%PDF-';

/**
 * Stamp every page with the viewer's identity, the time, and the document id.
 *
 * Non-PDF content is returned unchanged with `watermarked: false` and a stated reason, rather
 * than silently pretending. The access log records the same false, so "was this export
 * watermarked?" has a truthful answer for every export rather than an assumed one.
 */
export const watermarkPdf = async (
  content: Buffer,
  context: WatermarkContext,
): Promise<WatermarkResult> => {
  if (content.subarray(0, 5).toString('ascii') !== PDF_MAGIC) {
    return {
      watermarked: false,
      content,
      reason: `Content type ${context.contentType} cannot carry a visual watermark.`,
    };
  }

  try {
    const pdf = await PDFDocument.load(content, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const stamp = `${context.viewer} · ${context.at.toISOString()} · doc ${context.documentId}`;

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();

      // Diagonal, translucent, across the middle: legible enough to identify the viewer,
      // faint enough that the document underneath stays readable.
      page.drawText(stamp, {
        x: 40,
        y: height / 2,
        size: 10,
        font,
        color: rgb(0.75, 0.1, 0.1),
        opacity: 0.35,
        rotate: degrees(30),
      });

      // Repeated in the footer, because a diagonal stamp is easy to crop and a footer is not
      // where someone looks when removing evidence of provenance.
      page.drawText(stamp, {
        x: 24,
        y: 12,
        size: 6,
        font,
        color: rgb(0.45, 0.45, 0.45),
        opacity: 0.85,
        maxWidth: width - 48,
      });
    }

    return { watermarked: true, content: Buffer.from(await pdf.save()) };
  } catch (error) {
    // A malformed or encrypted PDF must not block the export silently, and must not be
    // reported as watermarked when it is not.
    return {
      watermarked: false,
      content,
      reason: `Could not watermark: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
