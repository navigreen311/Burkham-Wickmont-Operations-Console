/**
 * The Event Ledger listener - Specification v2 §5.3, "Triggers on Event Ledger emissions.
 * Enables event-driven workflow initiation (e.g., document upload triggers Phase 0 workflow)."
 *
 * Two jobs per pass:
 *   1. resolve `wait` nodes that were parked awaiting a named event
 *   2. start instances for triggers matching the event
 *
 * Exactly-once is enforced by a unique constraint on `(triggerId, ledgerEventId)`, not by the
 * cursor. A crash between starting an instance and advancing the cursor replays the event, the
 * insert conflicts, and nothing starts twice. That distinction matters here specifically: a
 * duplicated workflow means duplicated client outreach.
 *
 * Each pass is bounded by the maximum ledger `seq` read at the start. The listener writes ledger
 * events of its own (`workflow.started`, `workflow.trigger_fired`), and without the bound a
 * trigger on a `workflow.*` type could feed itself inside a single pass. Bounding also makes a
 * pass finite regardless of what it produces.
 */

import { db, Prisma } from '@bwc/db';
import { append, read } from '@bwc/ledger';
import { find as findClient } from '@bwc/clients';
import {
  ok,
  refused,
  type EventActor,
  type EventType,
  type LedgerEvent,
  type Outcome,
} from '@bwc/core';
import { evaluate, type EvaluationScope, type Predicate } from './predicate.js';
import { start, findInstance, resolveEventWait } from './engine.js';
import { definitionForInstance } from './definition.js';

export const LISTENER_CONSUMER = 'workflow_listener';

export interface TriggerInput {
  readonly tenantId: string;
  readonly eventType: EventType;
  readonly playbookKey: string;
  readonly condition?: Predicate;
}

export interface Trigger {
  readonly id: string;
  readonly tenantId: string;
  readonly eventType: string;
  readonly playbookKey: string;
  readonly condition: Predicate | null;
  readonly enabled: boolean;
}

export const upsertTrigger = async (input: TriggerInput): Promise<Trigger> => {
  const row = await db().workflowTrigger.upsert({
    where: {
      tenantId_eventType_playbookKey: {
        tenantId: input.tenantId,
        eventType: input.eventType,
        playbookKey: input.playbookKey,
      },
    },
    create: {
      tenantId: input.tenantId,
      eventType: input.eventType,
      playbookKey: input.playbookKey,
      // Prisma models an absent nullable Json as DbNull, distinct from a stored JSON `null`.
      condition: input.condition === undefined ? Prisma.DbNull : (input.condition as object),
    },
    update: {
      condition: input.condition === undefined ? Prisma.DbNull : (input.condition as object),
      enabled: true,
    },
  });
  return toTrigger(row);
};

interface TriggerRow {
  id: string;
  tenantId: string;
  eventType: string;
  playbookKey: string;
  condition: unknown;
  enabled: boolean;
}

const toTrigger = (row: TriggerRow): Trigger => ({
  id: row.id,
  tenantId: row.tenantId,
  eventType: row.eventType,
  playbookKey: row.playbookKey,
  condition: (row.condition ?? null) as Predicate | null,
  enabled: row.enabled,
});

export const setTriggerEnabled = async (triggerId: string, enabled: boolean): Promise<void> => {
  await db().workflowTrigger.update({ where: { id: triggerId }, data: { enabled } });
};

// --- Cursor ---------------------------------------------------------------

const readCursor = async (tenantId: string): Promise<number> => {
  const row = await db().ledgerCursor.findUnique({
    where: { tenantId_consumer: { tenantId, consumer: LISTENER_CONSUMER } },
  });
  return row?.lastSeq ?? 0;
};

const writeCursor = async (tenantId: string, lastSeq: number): Promise<void> => {
  await db().ledgerCursor.upsert({
    where: { tenantId_consumer: { tenantId, consumer: LISTENER_CONSUMER } },
    create: { tenantId, consumer: LISTENER_CONSUMER, lastSeq },
    update: { lastSeq },
  });
};

