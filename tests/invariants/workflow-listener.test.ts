/**
 * Invariants for the Event Ledger listener - Specification v2 §5.3.
 *
 * The load-bearing property is exactly-once. A duplicated workflow here is duplicated client
 * outreach, and the failure is invisible from inside the system: two instances both look
 * legitimate. So the tests replay events deliberately rather than assuming the cursor is enough.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '@bwc/db';
import { append, read } from '@bwc/ledger';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import {
  assertNotSelfTriggering,
  listenerPass,
  publishPlaybook,
  seekToLatest,
  setTriggerEnabled,
  start,
  tick,
  upsertTrigger,
  forInstance,
  findInstance,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('wf-listen');
  // Skip the fixture's own setup events so triggers do not fire on history.
  await seekToLatest(fx.tenant.id);
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });
const key = (name: string) => `${name}-${fx.tenant.slug}`;
const listen = (now: Date) => listenerPass({ actor: actor(), now, tenantId: fx.tenant.id });

const ONBOARDING: PlaybookDefinition = {
  startNode: 'welcome',
  nodes: {
    welcome: {
      kind: 'agent_task',
      department: 'concierge_desk',
      action: 'Send welcome',
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

/** A playbook that parks on an event wait. */
const AWAIT_DOCS: PlaybookDefinition = {
  startNode: 'await_upload',
  nodes: {
    await_upload: {
      kind: 'wait',
      until: { event: 'consent.granted' },
      next: 'proceed',
    },
    proceed: {
      kind: 'agent_task',
      department: 'capital_readiness',
      action: 'Process',
      next: 'done',
    },
    done: { kind: 'terminal', outcome: 'completed' },
  },
};

