/**
 * System health - blueprint 11.8.
 *
 * Blueprint 11.8 lists twelve things to monitor. This system can genuinely measure four of them,
 * and the other eight report `unmonitored` with what would measure them. That ratio is the honest
 * state of a system with no metrics backend, and reporting it is more useful than a dashboard of
 * green ticks for probes that do not exist.
 *
 * What is measurable is measurable because 11.3 and 11.4 keep real records: the task queue has a
 * depth and a dead-letter count, the Ledger has a verifiable hash chain, workflows record their
 * own failures, and SLA breaches are rows. Those four are read from the database on every call -
 * a cached health check is a health check that reports the last time somebody looked.
 *
 * Thresholds are stated as constants with their reasoning, because "the queue is deep" is a
 * judgement and somebody should be able to disagree with the number.
 */

import { db } from '@bwc/db';
import { verifyIntegrity } from '@bwc/ledger';
import {
  degraded,
  failing,
  healthy,
  summarise,
  unmonitored,
  type ComponentHealth,
  type HealthSummary,
} from './probes.js';
import { vendorProbes } from './vendors.js';

/**
 * Queue depth at which the queue is behind rather than busy.
 *
 * A queue with work in it is working. What matters is work that is DUE and not being taken, which
 * is what `runAt <= now AND status = pending` counts.
 */
export const QUEUE_DEPTH_DEGRADED = 50;
export const QUEUE_DEPTH_FAILING = 250;

/**
 * Dead letters are failing at ONE, not at a threshold.
 *
 * A dead-lettered task is work the system gave up on after exhausting its retries. There is no
 * healthy number of those greater than zero, and a threshold would be a decision that some
 * abandoned work is acceptable - taken here, in advance, by somebody who has not seen which work.
 */
export const DEAD_LETTER_FAILING = 1;

/** Tasks whose lease expired and which have not been reclaimed. Indicates a dead worker. */
export const STALE_LEASE_DEGRADED = 1;

/**
 * The queue.
 *
 * Depth counts tasks that are DUE - a wait state scheduled for next month is a row in the same
 * table and is not backlog. Counting it would make every scheduled follow-up look like congestion.
 */
export const queueHealth = async (tenantId: string, now: Date): Promise<ComponentHealth> => {
  const [due, deadLettered, staleLeases] = await Promise.all([
    db().workflowTask.count({
      where: { tenantId, status: 'pending', runAt: { lte: now } },
    }),
    db().workflowTask.count({ where: { tenantId, status: 'dead_letter' } }),
    db().workflowTask.count({
      where: { tenantId, status: 'running', leaseExpiresAt: { lt: now } },
    }),
  ]);

  const measurement = `${due} due, ${deadLettered} dead-lettered, ${staleLeases} expired lease(s)`;

  if (deadLettered >= DEAD_LETTER_FAILING) {
    return failing({
      key: 'task_queue',
      label: 'Workflow task queue',
      measurement,
      detail: `${deadLettered} task(s) have been dead-lettered - work the system gave up on after exhausting its retries. There is no healthy number above zero: a threshold here would be a decision that some abandoned work is acceptable, taken in advance by somebody who has not seen which work.`,
    });
  }

  if (due >= QUEUE_DEPTH_FAILING) {
    return failing({
      key: 'task_queue',
      label: 'Workflow task queue',
      measurement,
      detail: `${due} tasks are due and unclaimed. Above ${QUEUE_DEPTH_FAILING} the queue is not busy, it is not being worked - check that a worker is running.`,
    });
  }

  if (due >= QUEUE_DEPTH_DEGRADED || staleLeases >= STALE_LEASE_DEGRADED) {
    return degraded({
      key: 'task_queue',
      label: 'Workflow task queue',
      measurement,
      detail:
        staleLeases >= STALE_LEASE_DEGRADED
          ? `${staleLeases} task(s) hold an expired lease, which means a worker died mid-task. They return to pending when leases are reclaimed; if the count is not falling, nothing is reclaiming them.`
          : `${due} tasks are due and unclaimed - deeper than the ${QUEUE_DEPTH_DEGRADED} at which the queue is keeping up.`,
    });
  }

  return healthy({
    key: 'task_queue',
    label: 'Workflow task queue',
    measurement,
    detail: `The queue is keeping up. Scheduled work with a future runAt is not counted as backlog - a follow-up booked for next month is not congestion.`,
  });
};

