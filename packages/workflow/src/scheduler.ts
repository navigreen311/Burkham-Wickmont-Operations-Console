/**
 * The scheduler - Specification v2 §5.3, "Cron-like capability for recurring workflows".
 *
 * Drives monthly Capital Command Briefs, 60/90-day promo expiry alerts, quarterly reviews,
 * lender-research staleness reviews, and annual partner recertification.
 *
 * Cron evaluation is delegated to `cron-parser` rather than hand-rolled. Cron's semantics are
 * subtle in ways that produce silent wrongness: day-of-month and day-of-week are OR'd when both
 * are restricted, month lengths vary, and a local wall-clock schedule has to survive DST. A
 * monthly brief landing an hour early for half the year is a defect nobody reports.
 *
 * Verified before adopting - `0 9 1 * *` in America/Los_Angeles yields 16:00Z through summer and
 * 17:00Z after the November transition, keeping wall-clock 09:00 on both sides.
 */

import { CronExpressionParser } from 'cron-parser';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { start } from './engine.js';

export interface ScheduleInput {
  readonly tenantId: string;
  readonly key: string;
  readonly playbookKey: string;
  readonly cronExpression: string;
  /** IANA zone. Required in practice: a bare cron expression is ambiguous without one. */
  readonly timezone: string;
  readonly now?: Date;
}

export interface Schedule {
  readonly id: string;
  readonly tenantId: string;
  readonly key: string;
  readonly playbookKey: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly nextRunAt: Date;
  readonly lastRunAt: Date | null;
  readonly enabled: boolean;
}

/**
 * Compute the next occurrence strictly after `after`.
 *
 * Returns an Outcome because an invalid cron expression or unknown timezone is a configuration
 * error a caller can report, not an exception to unwind through the worker loop. A scheduler
 * that throws on one bad row stops processing every other tenant's schedules.
 */
