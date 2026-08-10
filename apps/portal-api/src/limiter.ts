/**
 * Per-source rate limiting for the unauthenticated path.
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
 * ## Two implementations, and the deployment picks
 *
 * `createRateLimiter` holds its windows in this process's memory. **Two instances means twice the
 * limit**, and a restart clears every counter - which was written down here from the day it shipped
 * rather than discovered later.
 *
 * `createSharedRateLimiter` puts the counter in Postgres, where every instance sees the same one.
 * It costs a round trip on the hot path, and that round trip protects a scrypt verification costing
 * a hundred times more.
 *
 * Neither is the default. `PORTAL_RATE_LIMIT_STORE` has no default and the app refuses to start
 * without it, because a deployment that quietly counts per process behind three replicas is
 * enforcing a limit nobody chose and nothing reports.
 */

import { clearRateLimits, consumeRateLimit, sweepRateLimits } from '@bwc/identity';

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. For a `Retry-After` header. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /**
   * Count one attempt.
   *
   * **Async even for the in-memory implementation.** A shared store cannot be synchronous, and two
   * interfaces - one per implementation - would mean the transport choosing between them, which is
   * how a deployment ends up on the wrong one.
   */
  readonly check: (key: string, now?: Date) => Promise<RateLimitVerdict>;
  /** Test seam and operational escape hatch. Not reachable from a route. */
  readonly reset: () => Promise<void>;
}

const verdict = (input: {
  attempts: number;
  maxAttempts: number;
  windowSeconds: number;
  endsAtMs: number;
  nowMs: number;
}): RateLimitVerdict => {
  const retryAfterSeconds = Math.max(1, Math.ceil((input.endsAtMs - input.nowMs) / 1000));

  if (input.attempts > input.maxAttempts) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }
  return {
    allowed: true,
    remaining: input.maxAttempts - input.attempts,
    retryAfterSeconds,
  };
};

/** One counter per key, for one window. */
interface Window {
  count: number;
  /** When this window ends, in epoch milliseconds. */
  resetAt: number;
}

/**
 * A fixed-window limiter held in memory.
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
    check: async (key, now = new Date()): Promise<RateLimitVerdict> => {
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
      return verdict({
        attempts: existing.count,
        maxAttempts: input.maxAttempts,
        windowSeconds: input.windowSeconds,
        endsAtMs: existing.resetAt,
        nowMs,
      });
    },
    reset: async () => {
      windows.clear();
    },
  };
};

/**
 * A fixed-window limiter whose counter every instance shares.
 *
 * Same semantics as the in-memory one, including the boundary burst. **Changing the algorithm and
 * the storage in one slice would make it impossible to say which change caused a difference in
 * behaviour**, so only the storage changed.
 *
 * `scope` namespaces one budget from another - sign-in and password reset count separately, and
 * they now share a table rather than two objects, so the separation has to be in the key.
 *
 * The sweep runs opportunistically here rather than on a schedule. A scheduled job is a job that can
 * stop, and a stopped sweep would leave the table growing; running it on one write in a hundred ties
 * it to the traffic that creates the rows.
 */
export const createSharedRateLimiter = (input: {
  scope: string;
  windowSeconds: number;
  maxAttempts: number;
  /** Injectable so a test can force the sweep instead of waiting for the odds. */
  sweepEvery?: number;
}): RateLimiter => {
  const sweepEvery = input.sweepEvery ?? 100;
  let writes = 0;

  return {
    check: async (key, now = new Date()): Promise<RateLimitVerdict> => {
      const { attempts, windowStartedAt } = await consumeRateLimit({
        scope: input.scope,
        key,
        windowSeconds: input.windowSeconds,
        now,
      });

      writes += 1;
      if (writes % sweepEvery === 0) {
        // Deliberately not awaited into the response path: a slow delete must not make sign-in slow.
        // A failure here is a row that outlives its window, which costs disk and not correctness.
        void sweepRateLimits({ olderThanSeconds: input.windowSeconds * 2, now }).catch(
          () => undefined,
        );
      }

      return verdict({
        attempts,
        maxAttempts: input.maxAttempts,
        windowSeconds: input.windowSeconds,
        // Derived from the STORED window start, not from this request. Two instances handing out
        // different Retry-After values for one counter would be telling a client two things.
        endsAtMs: windowStartedAt.getTime() + input.windowSeconds * 1000,
        nowMs: now.getTime(),
      });
    },
    reset: async () => {
      await clearRateLimits(input.scope);
    },
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
