/**
 * The Workflow Engine - blueprint 2.2, Specification v2 §5.3.
 *
 * Instance lifecycle plus the worker tick. Decision C: the Console is the runner for all
 * workflows, and this is it.
 *
 * Every transition writes a ledger event (principle 3), including failures - §10.5 requires
 * zero silent workflow failures, and a retry that succeeded quietly is how a degrading
 * integration stays invisible until it fails permanently.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { find as findClient } from '@bwc/clients';
import { raise as raiseNotification } from '@bwc/notifications';
import { failed, noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { evaluate, type EvaluationScope } from './predicate.js';
import { validate, type PlaybookDefinition, type PlaybookNode } from './playbook.js';
import { definitionFor, definitionForInstance, latestActive } from './definition.js';
import {
  breachedSlas,
  claim,
  deferUntil,
  dueReminders,
  enqueue,
  fail,
  markEscalated,
  markReminded,
  park,
  scheduleReminder,
  reclaimExpiredLeases,
  succeed,
  type QueuedTask,
} from './queue.js';

export type InstanceStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly playbookKey: string;
  readonly playbookVersion: number;
  readonly status: InstanceStatus;
  readonly currentNodeKey: string | null;
  readonly context: Record<string, unknown>;
}

// --- Playbooks ------------------------------------------------------------

export interface PublishInput {
  readonly key: string;
  readonly version: number;
  readonly phase: number;
  readonly definition: PlaybookDefinition;
  /**
   * Who published it, and into whose Ledger.
   *
   * **Both required, and that is the fix rather than an inconvenience.** Publishing a playbook is
   * the firm changing the rules by which it serves every client who starts on it afterwards, and
   * principle 3 says a state change is an event. This wrote nothing for the whole life of the
   * module - ADR-0069 recorded the gap when only tests could reach it, and Batch D then gave it a
   * button at Level 3, which made an unrecorded act one click away.
   *
   * Optional attribution would have been the smaller change and the wrong one: every existing
   * caller would have kept publishing anonymously, and the one place it mattered would have been
   * the only place it was recorded. A control a caller can skip is not a control (ADR-0034).
   *
   * A playbook row is firm-wide and carries no tenant. The EVENT is tenant-scoped because the
   * Ledger is, and a Console process serves one tenant.
   */
  readonly tenantId: string;
  readonly actor: EventActor;
}

/**
 * Publish a playbook as `active`.
 *
 * Validation happens here rather than at execution. A dangling `next` discovered three weeks
 * into a client engagement fails in the middle of a live workflow; discovered at publish, it is
 * an authoring error with nothing at stake.
 */
