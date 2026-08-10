/**
 * Per-IP rate limiting for the unauthenticated path.
 *
 * **This is not lockout, and neither substitutes for the other.**
 *
 * 11.1 locks an account after five consecutive failures. That protects the ACCOUNT, and it does
 * nothing against password spraying: an attacker with ten thousand client emails tries
 * `Summer2026!` against each one, once. No account reaches two failures, so lockout never fires -
 * and one weak password anywhere in that list is a session.
 *
 * Rate limiting counts the ATTACKER rather than the victim, which is why it catches the case
 * lockout cannot. Both controls exist and they count different things.
 *
 * ## The limitation, stated rather than hidden
 *
 * The window is held in this process's memory. **Two instances means twice the limit**, and a
 * restart clears every counter. That is acceptable for a single-instance deployment and is not
 * acceptable behind a load balancer with three replicas - at which point this needs a shared store,
 * and Redis is the obvious one.
 *
 * Written in memory rather than reaching for a dependency because a rate limiter whose store this
 * system does not yet run would be a rate limiter nobody has tested against a real Redis. The
 * honest version is the small one with its limit written down.
 */

/** One counter per key, for one window. */
interface Window {
  count: number;
  /** When this window ends, in epoch milliseconds. */
  resetAt: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. For a `Retry-After` header. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  readonly check: (key: string, now?: Date) => RateLimitVerdict;
  /** Test seam and operational escape hatch. Not reachable from a route. */
  readonly reset: () => void;
  readonly size: () => number;
}

/**
 * A fixed-window limiter.
 *
 * Fixed rather than sliding, deliberately: a sliding window needs per-request timestamps and this
 * one needs to be cheap enough to run before anything else on an unauthenticated path. The known
 * cost is burst tolerance at a window boundary - up to 2N attempts across two adjacent windows -
 * which for a sign-in limit of ten is twenty, and twenty is still not password spraying.
 *
 * Expired windows are swept on write rather than on a timer. A timer would keep the process alive
 * and would be one more thing to shut down cleanly; sweeping on write means the map cannot grow
 * without traffic, and traffic is the only thing that grows it.
 */
export const createRateLimiter = (input: {
  windowSeconds: number;
  maxAttempts: number;
}): RateLimiter => {
  const windows = new Map<string, Window>();
  const windowMs = input.windowSeconds * 1000;

  const sweep = (nowMs: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= nowMs) windows.delete(key);
    }
  };

  return {
    check: (key, now = new Date()): RateLimitVerdict => {
      const nowMs = now.getTime();

      // Cheap and bounded: the map only holds keys seen inside one window.
      if (windows.size > 0 && windows.size % 64 === 0) sweep(nowMs);

      const existing = windows.get(key);

      if (!existing || existing.resetAt <= nowMs) {
        windows.set(key, { count: 1, resetAt: nowMs + windowMs });
        return {
          allowed: true,
          remaining: input.maxAttempts - 1,
          retryAfterSeconds: input.windowSeconds,
        };
      }

      existing.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000));

      if (existing.count > input.maxAttempts) {
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }

      return {
        allowed: true,
        remaining: input.maxAttempts - existing.count,
        retryAfterSeconds,
      };
    },
    reset: () => windows.clear(),
    size: () => windows.size,
  };
};

/**
 * The key a request is counted against.
 *
 * `req.ip`, which Express derives from the socket or from `X-Forwarded-For` according to
 * `trust proxy` - the setting `config.ts` refuses to guess, because getting it wrong makes this
 * function count the load balancer instead of the client.
 *
 * A missing IP counts as one shared bucket named `unknown` rather than being allowed through. An
 * unattributable request is exactly the one an attacker would arrange for.
 */
export const rateLimitKey = (ip: string | undefined): string =>
  ip === undefined || ip.trim() === '' ? 'unknown' : ip.trim();
