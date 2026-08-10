/**
 * Persistence for the entity graph.
 *
 * The only impure file in this package. Everything else operates on a `Graph` value, which is what
 * makes the traversals, exposure arithmetic and detections exhaustively testable without a
 * database.
 *
 * **SSN and EIN are envelope-encrypted at rest and never leave this file in plaintext.** The
 * `Graph` value carries only a display last-4, so no traversal, finding, rationale or ledger
 * payload can accidentally include one - not because each of those remembered to strip it, but
 * because they were never given it. `revealSsn`/`revealEin` are the only readers, and they are
 * separate functions a caller has to deliberately reach for.
 *
 * The key-encryption key arrives through the same `KekProvider` seam the Vault uses, and is
 * injectable per call. It was originally hardcoded to `new EnvKekProvider()`, which passed locally
 * - the developer `.env` has `VAULT_KEK` - and failed on CI, which does not. The local pass was the
 * false signal, and the deeper problem was the missing seam: a store that constructs its own key
 * provider cannot be pointed at a KMS without editing the store.
 */

import { db, Prisma } from '@bwc/db';
import { append } from '@bwc/ledger';
import { EnvKekProvider, decryptField, encryptField, type KekProvider } from '@bwc/vault';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import {
  validateEdge,
  type EdgeKind,
  type EntityNode,
  type EntityRole,
  type Graph,
  type NodeKind,
  type OwnerNode,
} from './model.js';

/**
 * Default provider, constructed lazily so importing this module never throws on a missing key -
 * only using it does, at the point where a caller actually asked to encrypt something.
 */
const kekOr = (provider?: KekProvider): KekProvider => provider ?? new EnvKekProvider();

/** Last four of an identifier, for display. Non-digits stripped so formatting cannot shift it. */
const last4 = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-4);
};

const decimal = (value: number): Prisma.Decimal => new Prisma.Decimal(value);

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface UpsertEntityInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly legalName: string;
  readonly role: EntityRole;
  readonly stateOfFormation?: string;
  readonly formationDate?: Date;
  readonly industry?: string;
  /** Plaintext. Encrypted here and never stored, logged or returned in the clear. */
  readonly ein?: string;
  readonly notes?: string;
  readonly actor: EventActor;
  /** Key provider. Defaults to the environment; injectable for a KMS or for a test. */
  readonly kek?: KekProvider;
}

export const upsertEntity = async (input: UpsertEntityInput): Promise<Outcome<EntityNode>> => {
  if (input.legalName.trim() === '') {
    return refused(
      'An entity needs a legal name.',
      'Blueprint 1.2 - an unnamed node cannot be matched to a filing, a lender record, or a client conversation',
    );
  }

  const einFields =
    input.ein !== undefined
      ? {
          einCiphertext: await encryptField(input.ein, kekOr(input.kek)),
          einLast4: last4(input.ein),
        }
      : {};

  const row = await db().entity.upsert({
    where: {
      tenantId_clientId_legalName: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        legalName: input.legalName,
      },
    },
    create: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      legalName: input.legalName,
      role: input.role as never,
      stateOfFormation: input.stateOfFormation ?? null,
      formationDate: input.formationDate ?? null,
      industry: input.industry ?? null,
      notes: input.notes ?? null,
      ...einFields,
    },
    update: {
      role: input.role as never,
      stateOfFormation: input.stateOfFormation ?? null,
      formationDate: input.formationDate ?? null,
      industry: input.industry ?? null,
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...einFields,
    },
  });

  // Note what is absent from the payload: no EIN, no last 4. The Ledger is append-only, so a
  // payload written wrongly cannot be corrected - only explained.
  await append({
    tenantId: input.tenantId,
    type: 'graph.entity.recorded',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      entityId: row.id,
      legalName: input.legalName,
      role: input.role,
      hasEin: input.ein !== undefined,
    },
  });

  return ok(toEntity(row));
};

interface EntityRow {
  id: string;
  clientId: string;
  legalName: string;
  role: string;
  stateOfFormation: string | null;
  formationDate: Date | null;
  industry: string | null;
  einLast4: string | null;
  statedAnnualRevenue: Prisma.Decimal | null;
  statedRevenueBy: string | null;
  statedRevenueAt: Date | null;
  statedRevenueDocRef: string | null;
  isPrimary: boolean;
}

