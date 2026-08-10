/**
 * Credential hashing - 11.1 Identity & Access, for the client users 11.10 needs.
 *
 * Pure and dependency-free: `scrypt` is in Node's standard library, and adding argon2 would mean a
 * native build step in CI for a function this file uses twice.
 *
 * **No credential material appears in a return value, a log line, an error message or a Ledger
 * event.** The only thing that leaves here is a verdict and an opaque encoded hash. That is worth
 * stating rather than assuming, because the usual way secrets leak is not a broken hash - it is a
 * debug line somebody added while the tests were failing.
 */

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * `promisify` loses the options overload, so the wrapper is explicit.
 *
 * Worth writing out rather than casting around: the cost parameters are the security property of
 * this file, and a signature that silently dropped them would still compile and would produce
 * hashes at Node's defaults.
 */
const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });

/**
 * scrypt cost parameters.
 *
 * N=2^15 is the interactive-login figure from the scrypt paper's own recommendations, and takes
 * roughly 100ms here. Raising it is a deliberate trade against login latency; lowering it is a
 * trade against an attacker's cost, and the attacker is the one with the GPU.
 */
export const SCRYPT_COST = 2 ** 15;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELISM = 1;
export const KEY_LENGTH = 64;
export const SALT_LENGTH = 32;

/**
 * scrypt's memory ceiling, raised from Node's default.
 *
 * scrypt needs `128 * N * r` bytes, which at N=2^15 and r=8 is exactly 32 MiB - and Node's default
 * `maxmem` is 32 MiB, checked as a strict inequality. The first run of this file failed at RUNTIME
 * with "memory limit exceeded", not at compile time, because the cost parameters and the ceiling
 * are unrelated numbers that happen to collide.
 *
 * Set explicitly at 64 MiB so the relationship is visible: raising `SCRYPT_COST` again means
 * raising this too, and the next person to try it will find out here rather than in production.
 */
export const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/** Below this a password is trivially guessable, whatever the hash costs. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Hash a password.
 *
 * Returns `scrypt$N$r$p$salt$hash`, so the cost parameters travel WITH the hash. A stored hash that
 * did not record them could not be verified after somebody raised them, and raising them is the
 * thing you want to be able to do without invalidating every credential.
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  });

  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
};

/**
 * Verify a password against an encoded hash.
 *
 * Compared with `timingSafeEqual`, so the time taken does not depend on how many leading bytes
 * matched. A plain `===` on two buffers leaks the match length to anybody who can time the call,
 * and this call is on an unauthenticated path by definition.
 *
 * Returns `false` rather than throwing on a malformed stored hash. A throw here would be
 * distinguishable from a wrong password by the caller, which is the same information leak in a
 * different shape.
 */
export const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number.parseInt(parts[1] as string, 10);
  const blockSize = Number.parseInt(parts[2] as string, 10);
  const parallelism = Number.parseInt(parts[3] as string, 10);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false;
  }

  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N: cost,
      r: blockSize,
      p: parallelism,
      // Read from the STORED parameters, not the current constants - that is what lets the cost
      // be raised without invalidating every existing credential.
      maxmem: SCRYPT_MAX_MEMORY,
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
};

/**
 * A hash suitable for a token we generated ourselves.
 *
 * Session and invitation tokens are 256 bits of `randomBytes`, so there is nothing to brute-force
 * and scrypt's cost buys nothing - it would just make every request 100ms slower. A single SHA-256
 * is the right tool for a high-entropy secret, and the wrong one for a password.
 */
export const hashToken = async (token: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(token, 'utf8').digest('hex');
};

/** A new opaque token. 256 bits, URL-safe. */
export const newToken = (): string => randomBytes(32).toString('base64url');

export interface PasswordCheck {
  readonly acceptable: boolean;
  readonly detail: string;
}

/**
 * Whether a password may be used.
 *
 * Length only, deliberately. Composition rules - one uppercase, one symbol - push people toward
 * `Password1!` and are worse than a length floor at the thing they are for. NIST dropped them for
 * that reason.
 */
export const checkPassword = (password: string): PasswordCheck => {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      acceptable: false,
      detail: `A password must be at least ${MINIMUM_PASSWORD_LENGTH} characters. There are no composition rules - requiring a symbol and a capital pushes people toward 'Password1!', which is worse at the thing the rule is for.`,
    };
  }
  if (password.trim().length === 0) {
    return { acceptable: false, detail: 'A password cannot be only whitespace.' };
  }
  return { acceptable: true, detail: 'Acceptable.' };
};