export const nextOccurrence = (
  cronExpression: string,
  timezone: string,
  after: Date,
): Outcome<Date> => {
  try {
    const iterator = CronExpressionParser.parse(cronExpression, {
      currentDate: after,
      tz: timezone,
    });
    return ok(iterator.next().toDate());
  } catch (error) {
    return refused(
      `Cannot evaluate cron '${cronExpression}' in timezone '${timezone}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      'Blueprint 2.2 - a schedule that cannot be evaluated is a configuration error, not a silent no-op',
    );
  }
};

export const upsertSchedule = async (input: ScheduleInput): Promise<Outcome<Schedule>> => {
  const now = input.now ?? new Date();
  const next = nextOccurrence(input.cronExpression, input.timezone, now);
  if (next.status !== 'ok') return next;

  const row = await db().scheduledWorkflow.upsert({
    where: { tenantId_key: { tenantId: input.tenantId, key: input.key } },
    create: {
      tenantId: input.tenantId,
      key: input.key,
      playbookKey: input.playbookKey,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      nextRunAt: next.value,
    },
    update: {
      playbookKey: input.playbookKey,
      cronExpression: input.cronExpression,
      timezone: input.timezone,
      nextRunAt: next.value,
    },
  });

  return ok(toSchedule(row));
};

interface ScheduleRow {
  id: string;
  tenantId: string;
  key: string;
  playbookKey: string;
  cronExpression: string;
  timezone: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  enabled: boolean;
}

const toSchedule = (row: ScheduleRow): Schedule => ({
  id: row.id,
  tenantId: row.tenantId,
  key: row.key,
  playbookKey: row.playbookKey,
  cronExpression: row.cronExpression,
  timezone: row.timezone,
  nextRunAt: row.nextRunAt,
  lastRunAt: row.lastRunAt,
  enabled: row.enabled,
});

export const findSchedule = async (tenantId: string, key: string): Promise<Schedule | null> => {
  const row = await db().scheduledWorkflow.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  return row ? toSchedule(row) : null;
};

export const setScheduleEnabled = async (
  tenantId: string,
  key: string,
  enabled: boolean,
): Promise<void> => {
  await db().scheduledWorkflow.update({
    where: { tenantId_key: { tenantId, key } },
    data: { enabled },
  });
};

export interface SchedulerPassResult {
  readonly due: number;
  readonly fired: number;
  readonly skippedLost: number;
  readonly failed: number;
}

export interface SchedulerPassOptions {
  readonly actor: EventActor;
  readonly now?: Date;
  readonly tenantId?: string;
}

/**
 * One scheduler pass.
 *
 * Claiming is a conditional update rather than a lock: the update matches on the exact
 * `nextRunAt` that was read, so two workers racing on the same row produce one winner and one
 * update-count of zero. No lease, nothing to expire, and the scheduler stays stateless.
 *
 * Catch-up policy: a due schedule fires **once** and then advances to the next occurrence after
 * `now`. A worker down for a week must not emit seven monthly briefs on restart. The gap is not
 * erased - it is recorded as `workflow.schedule_late`, so a missed window is visible rather than
 * silently absorbed.
 */
export const schedulerPass = async (
  options: SchedulerPassOptions,
): Promise<SchedulerPassResult> => {
  const now = options.now ?? new Date();

  const due = await db().scheduledWorkflow.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    },
  });

  let fired = 0;
  let skippedLost = 0;
  let failed = 0;

  for (const row of due) {
    const schedule = toSchedule(row);

    const next = nextOccurrence(schedule.cronExpression, schedule.timezone, now);
    if (next.status !== 'ok') {
      // A misconfigured schedule must not stall the pass or fire forever. Disable it and say so.
      await db().scheduledWorkflow.update({
        where: { id: schedule.id },
        data: { enabled: false },
      });
      await append({
        tenantId: schedule.tenantId,
        type: 'workflow.failed',
        actor: options.actor,
        payload: {
          scheduleKey: schedule.key,
          reason: next.reason,
          action: 'schedule disabled until corrected',
        },
      });
      failed += 1;
      continue;
    }

    // Conditional claim. `count === 0` means another worker took this occurrence.
    const claimed = await db().scheduledWorkflow.updateMany({
      where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt: next.value, lastRunAt: now },
    });

    if (claimed.count === 0) {
      skippedLost += 1;
      continue;
    }

    // Late by more than one whole interval means occurrences were skipped. Record it.
    const lateByMs = now.getTime() - schedule.nextRunAt.getTime();
    if (lateByMs > 60_000) {
      await append({
        tenantId: schedule.tenantId,
        type: 'workflow.schedule_late',
        actor: options.actor,
        payload: {
          scheduleKey: schedule.key,
          dueAt: schedule.nextRunAt.toISOString(),
          firedAt: now.toISOString(),
          lateBySeconds: Math.round(lateByMs / 1000),
        },
      });
    }

    const started = await start({
      tenantId: schedule.tenantId,
      playbookKey: schedule.playbookKey,
      actor: options.actor,
      now,
      context: { scheduleKey: schedule.key, scheduledFor: schedule.nextRunAt.toISOString() },
    });

    if (started.status !== 'ok') {
      await append({
        tenantId: schedule.tenantId,
        type: 'workflow.failed',
        actor: options.actor,
        payload: {
          scheduleKey: schedule.key,
          reason:
            started.status === 'refused' || started.status === 'failed'
              ? started.reason
              : `could not start: ${started.status}`,
        },
      });
      failed += 1;
      continue;
    }

    await append({
      tenantId: schedule.tenantId,
      type: 'workflow.schedule_fired',
      actor: options.actor,
      payload: {
        scheduleKey: schedule.key,
        instanceId: started.value.id,
        playbookKey: schedule.playbookKey,
        nextRunAt: next.value.toISOString(),
      },
    });
    fired += 1;
  }

  return { due: due.length, fired, skippedLost, failed };
};
