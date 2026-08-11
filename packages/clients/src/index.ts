/**
 * @bwc/clients - 1.1 Client Lifecycle & CRM (compliance state surface).
 *
 * The walking skeleton needs exactly one thing from this module: the compliance categorical
 * state, and a transition path that writes a ledger event carrying the findings that produced
 * it. Decision E.
 *
 * The rest of 1.1 - offer tier, phase status, risk rating, classification, vertical playbook -
 * is deliberately absent rather than stubbed, so nothing reads as built when it is not.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import {
  isComplianceState,
  ok,
  failed,
  noData,
  type ComplianceState,
  type ComplianceStateChangedPayload,
  type EventActor,
  type Outcome,
} from '@bwc/core';

export interface Client {
  readonly id: string;
  readonly tenantId: string;
  readonly legalName: string;
  readonly complianceState: ComplianceState;
}

export interface Finding {
  readonly code: string;
  readonly summary: string;
}

export const create = async (
  tenantId: string,
  legalName: string,
  actor: EventActor,
): Promise<Client> => {
  const row = await db().client.create({ data: { tenantId, legalName } });

  await append({
    tenantId,
    type: 'client.created',
    actor,
    clientId: row.id,
    payload: { legalName: row.legalName, complianceState: row.complianceState },
  });

  return {
    id: row.id,
    tenantId: row.tenantId,
    legalName: row.legalName,
    complianceState: row.complianceState,
  };
};

/**
 * Returns `no_data` rather than null so a caller cannot mistake "no such client" for
 * "a client with nothing in it" - principle 9.
 */
export const find = async (tenantId: string, clientId: string): Promise<Outcome<Client>> => {
  const row = await db().client.findFirst({ where: { id: clientId, tenantId } });

  if (!row) return noData(`No client ${clientId} in this tenant.`);
  if (!isComplianceState(row.complianceState)) {
    return failed(`Client ${clientId} holds an unrecognised compliance state.`);
  }

  return ok({
    id: row.id,
    tenantId: row.tenantId,
    legalName: row.legalName,
    complianceState: row.complianceState,
  });
};

export interface TransitionInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly to: ComplianceState;
  readonly reason: string;
  readonly findings?: readonly Finding[];
  readonly actor: EventActor;
}

/**
 * Transition a client's compliance state.
 *
 * The findings travel with the transition into the ledger event rather than being looked up
 * afterwards: the Compliance Evidence Vault (7.1) generates regulator-ready files from the
 * transition history, and a finding resolved later would otherwise rewrite the past.
 *
 * There is no validation of "allowed" transitions. Any state can follow any other - a client
 * can go from fail back to pass when findings are resolved, and forcing a graph here would
 * encode a workflow that belongs in the Human Approval Console (2.4).
 */
export const transitionComplianceState = async (
  input: TransitionInput,
): Promise<Outcome<Client>> => {
  const current = await find(input.tenantId, input.clientId);
  if (current.status !== 'ok') return current;

  const findings = input.findings ?? [];
  const prisma = db();

  const row = await prisma.$transaction(async (tx) => {
    if (findings.length > 0) {
      await tx.complianceFinding.createMany({
        data: findings.map((finding) => ({
          clientId: input.clientId,
          code: finding.code,
          summary: finding.summary,
        })),
      });
    }
    return tx.client.update({
      where: { id: input.clientId },
      data: { complianceState: input.to },
    });
  });

  const payload: ComplianceStateChangedPayload = {
    from: current.value.complianceState,
    to: input.to,
    reason: input.reason,
    findingCodes: findings.map((finding) => finding.code),
  };

  await append({
    tenantId: input.tenantId,
    type: 'client.compliance_state_changed',
    actor: input.actor,
    clientId: input.clientId,
    payload,
  });

  return ok({
    id: row.id,
    tenantId: row.tenantId,
    legalName: row.legalName,
    complianceState: input.to,
  });
};

export interface ClientPage {
  readonly clients: readonly Client[];
  /** How many the tenant holds in total, so a page can say what it is a page OF. */
  readonly total: number;
}

/** The largest page this will return, whatever is asked for. */
export const MAX_CLIENT_PAGE = 100;

/**
 * A page of the tenant's clients, newest first.
 *
 * Added for the Console, which needs a list before it can offer a file. **Tenant-scoped with no way
 * to ask for another tenant's** - the parameter is not optional and there is no "all clients" call
 * to reach for by mistake.
 *
 * `total` travels with the page rather than being left to the caller to count. A list that silently
 * showed the first fifty of four hundred would read as the whole book, and the person reading it is
 * deciding what needs attention today.
 *
 * A row whose stored state is not a recognised compliance state is REPORTED rather than dropped:
 * `find` already returns `failed` for one, and a list that quietly omitted it would hide the client
 * whose record is broken - which is the client somebody most needs to see.
 */
export const listClients = async (input: {
  tenantId: string;
  limit?: number;
  offset?: number;
  /** Case-insensitive match on legal name. */
  search?: string;
}): Promise<Outcome<ClientPage>> => {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), MAX_CLIENT_PAGE);
  const offset = Math.max(input.offset ?? 0, 0);
  const search = input.search?.trim();

  const where = {
    tenantId: input.tenantId,
    ...(search && search !== ''
      ? { legalName: { contains: search, mode: 'insensitive' as const } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db().client.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
    db().client.count({ where }),
  ]);

  const broken = rows.find((row) => !isComplianceState(row.complianceState));
  if (broken) {
    return failed(`Client ${broken.id} holds an unrecognised compliance state.`);
  }

  return ok({
    clients: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      legalName: row.legalName,
      complianceState: row.complianceState as ComplianceState,
    })),
    total,
  });
};

export const openFindings = async (clientId: string): Promise<Finding[]> => {
  const rows = await db().complianceFinding.findMany({
    where: { clientId, resolvedAt: null },
    select: { code: true, summary: true },
  });
  return rows;
};