/**
 * The Event Ledger's hash chain.
 *
 * The most consequential check here, and the cheapest to state: either the chain verifies or the
 * audit trail cannot be trusted. There is no degraded case - a chain with one broken link is a
 * chain, and 11.3's whole value is that a reader can check rather than trust.
 */
export const ledgerHealth = async (tenantId: string): Promise<ComponentHealth> => {
  const integrity = await verifyIntegrity(tenantId);

  if (integrity.checked === 0) {
    return unmonitored({
      key: 'event_ledger',
      label: 'Event Ledger hash chain',
      wouldRequire:
        'The tenant has no ledger events, so there is no chain to verify. This is an empty ledger, not an intact one - the check becomes meaningful with the first event.',
    });
  }

  if (!integrity.intact) {
    return failing({
      key: 'event_ledger',
      label: 'Event Ledger hash chain',
      measurement: `${integrity.checked} event(s) checked`,
      detail:
        `The hash chain is broken${integrity.firstBreakAtSeq !== undefined ? ` from sequence ${integrity.firstBreakAtSeq}` : ''}. ${integrity.detail ?? ''} The audit trail cannot be relied on until this is explained.`.trim(),
    });
  }

  return healthy({
    key: 'event_ledger',
    label: 'Event Ledger hash chain',
    measurement: `${integrity.checked} event(s) checked`,
    detail: 'Every event links to its predecessor and every signature verifies.',
  });
};

/**
 * Workflow execution.
 *
 * Counts failures against completions over the recent window rather than all time, because a
 * system that ran badly in March and well since should not read as failing today.
 */
export const WORKFLOW_FAILURE_WINDOW_HOURS = 24;
export const WORKFLOW_FAILURE_DEGRADED_SHARE = 0.1;
export const WORKFLOW_FAILURE_FAILING_SHARE = 0.3;

export const workflowHealth = async (tenantId: string, now: Date): Promise<ComponentHealth> => {
  const since = new Date(now.getTime() - WORKFLOW_FAILURE_WINDOW_HOURS * 60 * 60 * 1000);

  const [failed, succeeded] = await Promise.all([
    db().ledgerEvent.count({
      where: { tenantId, type: 'workflow.task_failed', createdAt: { gte: since } },
    }),
    db().ledgerEvent.count({
      where: { tenantId, type: 'workflow.task_succeeded', createdAt: { gte: since } },
    }),
  ]);

  const total = failed + succeeded;

  if (total === 0) {
    return unmonitored({
      key: 'workflow_execution',
      label: 'Workflow execution',
      wouldRequire: `No workflow task completed or failed in the last ${WORKFLOW_FAILURE_WINDOW_HOURS} hours, so there is no failure rate. Nothing ran - which is a different fact from everything running cleanly, and worth checking if a worker should have been busy.`,
    });
  }

  const share = failed / total;
  const measurement = `${failed} failed of ${total} in ${WORKFLOW_FAILURE_WINDOW_HOURS}h`;

  if (share >= WORKFLOW_FAILURE_FAILING_SHARE) {
    return failing({
      key: 'workflow_execution',
      label: 'Workflow execution',
      measurement,
      detail: `${(share * 100).toFixed(0)}% of workflow tasks failed. Above ${WORKFLOW_FAILURE_FAILING_SHARE * 100}% the problem is systemic rather than a handful of bad rows.`,
    });
  }

  if (share >= WORKFLOW_FAILURE_DEGRADED_SHARE) {
    return degraded({
      key: 'workflow_execution',
      label: 'Workflow execution',
      measurement,
      detail: `${(share * 100).toFixed(0)}% of workflow tasks failed, above the ${WORKFLOW_FAILURE_DEGRADED_SHARE * 100}% at which retries are absorbing the noise.`,
    });
  }

  return healthy({
    key: 'workflow_execution',
    label: 'Workflow execution',
    measurement,
    detail: 'Failures are within the range retries absorb.',
  });
};

