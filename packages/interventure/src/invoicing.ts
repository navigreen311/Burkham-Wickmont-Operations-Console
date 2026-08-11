/**
 * Intercompany invoicing - blueprint 10.1's "intercompany invoicing routes to Gardner-level
 * ledger".
 *
 * The invoice RECORD is real and belongs here: what was billed, to which venture, for what period,
 * on which engagement. That is the audit trail blueprint 10.1 asks for.
 *
 * The ROUTING is a seam. There is no Gardner-level ledger in this system - it is the portfolio's,
 * not Burkham Wickmont's - so `routeToGardnerLedger` reports `not_built`, and an invoice never
 * reaches `settled`.
 *
 * That last part is the one worth stating. A `settled` intercompany invoice nobody routed would
 * read as money that moved between two entities when none did - and unlike most unbuilt seams,
 * this one produces a figure that would flow into two sets of accounts, one of which is not ours.
 * An unsettled invoice is a visible gap; a falsely settled one is a reconciliation problem nobody
 * discovers until year end.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import type { Cents } from '@bwc/billing';
import { noData, notBuilt, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { mayProceed } from './conflicts.js';

export type InvoiceState = 'drafted' | 'routed_pending' | 'settled';

export interface IntercompanyInvoice {
  readonly id: string;
  readonly engagementId: string;
  readonly amountCents: Cents;
  readonly description: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly state: InvoiceState;
  readonly gardnerLedgerReference: string | null;
}

interface InvoiceRow {
  id: string;
  engagementId: string;
  amountCents: number;
  description: string;
  periodFrom: Date;
  periodTo: Date;
  state: string;
  gardnerLedgerReference: string | null;
}

const toInvoice = (row: InvoiceRow): IntercompanyInvoice => ({
  id: row.id,
  engagementId: row.engagementId,
  amountCents: row.amountCents,
  description: row.description,
  periodFrom: row.periodFrom.toISOString(),
  periodTo: row.periodTo.toISOString(),
  state: row.state as InvoiceState,
  gardnerLedgerReference: row.gardnerLedgerReference,
});

/**
 * Raise an intercompany invoice.
 *
 * Gated on the conflict disclosure being fully acknowledged. Billing a sibling venture on an
 * undisclosed related-party engagement is the transaction the whole module exists to prevent, and
 * the invoice is the point at which money actually moves - so the gate belongs here as well as at
 * the start of the work.
 */
export const raiseInvoice = async (input: {
  tenantId: string;
  clientId: string;
  engagementId: string;
  amountCents: Cents;
  description: string;
  periodFrom: Date;
  periodTo: Date;
  raisedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<IntercompanyInvoice>> => {
  const now = input.now ?? new Date();

  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return refused(
      `An intercompany invoice for ${input.amountCents} is not a whole positive number of cents.`,
      'ADR-0011 - money is integer cents',
    );
  }
  if (input.periodTo.getTime() <= input.periodFrom.getTime()) {
    return refused(
      'An invoice period must end after it starts.',
      'Blueprint 10.1 - intercompany invoicing records',
    );
  }

  const relationship = await db().ventureRelationship.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId },
  });
  if (!relationship) {
    return refused(
      'This client is not a Green Companies venture, so an intercompany invoice does not apply. Ordinary billing is 1.4.',
      'Blueprint 10.1 - intercompany invoicing',
    );
  }

  const clearance = await mayProceed(input.tenantId, input.clientId, input.engagementId);
  if (clearance.status !== 'ok') {
    return refused(
      `An intercompany invoice cannot be raised on an engagement whose conflict disclosure is incomplete. ${clearance.status === 'refused' ? clearance.reason : ''}`.trim(),
      'Blueprint 10.1 - conflict-of-interest disclosures per engagement',
    );
  }

  const row = await db().intercompanyInvoice.create({
    data: {
      tenantId: input.tenantId,
      relationshipId: relationship.id,
      engagementId: input.engagementId,
      amountCents: input.amountCents,
      description: input.description,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      raisedAt: now,
      raisedBy: input.raisedBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'interventure.invoice.raised',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      invoiceId: row.id,
      engagementId: input.engagementId,
      ventureKey: relationship.ventureKey,
      amountCents: input.amountCents,
    },
  });

  return ok(toInvoice(row));
};

/**
 * Route an invoice to the Gardner-level ledger.
 *
 * `not_built`. The Gardner ledger is the portfolio's, not this system's, and nothing here can post
 * to it. The invoice moves to `routed_pending` so the queue of what is waiting is visible, and it
 * never reaches `settled` - a settled invoice nobody routed would read as money that moved between
 * two entities when none did, and it would do so in two sets of accounts, one of which is not ours.
 */
export const routeToGardnerLedger = async (input: {
  tenantId: string;
  invoiceId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<never>> => {
  const now = input.now ?? new Date();

  const row = await db().intercompanyInvoice.findFirst({
    where: { tenantId: input.tenantId, id: input.invoiceId },
  });
  if (!row) return noData(`No intercompany invoice ${input.invoiceId} is on record.`);

  if (row.state === 'drafted') {
    await db().intercompanyInvoice.update({
      where: { id: row.id },
      data: { state: 'routed_pending' },
    });

    await append({
      tenantId: input.tenantId,
      type: 'interventure.invoice.routing_attempted',
      actor: input.actor,
      payload: { invoiceId: row.id, attemptedAt: now.toISOString() },
    });
  }

  return notBuilt(
    '11.5 Integration Layer - Gardner-level intercompany ledger',
    `Invoice ${input.invoiceId} is recorded and marked as awaiting routing, but no Gardner-level ledger is connected, so nothing has been posted and nothing has settled. It is deliberately not marked settled: a settled intercompany invoice nobody routed would read as money that moved between two entities when none did, in two sets of accounts, one of which is not ours.`,
  );
};

/** Invoices awaiting a Gardner ledger. The queue that makes the seam visible rather than silent. */
export const awaitingRouting = async (
  tenantId: string,
): Promise<readonly IntercompanyInvoice[]> => {
  const rows = await db().intercompanyInvoice.findMany({
    where: { tenantId, state: { in: ['drafted', 'routed_pending'] } },
    orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toInvoice);
};

export const invoicesFor = async (
  tenantId: string,
  engagementId: string,
): Promise<readonly IntercompanyInvoice[]> => {
  const rows = await db().intercompanyInvoice.findMany({
    where: { tenantId, engagementId },
    orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toInvoice);
};
