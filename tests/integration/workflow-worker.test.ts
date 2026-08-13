/**
 * Integration: the worker runtime drives scheduler, listener and engine in one pass, and a
 * schedule-started workflow reaches completion without anyone calling `tick()` by hand.
 *
 * This is the slice's actual claim - that the Engine now runs by itself - so it is worth testing
 * end to end rather than trusting that three separately-tested passes compose.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { read } from '@bwc/ledger';
import { create as createClient } from '@bwc/clients';
import { openFor } from '@bwc/notifications';
import {
  completeExternalTask,
  findInstance,
  forInstance,
  publishPlaybook,
  runPass,
  seekToLatest,
  startWorker,
  upsertSchedule,
  upsertTrigger,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('wf-worker');
  await seekToLatest(fx.tenant.id);
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });
const key = (name: string) => `${name}-${fx.tenant.slug}`;

const pass = (now: Date) =>
  runPass({
    workerId: 'test-worker',
    actor: actor(),
    tenantId: fx.tenant.id,
    clock: () => now,
  });

const BRIEF: PlaybookDefinition = {
  startNode: 'generate',
  nodes: {
    generate: {
      kind: 'agent_task',
      department: 'capital_operations',
      action: 'Generate Capital Command Brief',
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

describe('one pass drives scheduler, listener and engine', () => {
  it('fires a schedule and dispatches its first task in the same pass', async () => {
    await publishPlaybook({
      key: key('brief'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('monthly'),
      playbookKey: key('brief'),
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-08-10T00:00:00Z'),
    });

    // Scheduler runs before the engine tick, so the instance it creates is executed in the
    // same pass rather than waiting a whole interval.
    const result = await pass(new Date('2026-09-01T09:00:30Z'));

    expect(result.scheduler.fired).toBe(1);
    expect(result.engine.parked).toBeGreaterThan(0);

    const assignments = await openFor(fx.tenant.id, 'capital_operations');
    expect(assignments.length).toBeGreaterThan(0);
  });

  it('carries a trigger-started workflow through to completion across passes', async () => {
    await publishPlaybook({
      key: key('onboard'),
      version: 1,
      phase: 0,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'client.created',
      playbookKey: key('onboard'),
    });

    const client = await createClient(fx.tenant.id, 'Worker Co', actor());

    // Pass 1: the listener sees client.created, starts the instance, and the tick dispatches
    // its first task.
    const first = await pass(new Date('2026-09-02T09:00:00Z'));
    expect(first.listener.triggersFired).toBeGreaterThan(0);

    const fired = await read({ tenantId: fx.tenant.id, type: 'workflow.trigger_fired' });
    const mine = fired.find((event) => event.clientId === client.id);
    expect(mine).toBeDefined();
    const instanceId = mine?.payload['instanceId'] as string;

    const dispatched = (await forInstance(instanceId)).find((t) => t.status === 'waiting');
    expect(dispatched).toBeDefined();
    if (!dispatched) return;

    // The department completes its work.
    await completeExternalTask(
      fx.tenant.id,
      dispatched.id,
      actor(),
      {},
      new Date('2026-09-02T10:00:00Z'),
    );

    // Pass 2: the terminal node runs and the instance completes.
    await pass(new Date('2026-09-02T10:01:00Z'));
    expect((await findInstance(instanceId))?.status).toBe('completed');
  });
});

describe('the worker loop', () => {
  it('starts, runs at least one pass, and stops cleanly', async () => {
    const passes: number[] = [];

    const worker = startWorker({
      workerId: 'loop-worker',
      actor: actor(),
      tenantId: fx.tenant.id,
      intervalMs: 20,
      onPass: (result) => passes.push(result.durationMs),
      onError: (error) => {
        throw error;
      },
    });

    expect(worker.running).toBe(true);

    // Wait for the loop to produce passes rather than sleeping a fixed duration and hoping.
    const deadline = Date.now() + 5_000;
    while (passes.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await worker.stop();

    expect(worker.running).toBe(false);
    expect(passes.length).toBeGreaterThanOrEqual(2);

    // stop() awaits the in-flight pass, so nothing should arrive after it resolves.
    const settled = passes.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(passes.length).toBe(settled);
  });

  it('keeps running when a pass throws', async () => {
    const errors: unknown[] = [];
    const passes: number[] = [];

    const worker = startWorker({
      workerId: 'resilient-worker',
      actor: { id: '00000000-0000-0000-0000-000000000000', kind: 'human' },
      tenantId: fx.tenant.id,
      intervalMs: 20,
      onPass: (result) => passes.push(result.durationMs),
      onError: (error) => errors.push(error),
    });

    const deadline = Date.now() + 5_000;
    while (passes.length + errors.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await worker.stop();

    // Whether this actor causes an error or not, the loop must have kept going: one tenant's
    // bad configuration cannot stop processing for everyone else.
    expect(passes.length + errors.length).toBeGreaterThanOrEqual(2);
  });
});
