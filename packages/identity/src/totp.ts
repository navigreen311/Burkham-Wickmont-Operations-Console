/**
 * TOTP - RFC 6238, on top of HOTP - RFC 4226.
 *
 * Pure and dependency-free, and **verified against the RFC's own published test vectors** rather
 * than against itself. That matters more here than usual: an implementation with an off-by-one in
 * the counter encoding produces six digits that look exactly like the right six digits, agrees with
 * itself perfectly, and matches no authenticator app on earth. The failure is only visible against
 * an external reference.
 *
 * **HMAC-SHA1, deliberately.** SHA-1's weakness is collision resistance, which is not the property
 * HMAC relies on; HMAC-SHA1 has no practical break. More to the point, the algorithm is not really
 * a free choice: authenticator apps overwhelmingly implement SHA-1 only, and a secret they cannot
 * use is a factor the client cannot enrol.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Seconds per step. Thirty is the value every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of now are accepted.
 *
 * One - thirty seconds - which covers an unsynchronised phone clock and a person typing slowly.
 * Widening it multiplies the number of codes an attacker's guess could match and lengthens the
 * window in which an observed code is still live, so it buys convenience with exactly the property
 * the factor exists for.
 */
export const TOTP_DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32, because that is what an authenticator app reads.
 *
 * RFC 4648 without padding. Written out rather than pulled in: it is twenty lines, and a dependency
 * here would be a dependency in the path that mints credentials.
 */
export const base32Encode = (data: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
};

/** Decode base32. Returns null rather than throwing on anything that is not base32. */
export const base32Decode = (encoded: string): Buffer | null => {
  const clean = encoded.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase();
  if (clean === '') return null;

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

/**
 * HOTP - RFC 4226 §5.3.
 *
 * The counter is an eight-byte big-endian integer, and the truncation reads the low four bits of
 * the last HMAC byte as an offset. Both are the parts an implementation gets subtly wrong.
 */
export const hotp = (
  secret: Buffer,
  counter: bigint,
  digits: number = TOTP_DIGITS,
  algorithm = 'sha1',
): string => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);

  const digest = createHmac(algorithm, secret).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;

  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
};

/** The time step a moment falls in. The counter TOTP feeds to HOTP. */
export const timeStep = (at: Date, stepSeconds: number = TOTP_STEP_SECONDS): bigint =>
  BigInt(Math.floor(at.getTime() / 1000 / stepSeconds));

export const totp = (
  secret: Buffer,
  at: Date,
  digits: number = TOTP_DIGITS,
  stepSeconds: number = TOTP_STEP_SECONDS,
  algorithm = 'sha1',
): string => hotp(secret, timeStep(at, stepSeconds), digits, algorithm);

export interface TotpVerification {
  readonly valid: boolean;
  /** The step the code matched. Stored, so the same code cannot be presented again. */
  readonly step: bigint | null;
}

/**
 * Verify a code, returning the step it matched.
 *
 * **The step comes back rather than a bare boolean**, because the caller has to record it: a code is
 * valid for at least thirty seconds, and an attacker who watched one over a shoulder or through a
 * phishing proxy has that long to replay it. Refusing any step at or below the last accepted one
 * closes that window, and it also stops the same code opening two sessions at once.
 *
 * Compared with `timingSafeEqual` - the comparison is against a value an unauthenticated caller
 * supplies, and leaking how many leading digits matched would reduce six digits to six guesses.
 */
export const verifyTotp = (input: {
  secret: Buffer;
  code: string;
  at: Date;
  /** The last step accepted for this factor, if any. Anything at or below it is refused. */
  lastUsedStep?: bigint | null;
  driftSteps?: number;
  digits?: number;
  stepSeconds?: number;
}): TotpVerification => {
  const code = input.code.replace(/\s+/gu, '');
  const digits = input.digits ?? TOTP_DIGITS;
  if (!new RegExp(`^\\d{${digits}}$`, 'u').test(code)) return { valid: false, step: null };

  const drift = input.driftSteps ?? TOTP_DRIFT_STEPS;
  const current = timeStep(input.at, input.stepSeconds ?? TOTP_STEP_SECONDS);
  const supplied = Buffer.from(code, 'utf8');

  for (let offset = -drift; offset <= drift; offset += 1) {
    const step = current + BigInt(offset);
    if (step < 0n) continue;
    // A step already spent is not a candidate, however recent. This is what makes the acceptance
    // window safe to have at all.
    if (input.lastUsedStep != null && step <= input.lastUsedStep) continue;

    const expected = Buffer.from(hotp(input.secret, step, digits), 'utf8');
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      return { valid: true, step };
    }
  }

  return { valid: false, step: null };
};

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label carries the issuer and the account, because a client with several authenticators needs
 * to be able to tell which entry is which - and an entry they cannot identify is one they delete.
 */
export const otpauthUri = (input: {
  issuer: string;
  account: string;
  secretBase32: string;
  digits?: number;
  stepSeconds?: number;
}): string => {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const parameters = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.stepSeconds ?? TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
};