/**
 * Skip a tenant's existing history.
 *
 * Registering a trigger should not fire it retroactively across every event already in the
 * Ledger - that would start a workflow per historical client the moment someone saves a
 * configuration. Called when a tenant is first onboarded to the listener.
 */
export const seekToLatest = async (tenantId: string): Promise<number> => {
  const tail = await db().ledgerEvent.findFirst({
    where: { tenantId },
    orderBy: [{ seq: 'desc' }, { id: 'asc' }],
    select: { seq: true },
  });
  const seq = tail?.seq ?? 0;
  await writeCursor(tenantId, seq);
  return seq;
};

// --- The pass -------------------------------------------------------------

export interface ListenerPassResult {
  readonly tenantsScanned: number;
  readonly eventsProcessed: number;
  readonly waitsResolved: number;
  readonly triggersFired: number;
  readonly duplicatesSkipped: number;
}

export interface ListenerPassOptions {
  readonly actor: EventActor;
  readonly now?: Date;
  readonly tenantId?: string;
}

export const listenerPass = async (options: ListenerPassOptions): Promise<ListenerPassResult> => {
  const now = options.now ?? new Date();

  const tenants =
    options.tenantId !== undefined
      ? [{ id: options.tenantId }]
      : await db().tenant.findMany({ select: { id: true } });

  let eventsProcessed = 0;
  let waitsResolved = 0;
  let triggersFired = 0;
  let duplicatesSkipped = 0;

  for (const tenant of tenants) {
    const cursor = await readCursor(tenant.id);

    // Bound the pass. Events this pass writes are picked up by the next one.
    const tail = await db().ledgerEvent.findFirst({
      where: { tenantId: tenant.id },
      orderBy: [{ seq: 'desc' }, { id: 'asc' }],
      select: { seq: true },
    });
    const maxSeq = tail?.seq ?? 0;
    if (maxSeq <= cursor) continue;

    const events = (await read({ tenantId: tenant.id })).filter(
      (event) => event.seq > cursor && event.seq <= maxSeq,
    );

    const triggers = (
      await db().workflowTrigger.findMany({ where: { tenantId: tenant.id, enabled: true } })
    ).map(toTrigger);

    for (const event of events) {
      eventsProcessed += 1;

      waitsResolved += await resolveWaits(event, options.actor, now);

      for (const trigger of triggers.filter((t) => t.eventType === event.type)) {
        const outcome = await fireTrigger(trigger, event, options.actor, now);
        if (outcome === 'fired') triggersFired += 1;
        else if (outcome === 'duplicate') duplicatesSkipped += 1;
      }
    }

    await writeCursor(tenant.id, maxSeq);
  }

  return {
    tenantsScanned: tenants.length,
    eventsProcessed,
    waitsResolved,
    triggersFired,
    duplicatesSkipped,
  };
};

/**
 * Resolve `wait` nodes awaiting this event type.
 *
 * A wait parked by an instance carrying a client only resolves for an event about that client -
 * otherwise one client's document upload would wake every other client's waiting workflow.
 * Instances with no client resolve on any matching event in the tenant.
 */
const resolveWaits = async (event: LedgerEvent, actor: EventActor, now: Date): Promise<number> => {
  const waiting = await db().workflowTask.findMany({
    where: { tenantId: event.tenantId, kind: 'wait', status: 'waiting' },
  });

  let resolved = 0;

  for (const task of waiting) {
    const instance = await findInstance(task.instanceId);
    if (!instance) continue;
    if (instance.clientId !== null && instance.clientId !== (event.clientId ?? null)) continue;

    const definition = await definitionForInstance(instance);
    const node = definition?.nodes[task.nodeKey];
    if (!node || node.kind !== 'wait' || !('event' in node.until)) continue;
    if (node.until.event !== event.type) continue;

    // The engine performs the advance: the listener knows the wait is satisfied, but only the
    // engine knows what comes next in the graph. Guarded on `waiting` inside, so a concurrent
    // pass cannot resolve the same wait twice.
    const resumed = await resolveEventWait(event.tenantId, task.id, actor, now);
    if (resumed.status !== 'ok') continue;

    await append({
      tenantId: event.tenantId,
      type: 'workflow.wait_resolved',
      actor,
      ...(instance.clientId !== null ? { clientId: instance.clientId } : {}),
      payload: {
        instanceId: instance.id,
        nodeKey: task.nodeKey,
        resolvedByEvent: event.type,
        ledgerEventId: event.id,
      },
    });
    resolved += 1;
  }

  return resolved;
};

