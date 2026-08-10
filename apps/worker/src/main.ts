/**
 * The Workflow Engine worker process.
 *
 * Runs scheduler -> listener -> engine tick on an interval. This is what turns `tick()` from a
 * tested function into a system that runs on its own.
 *
 * Deliberately minimal: all the logic lives in `@bwc/workflow` where it is testable with an
 * injected clock. This file owns only process concerns - configuration, the system actor,
 * logging, and shutdown.
 */

import 'dotenv/config';
import { hostname } from 'node:os';
import { disconnect } from '@bwc/db';
import { findActor } from '@bwc/identity';
import { startWorker, type PassResult } from '@bwc/workflow';

const intervalMs = Number(process.env['WORKER_INTERVAL_MS'] ?? 5_000);
const batchSize = Number(process.env['WORKER_BATCH_SIZE'] ?? 20);
const workerId = `${hostname()}-${process.pid}`;

/**
 * The worker acts as a specific, real actor - not an anonymous "system" identity.
 *
 * Every ledger event carries an actor, and principle 3 means there are no anonymous state
 * changes. An actor id that does not resolve is a configuration error worth refusing to start
 * over, rather than discovering later as a ledger full of events attributed to nobody.
 */
const resolveActor = async () => {
  const actorId = process.env['WORKER_ACTOR_ID'];
  if (!actorId) {
    throw new Error(
      'WORKER_ACTOR_ID is required. The worker writes ledger events and every event needs a real actor.',
    );
  }
  const actor = await findActor(actorId);
  if (!actor) {
    throw new Error(`WORKER_ACTOR_ID '${actorId}' does not resolve to an actor.`);
  }
  return { id: actor.id, kind: actor.kind };
};

const summarize = (result: PassResult): string =>
  [
    `scheduler(due=${result.scheduler.due} fired=${result.scheduler.fired})`,
    `listener(events=${result.listener.eventsProcessed} waits=${result.listener.waitsResolved} triggers=${result.listener.triggersFired})`,
    `engine(claimed=${result.engine.claimed} advanced=${result.engine.advanced} parked=${result.engine.parked} failed=${result.engine.failed})`,
    `${result.durationMs}ms`,
  ].join(' ');

const main = async (): Promise<void> => {
  const actor = await resolveActor();

  console.log(`bwc-worker ${workerId} starting; interval=${intervalMs}ms batch=${batchSize}`);

  const worker = startWorker({
    workerId,
    actor,
    intervalMs,
    batchSize,
    ...(process.env['WORKER_TENANT_ID'] !== undefined
      ? { tenantId: process.env['WORKER_TENANT_ID'] }
      : {}),
    onPass: (result) => {
      // Quiet when idle: a line per five seconds saying nothing happened buries the lines that
      // matter. Observability proper belongs to System Health (11.8).
      const didSomething =
        result.scheduler.fired > 0 ||
        result.listener.eventsProcessed > 0 ||
        result.engine.claimed > 0 ||
        result.engine.escalated > 0;
      if (didSomething) console.log(summarize(result));
    },
    onError: (error) => {
      // The passes convert expected failures into ledger events, so an exception here is
      // genuinely unexpected. Log it loudly and keep the loop alive.
      console.error('worker pass failed:', error);
    },
  });

  const shutdown = (signal: string) => {
    void (async () => {
      console.log(`\n${signal} received; finishing in-flight pass...`);
      await worker.stop();
      await disconnect();
      console.log('bwc-worker stopped cleanly');
      process.exit(0);
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main().catch(async (error: unknown) => {
  console.error('bwc-worker failed to start:', error);
  await disconnect();
  process.exit(1);
});