const toEntity = (row: EntityRow): EntityNode => ({
  id: row.id,
  clientId: row.clientId,
  legalName: row.legalName,
  role: row.role as EntityRole,
  stateOfFormation: row.stateOfFormation,
  formationDate: row.formationDate?.toISOString() ?? null,
  industry: row.industry,
  einLast4: row.einLast4,
  statedAnnualRevenue: row.statedAnnualRevenue?.toNumber() ?? null,
  statedRevenueBy: row.statedRevenueBy,
  statedRevenueAt: row.statedRevenueAt?.toISOString() ?? null,
  statedRevenueDocRef: row.statedRevenueDocRef,
  isPrimary: row.isPrimary,
});

/**
 * Record what the client says their revenue is.
 *
 * Requires `statedBy`, because the figure's whole epistemic status is *somebody said this*. A
 * revenue with no attributed source would be indistinguishable from a measured one the moment it
 * reached a deliverable.
 */
export const recordStatedRevenue = async (input: {
  tenantId: string;
  clientId: string;
  entityId: string;
  annualRevenue: number;
  statedBy: string;
  statedAt: Date;
  documentReference?: string;
  actor: EventActor;
}): Promise<Outcome<EntityNode>> => {
  if (input.statedBy.trim() === '') {
    return refused(
      'A stated revenue needs the name of whoever stated it.',
      'Decision D - a figure with no attributed source is indistinguishable from a measured one',
    );
  }
  if (!Number.isFinite(input.annualRevenue) || input.annualRevenue < 0) {
    return refused(
      'Stated revenue must be a non-negative finite number.',
      'Blueprint 1.2 - a figure that cannot be arithmetic on is not a figure',
    );
  }

  const existing = await db().entity.findFirst({
    where: { id: input.entityId, tenantId: input.tenantId },
  });
  if (!existing) return noData('No such entity in this tenant.');

  const row = await db().entity.update({
    where: { id: input.entityId },
    data: {
      statedAnnualRevenue: decimal(input.annualRevenue),
      statedRevenueBy: input.statedBy,
      statedRevenueAt: input.statedAt,
      statedRevenueDocRef: input.documentReference ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'graph.revenue.stated',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      entityId: input.entityId,
      statedBy: input.statedBy,
      hasSupportingDocument: input.documentReference !== undefined,
    },
  });

  return ok(toEntity(row));
};

/**
 * Designate the entity a funding application is for.
 *
 * Clears any other primary in the same transaction. Two primaries would make `deriveProfile`'s
 * answer depend on row order, which is the kind of defect that behaves consistently in testing and
 * differently in production after a vacuum.
 */
export const setPrimaryEntity = async (input: {
  tenantId: string;
  clientId: string;
  entityId: string;
  actor: EventActor;
}): Promise<Outcome<EntityNode>> => {
  const existing = await db().entity.findFirst({
    where: { id: input.entityId, tenantId: input.tenantId, clientId: input.clientId },
  });
  if (!existing) return noData('No such entity for this client.');

  const row = await db().$transaction(async (tx) => {
    await tx.entity.updateMany({
      where: { tenantId: input.tenantId, clientId: input.clientId, isPrimary: true },
      data: { isPrimary: false },
    });
    return tx.entity.update({ where: { id: input.entityId }, data: { isPrimary: true } });
  });

  await append({
    tenantId: input.tenantId,
    type: 'graph.primary_entity.set',
    actor: input.actor,
    clientId: input.clientId,
    payload: { entityId: input.entityId, legalName: row.legalName },
  });

  return ok(toEntity(row));
};

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

