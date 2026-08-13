/**
 * Invariants for the scheduler - Specification v2 §10.1, "scheduled workflows fire on time".
 *
 * The two properties that decay silently are DST correctness and catch-up behaviour. Neither
 * produces an error: a brief an hour early for half the year looks fine, and a worker restart
 * emitting six months of briefs at once looks like a busy morning.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '@bwc/db';
import { read } from '@bwc/ledger';
import {
  findSchedule,
  nextOccurrence,
  publishPlaybook,
  schedulerPass,
  setScheduleEnabled,
  upsertSchedule,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('wf-sched');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });
const key = (name: string) => `${name}-${fx.tenant.slug}`;

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

const pass = (now: Date) => schedulerPass({ actor: actor(), now, tenantId: fx.tenant.id });

describe('cron evaluation', () => {
  it('keeps wall-clock time across a DST transition', () => {
    // 09:00 America/Los_Angeles. PDT is UTC-7, PST is UTC-8, so the UTC instant must move
    // while the local hour stays put. A naive implementation keeps the UTC instant instead,
    // which silently shifts every brief by an hour for half the year.
    const summer = nextOccurrence(
      '0 9 1 * *',
      'America/Los_Angeles',
      new Date('2026-08-10T00:00:00Z'),
    );
    const winter = nextOccurrence(
      '0 9 1 * *',
      'America/Los_Angeles',
      new Date('2026-10-15T00:00:00Z'),
    );

    expect(summer.status).toBe('ok');
    expect(winter.status).toBe('ok');
    if (summer.status !== 'ok' || winter.status !== 'ok') return;

    expect(summer.value.toISOString()).toBe('2026-09-01T16:00:00.000Z'); // 09:00 PDT
    expect(winter.value.toISOString()).toBe('2026-11-01T17:00:00.000Z'); // 09:00 PST
  });

  it('refuses an invalid expression rather than throwing', () => {
    const result = nextOccurrence('not a cron', 'UTC', new Date());
    expect(result.status).toBe('refused');
  });

  it('refuses an unknown timezone', () => {
    const result = nextOccurrence('0 9 1 * *', 'Mars/Olympus_Mons', new Date());
    expect(result.status).toBe('refused');
  });
});

describe('scheduler firing', () => {
  it('fires a due schedule once and advances to the next occurrence', async () => {
    await publishPlaybook({
      key: key('brief'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    const created = await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('monthly-brief'),
      playbookKey: key('brief'),
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-08-10T00:00:00Z'),
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    expect(created.value.nextRunAt.toISOString()).toBe('2026-09-01T09:00:00.000Z');

    // Before it is due, nothing fires.
    expect((await pass(new Date('2026-08-31T23:59:00Z'))).fired).toBe(0);

    const fired = await pass(new Date('2026-09-01T09:00:30Z'));
    expect(fired.fired).toBe(1);

    const after = await findSchedule(fx.tenant.id, key('monthly-brief'));
    expect(after?.nextRunAt.toISOString()).toBe('2026-10-01T09:00:00.000Z');

    // Immediately re-running must not fire again.
    expect((await pass(new Date('2026-09-01T09:01:00Z'))).fired).toBe(0);
  });

  it('fires once after a long outage rather than once per missed window', async () => {
    await publishPlaybook({
      key: key('brief-catchup'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('catchup'),
      playbookKey: key('brief-catchup'),
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-01-10T00:00:00Z'),
    });

    // The worker has been down since February; it is now June. Six windows were missed.
    const result = await pass(new Date('2026-06-15T12:00:00Z'));
    expect(result.fired).toBe(1);

    const after = await findSchedule(fx.tenant.id, key('catchup'));
    expect(after?.nextRunAt.toISOString()).toBe('2026-07-01T09:00:00.000Z');

    // The gap is recorded rather than erased.
    const late = await read({ tenantId: fx.tenant.id, type: 'workflow.schedule_late' });
    expect(late.some((event) => event.payload['scheduleKey'] === key('catchup'))).toBe(true);
  });

  it('fires a due schedule exactly once under concurrent passes', async () => {
    await publishPlaybook({
      key: key('brief-race'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('race'),
      playbookKey: key('brief-race'),
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-08-10T00:00:00Z'),
    });

    const at = new Date('2026-09-01T09:00:30Z');
    const [a, b] = await Promise.all([pass(at), pass(at)]);

    // Assert on THIS schedule, not on the pass totals: other schedules in the tenant may also
    // be due at this instant, and a tenant-wide count would pass or fail for reasons unrelated
    // to the race being tested.
    const fired = await read({ tenantId: fx.tenant.id, type: 'workflow.schedule_fired' });
    const mine = fired.filter((event) => event.payload['scheduleKey'] === key('race'));

    // Exactly one winner. A duplicate here is a duplicated client deliverable.
    expect(mine).toHaveLength(1);
    expect(a.skippedLost + b.skippedLost).toBeGreaterThanOrEqual(1);
  });

  it('does nothing for a disabled schedule', async () => {
    await publishPlaybook({
      key: key('brief-off'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('disabled'),
      playbookKey: key('brief-off'),
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-08-10T00:00:00Z'),
    });
    await setScheduleEnabled(fx.tenant.id, key('disabled'), false);

    const result = await pass(new Date('2026-09-01T09:00:30Z'));
    expect(result.due).toBe(0);
    expect(result.fired).toBe(0);
  });

  it('disables a schedule whose playbook does not exist, rather than retrying forever', async () => {
    await publishPlaybook({
      key: key('brief-ghost'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('ghost'),
      playbookKey: 'no-such-playbook-anywhere',
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-08-10T00:00:00Z'),
    });

    const result = await pass(new Date('2026-09-01T09:00:30Z'));
    expect(result.failed).toBe(1);

    // The failure is a ledger event, not a silent skip (§10.5).
    const failures = await read({ tenantId: fx.tenant.id, type: 'workflow.failed' });
    expect(failures.some((event) => event.payload['scheduleKey'] === key('ghost'))).toBe(true);
  });

  it('stores the timezone rather than assuming UTC', async () => {
    await publishPlaybook({
      key: key('brief-tz'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('tz'),
      playbookKey: key('brief-tz'),
      cronExpression: '0 9 1 * *',
      timezone: 'America/Los_Angeles',
      now: new Date('2026-08-10T00:00:00Z'),
    });

    const stored = await findSchedule(fx.tenant.id, key('tz'));
    expect(stored?.timezone).toBe('America/Los_Angeles');
    expect(stored?.nextRunAt.toISOString()).toBe('2026-09-01T16:00:00.000Z');
  });

  it('records the instance it started', async () => {
    await publishPlaybook({
      key: key('brief-inst'),
      version: 1,
      phase: 2,
      definition: BRIEF,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    await upsertSchedule({
      tenantId: fx.tenant.id,
      key: key('inst'),
      playbookKey: key('brief-inst'),
      cronExpression: '0 9 1 * *',
      timezone: 'UTC',
      now: new Date('2026-08-10T00:00:00Z'),
    });

    await pass(new Date('2026-09-01T09:00:30Z'));

    const fired = await read({ tenantId: fx.tenant.id, type: 'workflow.schedule_fired' });
    const mine = fired.find((event) => event.payload['scheduleKey'] === key('inst'));
    expect(mine).toBeDefined();

    const instanceId = mine?.payload['instanceId'] as string;
    const instance = await db().workflowInstance.findUnique({ where: { id: instanceId } });
    expect(instance?.playbookKey).toBe(key('brief-inst'));
  });
});