export const publishPlaybook = async (input: PublishInput): Promise<Outcome<{ id: string }>> => {
  const issues = validate(input.definition);
  if (issues.length > 0) {
    return {
      status: 'refused',
      reason: `Playbook '${input.key}' v${input.version} is invalid: ${issues
        .map((issue) => `${issue.nodeKey}: ${issue.problem}`)
        .join('; ')}`,
      principle: 'Blueprint 2.2 - playbooks are validated before publication, not at execution',
    };
  }

  const existing = await db().playbook.findUnique({
    where: { key_version: { key: input.key, version: input.version } },
    select: { id: true },
  });

  const row = await db().playbook.upsert({
    where: { key_version: { key: input.key, version: input.version } },
    create: {
      key: input.key,
      version: input.version,
      phase: input.phase,
      status: 'active',
      definition: input.definition as unknown as object,
      publishedAt: new Date(),
    },
    update: {
      phase: input.phase,
      status: 'active',
      definition: input.definition as unknown as object,
      publishedAt: new Date(),
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'workflow.playbook_published',
    actor: input.actor,
    payload: {
      playbookId: row.id,
      key: input.key,
      version: input.version,
      phase: input.phase,
      nodeCount: Object.keys(input.definition.nodes).length,
      // Republished, not first published. The upsert makes those indistinguishable in the row and
      // they are different acts: one adds a version, the other rewrites a definition instances may
      // already be pinned to.
      republished: existing !== null,
    },
  });

  return ok({ id: row.id });
};

// --- Instances ------------------------------------------------------------

export interface StartInput {
  readonly tenantId: string;
  readonly playbookKey: string;
  readonly actor: EventActor;
  readonly clientId?: string;
  readonly context?: Record<string, unknown>;
  /**
   * The clock. Required to be injectable here for the same reason it is everywhere else in the
   * engine: the first task's `runAt` and `slaDueAt` are stamped from it, and an instance started
   * against wall-clock time while the worker ticks against a test clock produces SLA deadlines
   * that are already breached, or waits that never come due. This defaulted to `new Date()`
   * internally at first and made exactly that failure.
   */
  readonly now?: Date;
}

/**
 * Start an instance of the latest active version of a playbook.
 *
 * The version is pinned into the instance. Publishing v2 while a client is midway through v1
 * must not silently move them onto different rules - the engagement they are in is the one they
 * were assessed under, and re-routing it is a decision for a human, not a side effect of a
 * publish.
 */
export const start = async (input: StartInput): Promise<Outcome<WorkflowInstance>> => {
  const playbook = await latestActive(input.playbookKey);
  if (!playbook) {
    return noData(`No active playbook '${input.playbookKey}'.`);
  }

  const startNode = playbook.definition.nodes[playbook.definition.startNode];
  if (!startNode) {
    return failed(`Playbook '${input.playbookKey}' has no resolvable start node.`);
  }

  const now = input.now ?? new Date();

  const instance = await db().workflowInstance.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId ?? null,
      playbookKey: input.playbookKey,
      playbookVersion: playbook.version,
      status: 'running',
      currentNodeKey: playbook.definition.startNode,
      context: (input.context ?? {}) as object,
      startedAt: now,
    },
  });

  await enqueueNode(instance.id, input.tenantId, playbook.definition.startNode, startNode, now);

  await append({
    tenantId: input.tenantId,
    type: 'workflow.started',
    actor: input.actor,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    payload: {
      instanceId: instance.id,
      playbookKey: input.playbookKey,
      playbookVersion: playbook.version,
    },
  });

  return ok(toInstance(instance));
};

interface InstanceRow {
  id: string;
  tenantId: string;
  clientId: string | null;
  playbookKey: string;
  playbookVersion: number;
  status: string;
  currentNodeKey: string | null;
  context: unknown;
}

const toInstance = (row: InstanceRow): WorkflowInstance => ({
  id: row.id,
  tenantId: row.tenantId,
  clientId: row.clientId,
  playbookKey: row.playbookKey,
  playbookVersion: row.playbookVersion,
  status: row.status as InstanceStatus,
  currentNodeKey: row.currentNodeKey,
  context: (row.context ?? {}) as Record<string, unknown>,
});

export const findInstance = async (instanceId: string): Promise<WorkflowInstance | null> => {
  const row = await db().workflowInstance.findUnique({ where: { id: instanceId } });
  return row ? toInstance(row) : null;
};

export interface InstanceFilter {
  /** Omit for every status. `running` and `waiting` together are "what is live". */
  readonly status?: InstanceStatus;
  readonly clientId?: string;
  readonly playbookKey?: string;
  readonly limit?: number;
}

/**
 * What is running for one tenant.
 *
 * **This did not exist, and its absence was the last thing any Console panel reported as missing.**
 * The module offered `findInstance(instanceId)` and nothing else, so a surface could answer "how is
 * this one instance doing" and not "what is happening". The route refused to fill the gap by
 * querying the table itself - that would have put a module read in the transport, which is the
 * thing this repository has refused everywhere else - so it reported the gap and waited.
 *
 * Ordered newest first and limited, because an unbounded list of every instance a tenant has ever
 * run is a page nobody can use and a query that gets slower every month.
 */
