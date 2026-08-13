/**
 * Two things a wait can now do, and the reason each exists.
 *
 * Three seeded message templates had no step that could send them, and the blocker in every case
 * was the same shape: `WaitNode.until` was a duration or an event, an event wait had no timeout,
 * and `slaMinutes` recorded a deadline nothing acted on. So a playbook could wait for a client and
 * could not chase them, and could not wait until a date somebody had written down.
 *
 * **A chase does not move the instance.** That is the property that makes it safe to point at a
 * client. Advancing to a reminder node and back would open a race - the awaited event arrives while
 * the instance is off sending a nudge, the wait re-parks having missed it, and the client who
 * answered promptly gets chased for something they already sent. The wait stays parked and the
 * chase is raised beside it, so the moment the event lands the task stops being `waiting` and
 * `dueReminders` stops returning it.
 *
 * **A context-time wait fails loudly when the moment is missing.** A wait with nothing to resolve
 * to is a workflow that has stopped without saying so.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { append } from '@bwc/ledger';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { openFor } from '@bwc/notifications';
import {
  completeExternalTask,
  findInstance,
  forInstance,
  listenerPass,
  POST_FUNDING_PLAYBOOK,
  POST_FUNDING_TRIGGER,
  publishPlaybook,
  seekToLatest,
  start,
  tick,
  upsertTrigger,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

const T0 = new Date('2026-10-01T09:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const DAY = 60 * 24;

const run = (now: Date) =>
  tick({ workerId: 'reminder-test', now, actor: actor(), tenantId: fx.tenant.id });

/** A wait on documents that chases twice, three days apart. */
const chaseDefinition: PlaybookDefinition = {
  startNode: 'await_documents',
  nodes: {
    await_documents: {
      kind: 'wait',
      until: { event: 'vault.document_stored' },
      remindAfterMinutes: 3 * DAY,
      remindQueue: 'concierge_desk',
      remindSummary: 'Chase the outstanding documents (4.1, document-request-reminder-sms).',
      maxReminders: 2,
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

const startChase = async (key: string, now: Date): Promise<string> => {
  const published = await publishPlaybook({
    key,
    version: 1,
    phase: 0,
    definition: chaseDefinition,
    tenantId: fx.tenant.id,
    actor: actor(),
  });
  expect(published.status, JSON.stringify(published)).toBe('ok');
  const started = await start({
    tenantId: fx.tenant.id,
    playbookKey: key,
    clientId,
    actor: actor(),
    now,
  });
  if (started.status !== 'ok') throw new Error('did not start');
  return started.value.id;
};

const reminders = async (): Promise<number> =>
  (await openFor(fx.tenant.id, 'concierge_desk')).filter(
    (task) => task.kind === 'workflow_reminder',
  ).length;

beforeAll(async () => {
  fx = await makeFixture('wait-reminders');
  clientId = (await createClient(fx.tenant.id, 'Chase Me Holdings LLC', actor())).id;
  await seekToLatest(fx.tenant.id);
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('a wait that chases', () => {
  let instanceId: string;

  beforeAll(async () => {
    instanceId = await startChase(`chase-${fx.tenant.id.slice(0, 8)}`, T0);
    // Park the wait.
    await run(at(1));
  });

  it('does not chase before the interval is up', async () => {
    const before = await reminders();
    await run(at(2 * DAY));
    expect(await reminders()).toBe(before);
  });

  it('raises a chase to the queue the node names, without moving the instance', async () => {
    const nodeBefore = (await findInstance(instanceId))?.currentNodeKey;

    const result = await run(at(3 * DAY + 1));
    expect(result.reminded).toBe(1);

    const raised = (await openFor(fx.tenant.id, 'concierge_desk')).filter(
      (task) => task.kind === 'workflow_reminder',
    );
    expect(raised.length).toBe(1);
    expect(raised[0]?.summary).toMatch(/document-request-reminder-sms/);

    // The instance is exactly where it was. A chase is an assignment to a department, not a step.
    expect((await findInstance(instanceId))?.currentNodeKey).toBe(nodeBefore);
  });

  it('leaves the wait parked, which is what stops a chase outliving its cause', async () => {
    // THE PROPERTY. The task is still `waiting` on its event after being chased - the instance did
    // not advance to a reminder node and back, so there is no window in which the awaited event
    // could arrive unheard.
    const tasks = await forInstance(instanceId);
    const wait = tasks.find((task) => task.nodeKey === 'await_documents');
    expect(wait?.status).toBe('waiting');
    expect(tasks).toHaveLength(1);
  });

  it('chases again after another interval, and then stops at the cap', async () => {
    await run(at(6 * DAY + 2));
    expect(await reminders()).toBe(2);

    // maxReminders is 2. A chase that repeats forever is a chase nobody set out to send.
    await run(at(30 * DAY));
    expect(await reminders()).toBe(2);
  });

  it('stops chasing the moment the thing it was chasing arrives', async () => {
    const fresh = `chase-b-${fx.tenant.id.slice(0, 8)}`;
    const id = await startChase(fresh, at(100));
    await run(at(101));

    await append({
      tenantId: fx.tenant.id,
      type: 'vault.document_stored',
      actor: actor(),
      clientId,
      payload: { note: 'the client answered' },
    });
    await listenerPass({ actor: actor(), now: at(102), tenantId: fx.tenant.id });

    const before = await reminders();
    // Well past the interval. The wait has resolved, so the row is no longer `waiting` and cannot
    // be returned by `dueReminders` - the client who answered is not chased.
    await run(at(100 + 10 * DAY));
    expect(await reminders()).toBe(before);

    const instance = await findInstance(id);
    expect(instance?.status).toBe('completed');
  });
});

describe('a wait until a moment in the context', () => {
  const definition = (offsetMinutes: number): PlaybookDefinition => ({
    startNode: 'book',
    nodes: {
      book: {
        kind: 'agent_task',
        department: 'concierge_desk',
        action: 'Book the call and write reviewCallAt into the context.',
        next: 'await_call',
      },
      await_call: {
        kind: 'wait',
        until: { atContextField: 'reviewCallAt', offsetMinutes },
        next: 'remind',
      },
      remind: {
        kind: 'agent_task',
        department: 'concierge_desk',
        action: 'Send the appointment reminder (4.1, appointment-reminder-sms).',
        next: 'done',
      },
      done: { kind: 'terminal', outcome: 'completed' },
    },
  });

  const walkToWait = async (key: string, callAt: string | undefined, now: Date) => {
    const published = await publishPlaybook({
      key,
      version: 1,
      phase: 0,
      definition: definition(-DAY),
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    expect(published.status).toBe('ok');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key,
      clientId,
      actor: actor(),
      now,
    });
    if (started.status !== 'ok') throw new Error('did not start');

    await tick({ workerId: 'ctx', now, actor: actor(), tenantId: fx.tenant.id });
    const parked = (await forInstance(started.value.id)).find((task) => task.status === 'waiting');
    expect(parked, 'book should be parked').toBeDefined();

    await completeExternalTask(
      fx.tenant.id,
      parked?.id ?? '',
      actor(),
      callAt === undefined ? {} : { reviewCallAt: callAt },
      now,
    );
    return started.value.id;
  };

  it('waits until the offset before the recorded moment, not a fixed period after booking', async () => {
    // Booked on day 0 for a call on day 20. A duration wait could not express this: the gap
    // between booking a call and holding it is exactly what varies.
    const id = await walkToWait(
      `ctx-a-${fx.tenant.id.slice(0, 8)}`,
      at(20 * DAY).toISOString(),
      at(200),
    );

    await tick({ workerId: 'ctx', now: at(201), actor: actor(), tenantId: fx.tenant.id });

    // Day 10: nothing. The reminder is due the day before the call, not ten days before it.
    await tick({ workerId: 'ctx', now: at(10 * DAY), actor: actor(), tenantId: fx.tenant.id });
    let tasks = await forInstance(id);
    expect(tasks.some((task) => task.nodeKey === 'remind')).toBe(false);

    // Day 19 - one day before. Now it advances.
    await tick({ workerId: 'ctx', now: at(19 * DAY), actor: actor(), tenantId: fx.tenant.id });
    tasks = await forInstance(id);
    expect(tasks.some((task) => task.nodeKey === 'remind')).toBe(true);
  });

  it('fails loudly when the moment is not in the context', async () => {
    // A wait with nothing to resolve to is a workflow that has quietly stopped. Failing names the
    // key, so the fix is obvious rather than archaeological.
    const id = await walkToWait(`ctx-b-${fx.tenant.id.slice(0, 8)}`, undefined, at(300));
    await tick({ workerId: 'ctx', now: at(301), actor: actor(), tenantId: fx.tenant.id });

    const wait = (await forInstance(id)).find((task) => task.nodeKey === 'await_call');
    expect(wait?.lastError).toMatch(/reviewCallAt/);
    expect(wait?.lastError).toMatch(/not set/);
  });

  it('resolves immediately when the moment has already passed', async () => {
    // The call is tomorrow and this ran late. Sending the reminder now beats never sending it.
    const id = await walkToWait(
      `ctx-c-${fx.tenant.id.slice(0, 8)}`,
      at(400).toISOString(),
      at(5 * DAY),
    );
    await tick({ workerId: 'ctx', now: at(5 * DAY + 1), actor: actor(), tenantId: fx.tenant.id });

    expect((await forInstance(id)).some((task) => task.nodeKey === 'remind')).toBe(true);
  });
});

describe('the post-funding follow-up, which needed no engine change at all', () => {
  it('starts on the funding event, sleeps three months, and asks for the check-in', async () => {
    // The third blocked template. It was not blocked on a missing capability - `upsertTrigger`
    // starts a playbook from an event and a duration wait can be a start node, so "three months
    // after funding" was already expressible. It was blocked on nobody looking.
    const published = await publishPlaybook({
      key: POST_FUNDING_PLAYBOOK.key,
      version: POST_FUNDING_PLAYBOOK.version,
      phase: POST_FUNDING_PLAYBOOK.phase,
      definition: POST_FUNDING_PLAYBOOK.definition,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    expect(published.status, JSON.stringify(published)).toBe('ok');

    await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: POST_FUNDING_TRIGGER.eventType,
      playbookKey: POST_FUNDING_TRIGGER.playbookKey,
    });
    await seekToLatest(fx.tenant.id);

    await append({
      tenantId: fx.tenant.id,
      type: 'billing.funding_outcome.funded',
      actor: actor(),
      clientId,
      payload: { note: 'the money arrived' },
    });
    const pass = await listenerPass({ actor: actor(), now: at(500), tenantId: fx.tenant.id });
    expect(pass.triggersFired).toBeGreaterThan(0);

    const instances = await db().workflowInstance.findMany({
      where: { tenantId: fx.tenant.id, playbookKey: POST_FUNDING_PLAYBOOK.key },
    });
    expect(instances).toHaveLength(1);
    const id = instances[0]?.id ?? '';

    // A month in: still asleep. The client is living with the facility and has nothing to say yet.
    await run(at(500 + 30 * DAY));
    expect((await forInstance(id)).some((task) => task.nodeKey === 'check_in')).toBe(false);

    // Ninety days: the check-in is raised to the Concierge Desk.
    await run(at(500 + 91 * DAY));
    const tasks = await forInstance(id);
    const checkIn = tasks.find((task) => task.nodeKey === 'check_in');
    expect(checkIn?.department).toBe('concierge_desk');
  });
});