export const upsertOwner = async (input: {
  tenantId: string;
  clientId: string;
  fullName: string;
  /** Plaintext. Encrypted here; the plaintext never leaves this call. */
  ssn?: string;
  notes?: string;
  actor: EventActor;
  kek?: KekProvider;
}): Promise<Outcome<OwnerNode>> => {
  if (input.fullName.trim() === '') {
    return refused(
      'An owner needs a name.',
      'Blueprint 1.2 - an unnamed guarantor cannot be matched to a signature',
    );
  }

  const ssnFields =
    input.ssn !== undefined
      ? {
          ssnCiphertext: await encryptField(input.ssn, kekOr(input.kek)),
          ssnLast4: last4(input.ssn),
        }
      : {};

  const row = await db().owner.upsert({
    where: {
      tenantId_clientId_fullName: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        fullName: input.fullName,
      },
    },
    create: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      fullName: input.fullName,
      notes: input.notes ?? null,
      ...ssnFields,
    },
    update: { ...(input.notes !== undefined ? { notes: input.notes } : {}), ...ssnFields },
  });

  await append({
    tenantId: input.tenantId,
    type: 'graph.owner.recorded',
    actor: input.actor,
    clientId: input.clientId,
    payload: { ownerId: row.id, fullName: input.fullName, hasSsn: input.ssn !== undefined },
  });

  return ok({
    id: row.id,
    clientId: row.clientId,
    fullName: row.fullName,
    ssnLast4: row.ssnLast4,
  });
};

/**
 * Decrypt an owner's SSN.
 *
 * A separate function rather than a flag on a read, so reaching for the plaintext is a deliberate
 * act visible in a diff. Writes an access event for the same reason the Vault logs document reads:
 * the question a regulator asks is not whether the data was encrypted but who looked at it.
 */
export const revealSsn = async (input: {
  tenantId: string;
  ownerId: string;
  actor: EventActor;
  purpose: string;
  kek?: KekProvider;
}): Promise<Outcome<string>> => {
  if (input.purpose.trim() === '') {
    return refused(
      'Revealing an SSN requires a stated purpose.',
      'Specification 6.2 - access to the highest-sensitivity fields is logged with its reason',
    );
  }

  const row = await db().owner.findFirst({
    where: { id: input.ownerId, tenantId: input.tenantId },
  });
  if (!row) return noData('No such owner in this tenant.');
  if (row.ssnCiphertext === null) return noData('No SSN is on file for this owner.');

  const plaintext = await decryptField(row.ssnCiphertext, kekOr(input.kek));

  await append({
    tenantId: input.tenantId,
    type: 'graph.ssn.revealed',
    actor: input.actor,
    clientId: row.clientId,
    payload: { ownerId: input.ownerId, purpose: input.purpose },
  });

  return ok(plaintext);
};

/** Decrypt an entity's EIN. Same discipline as `revealSsn`. */
export const revealEin = async (input: {
  tenantId: string;
  entityId: string;
  actor: EventActor;
  purpose: string;
  kek?: KekProvider;
}): Promise<Outcome<string>> => {
  if (input.purpose.trim() === '') {
    return refused(
      'Revealing an EIN requires a stated purpose.',
      'Specification 6.2 - access to the highest-sensitivity fields is logged with its reason',
    );
  }

  const row = await db().entity.findFirst({
    where: { id: input.entityId, tenantId: input.tenantId },
  });
  if (!row) return noData('No such entity in this tenant.');
  if (row.einCiphertext === null) return noData('No EIN is on file for this entity.');

  const plaintext = await decryptField(row.einCiphertext, kekOr(input.kek));

  await append({
    tenantId: input.tenantId,
    type: 'graph.ein.revealed',
    actor: input.actor,
    clientId: row.clientId,
    payload: { entityId: input.entityId, purpose: input.purpose },
  });

  return ok(plaintext);
};

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export interface AddEdgeInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: EdgeKind;
  readonly fromKind: NodeKind;
  readonly fromId: string;
  readonly toKind: NodeKind;
  readonly toId?: string;
  readonly toLabel?: string;
  readonly ownershipPercent?: number;
  readonly amount?: number;
  /** Omit for an uncapped guarantee - a different condition from a very large cap. */
  readonly guaranteeLimit?: number;
  readonly provenanceTag: string;
  readonly sourceNote?: string;
  readonly effectiveFrom?: Date;
  readonly actor: EventActor;
}

/**
 * Add an edge, validated against `EDGE_RULES`.
 *
 * Refuses rather than throws: an operator entering a household by hand will get a direction wrong,
 * and the honest answer names which end was wrong rather than producing a stack trace.
 */
