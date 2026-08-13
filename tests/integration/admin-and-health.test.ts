/**
 * 11.7 Admin Configuration Center and 11.8 System Health, end to end.
 *
 * Three properties carry this file.
 *
 * **An invariant cannot be set through the API either.** The registry absence is asserted in the
 * unit test; here the write path is asserted, because a registry that omits a key and an API that
 * accepts one anyway would be a control that looks enforced.
 *
 * **The effective value is derived, and a staged change does not take effect.** Staging that only
 * set a flag would pass a test that checked the flag and fail the one that reads the value.
 *
 * **A broken ledger chain reports failing.** The most consequential probe, tested by breaking it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { create as createClient } from '@bwc/clients';
import {
  allEffectiveValues,
  changeHistory,
  effectiveValue,
  parameterFor,
  promoteStagedChange,
  rollback,
  setParameter,
  stagedChanges,
} from '@bwc/admin';
import {
  GATED_VENDORS,
  probeVendor,
  queueHealth,
  ledgerHealth,
  systemHealth,
  workflowHealth,
} from '@bwc/observability';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

const NOW = new Date('2026-08-11T12:00:00.000Z');
const HUMAN = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('admin-health');
  await createClient(fx.tenant.id, 'Health Check Holdings LLC', HUMAN());
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('11.7 the effective value is derived', () => {
  it('falls back to the compiled default and says so', async () => {
    const value = await effectiveValue(fx.tenant.id, 'sales.INACTIVITY_DAYS');
    expect(value.status).toBe('ok');
    if (value.status !== 'ok') return;
    expect(value.value.value).toBe(45);
    // A caller that could not tell the difference would have no way to know whether a tenant had
    // ever considered the setting.
    expect(value.value.source).toBe('compiled_default');
    expect(value.value.changedAt).toBeNull();
  });

  it('follows a change, with no separate current-value table to keep in step', async () => {
    const changed = await setParameter({
      tenantId: fx.tenant.id,
      key: 'sales.INACTIVITY_DAYS',
      value: 30,
      reason: 'Concierge Desk asked for a tighter follow-up rhythm on the Texas cohort.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(changed.status).toBe('ok');

    const value = await effectiveValue(fx.tenant.id, 'sales.INACTIVITY_DAYS');
    if (value.status !== 'ok') return;
    expect(value.value.value).toBe(30);
    expect(value.value.source).toBe('configured');
    expect(value.value.reason).toMatch(/tighter follow-up rhythm/);
  });

  it('refuses a change with no readable reason', async () => {
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'sales.INACTIVITY_DAYS',
      value: 35,
      reason: 'tweak',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('refuses a value outside the declared bounds', async () => {
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'sales.INACTIVITY_DAYS',
      value: 400,
      reason: 'Somebody wants leads to escalate roughly never.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/7-120/);
  });

  it('refuses a change by an agent', async () => {
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'sales.INACTIVITY_DAYS',
      value: 35,
      reason: 'The agent believes a shorter window would improve conversion.',
      changedBy: fx.agent.id,
      actor: { id: fx.agent.id, kind: 'village_agent' },
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });

  it('refuses a change that changes nothing', async () => {
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'sales.INACTIVITY_DAYS',
      value: 30,
      reason: 'Setting it to the value it already has, which is noise in the audit trail.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
  });
});

describe('11.7 an invariant cannot be set through the API', () => {
  it('refuses a registered invariant with its reasoning', async () => {
    // The registry omits it; this asserts the WRITE PATH refuses too. A registry that omitted a key
    // and an API that accepted one anyway would be a control that only looks enforced.
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'comms.QUIET_HOURS',
      value: 24,
      reason: 'Somebody wants to be able to text clients at three in the morning.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/TCPA/);
      expect(result.reason).toMatch(/configurable version of breaking the law/);
    }
  });

  it('refuses the prohibited-action list', async () => {
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'core.PROHIBITED_ACTIONS',
      value: 1,
      reason: 'An attempt to make a Level 4 action permitted through configuration.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    if (result.status === 'refused') {
      expect(result.reason).toMatch(/no authority level that could edit the list/);
    }
  });

  it('refuses an unregistered key rather than storing it', async () => {
    // A typo must not create a setting nothing reads - which would look configured and change
    // nothing, and be discovered when somebody wondered why the change had no effect.
    const result = await setParameter({
      tenantId: fx.tenant.id,
      key: 'sales.INACTIVITY_DAYZ',
      value: 30,
      reason: 'A mistyped key that should not silently become a setting.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(result.status).toBe('refused');
    expect(await db().configurationChange.count({ where: { key: 'sales.INACTIVITY_DAYZ' } })).toBe(
      0,
    );
  });

  it('refuses to READ an invariant as a parameter, with the same reasoning', async () => {
    const result = await effectiveValue(fx.tenant.id, 'partners.MINIMUM_COHORT');
    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.reason).toMatch(/ADR-0014/);
  });
});

describe('11.7 staged rollout and rollback', () => {
  let stagedId: string;

  it('stages a high-risk change without applying it', async () => {
    expect(parameterFor('partners.RECERTIFICATION_CADENCE_DAYS')?.highRisk).toBe(true);

    const staged = await setParameter({
      tenantId: fx.tenant.id,
      key: 'partners.RECERTIFICATION_CADENCE_DAYS',
      value: 180,
      reason:
        'Channel Partnerships proposes six-monthly recertification after the claim-library review.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });

    expect(staged.status).toBe('ok');
    if (staged.status !== 'ok') return;
    stagedId = staged.value.id;
    expect(staged.value.staged).toBe(true);
    expect(staged.value.appliedAt).toBeNull();

    // THE ASSERTION. Staging that only set a flag would pass a test checking the flag and fail
    // this one - the value must not have moved.
    const value = await effectiveValue(fx.tenant.id, 'partners.RECERTIFICATION_CADENCE_DAYS');
    if (value.status !== 'ok') return;
    expect(value.value.value).toBe(365);
    expect(value.value.source).toBe('compiled_default');

    expect((await stagedChanges(fx.tenant.id)).map((change) => change.id)).toContain(stagedId);
  });

  it('takes effect on promotion', async () => {
    const promoted = await promoteStagedChange({
      tenantId: fx.tenant.id,
      changeId: stagedId,
      promotedBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(promoted.status).toBe('ok');

    const value = await effectiveValue(fx.tenant.id, 'partners.RECERTIFICATION_CADENCE_DAYS');
    if (value.status !== 'ok') return;
    expect(value.value.value).toBe(180);

    // Promoting twice is refused.
    expect(
      (
        await promoteStagedChange({
          tenantId: fx.tenant.id,
          changeId: stagedId,
          promotedBy: fx.human.id,
          actor: HUMAN(),
          now: NOW,
        })
      ).status,
    ).toBe('refused');
  });

  it('rolls back by writing a new change, not by deleting the old one', async () => {
    const history = await changeHistory(fx.tenant.id, 'sales.INACTIVITY_DAYS');
    const original = history[0];
    expect(original).toBeDefined();

    const rolledBack = await rollback({
      tenantId: fx.tenant.id,
      changeId: original!.id,
      reason:
        'The tighter window produced escalations on leads that were simply waiting on documents.',
      rolledBackBy: fx.human.id,
      actor: HUMAN(),
      now: NOW,
    });
    expect(rolledBack.status).toBe('ok');

    const value = await effectiveValue(fx.tenant.id, 'sales.INACTIVITY_DAYS');
    if (value.status !== 'ok') return;
    expect(value.value.value).toBe(45);

    // The Tuesday change is still there. An undo that removed it would answer "what is it now" and
    // lose "what happened", which is the question an audit asks.
    const after = await changeHistory(fx.tenant.id, 'sales.INACTIVITY_DAYS');
    expect(after.length).toBeGreaterThan(history.length);
    expect(after.map((change) => change.id)).toContain(original!.id);
    expect(after.at(-1)?.reason).toMatch(/Rollback of change/);
  });

  it('resolves two changes at the same instant by insertion order', async () => {
    // The regression this pins. `appliedAt` collides whenever a change and its rollback are
    // recorded at the same logical instant - which is the ordinary case, not a contrived one - and
    // with a single sort key the winner was whichever row Postgres happened to return. It passed
    // in CI and failed locally on the same code, which is what a non-deterministic sort looks like.
    const key = 'risk.DEFAULT_REVIEW_CADENCE_DAYS';
    const SAME = new Date('2026-08-11T09:00:00.000Z');

    const first = await setParameter({
      tenantId: fx.tenant.id,
      key,
      value: 120,
      reason: 'Lengthened while the Risk & Defense review backlog is cleared.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: SAME,
    });
    expect(first.status).toBe('ok');

    const second = await setParameter({
      tenantId: fx.tenant.id,
      key,
      value: 60,
      reason: 'Reverted at the same recorded instant, which is what a rollback usually is.',
      changedBy: fx.human.id,
      actor: HUMAN(),
      now: SAME,
    });
    expect(second.status).toBe('ok');

    // Both rows carry the same appliedAt; the later INSERT must win.
    const value = await effectiveValue(fx.tenant.id, key);
    if (value.status !== 'ok') return;
    expect(value.value.value).toBe(60);
  });

  it('lists every parameter with the value in force', async () => {
    const all = await allEffectiveValues(fx.tenant.id);
    expect(all.length).toBe((await import('@bwc/admin')).PARAMETERS.length);
    const cadence = all.find((entry) => entry.key === 'partners.RECERTIFICATION_CADENCE_DAYS');
    expect(cadence?.value).toBe(180);
    expect(cadence?.parameter.owner).toBe('Channel Partnerships');
  });
});

describe('11.8 system health', () => {
  it('reports an empty ledger as unmonitored rather than intact', async () => {
    const empty = await makeFixture('health-empty');
    const health = await ledgerHealth(empty.tenant.id);
    // An empty ledger is not an intact one. The check becomes meaningful with the first event.
    expect(health.state).toBe('unmonitored');
    await cleanupTenant(empty.tenant.id);
  });

  it('reports an intact ledger as healthy, with what was checked', async () => {
    const health = await ledgerHealth(fx.tenant.id);
    expect(health.state).toBe('healthy');
    expect(health.measurement).toMatch(/event\(s\) checked/);
  });

  it('reports a broken chain as failing', async () => {
    const broken = await makeFixture('health-broken');
    await createClient(broken.tenant.id, 'Chain Test LLC', {
      id: broken.human.id,
      kind: 'human',
    });

    // Break the chain the only way it CAN be broken: an INSERT straight into the table with a
    // prevHash that does not link. 11.3's trigger rejects UPDATE outright, which is why the
    // obvious tampering approach fails - and is itself worth knowing when reading this test.
    const last = await db().ledgerEvent.findFirst({
      where: { tenantId: broken.tenant.id },
      orderBy: { seq: 'desc' },
    });
    expect(last).not.toBeNull();
    await db().$executeRawUnsafe(`
      INSERT INTO ledger.ledger_events
        (id, "tenantId", seq, type, "actorId", "actorKind", payload, "prevHash", signature)
      VALUES
        (gen_random_uuid(), '${broken.tenant.id}'::uuid, ${(last?.seq ?? 0) + 1}, 'client.created',
         '${broken.human.id}'::uuid, 'human', '{"injected":true}'::jsonb, 'not-the-real-prev', 'deadbeef')
    `);

    const health = await ledgerHealth(broken.tenant.id);
    expect(health.state).toBe('failing');
    expect(health.detail).toMatch(/cannot be relied on/);

    await cleanupTenant(broken.tenant.id);
  });

  it('reports a quiet queue as healthy and does not count future work as backlog', async () => {
    const health = await queueHealth(fx.tenant.id, NOW);
    expect(health.state).toBe('healthy');
    // A follow-up booked for next month is not congestion.
    expect(health.detail).toMatch(/not counted as backlog/);
  });

  it('reports no workflow activity as unmonitored, not as clean', async () => {
    const health = await workflowHealth(fx.tenant.id, NOW);
    expect(health.state).toBe('unmonitored');
    // Nothing ran is a different fact from everything running cleanly.
    expect(health.detail).toMatch(/Nothing ran/);
  });

  it('reports a failing workflow rate as failing', async () => {
    const busy = await makeFixture('health-busy');
    for (let index = 0; index < 4; index += 1) {
      await append({
        tenantId: busy.tenant.id,
        type: 'workflow.task_failed',
        actor: { id: busy.human.id, kind: 'human' },
        payload: { taskId: `t${index}` },
      });
    }
    await append({
      tenantId: busy.tenant.id,
      type: 'workflow.task_succeeded',
      actor: { id: busy.human.id, kind: 'human' },
      payload: { taskId: 'ok' },
    });

    const health = await workflowHealth(busy.tenant.id, new Date());
    expect(health.state).toBe('failing');
    expect(health.measurement).toMatch(/4 failed of 5/);

    await cleanupTenant(busy.tenant.id);
  });

  it('never shows a gated vendor as healthy', async () => {
    const health = await systemHealth(fx.tenant.id, NOW);

    for (const vendor of GATED_VENDORS) {
      const row = health.components.find((component) => component.key === `vendor_${vendor.key}`);
      expect(row, vendor.key).toBeDefined();
      // Zero calls is not zero errors. A green Plaid row on a system that has never called Plaid
      // is the most confidently wrong thing this module could produce.
      expect(row?.state, vendor.key).toBe('unmonitored');
      // Every row says WHY it is gated. The assertion used to require "Decision A" or "Decision B",
      // which held while every gated vendor was a data source; the delivery processors added in
      // ADR-0085 are gated for a different reason and cite no such decision.
      expect(String(row?.detail).length, vendor.key).toBeGreaterThan(40);
    }

    // The three data vendors still cite the decision that put them behind the gate.
    for (const key of ['plaid', 'business_bureau', 'personal_credit']) {
      const row = health.components.find((component) => component.key === `vendor_${key}`);
      expect(row?.detail, key).toMatch(/Decision [AB]/);
    }

    // And the three delivery processors appear at all, which they did not before: a health board
    // that omits a category reports on a subset while looking complete.
    for (const key of ['email', 'sms', 'voice']) {
      expect(
        health.components.some((component) => component.key === `vendor_${key}`),
        key,
      ).toBe(true);
    }
  });

  it('carries every unmonitored component rather than omitting it', async () => {
    const health = await systemHealth(fx.tenant.id, NOW);
    const keys = health.components.map((component) => component.key);
    for (const key of ['uptime', 'api_latency', 'ocr_failures', 'security_alerts']) {
      expect(keys, key).toContain(key);
    }
    // Each names what would monitor it, so the row is a gap somebody can close.
    for (const component of health.components.filter((entry) => entry.state === 'unmonitored')) {
      expect(component.detail.length, component.key).toBeGreaterThan(40);
    }
  });

  it('takes the worst component as the overall verdict', async () => {
    const health = await systemHealth(fx.tenant.id, NOW);
    // With several unmonitored components and nothing failing, overall is unmonitored - not
    // healthy, and not an average of the healthy probes.
    expect(health.overall).toBe('unmonitored');
    expect(health.counts.healthy).toBeGreaterThan(0);
  });

  it('reports a direct vendor probe as not_built naming the gate', async () => {
    const result = await probeVendor('plaid');
    expect(result.status).toBe('not_built');
    if (result.status === 'not_built') expect(result.reason).toMatch(/Decision A/);

    const unknown = await probeVendor('nonesuch');
    expect(unknown.status).toBe('not_built');
    if (unknown.status === 'not_built') expect(unknown.reason).toMatch(/not a known vendor/);
  });
});
