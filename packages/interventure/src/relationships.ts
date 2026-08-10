/**
 * Tagging a client as a Green Companies venture - blueprint 10.1's "automatic tagging".
 *
 * The entry point the rest of the module hangs off. `tagIfVenture` is meant to run when a client
 * is created, and it is idempotent so running it again is free - which matters, because the
 * alternative to running it everywhere is running it nowhere and relying on somebody noticing.
 *
 * A `possible` detection REFUSES rather than tagging or ignoring. Both wrong answers are
 * expensive: a false tag blocks a stranger behind a conflict process that cannot be completed
 * (there is no sibling to acknowledge the disclosure), and a missed one is an undisclosed
 * related-party transaction. A question costs less than either.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { detectVenture, gardnerMayView, type VentureKey } from './ventures.js';

export interface VentureRelationship {
  readonly id: string;
  readonly clientId: string;
  readonly ventureKey: VentureKey;
  readonly displayName: string;
  readonly gardnerVisible: boolean;
  readonly detectionBasis: string;
  readonly taggedAt: string;
}

interface RelationshipRow {
  id: string;
  clientId: string;
  ventureKey: string;
  displayName: string;
  gardnerVisible: boolean;
  detectionBasis: string;
  taggedAt: Date;
}

const toRelationship = (row: RelationshipRow): VentureRelationship => ({
  id: row.id,
  clientId: row.clientId,
  ventureKey: row.ventureKey as VentureKey,
  displayName: row.displayName,
  gardnerVisible: row.gardnerVisible,
  detectionBasis: row.detectionBasis,
  taggedAt: row.taggedAt.toISOString(),
});

/**
 * Tag a client if their legal name identifies a venture.
 *
 * Returns `no_data` for an unrelated client - not a refusal, because there is nothing wrong with
 * being a normal client, and a refusal here would make the caller treat the ordinary case as an
 * error path.
 */
export const tagIfVenture = async (input: {
  tenantId: string;
  clientId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<VentureRelationship>> => {
  const now = input.now ?? new Date();

  const existing = await db().ventureRelationship.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });
  if (existing) return ok(toRelationship(existing));

  const client = await db().client.findFirst({
    where: { tenantId: input.tenantId, id: input.clientId },
  });
  if (!client) return noData(`No client ${input.clientId} is on record.`);

  const detection = detectVenture(client.legalName);

  if (detection.verdict === 'possible') {
    return refused(detection.detail, 'Blueprint 10.1 - automatic tagging, confirmed by a person');
  }

  if (detection.verdict === 'unrelated' || detection.venture === null) {
    return noData(detection.detail);
  }

  const row = await db().ventureRelationship.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      ventureKey: detection.venture.key,
      displayName: detection.venture.displayName,
      detectionBasis: detection.detail,
      // Derived, never passed in. A settable flag would eventually be set on a normal client.
      gardnerVisible: gardnerMayView(detection),
      taggedAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.venture.tagged',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      relationshipId: row.id,
      ventureKey: detection.venture.key,
      gardnerVisible: row.gardnerVisible,
    },
  });

  return ok(toRelationship(row));
};

/**
 * Confirm a `possible` detection as a venture, by hand.
 *
 * The route through the refusal. Takes the venture key explicitly - the caller is answering the
 * question the detector could not, and asking them to name which venture is the whole point.
 */
export const confirmVenture = async (input: {
  tenantId: string;
  clientId: string;
  ventureKey: VentureKey;
  confirmedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<VentureRelationship>> => {
  const now = input.now ?? new Date();

  const existing = await db().ventureRelationship.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });
  if (existing) return ok(toRelationship(existing));

  const { ventureByKey } = await import('./ventures.js');
  const venture = ventureByKey(input.ventureKey);
  if (!venture) {
    return refused(
      `'${input.ventureKey}' is not a Green Companies venture.`,
      'Blueprint 10.1 - the portfolio register',
    );
  }

  const row = await db().ventureRelationship.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      ventureKey: venture.key,
      displayName: venture.displayName,
      detectionBasis: `Confirmed by ${input.confirmedBy} after the automatic check returned an ambiguous result.`,
      gardnerVisible: true,
      taggedAt: now,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.venture.tagged',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      relationshipId: row.id,
      ventureKey: venture.key,
      gardnerVisible: true,
      confirmedBy: input.confirmedBy,
    },
  });

  return ok(toRelationship(row));
};

export const relationshipFor = async (
  tenantId: string,
  clientId: string,
): Promise<VentureRelationship | null> => {
  const row = await db().ventureRelationship.findFirst({ where: { tenantId, clientId } });
  return row ? toRelationship(row) : null;
};

/** Every intercompany relationship in the tenant. The register Gardner reads. */
export const allRelationships = async (
  tenantId: string,
): Promise<readonly VentureRelationship[]> => {
  const rows = await db().ventureRelationship.findMany({
    where: { tenantId },
    orderBy: { taggedAt: 'asc' },
  });
  return rows.map(toRelationship);
};
