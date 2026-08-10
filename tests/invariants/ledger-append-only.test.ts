/**
 * Invariant: the Event Ledger is append-only, hash-chained, and signed.
 *
 * Specification v2 section 5.2. The chain is only meaningful if tampering is detectable, so
 * these tests tamper on purpose and assert detection - a verifier that has never been shown
 * a broken chain has not been tested, it has been run.
 *
 * The UPDATE / DELETE assertions go through raw SQL rather than the repository. Testing that
 * a repository declines to expose `update` proves only that the repository declines; the
 * question is whether the database refuses, because psql and any future ORM call bypass the
 * repository entirely.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { db } from '@bwc/db';
import { append, read, verifyIntegrity, GENESIS_HASH } from '@bwc/ledger';
import { makeFixture, cleanupTenant, type Fixture } from '../setup.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await makeFixture('ledger');
});

afterAll(async () => {
  await cleanupTenant(fx.tenant.id);
});

const actor = () => ({ id: fx.human.id, kind: 'human' as const });

describe('Event Ledger is append-only', () => {
  it('rejects UPDATE at the database, not merely in the repository', async () => {
    const event = await append({
      tenantId: fx.tenant.id,
      type: 'client.created',
      actor: actor(),
      payload: { probe: 'update' },
    });

    await expect(
      db().$executeRawUnsafe(
        `UPDATE ledger.ledger_events SET type = 'tampered' WHERE id = '${event.id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/i);

    // The row must be unchanged, not merely "the statement errored".
    const after = await read({ tenantId: fx.tenant.id });
    expect(after.find((e) => e.id === event.id)?.type).toBe('client.created');
  });

  it('rejects DELETE at the database', async () => {
    const event = await append({
      tenantId: fx.tenant.id,
      type: 'client.created',
      actor: actor(),
      payload: { probe: 'delete' },
    });

    await expect(
      db().$executeRawUnsafe(`DELETE FROM ledger.ledger_events WHERE id = '${event.id}'::uuid`),
    ).rejects.toThrow(/append-only/i);

    const after = await read({ tenantId: fx.tenant.id });
    expect(after.some((e) => e.id === event.id)).toBe(true);
  });

  it('rejects TRUNCATE, which bypasses row-level triggers', async () => {
    await expect(db().$executeRawUnsafe('TRUNCATE ledger.ledger_events')).rejects.toThrow(
      /append-only/i,
    );
  });
});

describe('Event Ledger chain', () => {
  it('starts at GENESIS and links each entry to its predecessor', async () => {
    const events = await read({ tenantId: fx.tenant.id });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.prevHash).toBe(GENESIS_HASH);

    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]?.prevHash).toBe(events[i - 1]?.signature);
      expect(events[i]?.seq).toBe((events[i - 1]?.seq ?? 0) + 1);
    }
  });

  it('verifies an intact chain and reports how many entries it checked', async () => {
    const result = await verifyIntegrity(fx.tenant.id);
    expect(result.intact).toBe(true);
    // "verified 0 entries" is a different claim from "verified the chain"; assert the count
    // so an empty read cannot pass as a successful verification.
    expect(result.checked).toBeGreaterThan(0);
  });

  it('detects a forged signature', async () => {
    const forged = await makeFixture('ledger-forged');
    try {
      await append({
        tenantId: forged.tenant.id,
        type: 'client.created',
        actor: { id: forged.human.id, kind: 'human' },
        payload: { legitimate: true },
      });

      expect((await verifyIntegrity(forged.tenant.id)).intact).toBe(true);

      // Insert an entry directly, with a signature not derived from the signing key -
      // exactly what an attacker with database access but no key could produce.
      await db().$executeRawUnsafe(`
        INSERT INTO ledger.ledger_events
          (id, "tenantId", seq, type, "actorId", "actorKind", payload, "prevHash", signature)
        VALUES
          (gen_random_uuid(), '${forged.tenant.id}'::uuid, 2, 'client.created',
           '${forged.human.id}'::uuid, 'human', '{"injected":true}'::jsonb, 'not-the-real-prev', 'deadbeef')
      `);

      const result = await verifyIntegrity(forged.tenant.id);
      expect(result.intact).toBe(false);
      expect(result.firstBreakAtSeq).toBe(2);
    } finally {
      await cleanupTenant(forged.tenant.id);
    }
  });

  it('survives concurrent appends to the same tenant, with a contiguous intact chain', async () => {
    // Regression guard. Appends to one tenant are strictly serial by construction - `seq` is
    // monotonic and each entry hashes its predecessor - so two concurrent appends must order
    // somehow. Under `Serializable` alone they ordered by one of them ABORTING, which surfaced
    // as a thrown PrismaClientKnownRequestError the first time two workers wrote for the same
    // tenant at once. It passed on a slower machine and failed in CI, which is the wrong way
    // round for a defect that would hit production the moment a second worker started.
    const concurrent = await makeFixture('ledger-concurrent');
    try {
      const writes = Array.from({ length: 12 }, (_, index) =>
        append({
          tenantId: concurrent.tenant.id,
          type: 'client.created',
          actor: { id: concurrent.human.id, kind: 'human' },
          payload: { index },
        }),
      );

      // Every write must succeed. A ledger append that throws means a state change happened
      // with no record of it.
      const results = await Promise.all(writes);
      expect(results).toHaveLength(12);

      const events = await read({ tenantId: concurrent.tenant.id });
      expect(events).toHaveLength(12);

      // Contiguous sequence, no gaps and no duplicates.
      expect(events.map((event) => event.seq)).toEqual([...Array(12).keys()].map((n) => n + 1));

      // And the hash chain still verifies - ordering under contention must not fork it.
      const integrity = await verifyIntegrity(concurrent.tenant.id);
      expect(integrity.intact).toBe(true);
      expect(integrity.checked).toBe(12);
    } finally {
      await cleanupTenant(concurrent.tenant.id);
    }
  });

  it('assigns seq and signature itself, ignoring anything a caller supplies', async () => {
    const event = await append({
      tenantId: fx.tenant.id,
      type: 'client.created',
      actor: actor(),
      // Cast: the type forbids these fields. The test is about runtime behaviour if a
      // caller sends them anyway - a caller-set seq would let a module rewrite history.
      payload: { seq: 9999, signature: 'attacker-supplied' },
    } as Parameters<typeof append>[0]);

    expect(event.seq).not.toBe(9999);
    expect(event.signature).not.toBe('attacker-supplied');
    expect((await verifyIntegrity(fx.tenant.id)).intact).toBe(true);
  });
});