describe('triggers fire exactly once', () => {
  it('starts a workflow when a matching event is written', async () => {
    await publishPlaybook({ key: key('onboarding'), version: 1, phase: 0, definition: ONBOARDING });
    await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'client.created',
      playbookKey: key('onboarding'),
    });

    const client = await createClient(fx.tenant.id, 'Triggered Co', actor());

    const result = await listen(new Date('2026-08-10T10:00:00Z'));
    expect(result.triggersFired).toBeGreaterThan(0);

    const fired = await read({ tenantId: fx.tenant.id, type: 'workflow.trigger_fired' });
    expect(fired.some((event) => event.clientId === client.id)).toBe(true);
  });

  it('does not fire twice when the same event is replayed', async () => {
    await publishPlaybook({
      key: key('onboarding-2'),
      version: 1,
      phase: 0,
      definition: ONBOARDING,
    });
    const trigger = await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'client.created',
      playbookKey: key('onboarding-2'),
    });

    const client = await createClient(fx.tenant.id, 'Replay Co', actor());
    await listen(new Date('2026-08-10T10:00:00Z'));

    // Identify the exact ledger event, and count firings for that pair only. A tenant-wide
    // count would also move when the replay legitimately shows this trigger older events it
    // had not seen before - which is correct behaviour, and not what is under test here.
    const creations = await read({ tenantId: fx.tenant.id, type: 'client.created' });
    const thisEvent = creations.find((event) => event.clientId === client.id);
    if (!thisEvent) throw new Error('expected the client.created event');

    const firingsFor = () =>
      db().workflowTriggerFiring.count({
        where: { triggerId: trigger.id, ledgerEventId: thisEvent.id },
      });

    expect(await firingsFor()).toBe(1);

    // Simulate a crash between starting the instance and advancing the cursor: rewind the
    // cursor so the same events are read again. Idempotency must come from the unique
    // constraint, not from the cursor being correct.
    await db().ledgerCursor.update({
      where: { tenantId_consumer: { tenantId: fx.tenant.id, consumer: 'workflow_listener' } },
      data: { lastSeq: 0 },
    });

    const replay = await listen(new Date('2026-08-10T10:05:00Z'));
    expect(replay.duplicatesSkipped).toBeGreaterThan(0);

    // Still exactly one: the replay hit the unique constraint rather than starting a second
    // workflow for the same client.
    expect(await firingsFor()).toBe(1);
  });

  it('respects a condition, firing only when the predicate holds', async () => {
    await publishPlaybook({ key: key('escalate'), version: 1, phase: 0, definition: ONBOARDING });
    await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'client.compliance_state_changed',
      playbookKey: key('escalate'),
      condition: { field: 'context.to', op: 'eq', value: 'fail' },
    });

    const passing = await createClient(fx.tenant.id, 'Passing Co', actor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: passing.id,
      to: 'pass',
      reason: 'assessed',
      actor: actor(),
    });
    await listen(new Date('2026-08-10T11:00:00Z'));

    const firedFor = async (clientId: string) =>
      (await read({ tenantId: fx.tenant.id, type: 'workflow.trigger_fired' })).filter(
        (event) => event.clientId === clientId && event.payload['playbookKey'] === key('escalate'),
      );

    // Other triggers in this file also fire on client.created, so match the playbook too.
    expect(await firedFor(passing.id)).toHaveLength(0);

    const failing = await createClient(fx.tenant.id, 'Failing Co', actor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: failing.id,
      to: 'fail',
      reason: 'material finding',
      actor: actor(),
    });
    await listen(new Date('2026-08-10T11:05:00Z'));

    expect(await firedFor(failing.id)).toHaveLength(1);
  });

  it('disables a trigger whose condition is malformed instead of firing on everything', async () => {
    await publishPlaybook({
      key: key('broken-cond'),
      version: 1,
      phase: 0,
      definition: ONBOARDING,
    });
    const trigger = await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'consent.granted',
      playbookKey: key('broken-cond'),
      // Unknown operator: neither "fire on everything" nor "fire on nothing" is acceptable.
      condition: { field: 'context.kind', op: 'matches' } as never,
    });

    await append({
      tenantId: fx.tenant.id,
      type: 'consent.granted',
      actor: actor(),
      payload: { kind: 'application', scope: 'app-x' },
    });
    await listen(new Date('2026-08-10T12:00:00Z'));

    const row = await db().workflowTrigger.findUnique({ where: { id: trigger.id } });
    expect(row?.enabled).toBe(false);

    const failures = await read({ tenantId: fx.tenant.id, type: 'workflow.failed' });
    expect(failures.some((event) => event.payload['triggerId'] === trigger.id)).toBe(true);
  });

  it('does nothing for a disabled trigger', async () => {
    await publishPlaybook({
      key: key('disabled-trig'),
      version: 1,
      phase: 0,
      definition: ONBOARDING,
    });
    const trigger = await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'firewall.triggered',
      playbookKey: key('disabled-trig'),
    });
    await setTriggerEnabled(trigger.id, false);

    await append({
      tenantId: fx.tenant.id,
      type: 'firewall.triggered',
      actor: actor(),
      payload: { reason: 'test' },
    });
    await listen(new Date('2026-08-10T13:00:00Z'));

    expect(await db().workflowTriggerFiring.count({ where: { triggerId: trigger.id } })).toBe(0);
  });

  it('refuses a trigger that would feed itself', () => {
    expect(assertNotSelfTriggering('workflow.started', 'anything').status).toBe('refused');
    expect(assertNotSelfTriggering('client.created', 'anything').status).toBe('ok');
  });
});

