/**
 * The durable task queue - Specification v2 §5.3.
 *
 * Postgres-backed rather than Redis-backed (ADR-0003). One durability domain means enqueueing a
 * task, transitioning an instance, and appending the ledger event are a single transaction, so a
 * crash cannot leave the three disagreeing. That is what "recovery from failure at task
 * boundaries" (blueprint 2.2) actually requires.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so concurrent workers take disjoint batches without
 * blocking each other. Claims carry a lease; a worker that dies mid-task leaves an expired lease,
 * and `reclaimExpiredLeases` returns the row to `pending` rather than leaving it stranded in
 * `running` forever.
 *
 * `now` is a parameter everywhere. A wait state measured in months (promo expiry, re-stack
 * windows, month-10 retention triggers) is untestable against a real clock, and a scheduler
 * tested with `sleep` is tested slowly and flakily.
 */

import { db, type Prisma } from '@bwc/db';

export type TaskStatus =
  'pending' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled';

export type TaskKind = 'agent_task' | 'human_checkpoint' | 'decision' | 'wait' | 'terminal';

export interface QueuedTask {
  readonly id: string;
  readonly tenantId: string;
  readonly instanceId: string;
  readonly nodeKey: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly department: string | null;
  readonly priority: number;
  readonly runAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
  readonly lastError: string | null;
  readonly slaDueAt: Date | null;
  readonly escalatedAt: Date | null;
  readonly remindDueAt: Date | null;
  readonly remindersSent: number;
}

export interface EnqueueInput {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly nodeKey: string;
  readonly kind: TaskKind;
  readonly department?: string;
  readonly priority?: number;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  readonly backoffSeconds?: number;
  readonly slaDueAt?: Date;
}

/** Default lease. Long enough for a slow task, short enough that a crash is not a long outage. */
export const DEFAULT_LEASE_SECONDS = 300;

/** Exponential backoff cap. Beyond a day, a retry is not fixing a transient. */
export const MAX_BACKOFF_SECONDS = 24 * 60 * 60;

/**
 * Timestamps crossing into raw SQL are bound as ISO strings cast to `timestamp`, never as JS
 * Dates.
 *
 * Prisma maps `DateTime` to a naive `timestamp(3)` column holding UTC. Binding a JS Date into a
 * raw query sends a *timestamptz*, so Postgres compares it against the naive column by
 * converting through the session timezone - the comparison silently shifts by the local UTC
 * offset. Prisma's typed queries are unaffected, so the bug appears only in raw SQL and only as
 * "the claim returned the wrong rows", with nothing erroring.
 *
 * `toISOString()` yields UTC and `::timestamp` drops the zone designator, leaving the exact
 * value the column holds. This cost an afternoon on the claim query; keep every raw timestamp
 * going through here.
 */
const ts = (value: Date): string => value.toISOString();

type Client = Prisma.TransactionClient | ReturnType<typeof db>;

export const enqueue = async (input: EnqueueInput, tx?: Client): Promise<QueuedTask> => {
  const client = tx ?? db();
  const row = await client.workflowTask.create({
    data: {
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      nodeKey: input.nodeKey,
      kind: input.kind,
      department: input.department ?? null,
      priority: input.priority ?? 0,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
      backoffSeconds: input.backoffSeconds ?? 30,
      slaDueAt: input.slaDueAt ?? null,
    },
  });
  return toTask(row);
};

interface TaskRow {
  id: string;
  tenantId: string;
  instanceId: string;
  nodeKey: string;
  kind: string;
  status: string;
  department: string | null;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  backoffSeconds: number;
  lastError: string | null;
  slaDueAt: Date | null;
  escalatedAt: Date | null;
  remindDueAt: Date | null;
  remindersSent: number;
}

const toTask = (row: TaskRow): QueuedTask => ({
  id: row.id,
  tenantId: row.tenantId,
  instanceId: row.instanceId,
  nodeKey: row.nodeKey,
  kind: row.kind as TaskKind,
  status: row.status as TaskStatus,
  department: row.department,
  priority: row.priority,
  runAt: row.runAt,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  backoffSeconds: row.backoffSeconds,
  lastError: row.lastError,
  slaDueAt: row.slaDueAt,
  escalatedAt: row.escalatedAt,
  remindDueAt: row.remindDueAt,
  remindersSent: row.remindersSent,
});

