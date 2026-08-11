/**
 * The ordering key - ADR-0040.
 *
 * ADR-0034 found the defect and could not fix it: a sort whose only key is a millisecond timestamp
 * is not a sort, and the `{ id: 'asc' }` tie-break added behind every one of them is a random UUID,
 * so it makes a result *stable for a given set of rows* and leaves it *unrelated to insertion
 * order*. Four tables where a reader relies on insertion order now carry a `seq` from a Postgres
 * sequence, and this file is the guard.
 *
 * **Every assertion here is deterministic, and that is the point.** The defect was intermittent -
 * two rows only tie when they land in the same millisecond - and this repository has twice been
 * taught that a probabilistic guard passes most of the time whether or not the bug is present (the
 * PII detector, 2.3%). So the ties are FORCED rather than raced for: each case writes rows that
 * share one timestamp exactly, which is the state the old code could not order.
 *
 * Two things are asserted per table, and both are needed:
 *
 *   1. **The read comes back in insertion order.** This is what a caller sees. Under the old
 *      tie-break a five-row case would return the right order once in 120 tries.
 *   2. **`seq` strictly increases in insertion order.** This is the mechanism, and unlike (1) it
 *      cannot be satisfied by luck - there is no arrangement of random UUIDs that passes it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@bwc/db';
import { create as createClient } from '@bwc/clients';
import { activityFor, createLead, recordActivity } from '@bwc/sales';
import { observationsFor, recordObservation } from '@bwc/risk';
import { cleanupTenant, makeFixture, type Fixture } from '../setup.js';

let fx: Fixture;

/** One instant, shared by every row in a case. The tie is the fixture, not an accident of timing. */
const TIED = new Date('2026-07-04T12:00:00.000Z');
const NOW = new Date('2026-08-01T00:00:00.000Z');

const human = () => ({ id: fx.human.id, kind: 'human' as const });

