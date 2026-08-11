/**
 * The jurisdiction-aware clause library - blueprint 7.3.
 *
 * A clause is scoped three ways: by jurisdiction, by offer tier, and by channel. The scoping rule
 * is the same in all three and is worth stating once, because the alternative reading is the
 * dangerous one:
 *
 *   **An empty scope means "applies to all", not "applies to none."**
 *
 * A clause published with no tier restriction applies to every tier. Restricting a clause to
 * nothing is expressed by not publishing it. The opposite convention would make an omitted field
 * silently remove a clause from every document - which is how a required term disappears from a
 * contract without anybody editing anything.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { ALL_JURISDICTIONS } from './templates.js';

export interface ClauseRecord {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly text: string;
  readonly citation: string;
  readonly jurisdiction: string;
  readonly appliesToTiers: readonly string[];
  readonly appliesToChannels: readonly string[];
}

interface ClauseRow {
  id: string;
  key: string;
  version: number;
  text: string;
  citation: string;
  jurisdiction: string;
  appliesToTiers: string[];
  appliesToChannels: string[];
}

const toClause = (row: ClauseRow): ClauseRecord => ({
  id: row.id,
  key: row.key,
  version: row.version,
  text: row.text,
  citation: row.citation,
  jurisdiction: row.jurisdiction,
  appliesToTiers: row.appliesToTiers,
  appliesToChannels: row.appliesToChannels,
});

export interface PublishClauseInput {
  readonly tenantId: string;
  readonly key: string;
  readonly text: string;
  /** Why this clause exists - a statute, a policy decision, a partner agreement. */
  readonly citation: string;
  /** Omit for every jurisdiction. */
  readonly jurisdiction?: string;
  /** Omit for every tier / channel. */
  readonly appliesToTiers?: readonly string[];
  readonly appliesToChannels?: readonly string[];
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/** Publish a clause, superseding the prior version of the same key in the same jurisdiction. */
export const publishClause = async (input: PublishClauseInput): Promise<Outcome<ClauseRecord>> => {
  if (input.text.trim() === '') {
    return refused(
      `Clause '${input.key}' was published with no text.`,
      'Blueprint 7.3 - a clause with no content cannot be inserted or argued with',
    );
  }
  if (input.citation.trim() === '') {
    return refused(
      `Clause '${input.key}' was published with no citation. A term in a client agreement that nobody can trace to a rule or a decision cannot be reviewed, taught, or revisited.`,
      'Blueprint 7.3 - the same discipline 7.2 applies to a disclosure and 7.4 to a banned phrase',
    );
  }

  const jurisdiction = input.jurisdiction ?? ALL_JURISDICTIONS;
  const now = input.now ?? new Date();

  const current = await db().clause.findFirst({
    where: { tenantId: input.tenantId, key: input.key, jurisdiction, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });

  const row = await db().$transaction(async (tx) => {
    if (current) {
      await tx.clause.update({ where: { id: current.id }, data: { supersededAt: now } });
    }
    return tx.clause.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        version: (current?.version ?? 0) + 1,
        text: input.text,
        citation: input.citation,
        jurisdiction,
        appliesToTiers: [...(input.appliesToTiers ?? [])],
        appliesToChannels: [...(input.appliesToChannels ?? [])],
        createdBy: input.publishedBy,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'contract.clause.published',
    actor: input.actor,
    payload: {
      clauseKey: input.key,
      version: row.version,
      jurisdiction,
      publishedBy: input.publishedBy,
    },
  });

  return ok(toClause(row));
};

export interface ClauseSelector {
  readonly tenantId: string;
  readonly jurisdiction: string;
  readonly offerTier?: string;
  readonly channel?: string;
  /** When given, only these keys are considered - a template naming what it expects. */
  readonly keys?: readonly string[];
}

/**
 * The clauses in force for this jurisdiction, tier and channel.
 *
 * A state-scoped clause **adds to** the global set rather than replacing it, the same convention
 * the Marketing Claim Library uses for a state ban. Where both a global and a state-scoped clause
 * exist under one key, the state-scoped one wins - a jurisdiction-specific term is the more
 * specific instruction, and returning both would put two versions of the same term in one
 * document.
 */
export const applicableClauses = async (
  selector: ClauseSelector,
): Promise<readonly ClauseRecord[]> => {
  const rows = await db().clause.findMany({
    where: {
      tenantId: selector.tenantId,
      supersededAt: null,
      jurisdiction: { in: [ALL_JURISDICTIONS, selector.jurisdiction] },
      ...(selector.keys !== undefined ? { key: { in: [...selector.keys] } } : {}),
    },
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
  });

  const scoped = rows
    .map(toClause)
    .filter((clause) => inScope(clause.appliesToTiers, selector.offerTier))
    .filter((clause) => inScope(clause.appliesToChannels, selector.channel));

  // State-scoped beats global for the same key.
  const byKey = new Map<string, ClauseRecord>();
  for (const clause of scoped) {
    const existing = byKey.get(clause.key);
    if (existing === undefined || existing.jurisdiction === ALL_JURISDICTIONS) {
      byKey.set(clause.key, clause);
    }
  }

  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
};

/**
 * Empty scope means "applies to all".
 *
 * Stated as its own function so the convention has one home. Read the other way round - empty
 * meaning "applies to none" - an omitted field would silently drop a required term from every
 * document, which is how a clause disappears from a contract with nobody having edited anything.
 */
const inScope = (restriction: readonly string[], value: string | undefined): boolean =>
  restriction.length === 0 || (value !== undefined && restriction.includes(value));

/** Every version of a clause, newest first - readable when it explains an old agreement. */
export const clauseHistory = async (
  tenantId: string,
  key: string,
): Promise<readonly ClauseRecord[]> => {
  const rows = await db().clause.findMany({
    where: { tenantId, key },
    orderBy: [{ jurisdiction: 'asc' }, { version: 'desc' }],
  });
  return rows.map(toClause);
};
