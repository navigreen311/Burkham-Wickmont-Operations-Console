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
 * Append an event. The only write path into the Ledger.
 *
 * `seq`, `prevHash`, `signature` and `createdAt` are assigned here and cannot be supplied
 * by the caller - a caller-supplied sequence would let a module rewrite its own history.
 *
 * Serializable isolation, because two concurrent appends reading the same tail would both
 * compute the same `seq`. The unique constraint on (tenantId, seq) turns that race into a
 * failed transaction rather than a forked chain.
 */
export const append = async (input: LedgerEventInput): Promise<LedgerEvent> => {
  const safePayload = redactPii(input.payload) as Record<string, unknown>;
  assertNoPii(safePayload, `ledger append (${input.type})`);

  const prisma = db();

  const row = await prisma.$transaction(
    async (tx) => {
      const tail = await tx.ledgerEvent.findFirst({
        where: { tenantId: input.tenantId },
        orderBy: { seq: 'desc' },
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
    { isolationLevel: 'Serializable' },
  );

  return toEvent(row);
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
  actor: { id: row.actorId, kind: row.actorKind as 'village_agent' | 'human' },
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
    orderBy: { seq: 'asc' },
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