/**
 * Claim up to `limit` due tasks for this worker.
 *
 * `SKIP LOCKED` is what makes concurrent workers safe: a row already locked by another
 * transaction is passed over instead of waited on, so two workers never claim the same task and
 * neither blocks. Without it, the same query serialises every worker behind the first one — the
 * queue still works and looks fine under a single worker, which is why it is worth stating.
 *
 * Written as raw SQL because Prisma has no `SKIP LOCKED`, and the alternatives (advisory locks,
 * optimistic retry loops) are more moving parts for the same result.
 */
export const claim = async (
  workerId: string,
  limit: number,
  now: Date = new Date(),
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
  tenantId?: string,
): Promise<QueuedTask[]> => {
  const leaseExpiry = new Date(now.getTime() + leaseSeconds * 1000);

  // Tenant scoping is optional and serves fairness: one tenant with a large backlog would
  // otherwise fill every batch and starve the others, which is a poor fit for principle 5's
  // isolation posture even though nothing leaks across the boundary. Omitting it processes
  // every tenant, which is the right default for a single worker pool.
  const rows = tenantId
    ? await db().$queryRaw<TaskRow[]>`
        UPDATE workflow.workflow_tasks AS t
        SET status = 'running',
            attempts = t.attempts + 1,
            "lockedBy" = ${workerId},
            "leaseExpiresAt" = ${ts(leaseExpiry)}::timestamp,
            "updatedAt" = ${ts(now)}::timestamp
        WHERE t.id IN (
          SELECT inner_t.id
          FROM workflow.workflow_tasks AS inner_t
          WHERE inner_t.status = 'pending'
            AND inner_t."runAt" <= ${ts(now)}::timestamp
            AND inner_t."tenantId" = ${tenantId}::uuid
          ORDER BY inner_t.priority DESC, inner_t."runAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING t.*
      `
    : await db().$queryRaw<TaskRow[]>`
        UPDATE workflow.workflow_tasks AS t
        SET status = 'running',
            attempts = t.attempts + 1,
            "lockedBy" = ${workerId},
            "leaseExpiresAt" = ${ts(leaseExpiry)}::timestamp,
            "updatedAt" = ${ts(now)}::timestamp
        WHERE t.id IN (
          SELECT inner_t.id
          FROM workflow.workflow_tasks AS inner_t
          WHERE inner_t.status = 'pending'
            AND inner_t."runAt" <= ${ts(now)}::timestamp
          ORDER BY inner_t.priority DESC, inner_t."runAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING t.*
      `;

  return rows.map(toTask);
};

/**
 * Return tasks whose lease has expired to `pending`.
 *
 * This is the crash-recovery path. A worker that died holding a claim leaves a `running` row
 * that nothing will ever complete; without reclaim, the workflow stalls silently, which
 * principle 9 forbids and which §10.5 counts as a silent workflow failure.
 *
 * Attempts are NOT decremented. A task that repeatedly kills its worker should exhaust its
 * retries and dead-letter rather than loop forever — an infinite reclaim cycle is the failure
 * mode this choice avoids.
 */
export const reclaimExpiredLeases = async (
  now: Date = new Date(),
  tenantId?: string,
): Promise<QueuedTask[]> => {
  const rows = await db().$queryRaw<TaskRow[]>`
    UPDATE workflow.workflow_tasks AS t
    SET status = 'pending',
        "lockedBy" = NULL,
        "leaseExpiresAt" = NULL,
        "lastError" = COALESCE(t."lastError", 'lease expired; worker presumed dead'),
        "updatedAt" = ${ts(now)}::timestamp
    WHERE t.status = 'running'
      AND t."leaseExpiresAt" IS NOT NULL
      AND t."leaseExpiresAt" < ${ts(now)}::timestamp
      AND (${tenantId ?? null}::uuid IS NULL OR t."tenantId" = ${tenantId ?? null}::uuid)
    RETURNING t.*
  `;
  return rows.map(toTask);
};

export const succeed = async (
  taskId: string,
  now: Date = new Date(),
  tx?: Client,
): Promise<void> => {
  const client = tx ?? db();
  await client.workflowTask.update({
    where: { id: taskId },
    data: { status: 'succeeded', lockedBy: null, leaseExpiresAt: null, updatedAt: now },
  });
};

/** Exponential backoff with a cap. `attempts` is the count already made. */
export const backoffFor = (attempts: number, baseSeconds: number): number =>
  Math.min(baseSeconds * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_SECONDS);

export type FailureDisposition =
  | { readonly outcome: 'retry_scheduled'; readonly nextRunAt: Date; readonly attempt: number }
  | { readonly outcome: 'dead_lettered'; readonly attempts: number };

