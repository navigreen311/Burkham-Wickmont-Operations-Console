/**
 * Internal Console transport configuration.
 *
 * The portal's config (`apps/portal-api/src/config.ts`) is the precedent and most of the reasoning
 * is the same, so it is not repeated here. What is different is the setting below that has no
 * counterpart there: `CONSOLE_DEV_ACTOR_HEADER`.
 *
 * **No secret is read here.** Sessions are opaque random tokens stored hashed (11.1), so there is
 * nothing to sign. `DATABASE_URL`, `LEDGER_SIGNING_KEY`, `VAULT_KEK` and `MFA_SECRET_KEY` are read
 * by the packages that own them, from the environment or a secret manager; none belongs in a
 * transport config and none is printed.
 */

export interface ConsoleConfig {
  readonly port: number;
  /** One deployment serves one firm. Never a request value - see `readConsoleConfig`. */
  readonly tenantId: string;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  /** Express's `trust proxy`, verbatim. `true` is refused; see the portal config for why. */
  readonly trustProxy: boolean | number;
  readonly maxJsonBytes: number;
  readonly signInWindowSeconds: number;
  readonly signInMaxAttempts: number;
  readonly rateLimitStore: ConsoleRateLimitStore;
  /**
   * Whether `x-actor-id` is accepted as an identity.
   *
   * **This is the seam the Console was built on and it is off unless somebody says otherwise.**
   * Until now the internal API took the acting staff member from this header - its own comment
   * called it "a development seam, not authentication", and ADR-0022 called fixing it "necessary
   * anyway". Anybody who could reach the port was any actor they cared to name.
   *
   * It survives because the worker, the integration tests and a developer with `curl` all use it,
   * and deleting it in the same slice that adds sign-in would mean two things changed at once with
   * no way to tell which broke. It survives as an explicit choice rather than a default: `false`
   * unless set, and `readConsoleConfig` REFUSES to return a config that has it on in production.
   *
   * A flag that could be left on in production would be a documented way to bypass the sign-in this
   * whole slice exists to add.
   */
  readonly devActorHeader: boolean;
}

export type ConsoleRateLimitStore = 'memory' | 'shared';

export const DEFAULT_CONSOLE_MAX_JSON_BYTES = 64 * 1024;

/**
 * Sign-in rate limit.
 *
 * Tighter than the portal's ten per five minutes. The portal's is sized for clients - many people,
 * many addresses, ordinary typos. This surface has a handful of accounts in total, so a source
 * making more than five attempts in five minutes is not somebody's colleague mistyping.
 */
export const DEFAULT_CONSOLE_SIGN_IN_WINDOW_SECONDS = 300;
export const DEFAULT_CONSOLE_SIGN_IN_MAX_ATTEMPTS = 5;

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. The Console refuses to start without it: this setting has no safe default, and guessing would be a security decision made by whoever wrote the default rather than by whoever deployed it.`,
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

const parseTrustProxy = (raw: string): boolean | number => {
  const value = raw.toLowerCase();
  if (value === 'false') return false;

  if (value === 'true') {
    throw new Error(
      "CONSOLE_TRUST_PROXY='true' is refused. It makes Express trust the entire X-Forwarded-For chain, which the client controls, so an attacker rotates the header and defeats per-IP rate limiting. Set 'false' when nothing is in front of this process, or the NUMBER of trusted proxies between the client and here.",
    );
  }

  const hops = Number.parseInt(value, 10);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new Error(
      `CONSOLE_TRUST_PROXY must be 'false' or a hop count between 1 and 10; got '${raw}'.`,
    );
  }
  return hops;
};

const parseRateLimitStore = (raw: string): ConsoleRateLimitStore => {
  const value = raw.toLowerCase();
  if (value === 'memory' || value === 'shared') return value;

  throw new Error(
    `CONSOLE_RATE_LIMIT_STORE must be 'memory' or 'shared'; got '${raw}'. 'memory' counts attempts per process and is correct for a single instance; 'shared' puts the counter in Postgres, which is what more than one instance needs.`,
  );
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
 * The tenant is DEPLOYMENT configuration and never a request value, for the reason the portal gives:
 * a caller who names their tenant is a caller enumerating tenants.
 *
 * The last check is the one worth reading. `CONSOLE_DEV_ACTOR_HEADER=true` with `NODE_ENV=production`
 * throws rather than warning, because a warning is a line in a log nobody reads and the thing it
 * would be warning about is authentication being optional.
 */
export const readConsoleConfig = (): ConsoleConfig => {
  const devActorHeader = process.env['CONSOLE_DEV_ACTOR_HEADER']?.trim().toLowerCase() === 'true';

  if (devActorHeader && process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'CONSOLE_DEV_ACTOR_HEADER=true with NODE_ENV=production is refused. That header lets any caller act as any actor by naming its id, which is not authentication - it is the development seam the Console sign-in replaced. There is no deployment where both are correct.',
    );
  }

  return {
    port: optionalInteger('CONSOLE_PORT', 4100),
    tenantId: required('CONSOLE_TENANT_ID'),
    cookieName: process.env['CONSOLE_COOKIE_NAME']?.trim() || 'bwc_console_session',
    cookieSecure: requiredBoolean('CONSOLE_COOKIE_SECURE'),
    trustProxy: parseTrustProxy(required('CONSOLE_TRUST_PROXY')),
    maxJsonBytes: optionalInteger('CONSOLE_MAX_JSON_BYTES', DEFAULT_CONSOLE_MAX_JSON_BYTES),
    signInWindowSeconds: optionalInteger(
      'CONSOLE_SIGN_IN_WINDOW_SECONDS',
      DEFAULT_CONSOLE_SIGN_IN_WINDOW_SECONDS,
    ),
    signInMaxAttempts: optionalInteger(
      'CONSOLE_SIGN_IN_MAX_ATTEMPTS',
      DEFAULT_CONSOLE_SIGN_IN_MAX_ATTEMPTS,
    ),
    rateLimitStore: parseRateLimitStore(required('CONSOLE_RATE_LIMIT_STORE')),
    devActorHeader,
  };
};
