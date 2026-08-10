/**
 * Which issued documents are behind the rules - blueprint 7.3's "auto-updates when Regulatory
 * Engine flags rule changes", read the only way it can safely be read.
 *
 * **Nothing here rewrites a document.** An issued agreement is the evidence of what was agreed; a
 * system that quietly updates one destroys that evidence, and would do so most eagerly for the
 * documents whose terms mattered most. What this file produces is a report: *these agreements were
 * generated against California module version 3, which is now version 4 - consider reissuing.*
 *
 * Derived rather than stored, for the reason ADR-0007 and ADR-0009 both give: a stored "stale"
 * flag needs a job to keep it true, and a job that stops leaves stale documents reading as current.
 */

import { db } from '@bwc/db';
import { standingFor } from '@bwc/regulatory';
import type { ContractKind } from './templates.js';

export interface StaleContract {
  readonly id: string;
  readonly clientId: string;
  readonly kind: ContractKind;
  readonly state: string;
  /** The module version this document was generated against. */
  readonly generatedAgainstVersion: number;
  readonly currentVersion: number;
  readonly issuedAt: string;
  /** Written for an operator deciding whether to reissue. */
  readonly reason: string;
}

/**
 * Issued documents generated against a superseded state module version.
 *
 * Reports against **any** later version rather than only material ones. That is deliberately
 * stricter than the activation gate, which ignores editorial changes: a state stays online through
 * an editorial correction because the rules did not move, but a document that quotes a corrected
 * citation is quoting something that has been fixed - and reissuing is cheap while a wrong citation
 * in a signed agreement is not.
 *
 * The report says which kind of change it was, so an operator can triage rather than reissue
 * everything.
 */
export const staleContracts = async (
  tenantId: string,
  state?: string,
): Promise<readonly StaleContract[]> => {
  const rows = await db().generatedContract.findMany({
    where: { tenantId, ...(state !== undefined ? { state } : {}) },
    orderBy: [{ state: 'asc' }, { issuedAt: 'asc' }],
  });

  const standingCache = new Map<string, number>();
  const stale: StaleContract[] = [];

  for (const row of rows) {
    let current = standingCache.get(row.state);
    if (current === undefined) {
      const standing = await standingFor(tenantId, row.state);
      current = standing.currentVersion ?? 0;
      standingCache.set(row.state, current);
    }

    if (current <= row.stateModuleVersion) continue;

    const material = await db().stateModule.findFirst({
      where: {
        tenantId,
        state: row.state,
        version: { gt: row.stateModuleVersion },
        changeKind: 'material',
      },
      orderBy: { version: 'asc' },
      select: { version: true },
    });

    stale.push({
      id: row.id,
      clientId: row.clientId,
      kind: row.kind as ContractKind,
      state: row.state,
      generatedAgainstVersion: row.stateModuleVersion,
      currentVersion: current,
      issuedAt: row.issuedAt.toISOString(),
      reason:
        material === null
          ? `Generated against ${row.state} module version ${row.stateModuleVersion}; now version ${current}. Every change since has been editorial, so the obligations have not moved - reissue only if the wording matters.`
          : `Generated against ${row.state} module version ${row.stateModuleVersion}; version ${material.version} made a material change. This document may state obligations that no longer match the state's rules.`,
    });
  }

  return stale;
};

/**
 * Documents generated from a template version counsel has since replaced materially.
 *
 * The template equivalent of the above, and separated from it because the remedy differs: a stale
 * state module means the law moved, while a stale template means we changed our own words. An
 * operator triaging the two makes different calls.
 */
export const contractsOnSupersededTemplates = async (
  tenantId: string,
): Promise<readonly { id: string; templateKey: string; from: number; to: number }[]> => {
  const rows = await db().generatedContract.findMany({ where: { tenantId } });
  const currentByKey = new Map<string, number>();
  const behind: { id: string; templateKey: string; from: number; to: number }[] = [];

  for (const row of rows) {
    let current = currentByKey.get(row.templateKey);
    if (current === undefined) {
      const template = await db().contractTemplate.findFirst({
        where: { tenantId, key: row.templateKey, supersededAt: null },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      current = template?.version ?? row.templateVersion;
      currentByKey.set(row.templateKey, current);
    }

    if (current > row.templateVersion) {
      behind.push({
        id: row.id,
        templateKey: row.templateKey,
        from: row.templateVersion,
        to: current,
      });
    }
  }

  return behind;
};

/**
 * Confirm a stored document still hashes to what was recorded.
 *
 * The question this answers is "was this what we sent?", and it has to be answerable without
 * trusting the row it is checking. A mismatch means the content model was altered after issue,
 * which for a contract is the most serious integrity failure the system can have.
 */
export const verifyStoredHash = async (
  tenantId: string,
  contractId: string,
  recompute: (content: unknown) => string,
): Promise<{ intact: boolean; detail: string }> => {
  const row = await db().generatedContract.findFirst({ where: { tenantId, id: contractId } });
  if (!row) return { intact: false, detail: 'No such contract in this tenant.' };

  const recomputed = recompute(row.content);
  return recomputed === row.contentHash
    ? { intact: true, detail: `Content matches the hash recorded at issue (${row.contentHash}).` }
    : {
        intact: false,
        detail: `Stored content hashes to ${recomputed}, but ${row.contentHash} was recorded at issue. The content model has been altered since the document was issued.`,
      };
};
