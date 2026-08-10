/**
 * Portal transport configuration.
 *
 * Two settings here have **no default**, and the app throws at construction without them. Both are
 * silently catastrophic when wrong, and a default is a decision made by whoever wrote the default
 * rather than by whoever deployed it.
 *
 * **No secret is read here.** The session secret does not exist - sessions are opaque random
 * tokens stored hashed (11.1), so there is nothing to sign and nothing to leak. `DATABASE_URL`,
 * `LEDGER_SIGNING_KEY` and `VAULT_KEK` are read by the packages that own them, from the
 * environment or a secret manager; none of them belongs in a transport config and none is printed.
 */

export interface PortalConfig {
  readonly port: number;
  /** One deployment serves one tenant. See `tenantId` below. */
  readonly tenantId: string;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  /**
   * Express's `trust proxy` setting, verbatim.
   *
   * `false` when nothing is in front of this process. A number when there are exactly that many
   * trusted proxies between the client and here - which is the setting almost everybody gets
   * wrong, in one of two silent ways:
   *
   *   UNSET behind a load balancer: every request appears to come from the balancer, and per-IP
   *   rate limiting collapses into a single global bucket that one noisy client can exhaust.
   *
   *   `true` in front of one: Express takes the leftmost `X-Forwarded-For` entry, which the client
   *   controls, so an attacker rotates the header and evades limiting entirely.
   *
   * Neither failure is visible from inside the process, which is why this is required rather than
   * defaulted.
   */
  readonly trustProxy: boolean | number;
  /** Maximum bytes for a JSON body. Small: these are form posts, not documents. */
  readonly maxJsonBytes: number;
  /** Maximum bytes for a document upload. */
  readonly maxUploadBytes: number;
  readonly signInWindowSeconds: number;
  readonly signInMaxAttempts: number;
  readonly resetWindowSeconds: number;
  readonly resetMaxAttempts: number;
  /**
   * Where attempt counters live.
   *
   * `memory` is correct for exactly one instance and wrong for two: each process would enforce the
   * configured limit on its own, so three replicas give an attacker three times the budget and a
   * rolling deploy hands them a clean slate. Neither is visible from inside any one process, which
   * is why this has no default.
   */
  readonly rateLimitStore: RateLimitStore;
  /**
   * The WebAuthn relying party.
   *
   * `rpId` is the domain a credential is scoped to; `origin` is the exact URL a browser must have
   * been on. **Neither may come from a request.** An RP ID a caller chooses is a caller choosing the
   * scope of the credential, and an origin a caller chooses is the phishing resistance switched off
   * by the party it exists to stop - which is the entire reason to prefer a key over six digits.
   */
  readonly rpId: string;
  readonly rpName: string;
  readonly origin: string;
}

export type RateLimitStore = 'memory' | 'shared';

export const DEFAULT_MAX_JSON_BYTES = 64 * 1024;
export const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Sign-in rate limit.
 *
 * Ten attempts per IP per five minutes. Deliberately generous for a person mistyping a password,
 * and hopeless for a script: password spraying needs thousands of attempts to be worth running,
 * and this caps one source at 120 an hour.
 *
 * These are TRANSPORT constants rather than 11.7 parameters. 11.7's registry is tenant-scoped and
 * read from the database, and this limit has to be enforced before the request has been associated
 * with anything - including before a database round trip, which is the point of having it.
 */
export const DEFAULT_SIGN_IN_WINDOW_SECONDS = 300;
export const DEFAULT_SIGN_IN_MAX_ATTEMPTS = 10;

/**
 * Password-reset rate limit, on its own counter rather than sharing sign-in's.
 *
 * Tighter, because the request path is more expensive than a sign-in attempt in a way that matters:
 * each one mints a token and sends an email to an address the requester chose, so an unlimited
 * endpoint is a way to have this firm mail somebody repeatedly.
 *
 * Separate rather than shared so the two cannot exhaust each other. A shared bucket would mean an
 * attacker spraying resets from a shared NAT address locks legitimate clients out of signing in -
 * which is a denial of service built out of two controls that are each individually correct.
 */
export const DEFAULT_RESET_WINDOW_SECONDS = 900;
export const DEFAULT_RESET_MAX_ATTEMPTS = 5;

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. The Client Portal refuses to start without it: this setting has no safe default, and guessing would be a security decision made by whoever wrote the default rather than by whoever deployed it.`,
    );
  }
  return value.trim();
};

const requiredBoolean = (name: string): boolean => {
  const value = required(name).toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} must be exactly 'true' or 'false'; got '${value}'.`);
  }
  return value === 'true';
};

