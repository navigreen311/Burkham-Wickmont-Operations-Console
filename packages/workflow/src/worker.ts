/**
 * The worker runtime.
 *
 * `tick()`, `schedulerPass()` and `listenerPass()` are each pure-ish functions taking a clock,
 * which is what makes them testable. This is the thing that calls them on an interval.
 *
 * Order within a pass matters:
 *   1. scheduler  - may create new instances whose first task is immediately due
 *   2. listener   - may resolve waits and create instances, also immediately due
 *   3. tick       - executes everything now runnable, including what 1 and 2 just produced
 *
 * Running `tick` first would leave anything the other two produced sitting until the next
 * interval. Not wrong, but it doubles the latency of every event-driven workflow for no reason.
 *
 * A pass never runs concurrently with itself. If a pass overruns the interval the next one is
 * skipped rather than queued, because overlapping passes would mean two workers' worth of
 * claiming from a single process, and a backlog of skipped passes cannot be worked off anyway.
 */

import type { EventActor } from '@bwc/core';
import { tick, type TickResult } from './engine.js';
import { schedulerPass, type SchedulerPassResult } from './scheduler.js';
import { listenerPass, type ListenerPassResult } from './listener.js';

export interface WorkerOptions {
  readonly workerId: string;
  readonly actor: EventActor;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly tenantId?: string;
  /** Injectable for tests; defaults to the real clock. */
  readonly clock?: () => Date;
  readonly onPass?: (result: PassResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface PassResult {
  readonly at: Date;
  readonly scheduler: SchedulerPassResult;
  readonly listener: ListenerPassResult;
  readonly engine: TickResult;
  readonly durationMs: number;
}

/**
 * Run one complete pass. Exported so a test, a one-shot CLI, or a health check can drive the
 * engine without starting a loop.
 */
export const runPass = async (options: WorkerOptions): Promise<PassResult> => {
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const startedAt = Date.now();

  const scheduler = await schedulerPass({
    actor: options.actor,
    now,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });

  const listener = await listenerPass({
    actor: options.actor,
    now,
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });

  const engine = await tick({
    workerId: options.workerId,
    actor: options.actor,
    now,
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
  });

  return { at: now, scheduler, listener, engine, durationMs: Date.now() - startedAt };
};

export interface Worker {
  /** Resolves once the loop has stopped and any in-flight pass has finished. */
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * Start the loop.
 *
 * A pass that throws is reported and the loop continues. One tenant's bad configuration must not
 * take down processing for every other tenant - and the individual passes already convert
 * expected failures into ledger events rather than exceptions, so an exception reaching here is
 * genuinely unexpected and worth surfacing loudly.
 */
export const startWorker = (options: WorkerOptions): Worker => {
  const intervalMs = options.intervalMs ?? 5_000;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loop = (): void => {
    if (stopped) return;

    inFlight = runPass(options)
      .then((result) => {
        options.onPass?.(result);
      })
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, intervalMs);
      });
  };

  loop();

  return {
    get running() {
      return !stopped;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Wait for the in-flight pass so shutdown does not abandon a claim mid-execution; the
      // lease would eventually reclaim it, but only after the lease expires.
      await inFlight;
    },
  };
};