export const addEdge = async (input: AddEdgeInput): Promise<Outcome<{ id: string }>> => {
  const validation = validateEdge({
    kind: input.kind,
    fromKind: input.fromKind,
    toKind: input.toKind,
    toId: input.toId ?? null,
    toLabel: input.toLabel ?? null,
    ownershipPercent: input.ownershipPercent ?? null,
    amount: input.amount ?? null,
  });

  if (!validation.valid) {
    return refused(
      validation.reasons.join(' '),
      'Blueprint 1.2 - an edge pointing the wrong way reverses every exposure figure derived from it',
    );
  }

  const row = await db().graphEdge.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind: input.kind as never,
      fromKind: input.fromKind as never,
      fromId: input.fromId,
      toKind: input.toKind as never,
      toId: input.toId ?? null,
      toLabel: input.toLabel ?? null,
      ownershipPercent:
        input.ownershipPercent !== undefined ? decimal(input.ownershipPercent) : null,
      amount: input.amount !== undefined ? decimal(input.amount) : null,
      guaranteeLimit: input.guaranteeLimit !== undefined ? decimal(input.guaranteeLimit) : null,
      provenanceTag: input.provenanceTag,
      sourceNote: input.sourceNote ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'graph.edge.recorded',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      edgeId: row.id,
      kind: input.kind,
      fromId: input.fromId,
      toId: input.toId ?? null,
      provenanceTag: input.provenanceTag,
    },
  });

  return ok({ id: row.id });
};

/**
 * End an edge rather than delete it.
 *
 * A guarantee released in March still explains the exposure figure that justified a March
 * recommendation, and the Compliance Evidence Vault reads that history.
 */
export const endEdge = async (input: {
  tenantId: string;
  clientId: string;
  edgeId: string;
  reason: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ id: string }>> => {
  const existing = await db().graphEdge.findFirst({
    where: { id: input.edgeId, tenantId: input.tenantId },
  });
  if (!existing) return noData('No such edge in this tenant.');

  await db().graphEdge.update({
    where: { id: input.edgeId },
    data: { endedAt: input.now ?? new Date() },
  });

  await append({
    tenantId: input.tenantId,
    type: 'graph.edge.ended',
    actor: input.actor,
    clientId: input.clientId,
    payload: { edgeId: input.edgeId, kind: existing.kind, reason: input.reason },
  });

  return ok({ id: input.edgeId });
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the whole household in three queries.
 *
 * Whole rather than lazily: every interesting computation here is global - total exposure across
 * all entities, cycles anywhere in the graph, an owner controlling two companies - and a lazy
 * loader would make each of them a query storm. A household is tens of nodes, not thousands.
 */
export const loadGraph = async (tenantId: string, clientId: string): Promise<Graph> => {
  const [entities, owners, edges] = await Promise.all([
    db().entity.findMany({
      where: { tenantId, clientId, active: true },
      orderBy: { legalName: 'asc' },
    }),
    db().owner.findMany({
      where: { tenantId, clientId, active: true },
      orderBy: { fullName: 'asc' },
    }),
    db().graphEdge.findMany({ where: { tenantId, clientId }, orderBy: { createdAt: 'asc' } }),
  ]);

  return {
    clientId,
    entities: entities.map(toEntity),
    owners: owners.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      fullName: row.fullName,
      ssnLast4: row.ssnLast4,
    })),
    edges: edges.map((row) => ({
      id: row.id,
      kind: row.kind as EdgeKind,
      fromKind: row.fromKind as NodeKind,
      fromId: row.fromId,
      toKind: row.toKind as NodeKind,
      toId: row.toId,
      toLabel: row.toLabel,
      ownershipPercent: row.ownershipPercent?.toNumber() ?? null,
      amount: row.amount?.toNumber() ?? null,
      guaranteeLimit: row.guaranteeLimit?.toNumber() ?? null,
      provenanceTag: row.provenanceTag,
      sourceNote: row.sourceNote,
      endedAt: row.endedAt?.toISOString() ?? null,
    })),
  };
};