export const instancesFor = async (
  tenantId: string,
  filter: InstanceFilter = {},
): Promise<readonly WorkflowInstance[]> => {
  const rows = await db().workflowInstance.findMany({
    where: {
      tenantId,
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      ...(filter.clientId !== undefined ? { clientId: filter.clientId } : {}),
      ...(filter.playbookKey !== undefined ? { playbookKey: filter.playbookKey } : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    take: Math.min(filter.limit ?? 50, 200),
  });
  return rows.map(toInstance);
};

/** Enqueue the task for a node, translating node config into queue config. */
const enqueueNode = async (
  instanceId: string,
  tenantId: string,
  nodeKey: string,
  node: PlaybookNode,
  now: Date,
): Promise<QueuedTask> => {
  const slaMinutes =
    node.kind === 'agent_task' || node.kind === 'human_checkpoint' ? node.slaMinutes : undefined;

  const runAt =
    node.kind === 'wait' && 'durationMinutes' in node.until
      ? new Date(now.getTime() + node.until.durationMinutes * 60_000)
      : now;

  return enqueue({
    tenantId,
    instanceId,
    nodeKey,
    kind: node.kind,
    ...(node.kind === 'agent_task' ? { department: node.department } : {}),
    ...(node.kind === 'agent_task' && node.maxAttempts !== undefined
      ? { maxAttempts: node.maxAttempts }
      : {}),
    ...(node.kind === 'agent_task' && node.backoffSeconds !== undefined
      ? { backoffSeconds: node.backoffSeconds }
      : {}),
    runAt,
    ...(slaMinutes !== undefined
      ? { slaDueAt: new Date(now.getTime() + slaMinutes * 60_000) }
      : {}),
  });
};

// --- The worker tick ------------------------------------------------------

export interface TickOptions {
  readonly workerId: string;
  readonly now?: Date;
  readonly batchSize?: number;
  readonly actor: EventActor;
  /**
   * Restrict this pass to one tenant. Omit to process every tenant, which is the right default
   * for a single worker pool; supply it to keep one tenant's backlog from filling every batch.
   */
  readonly tenantId?: string;
}

export interface TickResult {
  readonly reclaimed: number;
  readonly claimed: number;
  readonly advanced: number;
  readonly parked: number;
  readonly failed: number;
  readonly escalated: number;
  /** Chases raised on waits that are taking too long. */
  readonly reminded: number;
}

/**
 * One pass of the engine. Idempotent and safe to run concurrently with other workers.
 *
 * Called directly by tests with an explicit `now`, which is what makes a three-month wait state
 * a unit test rather than an integration test nobody runs.
 */
export const tick = async (options: TickOptions): Promise<TickResult> => {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 20;

  // 1. Crash recovery. Before claiming anything new, return abandoned work to the queue.
  const reclaimedTasks = await reclaimExpiredLeases(now, options.tenantId);
  for (const task of reclaimedTasks) {
    await append({
      tenantId: task.tenantId,
      type: 'workflow.task_lease_reclaimed',
      actor: options.actor,
      payload: { taskId: task.id, instanceId: task.instanceId, nodeKey: task.nodeKey },
    });
  }

  // 2. SLA breaches. Independent of claiming, because a breached task may be parked waiting on
  //    a human and will never be claimed at all.
  let escalated = 0;
  for (const task of await breachedSlas(now, options.tenantId)) {
    await markEscalated(task.id, now);
    await append({
      tenantId: task.tenantId,
      type: 'workflow.sla_breached',
      actor: options.actor,
      payload: {
        taskId: task.id,
        instanceId: task.instanceId,
        nodeKey: task.nodeKey,
        department: task.department,
      },
    });
    await raiseNotification({
      tenantId: task.tenantId,
      assignedTo: 'compliance_and_evidence',
      kind: 'sla_breach',
      summary: `Workflow task ${task.nodeKey} breached its SLA`,
      actor: options.actor,
      workflowTaskId: task.id,
    });
    escalated += 1;
  }

  // 2b. Chases on waits that are taking too long. Like the SLA pass, independent of claiming -
  //     the task is parked and will never be claimed until its event arrives, which is the whole
  //     situation being chased.
  //
  //     **The instance does not move.** The wait stays parked, so the chase cannot outlive the
  //     thing it is chasing: the moment the event lands, the task stops being `waiting` and
  //     `dueReminders` stops returning it. That is what makes this safe to point at a client - a
  //     nudge sent to somebody who has already answered is worse than no nudge at all.
  let reminded = 0;
  for (const task of await dueReminders(now, options.tenantId)) {
    const instance = await findInstance(task.instanceId);
    const definition = instance ? await definitionForInstance(instance) : null;
    const node = definition?.nodes[task.nodeKey];

    if (!instance || !node || node.kind !== 'wait' || node.remindAfterMinutes === undefined) {
      // The node stopped declaring a reminder, or the instance is gone. Clear the schedule rather
      // than re-reading this row on every pass forever.
      await markReminded(task.id, null);
      continue;
    }

    const sent = task.remindersSent + 1;
    const cap = node.maxReminders ?? 1;

    await raiseNotification({
      tenantId: task.tenantId,
      assignedTo: node.remindQueue ?? 'concierge_desk',
      kind: 'workflow_reminder',
      summary: node.remindSummary ?? `Chase ${task.nodeKey}`,
      actor: options.actor,
      workflowTaskId: task.id,
    });
    await append({
      tenantId: task.tenantId,
      type: 'workflow.reminder_raised',
      actor: options.actor,
      ...(instance.clientId !== null ? { clientId: instance.clientId } : {}),
      payload: {
        instanceId: instance.id,
        nodeKey: task.nodeKey,
        reminder: sent,
        of: cap,
        queue: node.remindQueue,
      },
    });

    // Null at the cap: the row leaves `dueReminders` for good rather than being re-counted.
    await markReminded(
      task.id,
      sent >= cap ? null : new Date(now.getTime() + node.remindAfterMinutes * 60_000),
    );
    reminded += 1;
  }

  // 3. Claim and execute.
  const claimed = await claim(options.workerId, batchSize, now, undefined, options.tenantId);
  let advanced = 0;
  let parked = 0;
  let failures = 0;

  for (const task of claimed) {
    const outcome = await executeTask(task, options.actor, now);
    if (outcome === 'advanced') advanced += 1;
    else if (outcome === 'parked') parked += 1;
    else failures += 1;
  }

  return {
    reclaimed: reclaimedTasks.length,
    claimed: claimed.length,
    advanced,
    parked,
    failed: failures,
    escalated,
    reminded,
  };
};

type ExecutionOutcome = 'advanced' | 'parked' | 'failed';

const executeTask = async (
  task: QueuedTask,
  actor: EventActor,
  now: Date,
): Promise<ExecutionOutcome> => {
  const instance = await findInstance(task.instanceId);
  if (!instance) {
    await recordFailure(task, 'instance no longer exists', actor, now);
    return 'failed';
  }

  const definition = await definitionFor(instance.playbookKey, instance.playbookVersion);
  const node = definition?.nodes[task.nodeKey];

  if (!node) {
    await recordFailure(
      task,
      `node '${task.nodeKey}' not found in ${instance.playbookKey} v${instance.playbookVersion}`,
      actor,
      now,
    );
    return 'failed';
  }

  switch (node.kind) {
    case 'terminal': {
      await succeed(task.id, now);
      await db().workflowInstance.update({
        where: { id: instance.id },
        data: {
          status: node.outcome === 'completed' ? 'completed' : 'cancelled',
          currentNodeKey: task.nodeKey,
          completedAt: now,
        },
      });
      await append({
        tenantId: task.tenantId,
        type: node.outcome === 'completed' ? 'workflow.completed' : 'workflow.cancelled',
        actor,
        ...(instance.clientId !== null ? { clientId: instance.clientId } : {}),
        payload: { instanceId: instance.id, nodeKey: task.nodeKey },
      });
      return 'advanced';
    }

    case 'decision': {
      const scope = await buildScope(instance);
      for (const branch of node.branches) {
        const result = evaluate(branch.when, scope);
        if (!result.ok) {
          // A malformed predicate is not a false branch. Taking `otherwise` would run the
          // wrong path silently, which is worse than stopping and saying the playbook is broken.
          await recordFailure(task, `decision predicate invalid: ${result.reason}`, actor, now);
          return 'failed';
        }
        if (result.value) {
          await advanceTo(task, instance, definition, branch.next, actor, now, {
            branchTaken: branch.next,
          });
          return 'advanced';
        }
      }
      await advanceTo(task, instance, definition, node.otherwise, actor, now, {
        branchTaken: node.otherwise,
        viaOtherwise: true,
      });
      return 'advanced';
    }

    case 'wait': {
      if ('atContextField' in node.until) {
        // Resolved at dispatch, from a moment an earlier task recorded. `runAt` in the future is
        // already how this engine waits, so the only new thing here is where the date comes from.
        const raw = instance.context[node.until.atContextField];
        const moment =
          typeof raw === 'string' || raw instanceof Date ? new Date(raw as string) : null;

        if (moment === null || Number.isNaN(moment.getTime())) {
          // Failed rather than parked. A wait with no resolvable moment is a workflow that has
          // stopped without saying so, and the reason names the key so the fix is obvious.
          await recordFailure(
            task,
            `wait needs context.${node.until.atContextField} to be a date and it is ${
              raw === undefined ? 'not set' : 'not a date'
            }`,
            actor,
            now,
          );
          return 'failed';
        }

        const runAt = new Date(moment.getTime() + (node.until.offsetMinutes ?? 0) * 60_000);

        // Already past - the appointment was booked for tomorrow and this ran late. Resolving now
        // is right: the alternative is a reminder that never arrives because it is overdue.
        if (runAt.getTime() <= now.getTime()) {
          await append({
            tenantId: task.tenantId,
            type: 'workflow.wait_resolved',
            actor,
            payload: { instanceId: instance.id, nodeKey: task.nodeKey, resolvedBy: 'context_time' },
          });
          await advanceTo(task, instance, definition, node.next, actor, now);
          return 'advanced';
        }

        await deferUntil(task.id, runAt);
        await append({
          tenantId: task.tenantId,
          type: 'workflow.wait_started',
          actor,
          payload: {
            instanceId: instance.id,
            nodeKey: task.nodeKey,
            awaitingContextField: node.until.atContextField,
            runAt: runAt.toISOString(),
          },
        });
        return 'parked';
      }

      if ('durationMinutes' in node.until) {
        // Claimed means `runAt` has arrived, so the duration has elapsed.
        await append({
          tenantId: task.tenantId,
          type: 'workflow.wait_resolved',
          actor,
          payload: { instanceId: instance.id, nodeKey: task.nodeKey },
        });
        await advanceTo(task, instance, definition, node.next, actor, now);
        return 'advanced';
      }
      // Event waits are resolved by the Event Ledger listener, which is the next slice. Park
      // rather than fail: the workflow is legitimately waiting, and a `waiting` task is
      // visible as such rather than looking like a stall.
      await park(task.id, now);
      if (node.remindAfterMinutes !== undefined) {
        // The chase clock starts when the wait does. Set here rather than at enqueue, because a
        // wait that was never reached should never be chased.
        await scheduleReminder(task.id, new Date(now.getTime() + node.remindAfterMinutes * 60_000));
      }
      await append({
        tenantId: task.tenantId,
        type: 'workflow.wait_started',
        actor,
        payload: {
          instanceId: instance.id,
          nodeKey: task.nodeKey,
          awaitingEvent: node.until.event,
          ...(node.remindAfterMinutes !== undefined
            ? { remindAfterMinutes: node.remindAfterMinutes }
            : {}),
        },
      });
      return 'parked';
    }

    case 'agent_task':
    case 'human_checkpoint': {
      // Dispatched, not executed. The Engine raises the assignment and parks; completion comes
      // back through `completeExternalTask`. The Engine deliberately does not perform the work
      // itself - that would route around the middleware chain and its Authority Level check.
      await park(task.id, now);
      await raiseNotification({
        tenantId: task.tenantId,
        assignedTo: node.kind === 'agent_task' ? node.department : node.queue,
        kind: node.kind,
        summary: node.kind === 'agent_task' ? node.action : node.summary,
        actor,
        workflowTaskId: task.id,
        ...(instance.clientId !== null ? { clientId: instance.clientId } : {}),
        ...(task.slaDueAt !== null ? { slaDueAt: task.slaDueAt } : {}),
      });
      await append({
        tenantId: task.tenantId,
        type: 'workflow.task_dispatched',
        actor,
        ...(instance.clientId !== null ? { clientId: instance.clientId } : {}),
        payload: {
          instanceId: instance.id,
          taskId: task.id,
          nodeKey: task.nodeKey,
          kind: node.kind,
          assignedTo: node.kind === 'agent_task' ? node.department : node.queue,
        },
      });
      return 'parked';
    }
  }
};

/** Facts a decision predicate may read. Nothing beyond these three roots is reachable. */
const buildScope = async (instance: WorkflowInstance): Promise<EvaluationScope> => {
  const scope: {
    client?: Record<string, unknown>;
    context: Record<string, unknown>;
    instance: Record<string, unknown>;
  } = {
    context: instance.context,
    instance: {
      playbookKey: instance.playbookKey,
      playbookVersion: instance.playbookVersion,
      status: instance.status,
    },
  };

  if (instance.clientId !== null) {
    const client = await findClient(instance.tenantId, instance.clientId);
    if (client.status === 'ok') {
      scope.client = {
        id: client.value.id,
        legalName: client.value.legalName,
        complianceState: client.value.complianceState,
      };
    }
  }

  return scope;
};

const advanceTo = async (
  task: QueuedTask,
  instance: WorkflowInstance,
  definition: PlaybookDefinition,
  nextKey: string,
  actor: EventActor,
  now: Date,
  decisionPayload?: Record<string, unknown>,
): Promise<void> => {
  const next = definition.nodes[nextKey];
  if (!next) {
    await recordFailure(task, `next node '${nextKey}' not found`, actor, now);
    return;
  }

  await succeed(task.id, now);
  await db().workflowInstance.update({
    where: { id: instance.id },
    data: { status: 'running', currentNodeKey: nextKey },
  });
  await enqueueNode(instance.id, task.tenantId, nextKey, next, now);

  if (decisionPayload) {
    await append({
      tenantId: task.tenantId,
      type: 'workflow.decision_evaluated',
      actor,
      ...(instance.clientId !== null ? { clientId: instance.clientId } : {}),
      payload: { instanceId: instance.id, nodeKey: task.nodeKey, ...decisionPayload },
    });
  }

  await append({
    tenantId: task.tenantId,
    type: 'workflow.task_succeeded',
    actor,
    payload: { instanceId: instance.id, taskId: task.id, nodeKey: task.nodeKey, next: nextKey },
  });
};

/** Record a failure, apply the retry policy, and log whichever happened. */
const recordFailure = async (
  task: QueuedTask,
  error: string,
  actor: EventActor,
  now: Date,
): Promise<void> => {
  const disposition = await fail(task, error, now);

  await append({
    tenantId: task.tenantId,
    type: 'workflow.task_failed',
    actor,
    payload: {
      taskId: task.id,
      instanceId: task.instanceId,
      nodeKey: task.nodeKey,
      error,
      attempt: task.attempts,
    },
  });

  if (disposition.outcome === 'retry_scheduled') {
    await append({
      tenantId: task.tenantId,
      type: 'workflow.task_retry_scheduled',
      actor,
      payload: {
        taskId: task.id,
        instanceId: task.instanceId,
        attempt: disposition.attempt,
        nextRunAt: disposition.nextRunAt.toISOString(),
      },
    });
    return;
  }

  await append({
    tenantId: task.tenantId,
    type: 'workflow.task_dead_lettered',
    actor,
    payload: { taskId: task.id, instanceId: task.instanceId, attempts: disposition.attempts },
  });

  // A dead-lettered task ends its instance. Leaving the instance `running` with nothing left to
  // run is precisely the silent stall §10.5 counts as a failure.
  await db().workflowInstance.update({
    where: { id: task.instanceId },
    data: { status: 'failed', completedAt: now },
  });

  await append({
    tenantId: task.tenantId,
    type: 'workflow.failed',
    actor,
    payload: { instanceId: task.instanceId, nodeKey: task.nodeKey, reason: error },
  });
};

/**
 * Resume a `wait` node that was parked awaiting a named event, because that event has arrived.
 *
 * Called by the Event Ledger listener. The listener knows *that* the wait is satisfied; only the
 * engine knows what comes next in the graph, so advancement stays here.
 *
 * The earlier shape of this was for the listener to flip the task back to `pending` and let the
 * worker pick it up. That does not work: the worker's `wait` handler re-parks any event-wait it
 * claims, since from its point of view the event has not arrived. The task ping-ponged between
 * `pending` and `waiting` forever and the workflow never advanced - with nothing failing.
 */
export const resolveEventWait = async (
  tenantId: string,
  taskId: string,
  actor: EventActor,
  now: Date = new Date(),
): Promise<Outcome<WorkflowInstance>> => {
  // Guarded on `waiting`, so two concurrent listener passes cannot both resume it.
  const claimed = await db().workflowTask.updateMany({
    where: { id: taskId, tenantId, status: 'waiting' },
    data: { status: 'running', updatedAt: now },
  });
  if (claimed.count === 0) {
    return refused(
      'Task is not awaiting an event.',
      'Blueprint 2.2 - task state transitions are explicit',
    );
  }

  const task = await db().workflowTask.findFirst({ where: { id: taskId, tenantId } });
  if (!task) return failed('Workflow task vanished mid-resume.');

  const instance = await findInstance(task.instanceId);
  if (!instance) return failed('Workflow instance no longer exists.');

  const definition = await definitionForInstance(instance);
  const node = definition?.nodes[task.nodeKey];
  if (!definition || !node || node.kind !== 'wait') {
    return failed(`Node '${task.nodeKey}' is not a wait node.`);
  }

  await advanceTo(
    { ...task, kind: 'wait' } as QueuedTask,
    instance,
    definition,
    node.next,
    actor,
    now,
  );

  const updated = await findInstance(instance.id);
  return updated ? ok(updated) : failed('Instance vanished mid-resume.');
};

// --- External completion --------------------------------------------------

/**
 * Report an agent task or human checkpoint as done, resuming the instance.
 *
 * `contextPatch` merges into the instance context, which is how a task's result becomes readable
 * by a later decision node. It is merged rather than replaced so two tasks completing out of
 * order do not erase each other.
 */
export const completeExternalTask = async (
  tenantId: string,
  taskId: string,
  actor: EventActor,
  contextPatch: Record<string, unknown> = {},
  now: Date = new Date(),
): Promise<Outcome<WorkflowInstance>> => {
  const task = await db().workflowTask.findFirst({ where: { id: taskId, tenantId } });
  if (!task) return noData('No such workflow task in this tenant.');

  if (task.status !== 'waiting') {
    return {
      status: 'refused',
      reason: `Task is '${task.status}', not 'waiting'. Only a dispatched task awaiting external completion can be completed.`,
      principle: 'Blueprint 2.2 - task state transitions are explicit',
    };
  }

  const instance = await findInstance(task.instanceId);
  if (!instance) return failed('Workflow instance no longer exists.');

  const definition = await definitionFor(instance.playbookKey, instance.playbookVersion);
  const node = definition?.nodes[task.nodeKey];
  if (!definition || !node) return failed('Playbook node no longer resolvable.');
  if (node.kind !== 'agent_task' && node.kind !== 'human_checkpoint') {
    return failed(`Node '${task.nodeKey}' is a ${node.kind}, which is not externally completed.`);
  }

  await db().workflowInstance.update({
    where: { id: instance.id },
    data: { context: { ...instance.context, ...contextPatch } as object },
  });

  await advanceTo(
    { ...task, kind: node.kind } as QueuedTask,
    instance,
    definition,
    node.next,
    actor,
    now,
  );

  const updated = await findInstance(instance.id);
  return updated ? ok(updated) : failed('Instance vanished mid-completion.');
};
