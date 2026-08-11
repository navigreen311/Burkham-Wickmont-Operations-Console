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
import { autoListForComplianceFail } from '@bwc/risk';
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
  /**
   * When this determination was made.
   *
   * Present because the automatic Do Not Fund listing below is DATED, and a listing's date is what
   * its review cadence counts from - so a caller reconstructing a past determination has to be able
   * to say when it happened. Defaults to now, as everywhere else that takes one.
   */
  readonly now?: Date;
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
 *
 * ## `fail` lists the client, and it happens HERE
 *
 * Decision E says a failed compliance state routes the client to Do Not Fund Governance. 6.4 wrote
 * `autoListForComplianceFail` to do it - and **for the whole life of this system nothing called
 * it**, so a client moved to `fail` stayed fundable. The function was exported, tested, and dead.
 *
 * It is called from inside this function rather than beside it, and that is the decision worth
 * reading (ADR-0034):
 *
 * **A control a caller can skip by calling a different function is not a control.** Composing it in
 * the transport, in the middleware chain, or in a wrapper somebody is supposed to prefer all leave
 * `transitionComplianceState` reachable and unlisted - and the next caller will reach for the plain
 * one, because it is the one that is named after what they want to do.
 *
 * **Synchronously, not through a Ledger listener.** A listener is the tidier architecture and the
 * wrong shape for this: it makes a SAFETY control eventually-consistent on a queue that can stop,
 * which is precisely what 6.4 refused - *"a client whose compliance failed on a Friday stayed
 * fundable until Monday"*. The listing has to be true by the time this call returns.
 *
 * The cost is a dependency from 1.1 to 6.4, which is the wrong direction on a layer diagram. It is
 * accepted knowingly: Decision E is already enforced in `@bwc/firewall` too, and the alternative to
 * one wrong-direction import is a control anybody can walk past.
 *
 * **If the listing cannot be written, this returns `failed` and says so.** The transition is already
 * in the Ledger by then and the Ledger is append-only, so there is nothing to roll back - and a
 * caller who got `ok` would believe a client was blocked who is not.
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

  if (input.to === 'fail') {
    // Idempotent: a client already listed is left as they are. A second `fail` transition is
    // ordinary and must not produce a second determination.
    const listed = await autoListForComplianceFail({
      tenantId: input.tenantId,
      clientId: input.clientId,
      complianceState: input.to,
      reason: input.reason,
      triggeredBy: input.actor,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    if (listed.status !== 'ok') {
      return failed(
        'The compliance state was recorded as Fail, and the automatic Do Not Fund listing was NOT written. This client is not blocked. List them by hand.',
        listed.status === 'refused' ? listed.reason : `Listing returned ${listed.status}.`,
      );
    }
  }

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
    db().client.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset,
    }),
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