describe('event waits resolve', () => {
  it('resolves a parked wait when its event arrives, and not before', async () => {
    await publishPlaybook({ key: key('await-docs'), version: 1, phase: 0, definition: AWAIT_DOCS });

    const client = await createClient(fx.tenant.id, 'Waiting Co', actor());
    const t0 = new Date('2026-08-10T14:00:00Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('await-docs'),
      clientId: client.id,
      actor: actor(),
      now: t0,
    });
    if (started.status !== 'ok') throw new Error('start failed');

    // The tick parks the wait task.
    await tick({ workerId: 'w', now: t0, actor: actor(), tenantId: fx.tenant.id });
    const parked = (await forInstance(started.value.id)).find((t) => t.nodeKey === 'await_upload');
    expect(parked?.status).toBe('waiting');

    // An unrelated event must not wake it.
    await append({
      tenantId: fx.tenant.id,
      type: 'firewall.cleared',
      actor: actor(),
      clientId: client.id,
      payload: { justification: 'unrelated' },
    });
    await listen(new Date('2026-08-10T14:05:00Z'));
    expect(
      (await forInstance(started.value.id)).find((t) => t.nodeKey === 'await_upload')?.status,
    ).toBe('waiting');

    // The awaited event does.
    await append({
      tenantId: fx.tenant.id,
      type: 'consent.granted',
      actor: actor(),
      clientId: client.id,
      payload: { kind: 'application', scope: 'app-1' },
    });
    const resolved = await listen(new Date('2026-08-10T14:10:00Z'));
    expect(resolved.waitsResolved).toBeGreaterThan(0);

    await tick({
      workerId: 'w',
      now: new Date('2026-08-10T14:11:00Z'),
      actor: actor(),
      tenantId: fx.tenant.id,
    });
    expect((await findInstance(started.value.id))?.currentNodeKey).toBe('proceed');
  });

  it("does not wake another client's waiting workflow", async () => {
    await publishPlaybook({
      key: key('await-docs-b'),
      version: 1,
      phase: 0,
      definition: AWAIT_DOCS,
    });

    const mine = await createClient(fx.tenant.id, 'Mine Co', actor());
    const other = await createClient(fx.tenant.id, 'Other Co', actor());

    const t0 = new Date('2026-08-10T15:00:00Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('await-docs-b'),
      clientId: mine.id,
      actor: actor(),
      now: t0,
    });
    if (started.status !== 'ok') throw new Error('start failed');
    await tick({ workerId: 'w', now: t0, actor: actor(), tenantId: fx.tenant.id });

    // The right event type, but about a different client.
    await append({
      tenantId: fx.tenant.id,
      type: 'consent.granted',
      actor: actor(),
      clientId: other.id,
      payload: { kind: 'application', scope: 'app-other' },
    });
    await listen(new Date('2026-08-10T15:05:00Z'));

    expect(
      (await forInstance(started.value.id)).find((t) => t.nodeKey === 'await_upload')?.status,
    ).toBe('waiting');
  });
});

describe('the listener terminates', () => {
  it('does not loop on the events it writes itself', async () => {
    await publishPlaybook({ key: key('selffeed'), version: 1, phase: 0, definition: ONBOARDING });
    // A trigger on an event type the listener itself produces. Bounding each pass by the max
    // seq read at the start is what stops this from running away inside one pass.
    await upsertTrigger({
      tenantId: fx.tenant.id,
      eventType: 'workflow.trigger_fired',
      playbookKey: key('selffeed'),
    });

    await createClient(fx.tenant.id, 'Loop Co', actor());

    // Each pass must return; a runaway would hang the test rather than fail it, so the
    // assertion is simply that a bounded number of passes complete.
    for (let i = 0; i < 3; i += 1) {
      const result = await listen(new Date(`2026-08-10T16:0${i}:00Z`));
      expect(result.eventsProcessed).toBeLessThan(1000);
    }

    await setTriggerEnabled(
      (
        await db().workflowTrigger.findFirstOrThrow({
          where: { tenantId: fx.tenant.id, eventType: 'workflow.trigger_fired' },
        })
      ).id,
      false,
    );
  });

  it('advances the cursor so a second pass over the same events does nothing', async () => {
    const before = await listen(new Date('2026-08-10T17:00:00Z'));
    const after = await listen(new Date('2026-08-10T17:01:00Z'));
    expect(after.eventsProcessed).toBe(0);
    expect(before.eventsProcessed).toBeGreaterThanOrEqual(0);
  });
});
