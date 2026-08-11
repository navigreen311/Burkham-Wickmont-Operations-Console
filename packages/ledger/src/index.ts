/**
 * @bwc/ledger - 11.3 Event Ledger.
 *
 * The canonical system of record. Design principle 2 (blueprint) and 3 (specification):
 * every state change generates an immutable event; modules query the Ledger for state
 * rather than each other.
 *
 * Three properties make an entry trustworthy, and all three are enforced here rather than
 * assumed:
 *   - append-only    : the database rejects UPDATE, DELETE and TRUNCATE (migration trigger)
 *   - hash-chained   : each entry carries the hash of its predecessor, so a removed or
 *                      reordered entry breaks verification even if the trigger were dropped
 *   - signed         : HMAC over the canonical entry, so an entry forged directly in SQL
 *                      without the key fails verification
 *
 * The chain is per tenant. A tenant's history is independently verifiable, and one tenant's
 * activity cannot advance another's sequence.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@bwc/db';
import {
  assertNoPii,
  redactPii,
  type EventType,
  type LedgerEvent,
  type LedgerEventInput,
} from '@bwc/core';

export const GENESIS_HASH = 'GENESIS';

const signingKey = (): string => {
  const key = process.env['LEDGER_SIGNING_KEY'];
  if (!key || key.length < 32) {
    throw new Error(
      'LEDGER_SIGNING_KEY must be set to at least 32 characters. A signature is only as meaningful as the key behind it.',
    );
  }
  return key;
};

/**
 * Canonical string form of an entry. Signed and hashed over this rather than over
 * `JSON.stringify(row)`, because key order in the latter is an implementation detail and
 * a signature that depends on it will start failing for no visible reason.
 */
const canonicalize = (parts: {
  tenantId: string;
  seq: number;
  type: string;
  actorId: string;
  clientId: string | null;
  payload: unknown;
  prevHash: string;
}): string =>
  [
    parts.tenantId,
    String(parts.seq),
    parts.type,
    parts.actorId,
    parts.clientId ?? '',
    stableStringify(parts.payload),
    parts.prevHash,
  ].join('');

/** Deterministic JSON: object keys sorted at every depth. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
};

const sign = (canonical: string): string =>
  createHmac('sha256', signingKey()).update(canonical).digest('hex');

/**
 * Advisory-lock namespace for ledger appends. The two-argument form keys on (namespace, key) so
 * this cannot collide with any other advisory lock the application takes later.
 */
const LEDGER_LOCK_NAMESPACE = 4242;

/** Postgres serialization failure and deadlock. Both are documented as retryable. */
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']);

const isRetryable = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  // Prisma surfaces a serialization failure as P2034 and also passes through the SQLSTATE.
  if (code === 'P2034') return true;
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  return typeof meta?.code === 'string' && RETRYABLE_PG_CODES.has(meta.code);
};

const MAX_APPEND_ATTEMPTS = 5;

/**
 * Append an event. The only write path into the Ledger.
 *
 * `seq`, `prevHash`, `signature` and `createdAt` are assigned here and cannot be supplied by the
 * caller - a caller-supplied sequence would let a module rewrite its own history.
 *
 * Concurrency handling is explained on the transaction below; it is the subtle part.
 */
export const append = async (input: LedgerEventInput): Promise<LedgerEvent> => {
  const safePayload = redactPii(input.payload) as Record<string, unknown>;
  assertNoPii(safePayload, `ledger append (${input.type})`);

  const prisma = db();

  /**
   * Appends to one tenant are strictly serial by construction: `seq` is monotonic per tenant and
   * each entry hashes its predecessor's signature. Two concurrent appends therefore *must* order
   * somehow, and under `Serializable` alone they order by one of them aborting with a
   * serialization failure - which surfaced as a thrown `PrismaClientKnownRequestError` the first
   * time two workers wrote for the same tenant at once.
   *
   * A per-tenant transaction-scoped advisory lock makes that ordering explicit: the second
   * appender waits rather than aborting, and the lock releases with the transaction. This turns a
   * conflict into a short queue instead of wasted work plus an exception the caller cannot
   * usefully handle.
   *
   * **Read Committed, deliberately - not Serializable.** The first attempt at this fix kept
   * `Serializable` underneath the lock as a belt-and-braces backstop, and it still failed. Under
   * Serializable the snapshot is fixed when the transaction begins, so the appender that waits on
   * the lock acquires it *and then reads a tail from before the other transaction committed*. It
   * computes the same `seq`, and aborts. A lock can serialize entry; it cannot refresh a snapshot.
   *
   * Read Committed re-reads at each statement, so after the lock is acquired the tail query sees
   * the row the previous appender just wrote. The advisory lock supplies the mutual exclusion and
   * Read Committed supplies the fresh read; Serializable was providing neither and preventing the
   * second.
   *
   * The retry below is a backstop for anything outside this path. A ledger append that fails is
   * not a recoverable condition for the caller - it means a state change happened with no record
   * of it.
   */
  const attempt = async () =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_NAMESPACE}::int, hashtext(${input.tenantId}))`;

        const tail = await tx.ledgerEvent.findFirst({
          where: { tenantId: input.tenantId },
          orderBy: [{ seq: 'desc' }, { id: 'asc' }],
          select: { seq: true, signature: true },
        });

        const seq = (tail?.seq ?? 0) + 1;
        const prevHash = tail?.signature ?? GENESIS_HASH;

        const signature = sign(
          canonicalize({
            tenantId: input.tenantId,
            seq,
            type: input.type,
            actorId: input.actor.id,
            clientId: input.clientId ?? null,
            payload: safePayload,
            prevHash,
          }),
        );

        return tx.ledgerEvent.create({
          data: {
            tenantId: input.tenantId,
            seq,
            type: input.type,
            actorId: input.actor.id,
            actorKind: input.actor.kind,
            clientId: input.clientId ?? null,
            correlationId: input.correlationId ?? null,
            payload: safePayload as object,
            prevHash,
            signature,
          },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );

  let lastError: unknown;

  for (let tries = 1; tries <= MAX_APPEND_ATTEMPTS; tries += 1) {
    try {
      return toEvent(await attempt());
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
      // Short escalating backoff. The advisory lock makes contention rare, so this exists for
      // the residue rather than as the primary mechanism - a long backoff here would delay a
      // ledger write, and everything else waits on it.
      await new Promise((resolve) => setTimeout(resolve, 5 * tries));
    }
  }

  throw new Error(
    `Ledger append failed after ${MAX_APPEND_ATTEMPTS} attempts (${input.type}). A state change without a ledger entry is not recoverable: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

