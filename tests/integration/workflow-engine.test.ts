/**
 * Integration: a multi-node playbook runs end to end under a controlled clock, and the Ledger
 * tells the whole story afterwards.
 *
 * The clock is a parameter throughout the engine precisely so this test exists. A wait state of
 * 90 days is normal in this domain (promo expiry, re-stack windows, month-10 retention); tested
 * against a real clock it would be untestable, and tested with `sleep` it would be slow and flaky.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { read } from '@bwc/ledger';
import { openFor, findByWorkflowTask } from '@bwc/notifications';
import {
  completeExternalTask,
  findInstance,
  forInstance,
  publishPlaybook,
  start,
  tick,
  validate,
  type PlaybookDefinition,
} from '@bwc/workflow';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('wf-engine');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });
const run = (now: Date) =>
  tick({ workerId: 'test-worker', now, actor: actor(), tenantId: fx.tenant.id });

/**
 * Playbooks are not tenant-scoped - they are the operating company's own definitions - so
 * they outlive a test run and a fixed key would collide with the version a previous run
 * published. Same discipline as the per-run tenant slug.
 */
const key = (name: string) => `${name}-${fx.tenant.slug}`;

/**
 * Phase 0 shaped: collect documents, branch on compliance state, wait out a cooling period,
 * then a human checkpoint. Small enough to read, large enough to exercise every node kind.
 */
const PHASE_0: PlaybookDefinition = {
  startNode: 'collect_documents',
  nodes: {
    collect_documents: {
      kind: 'agent_task',
      department: 'capital_readiness',
      action: 'Collect Phase 0 intake documents',
      slaMinutes: 60,
      next: 'assess',
    },
    assess: {
      kind: 'decision',
      branches: [
        {
          when: {
            field: 'client.complianceState',
            op: 'in',
            value: ['pass', 'pass_with_findings'],
          },
          next: 'cooling_period',
        },
      ],
      otherwise: 'route_to_review',
    },
    cooling_period: {
      kind: 'wait',
      until: { durationMinutes: 60 * 24 * 90 }, // 90 days
      next: 'blueprint_review',
    },
    blueprint_review: {
      kind: 'human_checkpoint',
      queue: 'compliance_and_evidence',
      summary: 'Readiness Blueprint review call',
      next: 'done',
    },
    route_to_review: {
      kind: 'human_checkpoint',
      queue: 'compliance_and_evidence',
      summary: 'Client did not reach a passing compliance state',
      next: 'halted',
    },
    done: { kind: 'terminal', outcome: 'completed' },
    halted: { kind: 'terminal', outcome: 'cancelled' },
  },
};