/** SLA breaches recorded by 2.2. A breach is not a system failure, but it is not healthy either. */
export const slaHealth = async (tenantId: string, now: Date): Promise<ComponentHealth> => {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const breaches = await db().ledgerEvent.count({
    where: { tenantId, type: 'workflow.sla_breached', createdAt: { gte: since } },
  });

  if (breaches === 0) {
    return healthy({
      key: 'sla',
      label: 'Workflow SLA',
      measurement: '0 breaches in 7 days',
      detail: 'No workflow breached its SLA in the last week.',
    });
  }

  return degraded({
    key: 'sla',
    label: 'Workflow SLA',
    measurement: `${breaches} breach(es) in 7 days`,
    detail: `${breaches} workflow SLA breach(es) in the last week. A breach means work is late rather than broken, which is why this is degraded rather than failing - but it is what a client experiences.`,
  });
};

/**
 * Things blueprint 11.8 names that nothing in this system can measure.
 *
 * Carried as `unmonitored` rows rather than omitted. A dashboard missing a row asserts there is
 * nothing to report about it, and the reader concludes uptime is fine because there is no uptime
 * row.
 */
export const unmonitoredComponents = (): readonly ComponentHealth[] => [
  unmonitored({
    key: 'uptime',
    label: 'Uptime',
    wouldRequire:
      'No metrics backend or external uptime probe is connected. This would come from an APM or a synthetic check hitting the API from outside, neither of which exists.',
  }),
  unmonitored({
    key: 'api_latency',
    label: 'API latency',
    wouldRequire:
      'No request instrumentation exists. Latency percentiles need a metrics pipeline; computing them from the Ledger would measure business events rather than requests.',
  }),
  unmonitored({
    key: 'ocr_failures',
    label: 'OCR failures',
    wouldRequire:
      'Document parsing runs through CapitalForge to VisionAudioForge, which is not gated in (11.5). 3.3 reports its ingestion seam as not_built.',
  }),
  unmonitored({
    key: 'voice_failures',
    label: 'VoiceForge call failures',
    wouldRequire:
      'VoiceForge is not gated in. 4.3 records call consent and analyses supplied transcripts; no calls are placed or captured.',
  }),
  unmonitored({
    key: 'capitalforge_sync',
    label: 'CapitalForge data sync',
    wouldRequire: 'The CapitalForge integration is not gated in (11.5).',
  }),
  unmonitored({
    key: 'payment_processing',
    label: 'Payment processing failures',
    wouldRequire:
      'No payment processor is connected. 1.4 records charges and payments as bookkeeping entries; nothing moves money.',
  }),
  unmonitored({
    key: 'security_alerts',
    label: 'Security alerts',
    wouldRequire:
      'Argus is the portfolio security partner and is not integrated. The Vault records refused access attempts (3.2), which is a narrower thing than a security alerting surface.',
  }),
];

/**
 * The whole health picture.
 *
 * Every probe runs on every call - a cached health check reports the last time somebody looked,
 * which on this surface is the failure mode that matters.
 */
export const systemHealth = async (
  tenantId: string,
  now: Date = new Date(),
): Promise<HealthSummary> => {
  const measured = await Promise.all([
    queueHealth(tenantId, now),
    ledgerHealth(tenantId),
    workflowHealth(tenantId, now),
    slaHealth(tenantId, now),
  ]);

  return summarise([...measured, ...vendorProbes(), ...unmonitoredComponents()], now);
};