/**
 * Parse `PORTAL_TRUST_PROXY`.
 *
 * `false`, or a hop count. `true` is REFUSED: it tells Express to believe the whole
 * `X-Forwarded-For` chain, which the client writes, and there is no deployment where that is the
 * right answer for a rate-limited public surface.
 */
const parseTrustProxy = (raw: string): boolean | number => {
  const value = raw.toLowerCase();
  if (value === 'false') return false;

  if (value === 'true') {
    throw new Error(
      "PORTAL_TRUST_PROXY='true' is refused. It makes Express trust the entire X-Forwarded-For chain, which the client controls, so an attacker rotates the header and defeats per-IP rate limiting. Set 'false' when nothing is in front of this process, or the NUMBER of trusted proxies between the client and here.",
    );
  }

  const hops = Number.parseInt(value, 10);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new Error(
      `PORTAL_TRUST_PROXY must be 'false' or a hop count between 1 and 10; got '${raw}'.`,
    );
  }
  return hops;
};

/**
 * Parse `PORTAL_RATE_LIMIT_STORE`.
 *
 * No default, for the same reason `PORTAL_TRUST_PROXY` has none: both are settings whose wrong value
 * produces a system that looks like it is enforcing a control and is not, and neither failure is
 * visible from inside the process.
 */
const parseRateLimitStore = (raw: string): RateLimitStore => {
  const value = raw.toLowerCase();
  if (value === 'memory' || value === 'shared') return value;

  throw new Error(
    `PORTAL_RATE_LIMIT_STORE must be 'memory' or 'shared'; got '${raw}'. 'memory' counts attempts per process and is correct for a single instance; 'shared' puts the counter in Postgres, which is what more than one instance needs - three replicas counting separately give an attacker three times the limit.`,
  );
};

/**
 * Parse `PORTAL_ORIGIN`.
 *
 * An exact origin - scheme, host and port, no path. A trailing path would never match what a
 * browser reports, and the mismatch would show up as every key failing rather than as a
 * configuration error.
 */
const parseOrigin = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `PORTAL_ORIGIN must be an absolute URL such as https://portal.example.com; got '${raw}'.`,
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `PORTAL_ORIGIN must be an origin with no path, such as https://portal.example.com; got '${raw}'.`,
    );
  }
  return url.origin;
};

const optionalInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer; got '${raw}'.`);
  }
  return value;
};

/**
 * Read and validate the environment.
 *
 * The tenant is DEPLOYMENT configuration and never a request value. A header or subdomain naming
 * the tenant would be a value the client chooses, and a client who chooses their tenant is a
 * client enumerating tenants - the Console is one firm's dedicated workspace, so one deployment
 * per tenant is also what it actually is.
 */
export const readConfig = (): PortalConfig => ({
  port: optionalInteger('PORTAL_PORT', 4200),
  tenantId: required('PORTAL_TENANT_ID'),
  cookieName: process.env['PORTAL_COOKIE_NAME']?.trim() || 'bwc_portal_session',
  // No default. On breaks local development in a way that invites somebody to turn it off in a
  // shared config; off ships a session cookie over plaintext.
  cookieSecure: requiredBoolean('PORTAL_COOKIE_SECURE'),
  trustProxy: parseTrustProxy(required('PORTAL_TRUST_PROXY')),
  maxJsonBytes: optionalInteger('PORTAL_MAX_JSON_BYTES', DEFAULT_MAX_JSON_BYTES),
  maxUploadBytes: optionalInteger('PORTAL_MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES),
  signInWindowSeconds: optionalInteger(
    'PORTAL_SIGN_IN_WINDOW_SECONDS',
    DEFAULT_SIGN_IN_WINDOW_SECONDS,
  ),
  signInMaxAttempts: optionalInteger('PORTAL_SIGN_IN_MAX_ATTEMPTS', DEFAULT_SIGN_IN_MAX_ATTEMPTS),
  resetWindowSeconds: optionalInteger('PORTAL_RESET_WINDOW_SECONDS', DEFAULT_RESET_WINDOW_SECONDS),
  resetMaxAttempts: optionalInteger('PORTAL_RESET_MAX_ATTEMPTS', DEFAULT_RESET_MAX_ATTEMPTS),
  rateLimitStore: parseRateLimitStore(required('PORTAL_RATE_LIMIT_STORE')),
  rpId: required('PORTAL_RP_ID'),
  rpName: process.env['PORTAL_RP_NAME']?.trim() || 'Burkham Wickmont',
  origin: parseOrigin(required('PORTAL_ORIGIN')),
});
