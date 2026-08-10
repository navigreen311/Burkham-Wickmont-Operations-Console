/**
 * @bwc/notifications - 11.4 Notification & Task Queue.
 *
 * Specification v2 §5.3: the Workflow Engine's task queue "runs on top of Notification &
 * Task Queue (module 11.4)". This package owns the assignment record — who is expected to do
 * something, by when, and whether they have. The Engine owns the execution state; this owns
 * the human-facing surface of it.
 *
 * Blueprint 11.4 also lists multi-channel delivery (email, SMS, voice, in-app). That is
 * deliberately absent here rather than stubbed: sending anything client-facing has to pass the
 * Communication Compliance Scanner (4.2), which is not built. Raising an internal assignment
 * and sending an external message are different acts, and only the first one is safe today.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, type EventActor, type Outcome } from '@bwc/core';

export type NotificationStatus = 'open' | 'acknowledged' | 'completed' | 'cancelled';

export interface TaskNotification {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowTaskId: string | null;
  readonly clientId: string | null;
  readonly assignedTo: string;
  readonly kind: string;
  readonly summary: string;
  readonly status: NotificationStatus;
  readonly slaDueAt: Date | null;
}

export interface RaiseInput {
  readonly tenantId: string;
  readonly assignedTo: string;
  readonly kind: string;
  readonly summary: string;
  readonly actor: EventActor;
  readonly workflowTaskId?: string;
  readonly clientId?: string;
  readonly slaDueAt?: Date;
}

/**
 * Raise an assignment.
 *
 * `summary` reaches the Ledger, so it must stay PII-free. The ledger append redacts
 * defensively, but a summary quoting a client's actual SSN, EIN or account number would arrive
 * at a human queue with the value intact even after the ledger copy was scrubbed — describe the
 * task, never the data.
 *
 * (An earlier version of this comment illustrated the point with a realistic SSN-shaped literal,
 * and the CI secret-hygiene check rejected it. The check was right: a source file is the wrong
 * place for one even as an example.)
 */
export const raise = async (input: RaiseInput): Promise<TaskNotification> => {
  const row = await db().taskNotification.create({
    data: {
      tenantId: input.tenantId,
      assignedTo: input.assignedTo,
      kind: input.kind,
      summary: input.summary,
      workflowTaskId: input.workflowTaskId ?? null,
      clientId: input.clientId ?? null,
      slaDueAt: input.slaDueAt ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'notification.raised',
    actor: input.actor,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    payload: {
      notificationId: row.id,
      assignedTo: input.assignedTo,
      kind: input.kind,
      ...(input.workflowTaskId !== undefined ? { workflowTaskId: input.workflowTaskId } : {}),
    },
  });

  return toNotification(row);
};

interface NotificationRow {
  id: string;
  tenantId: string;
  workflowTaskId: string | null;
  clientId: string | null;
  assignedTo: string;
  kind: string;
  summary: string;
  status: string;
  slaDueAt: Date | null;
}

const toNotification = (row: NotificationRow): TaskNotification => ({
  id: row.id,
  tenantId: row.tenantId,
  workflowTaskId: row.workflowTaskId,
  clientId: row.clientId,
  assignedTo: row.assignedTo,
  kind: row.kind,
  summary: row.summary,
  status: row.status as NotificationStatus,
  slaDueAt: row.slaDueAt,
});

export const complete = async (
  tenantId: string,
  notificationId: string,
  actor: EventActor,
  now: Date = new Date(),
): Promise<Outcome<TaskNotification>> => {
  const existing = await db().taskNotification.findFirst({
    where: { id: notificationId, tenantId },
  });
  if (!existing) return noData('No such notification in this tenant.');

  const row = await db().taskNotification.update({
    where: { id: notificationId },
    data: { status: 'completed', completedAt: now },
  });

  await append({
    tenantId,
    type: 'notification.completed',
    actor,
    ...(row.clientId !== null ? { clientId: row.clientId } : {}),
    payload: { notificationId, assignedTo: row.assignedTo, kind: row.kind },
  });

  return ok(toNotification(row));
};

export const openFor = async (
  tenantId: string,
  assignedTo: string,
): Promise<TaskNotification[]> => {
  const rows = await db().taskNotification.findMany({
    where: { tenantId, assignedTo, status: 'open' },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toNotification);
};

export const findByWorkflowTask = async (
  tenantId: string,
  workflowTaskId: string,
): Promise<TaskNotification[]> => {
  const rows = await db().taskNotification.findMany({ where: { tenantId, workflowTaskId } });
  return rows.map(toNotification);
};
