/**
 * Invariant: raw SQL timestamp comparisons agree with Prisma's typed queries.
 *
 * Regression guard for a bug that produced no error and no exception - only the wrong rows.
 *
 * Prisma maps `DateTime` to a naive `timestamp(3)` column holding UTC. Binding a JS `Date` into
 * a raw query sends a *timestamptz*, and Postgres compares it against the naive column by
 * converting through the session timezone, shifting the comparison by the local UTC offset. On a
 * UTC machine the two agree and the bug is invisible; on any other machine the task queue claims
 * the wrong tasks - early, late, or not at all.
 *
 * This is why the test asserts agreement between the two query paths rather than asserting a
 * fixed count: the property is "raw SQL and Prisma see the same rows", and it must hold whatever
 * timezone the machine or CI runner is in.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '@bwc/db';
import { claim, enqueue, publishPlaybook, start, type PlaybookDefinition } from '@bwc/workflow';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('raw-ts');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const SIMPLE: PlaybookDefinition = {
  startNode: 'only',
  nodes: {
    only: { kind: 'agent_task', department: 'capital_readiness', action: 'x', next: 'done' },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

describe('raw SQL timestamps match Prisma timestamps', () => {
  it('claims exactly the tasks Prisma reports as due', async () => {
    const key = `raw-ts-${fx.tenant.slug}`;
    await publishPlaybook({
      key,
      version: 1,
      phase: 0,
      definition: SIMPLE,
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    // A time deliberately far from "now", so any timezone shift changes the answer.
    const anchor = new Date('2026-08-10T09:00:00.000Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key,
      actor: { id: fx.human.id, kind: 'human' },
      now: anchor,
    });
    if (started.status !== 'ok') throw new Error('start failed');

    // Two more: one an hour before the anchor, one an hour after.
    await enqueue({
      tenantId: fx.tenant.id,
      instanceId: started.value.id,
      nodeKey: 'earlier',
      kind: 'wait',
      runAt: new Date(anchor.getTime() - 60 * 60_000),
    });
    await enqueue({
      tenantId: fx.tenant.id,
      instanceId: started.value.id,
      nodeKey: 'later',
      kind: 'wait',
      runAt: new Date(anchor.getTime() + 60 * 60_000),
    });

    const dueAccordingToPrisma = await db().workflowTask.findMany({
      where: { tenantId: fx.tenant.id, status: 'pending', runAt: { lte: anchor } },
      select: { id: true },
    });

    const claimed = await claim('ts-worker', 100, anchor, 300, fx.tenant.id);

    expect(claimed).toHaveLength(dueAccordingToPrisma.length);
    expect(new Set(claimed.map((task) => task.id))).toEqual(
      new Set(dueAccordingToPrisma.map((task) => task.id)),
    );

    // And the one an hour in the future is genuinely excluded, not merely absent by luck.
    const nodeKeys = claimed.map((task) => task.nodeKey);
    expect(nodeKeys).toContain('only');
    expect(nodeKeys).toContain('earlier');
    expect(nodeKeys).not.toContain('later');
  });

  it('does not shift the boundary: a task due exactly at now is claimed', async () => {
    const key = `raw-ts-boundary-${fx.tenant.slug}`;
    await publishPlaybook({
      key,
      version: 1,
      phase: 0,
      definition: SIMPLE,
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    const anchor = new Date('2026-12-25T00:00:00.000Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key,
      actor: { id: fx.human.id, kind: 'human' },
      now: anchor,
    });
    if (started.status !== 'ok') throw new Error('start failed');

    // `runAt <= now` at exactly the boundary. A timezone shift in either direction breaks this.
    const claimed = await claim('boundary-worker', 100, anchor, 300, fx.tenant.id);
    expect(claimed.map((task) => task.nodeKey)).toContain('only');
  });
});