describe('playbook validation', () => {
  it('accepts the Phase 0 playbook', () => {
    expect(validate(PHASE_0)).toEqual([]);
  });

  it('rejects a dangling next at publish rather than at execution', async () => {
    const result = await publishPlaybook({
      key: key('broken-dangling'),
      version: 1,
      phase: 0,
      definition: {
        startNode: 'a',
        nodes: {
          a: { kind: 'agent_task', department: 'x', action: 'y', next: 'nowhere' },
          end: { kind: 'terminal', outcome: 'completed' },
        },
      },
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/does not exist/i);
  });

  it('rejects a playbook with no terminal node', () => {
    const issues = validate({
      startNode: 'a',
      nodes: { a: { kind: 'wait', until: { durationMinutes: 1 }, next: 'a' } },
    });
    expect(issues.some((issue) => issue.problem.match(/cannot end/i))).toBe(true);
  });

  it('reports an unreachable node', () => {
    const issues = validate({
      startNode: 'a',
      nodes: {
        a: { kind: 'terminal', outcome: 'completed' },
        orphan: { kind: 'terminal', outcome: 'cancelled' },
      },
    });
    expect(issues.some((issue) => issue.nodeKey === 'orphan')).toBe(true);
  });
});

describe('a workflow runs end to end', () => {
  it('dispatches, branches, waits 90 days, checkpoints, and completes', async () => {
    await publishPlaybook({
      key: key('phase-0'),
      version: 1,
      phase: 0,
      definition: PHASE_0,
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    const client = await createClient(fx.tenant.id, 'Walkthrough Co', actor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'pass_with_findings',
      reason: 'intake assessed',
      actor: actor(),
    });

    const t0 = new Date('2026-08-10T09:00:00Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('phase-0'),
      clientId: client.id,
      actor: actor(),
      now: t0,
    });
    if (started.status !== 'ok') throw new Error('start failed');
    const instanceId = started.value.id;

    // --- t0: the agent task is dispatched and parked awaiting external completion ---------
    const first = await run(t0);
    expect(first.parked).toBe(1);

    const assignments = await openFor(fx.tenant.id, 'capital_readiness');
    expect(assignments.some((n) => n.kind === 'agent_task')).toBe(true);

    // The engine dispatches; it does not perform the work itself. Doing the work here would
    // route around the middleware chain and its Authority Level check.
    const collectTask = (await forInstance(instanceId)).find(
      (t) => t.nodeKey === 'collect_documents',
    );
    if (!collectTask) throw new Error('expected the collect task');
    expect(collectTask.status).toBe('waiting');

    // --- external completion advances to the decision -------------------------------------
    const completed = await completeExternalTask(
      fx.tenant.id,
      collectTask.id,
      actor(),
      { documentsReceived: 4 },
      new Date(t0.getTime() + 30 * 60_000),
    );
    expect(completed.status).toBe('ok');

    // --- t1: the decision evaluates and enqueues the 90-day wait ---------------------------
    const t1 = new Date(t0.getTime() + 31 * 60_000);
    await run(t1);

    const afterDecision = await findInstance(instanceId);
    expect(afterDecision?.currentNodeKey).toBe('cooling_period');

    // --- the wait does not resolve early ---------------------------------------------------
    const t2 = new Date(t1.getTime() + 89 * 24 * 60 * 60 * 1000);
    const during = await run(t2);
    expect(during.claimed).toBe(0);
    expect((await findInstance(instanceId))?.currentNodeKey).toBe('cooling_period');

    // --- t3: 90 days later it resolves and reaches the human checkpoint ---------------------
    const t3 = new Date(t1.getTime() + 91 * 24 * 60 * 60 * 1000);
    await run(t3);
    expect((await findInstance(instanceId))?.currentNodeKey).toBe('blueprint_review');

    await run(new Date(t3.getTime() + 60_000));
    const reviewTask = (await forInstance(instanceId)).find(
      (t) => t.nodeKey === 'blueprint_review',
    );
    if (!reviewTask) throw new Error('expected the review task');
    expect(reviewTask.status).toBe('waiting');
    expect(await findByWorkflowTask(fx.tenant.id, reviewTask.id)).not.toHaveLength(0);

    // --- the human completes the checkpoint; the workflow terminates -----------------------
    await completeExternalTask(
      fx.tenant.id,
      reviewTask.id,
      actor(),
      {},
      new Date(t3.getTime() + 120_000),
    );
    await run(new Date(t3.getTime() + 180_000));

    const final = await findInstance(instanceId);
    expect(final?.status).toBe('completed');

    // --- the Ledger tells the whole story --------------------------------------------------
    const types = (await read({ tenantId: fx.tenant.id, clientId: client.id })).map((e) => e.type);
    for (const expected of [
      'workflow.started',
      'workflow.task_dispatched',
      'workflow.decision_evaluated',
      'workflow.completed',
    ]) {
      expect(types, `${expected} should be in the ledger`).toContain(expected);
    }
  });

  it('takes the otherwise branch when the client is not in a passing state', async () => {
    await publishPlaybook({
      key: key('phase-0-b'),
      version: 1,
      phase: 0,
      definition: PHASE_0,
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    const client = await createClient(fx.tenant.id, 'Blocked Co', actor());
    await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId: client.id,
      to: 'needs_review',
      reason: 'discrepancy',
      actor: actor(),
    });

    const t0 = new Date('2026-08-10T09:00:00Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('phase-0-b'),
      clientId: client.id,
      actor: actor(),
      now: t0,
    });
    if (started.status !== 'ok') throw new Error('start failed');
    await run(t0);

    const collect = (await forInstance(started.value.id)).find(
      (t) => t.nodeKey === 'collect_documents',
    );
    if (!collect) throw new Error('expected the collect task');
    await completeExternalTask(fx.tenant.id, collect.id, actor(), {}, t0);
    await run(new Date(t0.getTime() + 60_000));

    expect((await findInstance(started.value.id))?.currentNodeKey).toBe('route_to_review');
  });
});