/**
 * Record a failure and decide what happens next.
 *
 * Returns the disposition so the caller writes the matching ledger event. Every failure is
 * logged — §10.5 requires zero silent workflow failures, and "the retry succeeded so nobody
 * needed to know" is exactly the reasoning that makes a degrading integration invisible until
 * it fails permanently.
 */
export const fail = async (
  task: QueuedTask,
  error: string,
  now: Date = new Date(),
): Promise<FailureDisposition> => {
  // `attempts` was already incremented at claim time, so it is the number made including this one.
  if (task.attempts >= task.maxAttempts) {
    await db().workflowTask.update({
      where: { id: task.id },
      data: {
        status: 'dead_letter',
        lastError: error,
        lockedBy: null,
        leaseExpiresAt: null,
        updatedAt: now,
      },
    });
    return { outcome: 'dead_lettered', attempts: task.attempts };
  }

  const nextRunAt = new Date(now.getTime() + backoffFor(task.attempts, task.backoffSeconds) * 1000);

  await db().workflowTask.update({
    where: { id: task.id },
    data: {
      status: 'pending',
      lastError: error,
      runAt: nextRunAt,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: now,
    },
  });

  return { outcome: 'retry_scheduled', nextRunAt, attempt: task.attempts };
};

/** Park a task until an external completion (agent work, human checkpoint, event wait). */
export const park = async (taskId: string, now: Date = new Date()): Promise<void> => {
  await db().workflowTask.update({
    where: { id: taskId },
    data: { status: 'waiting', lockedBy: null, leaseExpiresAt: null, updatedAt: now },
  });
};

export const find = async (taskId: string): Promise<QueuedTask | null> => {
  const row = await db().workflowTask.findUnique({ where: { id: taskId } });
  return row ? toTask(row) : null;
};

export const forInstance = async (instanceId: string): Promise<QueuedTask[]> => {
  const rows = await db().workflowTask.findMany({
    where: { instanceId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toTask);
};

/** Tasks past their SLA that have not yet been escalated. */
export const breachedSlas = async (
  now: Date = new Date(),
  tenantId?: string,
): Promise<QueuedTask[]> => {
  const rows = await db().workflowTask.findMany({
    where: {
      status: { in: ['pending', 'running', 'waiting'] },
      slaDueAt: { lt: now },
      escalatedAt: null,
      ...(tenantId !== undefined ? { tenantId } : {}),
    },
  });
  return rows.map(toTask);
};

/**
 * Push a claimed task back to pending with a later `runAt`, releasing the lease.
 *
 * "A wait state is a row with runAt in the future" is how this queue already works; this is that,
 * for a moment that could only be computed once the instance context was in hand. The task is
 * claimed again when the time comes and resolves itself then.
 */
/** Set when the first chase on a wait falls due. */
export const scheduleReminder = async (taskId: string, dueAt: Date): Promise<void> => {
  await db().workflowTask.update({ where: { id: taskId }, data: { remindDueAt: dueAt } });
};

export const deferUntil = async (taskId: string, runAt: Date): Promise<void> => {
  await db().workflowTask.update({
    where: { id: taskId },
    data: { status: 'pending', runAt, lockedBy: null, leaseExpiresAt: null },
  });
};

/**
 * Waits that are due a chase.
 *
 * Only `waiting` rows, and only ones a node gave a `remindDueAt`. A task that has resolved is no
 * longer waiting, so a reminder cannot be sent about something that has already arrived - the
 * property that makes this safe to point at a client.
 */
export const dueReminders = async (
  now: Date = new Date(),
  tenantId?: string,
): Promise<QueuedTask[]> => {
  const rows = await db().workflowTask.findMany({
    where: {
      status: 'waiting',
      remindDueAt: { lte: now },
      ...(tenantId !== undefined ? { tenantId } : {}),
    },
  });
  return rows.map(toTask);
};

/**
 * Record a chase, and schedule the next one or stop.
 *
 * `remindDueAt` is set to null at the cap, which is what takes the row out of `dueReminders`
 * permanently rather than leaving it to be re-counted on every pass.
 */
export const markReminded = async (taskId: string, nextDueAt: Date | null): Promise<void> => {
  await db().workflowTask.update({
    where: { id: taskId },
    data: { remindersSent: { increment: 1 }, remindDueAt: nextDueAt },
  });
};

export const markEscalated = async (taskId: string, now: Date = new Date()): Promise<void> => {
  await db().workflowTask.update({ where: { id: taskId }, data: { escalatedAt: now } });
};