interface LedgerRow {
  id: string;
  tenantId: string;
  seq: number;
  type: string;
  actorId: string;
  actorKind: string;
  clientId: string | null;
  correlationId: string | null;
  payload: unknown;
  prevHash: string;
  signature: string;
  createdAt: Date;
}

const toEvent = (row: LedgerRow): LedgerEvent => ({
  id: row.id,
  tenantId: row.tenantId,
  seq: row.seq,
  type: row.type as EventType,
  actor: { id: row.actorId, kind: row.actorKind as 'village_agent' | 'human' | 'client' },
  ...(row.clientId !== null ? { clientId: row.clientId } : {}),
  ...(row.correlationId !== null ? { correlationId: row.correlationId } : {}),
  payload: (row.payload ?? {}) as Record<string, unknown>,
  prevHash: row.prevHash,
  signature: row.signature,
  createdAt: row.createdAt,
});

export interface ReadOptions {
  readonly tenantId: string;
  readonly clientId?: string;
  readonly type?: EventType;
  readonly limit?: number;
}

/** Read events in sequence order. There is no update or delete counterpart, by design. */
export const read = async (options: ReadOptions): Promise<LedgerEvent[]> => {
  const rows = await db().ledgerEvent.findMany({
    where: {
      tenantId: options.tenantId,
      ...(options.clientId !== undefined ? { clientId: options.clientId } : {}),
      ...(options.type !== undefined ? { type: options.type } : {}),
    },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    ...(options.limit !== undefined ? { take: options.limit } : {}),
  });
  return rows.map(toEvent);
};

export interface IntegrityResult {
  readonly intact: boolean;
  readonly checked: number;
  readonly firstBreakAtSeq?: number;
  readonly detail?: string;
}

/**
 * Verify a tenant's chain end to end: sequence contiguity, prevHash linkage, and the
 * signature of every entry.
 *
 * `checked` is reported so a caller can tell "verified 400 entries" from "verified nothing".
 * An empty chain returns intact with checked 0 - true, and not the same claim.
 * Specification v2 section 10.1 requires this to be runnable quarterly.
 */
export const verifyIntegrity = async (tenantId: string): Promise<IntegrityResult> => {
  const events = await read({ tenantId });

  let expectedPrev = GENESIS_HASH;

  for (const [index, event] of events.entries()) {
    const expectedSeq = index + 1;

    if (event.seq !== expectedSeq) {
      return {
        intact: false,
        checked: index,
        firstBreakAtSeq: event.seq,
        detail: `sequence gap: expected ${expectedSeq}, found ${event.seq}`,
      };
    }

    if (event.prevHash !== expectedPrev) {
      return {
        intact: false,
        checked: index,
        firstBreakAtSeq: event.seq,
        detail: 'prevHash does not match the preceding entry signature',
      };
    }

    const expectedSignature = sign(
      canonicalize({
        tenantId: event.tenantId,
        seq: event.seq,
        type: event.type,
        actorId: event.actor.id,
        clientId: event.clientId ?? null,
        payload: event.payload,
        prevHash: event.prevHash,
      }),
    );

    const actual = Buffer.from(event.signature, 'hex');
    const expected = Buffer.from(expectedSignature, 'hex');

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return {
        intact: false,
        checked: index,
        firstBreakAtSeq: event.seq,
        detail: 'signature does not verify',
      };
    }

    expectedPrev = event.signature;
  }

  return { intact: true, checked: events.length };
};