beforeAll(async () => {
  fx = await makeFixture('ordering-key');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

/** Strictly increasing, not merely non-decreasing: a sequence that repeats decides nothing. */
const strictlyIncreasing = (values: readonly bigint[]): boolean =>
  values.every((value, index) => index === 0 || value > (values[index - 1] as bigint));

describe('sales lead activity', () => {
  it('returns a tied trail in the order it was written', async () => {
    const lead = await createLead({
      tenantId: fx.tenant.id,
      prospectName: 'Tied Trail Co',
      sourceChannel: 'referral',
      createdOn: TIED,
      actor: human(),
    });
    if (lead.status !== 'ok') throw new Error(`setup: ${lead.status}`);

    // `created` is written by createLead at TIED. Five more at the same instant behind it.
    const summaries = ['first', 'second', 'third', 'fourth', 'fifth'].map(
      (word) => `The ${word} thing that happened to this lead.`,
    );
    for (const summary of summaries) {
      const result = await recordActivity({
        tenantId: fx.tenant.id,
        leadId: lead.value.id,
        kind: 'note',
        summary,
        occurredAt: TIED,
        actor: human(),
      });
      expect(result.status).toBe('ok');
    }

    const trail = await activityFor(fx.tenant.id, lead.value.id);
    expect(trail.map((entry) => entry.summary).slice(1)).toEqual(summaries);

    const rows = await db().leadActivity.findMany({
      where: { tenantId: fx.tenant.id, leadId: lead.value.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, summary: true },
    });
    expect(strictlyIncreasing(rows.map((row) => row.seq))).toBe(true);
    expect(rows.map((row) => row.summary).slice(1)).toEqual(summaries);
  });

  it('sorts by when things happened before it sorts by when they were written', async () => {
    // `seq` is the tie-break and must not become the sort. `occurredAt` is caller-supplied and
    // back-dating is legitimate - a note written today about a call three weeks ago belongs three
    // weeks ago on the trail. A build that ordered by insertion alone would file it under today,
    // and would look correct in every test where nobody back-dated anything.
    const lead = await createLead({
      tenantId: fx.tenant.id,
      prospectName: 'Back Dated Co',
      sourceChannel: 'referral',
      createdOn: new Date('2026-07-10T00:00:00.000Z'),
      actor: human(),
    });
    if (lead.status !== 'ok') throw new Error(`setup: ${lead.status}`);

    await recordActivity({
      tenantId: fx.tenant.id,
      leadId: lead.value.id,
      kind: 'note',
      summary: 'Written second, about a call that happened first.',
      occurredAt: new Date('2026-07-01T00:00:00.000Z'),
      actor: human(),
    });

    const trail = await activityFor(fx.tenant.id, lead.value.id);
    expect(trail.map((entry) => entry.kind)).toEqual(['note', 'created']);
  });
});

describe('risk observations', () => {
  it('returns a tied timeline in the order it was written', async () => {
    // 6.3 writes several observations for one client in one detection pass, all describing the same
    // moment and therefore all carrying the same `occurredAt`. Before `seq` that timeline came back
    // in a different order than it went in, and 6.5 calls itself chronological.
    const client = await createClient(fx.tenant.id, 'Tied Timeline Co', human());

    const summaries = [
      'Applied independently while placement was frozen.',
      'Undisclosed balance found on the same day.',
      'Did not respond to the payment alert raised that morning.',
    ];
    for (const summary of summaries) {
      const result = await recordObservation({
        tenantId: fx.tenant.id,
        clientId: client.id,
        kind: 'other',
        severity: 'serious',
        summary,
        source: 'One detection pass over the same day.',
        occurredAt: TIED,
        recordedBy: fx.human.id,
        actor: human(),
        now: NOW,
      });
      expect(result.status).toBe('ok');
    }

    const timeline = await observationsFor(fx.tenant.id, client.id);
    expect(timeline.map((entry) => entry.summary)).toEqual(summaries);

    const rows = await db().riskObservation.findMany({
      where: { tenantId: fx.tenant.id, clientId: client.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, summary: true },
    });
    expect(strictlyIncreasing(rows.map((row) => row.seq))).toBe(true);
    expect(rows.map((row) => row.summary)).toEqual(summaries);
  });
});

describe('the sequence itself', () => {
  it('is monotonic across tenants, so one tenant cannot renumber another', async () => {
    // The sequence is global to the table rather than per-tenant, and that is deliberate: a
    // per-tenant counter is a read-modify-write and would need the advisory lock the Ledger needs
    // (see ADR in packages/ledger). Nothing here needs contiguity - only order - so a shared
    // sequence with gaps is the cheaper correct answer.
    const other = await makeFixture('ordering-key-2');
    try {
      const mine = await createClient(fx.tenant.id, 'Interleaved A', human());
      const theirs = await createClient(other.tenant.id, 'Interleaved B', {
        id: other.human.id,
        kind: 'human' as const,
      });

      const record = async (tenantId: string, clientId: string, actorId: string, note: string) => {
        const result = await recordObservation({
          tenantId,
          clientId,
          kind: 'other',
          severity: 'notable',
          summary: note,
          source: 'Interleaving check.',
          occurredAt: TIED,
          recordedBy: actorId,
          actor: { id: actorId, kind: 'human' },
          now: NOW,
        });
        if (result.status !== 'ok') throw new Error(`setup: ${result.status}`);
        const row = await db().riskObservation.findFirstOrThrow({
          where: { id: result.value.id },
          select: { seq: true },
        });
        return row.seq;
      };

      const a1 = await record(fx.tenant.id, mine.id, fx.human.id, 'Mine, first.');
      const b1 = await record(other.tenant.id, theirs.id, other.human.id, 'Theirs, second.');
      const a2 = await record(fx.tenant.id, mine.id, fx.human.id, 'Mine, third.');

      expect(strictlyIncreasing([a1, b1, a2])).toBe(true);

      // And the gap the other tenant's row left is invisible to a reader of this one: order is
      // preserved, contiguity was never promised.
      const timeline = await observationsFor(fx.tenant.id, mine.id);
      expect(timeline.map((entry) => entry.summary)).toEqual(['Mine, first.', 'Mine, third.']);
    } finally {
      await cleanupTenant(other.tenant.id);
    }
  });
});