describe('instances pin their playbook version', () => {
  it('does not re-route an in-flight instance when a new version is published', async () => {
    await publishPlaybook({
      key: key('pinned'),
      version: 1,
      phase: 0,
      definition: PHASE_0,
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('pinned'),
      actor: actor(),
    });
    if (started.status !== 'ok') throw new Error('start failed');
    expect(started.value.playbookVersion).toBe(1);

    // v2 routes somewhere entirely different.
    await publishPlaybook({
      key: key('pinned'),
      version: 2,
      phase: 0,
      definition: {
        startNode: 'straight_to_end',
        nodes: { straight_to_end: { kind: 'terminal', outcome: 'cancelled' } },
      },
      tenantId: fx.tenant.id,
      actor: actor(),
    });

    const t0 = new Date();
    await run(t0);

    // The instance still runs v1's graph. Changing the rules mid-engagement is a human decision,
    // not a side effect of publishing.
    const instance = await findInstance(started.value.id);
    expect(instance?.playbookVersion).toBe(1);
    expect(instance?.currentNodeKey).toBe('collect_documents');
    expect(instance?.status).not.toBe('cancelled');
  });
});

describe('SLA escalation', () => {
  it('escalates a breached task exactly once and notifies compliance', async () => {
    await publishPlaybook({
      key: key('sla'),
      version: 1,
      phase: 0,
      definition: PHASE_0,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    const t0 = new Date('2026-08-10T09:00:00Z');
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('sla'),
      actor: actor(),
      now: t0,
    });
    if (started.status !== 'ok') throw new Error('start failed');
    await run(t0);

    // The collect node carries a 60-minute SLA and is parked awaiting an agent.
    const breachTime = new Date(t0.getTime() + 61 * 60_000);
    const firstPass = await run(breachTime);
    expect(firstPass.escalated).toBeGreaterThan(0);

    // Escalating again every tick would bury the queue it is trying to raise attention in.
    const secondPass = await run(new Date(breachTime.getTime() + 60_000));
    expect(secondPass.escalated).toBe(0);

    const breaches = await read({ tenantId: fx.tenant.id, type: 'workflow.sla_breached' });
    expect(breaches.length).toBeGreaterThan(0);
    expect(await openFor(fx.tenant.id, 'compliance_and_evidence')).not.toHaveLength(0);
  });
});

describe('external completion is guarded', () => {
  it('refuses to complete a task that is not awaiting external completion', async () => {
    await publishPlaybook({
      key: key('guard'),
      version: 1,
      phase: 0,
      definition: PHASE_0,
      tenantId: fx.tenant.id,
      actor: actor(),
    });
    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: key('guard'),
      actor: actor(),
    });
    if (started.status !== 'ok') throw new Error('start failed');

    const task = (await forInstance(started.value.id))[0];
    if (!task) throw new Error('expected a task');

    // Still `pending` - never dispatched.
    const result = await completeExternalTask(fx.tenant.id, task.id, actor());
    expect(result.status).toBe('refused');
  });

  it("refuses to complete another tenant's task", async () => {
    const other = await makeFixture('wf-other');
    try {
      await publishPlaybook({
        key: key('cross'),
        version: 1,
        phase: 0,
        definition: PHASE_0,
        tenantId: fx.tenant.id,
        actor: actor(),
      });
      const started = await start({
        tenantId: fx.tenant.id,
        playbookKey: key('cross'),
        actor: actor(),
      });
      if (started.status !== 'ok') throw new Error('start failed');
      await run(new Date());

      const task = (await forInstance(started.value.id)).find((t) => t.status === 'waiting');
      if (!task) throw new Error('expected a dispatched task');

      const result = await completeExternalTask(other.tenant.id, task.id, {
        id: other.human.id,
        kind: 'human',
      });
      expect(result.status).not.toBe('ok');
    } finally {
      await db().workflowInstance.deleteMany({ where: { tenantId: other.tenant.id } });
      await cleanupTenant(other.tenant.id);
    }
  });
});
