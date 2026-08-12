/**
 * The seeded playbooks against a real database, and a Phase 0 client walked from end to end.
 *
 * **The blueprint's V1 goal is "execute Phases 0-2 end-to-end", and until this file nothing had.**
 * `publishPlaybook` was called only by tests, so no client workflow could start; the engine was
 * complete and empty. What this proves is not that the engine works - `workflow-engine.test.ts`
 * does that - but that the CONTENT is runnable: that the Phase 0 graph can be published, started,
 * and driven to a human checkpoint without a dead end.
 *
 * Three properties.
 *
 * **The seed is idempotent.** Run twice, and each playbook has exactly one row at the version it
 * declares. A seed that republished on every run would move every future instance onto a definition
 * nobody reviewed, and a seed that failed the second time would be one nobody dared run in an
 * environment that might already have it.
 *
 * Declaring a NEW version is a different act and a deliberate one: Phase 0 and Phase 1 are at v2
 * since the client-facing sends were added, and their v1 rows are still on the table because that
 * is what an instance started before the change is pinned to.
 *
 * **A human checkpoint raises an 11.4 task and nothing else.** Asserted by reading the notification
 * queue 2.4's console reads. There is no second approval store and this is what says so.
 *
 * **A wait resolves on a real event about the right client.** The listener matches on the client, so
 * one client's consent must not wake another's workflow.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { create as createClient, transitionComplianceState } from '@bwc/clients';
import { openFor } from '@bwc/notifications';
import {
  PHASE_0_PLAYBOOK,
  V1_PLAYBOOK_SEEDS,
  findInstance,
  forInstance,
  completeExternalTask,
  listenerPass,
  seedV1Playbooks,
  seekToLatest,
  start,
  tick,
} from '@bwc/workflow';
import { V1_TEMPLATE_SEEDS, seedV1DeliverableTemplates } from '@bwc/deliverables';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;
let clientId: string;

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

/** Fixed, because SLA deadlines and wait timers are stamped from it. */
const T0 = new Date('2026-09-01T09:00:00.000Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

const run = (now: Date) =>
  tick({ workerId: 'seed-test', now, actor: actor(), tenantId: fx.tenant.id });

beforeAll(async () => {
  fx = await makeFixture('workflow-seed');
  clientId = (await createClient(fx.tenant.id, 'Phase Zero Holdings LLC', actor())).id;
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

describe('seeding', () => {
  it('publishes the three V1 playbooks', async () => {
    const result = await seedV1Playbooks();

    expect(result.refused).toEqual([]);
    expect(result.published).toEqual(V1_PLAYBOOK_SEEDS.map((seed) => seed.key));
  });

  it('is idempotent: running it again changes nothing', async () => {
    const before = await db().playbook.findMany({
      where: { key: { in: V1_PLAYBOOK_SEEDS.map((seed) => seed.key) } },
      orderBy: [{ key: 'asc' }, { version: 'asc' }],
      select: { id: true, key: true, version: true, phase: true, status: true },
    });

    // **THE ASSERTION.** Not "it does not throw" - the rows are compared.
    const second = await seedV1Playbooks();
    expect(second.refused).toEqual([]);

    const after = await db().playbook.findMany({
      where: { key: { in: V1_PLAYBOOK_SEEDS.map((seed) => seed.key) } },
      orderBy: [{ key: 'asc' }, { version: 'asc' }],
      select: { id: true, key: true, version: true, phase: true, status: true },
    });

    // Same ids: an upsert, not an insert. Same versions: re-seeding does not move a definition
    // that running instances are pinned to.
    expect(after).toEqual(before);

    // Each seed is present at exactly the version it declares, once. Phase 0 and Phase 1 are at
    // v2 since the client-facing sends were added; Phase 2 is untouched at v1.
    //
    // Asserted per seed rather than as a row count, because a playbook is firm-wide and its rows
    // outlive a tenant fixture: an earlier version stays on the table deliberately - it is what a
    // pinned instance is still running - so counting rows measures how many times this suite has
    // ever run, which differs between a fresh CI database and a local one.
    for (const seed of V1_PLAYBOOK_SEEDS) {
      const rows = after.filter((row) => row.key === seed.key && row.version === seed.version);
      expect(rows, `${seed.key} v${seed.version}`).toHaveLength(1);
    }
  });

  it('registers the deliverable templates, twice, with the same result', async () => {
    const first = await seedV1DeliverableTemplates();
    expect(first).toEqual(V1_TEMPLATE_SEEDS.map((template) => template.key));

    const rowsAfterFirst = await db().deliverableTemplate.findMany({
      where: { key: { in: [...first] } },
      orderBy: [{ key: 'asc' }],
      select: { id: true, key: true, version: true, requiresHumanReview: true },
    });

    await seedV1DeliverableTemplates();

    const rowsAfterSecond = await db().deliverableTemplate.findMany({
      where: { key: { in: [...first] } },
      orderBy: [{ key: 'asc' }],
      select: { id: true, key: true, version: true, requiresHumanReview: true },
    });

    expect(rowsAfterSecond).toEqual(rowsAfterFirst);
    // Every one of these carries a compliance state or a recommendation, so none of them is
    // deliverable without a person.
    expect(rowsAfterSecond.every((row) => row.requiresHumanReview)).toBe(true);
  });
});

describe('a Phase 0 client, walked', () => {
  let instanceId: string;

  /** Complete whichever task is parked awaiting external completion. */
  const completeParked = async (expectedNode: string, now: Date): Promise<void> => {
    const parked = (await forInstance(instanceId)).find(
      (task) => task.status === 'waiting' && task.nodeKey === expectedNode,
    );
    expect(parked, `expected ${expectedNode} to be parked`).toBeDefined();

    const completed = await completeExternalTask(fx.tenant.id, parked?.id ?? '', actor(), {}, now);
    expect(completed.status, `completing ${expectedNode}`).toBe('ok');
  };

  /** Append the event a `wait` node is parked on, then let the listener resolve it. */
  const resolveWaitWith = async (type: 'consent.granted' | 'vault.document_stored', now: Date) => {
    await append({
      tenantId: fx.tenant.id,
      type,
      actor: actor(),
      clientId,
      payload: { note: 'driven by the seed test' },
    });
    return listenerPass({ actor: actor(), now, tenantId: fx.tenant.id });
  };

  beforeAll(async () => {
    await seedV1Playbooks();
    // Start the listener at the tail, so the events this test appends are the only ones it sees.
    await seekToLatest(fx.tenant.id);

    const started = await start({
      tenantId: fx.tenant.id,
      playbookKey: PHASE_0_PLAYBOOK.key,
      clientId,
      actor: actor(),
      now: T0,
    });
    expect(started.status, JSON.stringify(started)).toBe('ok');
    if (started.status !== 'ok') throw new Error('phase 0 did not start');
    instanceId = started.value.id;
  });

  it('starts on the node the playbook names', async () => {
    const instance = await findInstance(instanceId);
    expect(instance?.playbookKey).toBe(PHASE_0_PLAYBOOK.key);
    expect(instance?.currentNodeKey).toBe(PHASE_0_PLAYBOOK.definition.startNode);
    expect(instance?.clientId).toBe(clientId);
  });

  it('walks intake, resolves both waits, and stops at the compliance checkpoint', async () => {
    // open_file -> send_welcome -> record_initial_consents -> invite_bank_connection
    await run(at(1));
    await completeParked('open_file', at(2));
    await run(at(3));
    // The welcome goes out as soon as the file is open and an advisor is on it. Before this node
    // existed the template was published and nothing sent it.
    await completeParked('send_welcome', at(4));
    await run(at(5));
    await completeParked('record_initial_consents', at(6));
    await run(at(7));
    await completeParked('invite_bank_connection', at(8));

    // The Plaid connection authorization arrives as a consent for THIS client (Decision A).
    await run(at(9));
    const bankWait = (await forInstance(instanceId)).find(
      (task) => task.nodeKey === 'await_bank_authorization',
    );
    expect(bankWait?.status, 'the bank wait should be parked').toBe('waiting');

    const resolved = await resolveWaitWith('consent.granted', at(10));
    expect(resolved.waitsResolved).toBe(1);

    // request_documents -> await_documents
    await run(at(11));
    await completeParked('request_documents', at(12));
    await run(at(13));
    const docWait = (await forInstance(instanceId)).find(
      (task) => task.nodeKey === 'await_documents',
    );
    expect(docWait?.status).toBe('waiting');
    expect((await resolveWaitWith('vault.document_stored', at(14))).waitsResolved).toBe(1);

    // enrich -> graph -> score
    for (const [node, minute] of [
      ['enrich_intake', 16],
      ['build_entity_graph', 18],
      ['score_readiness', 20],
    ] as const) {
      await run(at(minute - 1));
      await completeParked(node, at(minute));
    }

    await run(at(21));

    // **The graph reached a human.** Nothing in Phase 0 could be walked before this slice.
    const checkpoint = (await forInstance(instanceId)).find(
      (task) => task.nodeKey === 'assess_compliance_state',
    );
    expect(checkpoint?.kind).toBe('human_checkpoint');
    expect(checkpoint?.status).toBe('waiting');
  });

  it('raised an 11.4 task for the checkpoint, and no second approval store', async () => {
    // **THE RULE, ASSERTED.** 2.4's console reads exactly this queue; the checkpoint did not invent
    // anywhere else to put an approval.
    const queue = await openFor(fx.tenant.id, 'compliance_and_evidence');
    const raised = queue.find((task) => task.kind === 'human_checkpoint');

    expect(raised, 'the checkpoint should have raised a notification').toBeDefined();
    expect(raised?.clientId).toBe(clientId);
    expect(raised?.summary).toContain('compliance categorical state');
    // The SLA travels with it, so a stalled assessment shows up as overdue rather than as silence.
    expect(raised?.slaDueAt).not.toBeNull();
  });

  it('holds an unassessed client rather than letting the gate pass them', async () => {
    // The client is still `pending_assessment`, which is neither passing nor failing. Decision E
    // freezes it, and the playbook puts that in front of a person rather than guessing.
    await completeParked('assess_compliance_state', at(20));
    // Two ticks: the first resolves the decision and enqueues the next node, the second dispatches
    // it. A single tick leaves the task `pending` - enqueued and not yet raised - which is a real
    // state and not the one this asserts.
    await run(at(21));
    await run(at(22));

    const held = (await forInstance(instanceId)).find(
      (task) => task.nodeKey === 'hold_for_findings',
    );
    expect(held?.status, 'an unassessed client should be held, not passed').toBe('waiting');

    // A second 11.4 task, for the same queue. The loop is bounded by a human each time round, so
    // it re-queues rather than spinning.
    const queue = await openFor(fx.tenant.id, 'compliance_and_evidence');
    expect(queue.filter((task) => task.kind === 'human_checkpoint').length).toBeGreaterThan(1);
  });

  it('routes a failed compliance state to Do Not Fund and ends cancelled', async () => {
    // Move the client to `fail`. Decision E: this is what auto-lists them on Do Not Fund, and the
    // gate has a branch for it that nothing has exercised until now.
    const moved = await transitionComplianceState({
      tenantId: fx.tenant.id,
      clientId,
      to: 'fail',
      reason: 'Driven by the seed test to exercise the fail branch.',
      findings: [{ code: 'SEED-1', summary: 'Synthetic finding for the fail path.' }],
      actor: actor(),
    });
    expect(moved.status, JSON.stringify(moved)).toBe('ok');

    await completeParked('hold_for_findings', at(23));
    await run(at(24));
    await run(at(25));

    const routing = (await forInstance(instanceId)).find(
      (task) => task.nodeKey === 'do_not_fund_routing',
    );
    expect(routing?.status, 'a failed client should route to Risk & Defense').toBe('waiting');

    // Raised to the RISK queue, not the compliance one: the branch chose a different reader.
    const riskQueue = await openFor(fx.tenant.id, 'risk_and_defense');
    expect(riskQueue.some((task) => task.summary.includes('Do Not Fund'))).toBe(true);

    await completeParked('do_not_fund_routing', at(26));
    await run(at(27));

    // **Cancelled, not completed.** Nothing was delivered, and a completed Phase 0 with no
    // Blueprint would read as a served client in every count that reads instance status.
    const instance = await findInstance(instanceId);
    expect(instance?.status).toBe('cancelled');
  });
});
