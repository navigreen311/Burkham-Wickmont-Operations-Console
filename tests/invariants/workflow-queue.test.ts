/**
 * Invariants for the durable task queue - Specification v2 §5.3, §10.5.
 *
 * The properties that matter are the ones that only show up under failure: a task claimed twice,
 * a task lost when a worker dies, a retry that never gives up, a dead-lettered task that runs
 * again anyway. Each is tested by causing the failure, not by asserting the happy path and
 * hoping.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '@bwc/db';
import { read } from '@bwc/ledger';
import {
  MAX_BACKOFF_SECONDS,
  backoffFor,
  claim,
  enqueue,
  fail,
  publishPlaybook,
  reclaimExpiredLeases,
  start,
  tick,
  forInstance,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('wf-queue');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

/** Playbooks outlive a test run, so keys are made unique per run. */
const key = (name: string) => `${name}-${fx.tenant.slug}`;

/** Every claim in this file is tenant-scoped so sibling tests cannot drain each other. */
const claimMine = (worker: string, limit: number, now: Date, lease?: number) =>
  claim(worker, limit, now, lease, fx.tenant.id);

/** Minimal valid playbook: one agent task then done. */
const SIMPLE: PlaybookDefinition = {
  startNode: 'collect',
  nodes: {
    collect: {
      kind: 'agent_task',
      department: 'capital_readiness',
      action: 'collect documents',
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

const newInstance = async (name: string, now: Date = new Date()) => {
  const playbookKey = key(name);
  await publishPlaybook({
    key: playbookKey,
    version: 1,
    phase: 0,
    definition: SIMPLE,
    tenantId: fx.tenant.id,
    actor: actor(),
  });
  const started = await start({ tenantId: fx.tenant.id, playbookKey, actor: actor(), now });
  if (started.status !== 'ok') throw new Error(`could not start: ${JSON.stringify(started)}`);
  return started.value;
};

describe('claim is exclusive', () => {
  it('gives a task to exactly one of two concurrent workers', async () => {
    const instance = await newInstance('queue-exclusive');
    const now = new Date();

    // Both workers claim at the same instant. SKIP LOCKED must partition the rows, not
    // duplicate them - a task dispatched twice means a client contacted twice.
    const [a, b] = await Promise.all([
      claimMine('worker-a', 10, now),
      claimMine('worker-b', 10, now),
    ]);

    const ids = [...a, ...b].map((task) => task.id);
    const mine = ids.filter((id) => a.some((t) => t.id === id) || b.some((t) => t.id === id));

    expect(new Set(mine).size).toBe(mine.length);
    expect(a.length + b.length).toBe(1);
    expect(instance.id).toBeTruthy();
  });

  it('does not claim a task whose runAt is in the future', async () => {
    const instance = await newInstance('queue-future');
    const tasks = await forInstance(instance.id);
    const task = tasks[0];
    if (!task) throw new Error('expected a task');

    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    await db().workflowTask.update({ where: { id: task.id }, data: { runAt: future } });

    // A wait measured in months is the same code path as one measured in seconds.
    expect(await claimMine('worker-x', 10, new Date())).toHaveLength(0);
    expect((await claimMine('worker-x', 10, new Date(future.getTime() + 1000))).length).toBe(1);
  });
});

describe('lease reclaim recovers from a dead worker', () => {
  it('returns an abandoned running task to pending without losing it', async () => {
    const instance = await newInstance('queue-reclaim');
    const now = new Date();

    const [claimed] = await claimMine('doomed-worker', 10, now, 60);
    if (!claimed) throw new Error('expected a claim');
    expect(claimed.status).toBe('running');

    // The worker dies. Nothing completes the task; without reclaim it sits in `running` forever,
    // which is a silent stall (§10.5).
    const afterLease = new Date(now.getTime() + 61_000);
    const reclaimed = await reclaimExpiredLeases(afterLease, fx.tenant.id);

    expect(reclaimed.map((t) => t.id)).toContain(claimed.id);
    expect((await claimMine('healthy-worker', 10, afterLease)).map((t) => t.id)).toContain(
      claimed.id,
    );
    expect(instance.id).toBeTruthy();
  });

  it('does not reset attempts on reclaim, so a poison task still exhausts its retries', async () => {
    const instance = await newInstance('queue-poison');
    const now = new Date();

    const [first] = await claimMine('w1', 10, now, 30);
    if (!first) throw new Error('expected a claim');
    expect(first.attempts).toBe(1);

    await reclaimExpiredLeases(new Date(now.getTime() + 31_000), fx.tenant.id);
    const [second] = await claimMine('w2', 10, new Date(now.getTime() + 32_000), 30);

    // Were attempts reset, a task that kills every worker would loop forever.
    expect(second?.attempts).toBe(2);
    expect(instance.id).toBeTruthy();
  });
});

describe('retry policy', () => {
  it('grows backoff exponentially and caps it', () => {
    expect(backoffFor(1, 30)).toBe(30);
    expect(backoffFor(2, 30)).toBe(60);
    expect(backoffFor(3, 30)).toBe(120);
    expect(backoffFor(50, 30)).toBe(MAX_BACKOFF_SECONDS);
  });

  it('retries until maxAttempts, then dead-letters', async () => {
    const instance = await newInstance('queue-retry');
    const now = new Date();

    const [task] = await claimMine('w', 10, now);
    if (!task) throw new Error('expected a claim');

    const first = await fail({ ...task, attempts: 1, maxAttempts: 3 }, 'boom', now);
    expect(first.outcome).toBe('retry_scheduled');

    const second = await fail({ ...task, attempts: 2, maxAttempts: 3 }, 'boom', now);
    expect(second.outcome).toBe('retry_scheduled');

    const third = await fail({ ...task, attempts: 3, maxAttempts: 3 }, 'boom', now);
    expect(third.outcome).toBe('dead_lettered');

    const row = await db().workflowTask.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe('dead_letter');
    expect(instance.id).toBeTruthy();
  });

  it('never claims a dead-lettered task again', async () => {
    const instance = await newInstance('queue-deadletter');
    const now = new Date();
    const [task] = await claimMine('w', 10, now);
    if (!task) throw new Error('expected a claim');

    await fail({ ...task, attempts: 99, maxAttempts: 1 }, 'terminal failure', now);

    const later = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect((await claimMine('w', 10, later)).map((t) => t.id)).not.toContain(task.id);
    expect((await reclaimExpiredLeases(later, fx.tenant.id)).map((t) => t.id)).not.toContain(
      task.id,
    );
    expect(instance.id).toBeTruthy();
  });
});

describe('zero silent workflow failures', () => {
  it('writes a ledger event for every failure, retry and dead-letter', async () => {
    // A playbook whose node vanishes: the task will fail on execution rather than by injection,
    // so this exercises the real failure path through tick().
    const playbookKey = key('queue-events');
    await publishPlaybook({
      key: playbookKey,
      version: 1,
      phase: 0,
      definition: {
        startNode: 'ghost',
        nodes: {
          ghost: {
            kind: 'agent_task',
            department: 'x',
            action: 'y',
            next: 'done',
            maxAttempts: 2,
            backoffSeconds: 1,
          },
          done: { kind: 'terminal', outcome: 'completed' },
        },
      },
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    const t0 = new Date();
    const started = await start({ tenantId: fx.tenant.id, playbookKey, actor: actor(), now: t0 });
    if (started.status !== 'ok') throw new Error('start failed');

    // Remove the node the queued task points at, so execution fails deterministically.
    await db().playbook.update({
      where: { key_version: { key: playbookKey, version: 1 } },
      data: {
        definition: {
          startNode: 'ghost',
          nodes: { done: { kind: 'terminal', outcome: 'completed' } },
        } as object,
      },
    });

    await tick({ workerId: 'w', now: t0, actor: actor(), tenantId: fx.tenant.id });
    await tick({
      workerId: 'w',
      now: new Date(t0.getTime() + 10_000),
      actor: actor(),
      tenantId: fx.tenant.id,
    });

    const events = await read({ tenantId: fx.tenant.id });
    const types = new Set(events.map((event) => event.type));

    expect(types.has('workflow.task_failed')).toBe(true);
    expect(types.has('workflow.task_retry_scheduled')).toBe(true);
    expect(types.has('workflow.task_dead_lettered')).toBe(true);
    // A dead-letter ends the instance rather than leaving it running with nothing to do.
    expect(types.has('workflow.failed')).toBe(true);

    const instance = await db().workflowInstance.findUnique({ where: { id: started.value.id } });
    expect(instance?.status).toBe('failed');
  });
});

describe('enqueue defaults', () => {
  it('accepts an explicit runAt far in the future without special-casing', async () => {
    const instance = await newInstance('queue-enqueue');
    const threeMonths = new Date(Date.now() + 92 * 24 * 60 * 60 * 1000);
    const task = await enqueue({
      tenantId: fx.tenant.id,
      instanceId: instance.id,
      nodeKey: 'later',
      kind: 'wait',
      runAt: threeMonths,
    });
    expect(task.runAt.getTime()).toBe(threeMonths.getTime());
  });
});
