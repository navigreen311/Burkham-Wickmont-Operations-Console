/**
 * TOTP, checked against RFC 6238's own test vectors.
 *
 * **This is the point of the file.** An implementation with an off-by-one in the counter encoding
 * or the dynamic truncation produces six digits that look exactly like the right six digits, agrees
 * with itself perfectly, and matches no authenticator app on earth. Only an external reference
 * catches it, and the RFC publishes one.
 */

import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  timeStep,
  totp,
  verifyTotp,
} from '@bwc/identity';

/** RFC 4226 Appendix D and RFC 6238 Appendix B both use this ASCII secret. */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('RFC 4226 - the HOTP test vectors', () => {
  // Appendix D, the published counter -> code table.
  const VECTORS: readonly [bigint, string][] = [
    [0n, '755224'],
    [1n, '287082'],
    [2n, '359152'],
    [3n, '969429'],
    [4n, '338314'],
    [5n, '254676'],
    [6n, '287922'],
    [7n, '162583'],
    [8n, '399871'],
    [9n, '520489'],
  ];

  it.each(VECTORS)('counter %s produces %s', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected);
  });
});

describe('RFC 6238 - the TOTP test vectors', () => {
  // Appendix B, SHA-1 column. Eight digits, as the RFC's table uses.
  const VECTORS: readonly [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(VECTORS)('unix time %s produces %s', (seconds, expected) => {
    expect(totp(RFC_SECRET, new Date(seconds * 1000), 8)).toBe(expected);
  });

  it('divides time into thirty-second steps', () => {
    expect(timeStep(new Date(59 * 1000))).toBe(1n);
    expect(timeStep(new Date(60 * 1000))).toBe(2n);
    expect(TOTP_STEP_SECONDS).toBe(30);
  });
});

describe('base32', () => {
  // RFC 4648 §10.
  const VECTORS: readonly [string, string][] = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(VECTORS)('encodes %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it('round-trips a secret', () => {
    expect(base32Decode(base32Encode(RFC_SECRET))?.equals(RFC_SECRET)).toBe(true);
  });

  it('returns null on anything that is not base32 rather than guessing', () => {
    // 0, 1 and 8 are deliberately absent from the alphabet, being the characters people misread.
    expect(base32Decode('MZXW6YTB01')).toBeNull();
    expect(base32Decode('')).toBeNull();
  });
});

describe('verification', () => {
  const AT = new Date('2026-08-13T10:00:00.000Z');

  it('accepts the current code', () => {
    const verified = verifyTotp({ secret: RFC_SECRET, code: totp(RFC_SECRET, AT), at: AT });
    expect(verified.valid).toBe(true);
    expect(verified.step).toBe(timeStep(AT));
  });

  it('accepts one step of drift either side, and no more', () => {
    const before = new Date(AT.getTime() - TOTP_STEP_SECONDS * 1000);
    const after = new Date(AT.getTime() + TOTP_STEP_SECONDS * 1000);
    const wayBefore = new Date(AT.getTime() - TOTP_STEP_SECONDS * 3 * 1000);

    expect(verifyTotp({ secret: RFC_SECRET, code: totp(RFC_SECRET, before), at: AT }).valid).toBe(
      true,
    );
    expect(verifyTotp({ secret: RFC_SECRET, code: totp(RFC_SECRET, after), at: AT }).valid).toBe(
      true,
    );
    expect(
      verifyTotp({ secret: RFC_SECRET, code: totp(RFC_SECRET, wayBefore), at: AT }).valid,
    ).toBe(false);
  });

  it('refuses a step already spent, which is what stops a replay', () => {
    // THE ASSERTION THIS BLOCK EXISTS FOR. A code stays valid for at least thirty seconds, so
    // somebody who read it over a shoulder or through a phishing proxy has that long to use it.
    const code = totp(RFC_SECRET, AT);
    const first = verifyTotp({ secret: RFC_SECRET, code, at: AT });
    expect(first.valid).toBe(true);

    const replay = verifyTotp({
      secret: RFC_SECRET,
      code,
      at: AT,
      lastUsedStep: first.step,
    });
    expect(replay.valid).toBe(false);
  });

  it('refuses the PREVIOUS code once a later one has been accepted', () => {
    // The drift window and the replay guard have to compose: accepting step-1 after step would
    // reopen exactly the window the guard closed.
    const previous = totp(RFC_SECRET, new Date(AT.getTime() - TOTP_STEP_SECONDS * 1000));
    const current = verifyTotp({ secret: RFC_SECRET, code: totp(RFC_SECRET, AT), at: AT });

    expect(
      verifyTotp({ secret: RFC_SECRET, code: previous, at: AT, lastUsedStep: current.step }).valid,
    ).toBe(false);
  });

  it('refuses anything that is not six digits without hashing it', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp({ secret: RFC_SECRET, code, at: AT }).valid).toBe(false);
    }
  });
});

describe('the otpauth URI', () => {
  it('carries the issuer, the account and the parameters an app needs', () => {
    const uri = otpauthUri({
      issuer: 'Burkham Wickmont',
      account: 'owner@example.com',
      secretBase32: base32Encode(RFC_SECRET),
    });

    expect(uri.startsWith('otpauth://totp/Burkham%20Wickmont:owner%40example.com?')).toBe(true);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});