type FireOutcome = 'fired' | 'duplicate' | 'condition_not_met' | 'failed';

const fireTrigger = async (
  trigger: Trigger,
  event: LedgerEvent,
  actor: EventActor,
  now: Date,
): Promise<FireOutcome> => {
  if (trigger.condition !== null) {
    const scope = await buildScope(event);
    const result = evaluate(trigger.condition, scope);
    if (!result.ok) {
      // A broken condition disables the trigger rather than firing it on everything or
      // silently on nothing. Both alternatives are worse than saying so.
      await setTriggerEnabled(trigger.id, false);
      await append({
        tenantId: trigger.tenantId,
        type: 'workflow.failed',
        actor,
        payload: {
          triggerId: trigger.id,
          reason: `trigger condition invalid: ${result.reason}`,
          action: 'trigger disabled until corrected',
        },
      });
      return 'failed';
    }
    if (!result.value) return 'condition_not_met';
  }

  // Claim the (trigger, event) pair before doing anything with side effects.
  try {
    await db().workflowTriggerFiring.create({
      data: { triggerId: trigger.id, ledgerEventId: event.id },
    });
  } catch {
    // Unique violation: this pair was already handled, by an earlier pass or another worker.
    return 'duplicate';
  }

  const started = await start({
    tenantId: trigger.tenantId,
    playbookKey: trigger.playbookKey,
    actor,
    now,
    ...(event.clientId !== undefined ? { clientId: event.clientId } : {}),
    context: { triggeredByEvent: event.type, ledgerEventId: event.id },
  });

  if (started.status !== 'ok') {
    await append({
      tenantId: trigger.tenantId,
      type: 'workflow.failed',
      actor,
      payload: {
        triggerId: trigger.id,
        playbookKey: trigger.playbookKey,
        reason:
          started.status === 'refused' || started.status === 'failed'
            ? started.reason
            : `could not start: ${started.status}`,
      },
    });
    return 'failed';
  }

  await db().workflowTriggerFiring.updateMany({
    where: { triggerId: trigger.id, ledgerEventId: event.id },
    data: { instanceId: started.value.id },
  });

  await append({
    tenantId: trigger.tenantId,
    type: 'workflow.trigger_fired',
    actor,
    ...(event.clientId !== undefined ? { clientId: event.clientId } : {}),
    payload: {
      triggerId: trigger.id,
      eventType: event.type,
      playbookKey: trigger.playbookKey,
      instanceId: started.value.id,
    },
  });

  return 'fired';
};

/** Facts a trigger condition may read: the event payload, and the client it concerns. */
const buildScope = async (event: LedgerEvent): Promise<EvaluationScope> => {
  const scope: {
    client?: Record<string, unknown>;
    context: Record<string, unknown>;
    instance: Record<string, unknown>;
  } = {
    context: { ...event.payload, eventType: event.type },
    instance: { eventType: event.type, seq: event.seq },
  };

  if (event.clientId !== undefined) {
    const client = await findClient(event.tenantId, event.clientId);
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

/** Guard for callers registering a trigger on an event type the Engine itself writes. */
export const assertNotSelfTriggering = (
  eventType: EventType,
  playbookKey: string,
): Outcome<true> =>
  eventType === 'workflow.started'
    ? refused(
        `A trigger on 'workflow.started' starting '${playbookKey}' would start a workflow for every workflow started, including its own.`,
        'Blueprint 2.2 - triggers must not feed themselves',
      )
    : ok(true);
