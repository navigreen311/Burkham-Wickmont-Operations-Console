/**
 * State modules - blueprint 7.2's "per-state modules", versioned.
 *
 * The specification's versioning section says state modules require "counsel review for material
 * changes". That sentence is the whole design of this file: `changeKind` is a required argument on
 * every publish, and a material publish returns an activated state to review.
 *
 * Required rather than defaulted, deliberately. A default is chosen once by whoever writes the
 * first call site and then inherited silently by every later change - which is precisely how a
 * material change ships as editorial.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

/** The seven the blueprint puts in V1. The remaining states arrive in V1.5 and V2. */
export const V1_PRIORITY_STATES = ['NV', 'CA', 'NY', 'TX', 'FL', 'AZ', 'UT'] as const;

export type ChangeKind = 'material' | 'editorial';

/** Sentinel for a disclosure that applies to every product in the state. */
export const ALL_PRODUCTS = '*';

export interface DisclosureRequirement {
  readonly key: string;
  readonly text: string;
  /** Which law obliges it. A requirement with no cited basis cannot be reviewed or defended. */
  readonly citation: string;
  /** Defaults to every product. */
  readonly productKind?: string;
}

export interface StateModuleRecord {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly summary: string;
  readonly citations: readonly string[];
  readonly changeKind: ChangeKind;
  readonly changeRationale: string | null;
  readonly marketingNotes: string | null;
  readonly supersededAt: string | null;
  readonly createdBy: string;
}

interface ModuleRow {
  id: string;
  state: string;
  version: number;
  summary: string;
  citations: string[];
  changeKind: string;
  changeRationale: string | null;
  marketingNotes: string | null;
  supersededAt: Date | null;
  createdBy: string;
}

const toModule = (row: ModuleRow): StateModuleRecord => ({
  id: row.id,
  state: row.state,
  version: row.version,
  summary: row.summary,
  citations: row.citations,
  changeKind: row.changeKind as ChangeKind,
  changeRationale: row.changeRationale,
  marketingNotes: row.marketingNotes,
  supersededAt: row.supersededAt?.toISOString() ?? null,
  createdBy: row.createdBy,
});

export interface PublishModuleInput {
  readonly tenantId: string;
  readonly state: string;
  readonly summary: string;
  readonly citations: readonly string[];
  readonly disclosures: readonly DisclosureRequirement[];
  /**
   * Required. Material publishes return an activated state to counsel review; editorial ones
   * leave activation intact and must say why they are not material.
   */
  readonly changeKind: ChangeKind;
  readonly changeRationale?: string;
  readonly marketingNotes?: string;
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Publish a new version of a state's module.
 *
 * Four refusals:
 *
 *  - **No citations.** A state module is a claim about what the law requires. Without the law it
 *    cites, counsel has nothing to review and nobody can tell a researched rule from a guess.
 *  - **An editorial change with no rationale.** "This is not material" is an assertion, and one
 *    that suppresses a counsel review; it has to be an assertion somebody signed.
 *  - **Version 1 declared editorial.** There is no prior version for it to be editorially
 *    different from, so the claim is incoherent - and it is the exact claim that would let a whole
 *    state module skip its first review.
 *  - **A disclosure with no citation**, for the same reason as the module's own.
 *
 * The supersede and the insert run in one transaction: split, a crash leaves either two current
 * versions of a state's rules with no way to tell which governs, or none at all.
 */
export const publishStateModule = async (
  input: PublishModuleInput,
): Promise<Outcome<StateModuleRecord>> => {
  if (input.citations.length === 0) {
    return refused(
      `The ${input.state} module was published with no citations. A state module is a claim about what the law requires; without the law it cites there is nothing for counsel to review.`,
      'Blueprint 7.2 - per-state modules exist to be reviewed, and a rule with no basis cannot be',
    );
  }

  const uncited = input.disclosures.filter((disclosure) => disclosure.citation.trim() === '');
  if (uncited.length > 0) {
    return refused(
      `${uncited.length} disclosure requirement(s) in the ${input.state} module have no citation: ${uncited.map((d) => d.key).join(', ')}.`,
      'Blueprint 7.2 - a required disclosure must name the law that requires it',
    );
  }

  if (input.changeKind === 'editorial' && (input.changeRationale ?? '').trim() === '') {
    return refused(
      `An editorial change to the ${input.state} module needs a rationale. Declaring a change non-material suppresses a counsel review, so it has to be an assertion somebody made deliberately.`,
      'Specification versioning - counsel review required for material changes',
    );
  }

  const now = input.now ?? new Date();

  const current = await db().stateModule.findFirst({
    where: { tenantId: input.tenantId, state: input.state, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });

  if (current === null && input.changeKind === 'editorial') {
    return refused(
      `The first version of the ${input.state} module cannot be editorial - there is no prior version for it to be editorially different from.`,
      'Specification versioning - the claim would let a whole state module skip its first review',
    );
  }

  const version = (current?.version ?? 0) + 1;

  const row = await db().$transaction(async (tx) => {
    if (current) {
      await tx.stateModule.update({ where: { id: current.id }, data: { supersededAt: now } });
    }

    return tx.stateModule.create({
      data: {
        tenantId: input.tenantId,
        state: input.state,
        version,
        summary: input.summary,
        citations: [...input.citations],
        changeKind: input.changeKind as never,
        changeRationale: input.changeRationale ?? null,
        marketingNotes: input.marketingNotes ?? null,
        createdBy: input.publishedBy,
        disclosures: {
          create: input.disclosures.map((disclosure) => ({
            tenantId: input.tenantId,
            key: disclosure.key,
            text: disclosure.text,
            citation: disclosure.citation,
            productKind: disclosure.productKind ?? ALL_PRODUCTS,
          })),
        },
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'regulatory.module.published',
    actor: input.actor,
    payload: {
      state: input.state,
      version,
      changeKind: input.changeKind,
      publishedBy: input.publishedBy,
      disclosureCount: input.disclosures.length,
    },
  });

  return ok(toModule(row));
};

/** The module in force for a state, or `no_data` when none has been published. */
export const currentModule = async (
  tenantId: string,
  state: string,
): Promise<Outcome<StateModuleRecord>> => {
  const row = await db().stateModule.findFirst({
    where: { tenantId, state, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });
  return row ? ok(toModule(row)) : noData(`No regulatory module has been published for ${state}.`);
};

/** Every version of a state's module, newest first - the audit view counsel reads. */
export const moduleHistory = async (
  tenantId: string,
  state: string,
): Promise<readonly StateModuleRecord[]> => {
  const rows = await db().stateModule.findMany({
    where: { tenantId, state },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });
  return rows.map(toModule);
};

export const statesWithModules = async (tenantId: string): Promise<readonly string[]> => {
  const rows = await db().stateModule.findMany({
    where: { tenantId, supersededAt: null },
    select: { state: true },
    orderBy: [{ state: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => row.state);
};
