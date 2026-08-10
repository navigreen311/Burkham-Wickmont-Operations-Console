/**
 * Extract readable text from a PDF by inflating its content streams.
 *
 * PDF content streams are Flate-compressed, so watermark text is genuinely present but not as
 * plaintext bytes. Searching the raw file would fail and tempt a weaker assertion - "the export got
 * bigger" - which would pass just as happily if the added bytes said nothing. The claim under test
 * is that the *viewer's identity is in the document*, so this decompresses and looks.
 *
 * Shared rather than copied. It was written for `vault-access.test.ts`, and the client-access test
 * needs exactly the same thing; a second copy that missed the hex-string decoding - as a first
 * attempt at one did - would produce a test that failed for a reason unrelated to what it asserts.
 */

import { inflateSync } from 'node:zlib';

export const pdfText = (pdf: Buffer): string => {
  const raw = pdf.toString('latin1');
  const parts: string[] = [raw];

  const decodeHexStrings = (content: string): void => {
    // pdf-lib writes drawn text as a hex string operand: <48656C6C6F> Tj
    const hexToken = /<([0-9A-Fa-f]+)>/g;
    let token: RegExpExecArray | null;
    while ((token = hexToken.exec(content)) !== null) {
      const hex = token[1];
      if (hex === undefined || hex.length % 2 !== 0) continue;
      parts.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  };

  let cursor = 0;
  for (;;) {
    const streamAt = raw.indexOf('stream', cursor);
    if (streamAt === -1) break;

    const end = raw.indexOf('endstream', streamAt);
    if (end === -1) break;

    // Skip past 'stream' and whatever end-of-line follows it.
    let start = streamAt + 'stream'.length;
    while (start < end && (raw.charCodeAt(start) === 13 || raw.charCodeAt(start) === 10)) {
      start += 1;
    }

    try {
      const inflated = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
      parts.push(inflated);
      decodeHexStrings(inflated);
    } catch {
      // Not a Flate stream. The raw copy above already covers uncompressed content.
    }

    cursor = end + 'endstream'.length;
  }

  decodeHexStrings(raw);
  return parts.join(String.fromCharCode(10));
};
