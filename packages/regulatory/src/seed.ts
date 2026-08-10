/**
 * The seven V1 priority states, as drafts.
 *
 * **These are a scaffold for counsel, not legal advice.** They cite the statutes the specification
 * names in its regulatory-surface section and summarise the obligations those statutes create, so
 * that a reviewing lawyer has something concrete to correct rather than a blank page.
 *
 * They ship as `draft` and are unusable until reviewed, which is exactly what the activation gate
 * is for. Nothing here can serve a client until a named human at Level 3 records a counsel review
 * against a document - and the seeding function deliberately has no way to do that.
 *
 * The state-law change tracker is where corrections land: an entry recorded against a state, with
 * its citation, addressed by a later module version.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import type { EventActor } from '@bwc/core';
import { publishStateModule, type DisclosureRequirement } from './states.js';

interface SeedState {
  readonly state: string;
  readonly summary: string;
  readonly citations: readonly string[];
  readonly disclosures: readonly DisclosureRequirement[];
  readonly marketingNotes?: string;
}

/**
 * Commercial financing disclosure is the common thread. California and New York have the most
 * developed regimes; Utah and Florida have registration and disclosure requirements of their own;
 * Nevada, Texas and Arizona are lighter but not empty.
 *
 * Where a state's obligations are genuinely uncertain to a non-lawyer, the module says so in its
 * summary rather than inventing a requirement. An invented rule is worse than a missing one: it
 * looks reviewed.
 */
export const V1_STATE_SEEDS: readonly SeedState[] = [
  {
    state: 'CA',
    summary:
      'California requires provider-side disclosures on most commercial financing under SB 1235 and its implementing regulations, and applies UDAAP standards to small-business financing conduct. Broker conduct and compensation disclosure require counsel attention.',
    citations: [
      'California SB 1235 (2018), Fin. Code §22800 et seq.',
      '10 C.C.R. §900 et seq. (DFPI commercial financing disclosure regulations)',
      'California Consumer Financial Protection Law (UDAAP), Fin. Code §90000 et seq.',
    ],
    disclosures: [
      {
        key: 'ca_commercial_financing_disclosure',
        text: 'For covered commercial financing, the provider must furnish a standardised disclosure stating the total amount funded, total dollar cost, term, payment amount and frequency, prepayment policy, and an annualised rate. Burkham Wickmont does not originate these disclosures and does not substitute for them.',
        citation: 'California SB 1235; 10 C.C.R. §900 et seq.',
      },
      {
        key: 'ca_broker_compensation',
        text: 'Any compensation Burkham Wickmont receives in connection with a placement is disclosed to the client before an application is submitted.',
        citation: 'California SB 1235 broker provisions; Fin. Code §22800 et seq.',
      },
    ],
    marketingNotes:
      'UDAAP standards under the CCFPL reach small-business financing conduct, so marketing review for California should be at least as strict as the national library.',
  },
  {
    state: 'NY',
    summary:
      'New York requires commercial financing disclosures under its Commercial Finance Disclosure Law, and the Attorney General has pursued merchant cash advance conduct aggressively. Confession-of-judgment practice is restricted.',
    citations: [
      'New York Commercial Finance Disclosure Law, Fin. Serv. Law §801 et seq.',
      '23 N.Y.C.R.R. Part 600 (DFS commercial financing disclosure)',
      'N.Y. C.P.L.R. §3218 (confession of judgment restrictions)',
    ],
    disclosures: [
      {
        key: 'ny_commercial_financing_disclosure',
        text: 'For covered commercial financing, the provider must furnish the disclosures required by the Commercial Finance Disclosure Law, including finance charge, annual percentage rate, and payment terms. Burkham Wickmont does not originate these and does not substitute for them.',
        citation: 'N.Y. Fin. Serv. Law §801 et seq.; 23 N.Y.C.R.R. Part 600',
      },
      {
        key: 'ny_mca_conduct',
        text: 'Merchant cash advance products presented to a New York client are accompanied by the true cost of capital expressed as an annualised rate alongside any factor rate.',
        citation: 'N.Y. Attorney General enforcement practice regarding merchant cash advances',
      },
    ],
    marketingNotes:
      'Attorney General enforcement in this area has focused on cost presentation. Any material naming an MCA should carry the annualised cost, not only the factor.',
  },
  {
    state: 'UT',
    summary:
      'Utah requires registration for commercial financing providers and specific disclosures on covered transactions.',
    citations: [
      'Utah Commercial Financing Registration and Disclosure Act, Utah Code §7-27-101 et seq.',
    ],
    disclosures: [
      {
        key: 'ut_commercial_financing_disclosure',
        text: 'For covered commercial financing, the provider must furnish the disclosures required by the Commercial Financing Registration and Disclosure Act, including total repayment amount and payment terms.',
        citation: 'Utah Code §7-27-101 et seq.',
      },
    ],
  },
  {
    state: 'FL',
    summary:
      'Florida requires disclosures on covered commercial financing transactions and regulates broker conduct in connection with them.',
    citations: ['Florida Commercial Financing Disclosure Law, Fla. Stat. §559.9611 et seq.'],
    disclosures: [
      {
        key: 'fl_commercial_financing_disclosure',
        text: 'For covered commercial financing, the provider must furnish the disclosures required by Florida law, including total funds provided, total repayment amount, and payment terms.',
        citation: 'Fla. Stat. §559.9611 et seq.',
      },
      {
        key: 'fl_broker_conduct',
        text: 'Burkham Wickmont does not accept an advance fee for arranging commercial financing in Florida.',
        citation: 'Fla. Stat. §559.9611 et seq. (broker provisions)',
      },
    ],
  },
  {
    state: 'TX',
    summary:
      'Texas has no general commercial financing disclosure statute as at the date of this draft. Federal obligations and the company’s own conduct rules apply. Counsel should confirm current status before activation, as several states have adopted regimes recently.',
    citations: [
      'No Texas commercial financing disclosure statute identified as at drafting; federal baseline applies',
      'Tex. Fin. Code (general lending and brokerage provisions) - scope to be confirmed by counsel',
    ],
    disclosures: [],
    marketingNotes:
      'The absence of a state disclosure statute is a finding for counsel to confirm, not a conclusion this module asserts.',
  },
  {
    state: 'AZ',
    summary:
      'Arizona has no general commercial financing disclosure statute as at the date of this draft. Federal obligations apply. Counsel should confirm current status before activation.',
    citations: [
      'No Arizona commercial financing disclosure statute identified as at drafting; federal baseline applies',
    ],
    disclosures: [],
    marketingNotes: 'Same caveat as Texas: absence of a statute is for counsel to confirm.',
  },
  {
    state: 'NV',
    summary:
      'Nevada has no general commercial financing disclosure statute as at the date of this draft. Federal obligations apply, and Nevada licensing provisions should be reviewed for the company’s specific activities before activation.',
    citations: [
      'No Nevada commercial financing disclosure statute identified as at drafting; federal baseline applies',
      'Nev. Rev. Stat. ch. 675 (installment loans) - applicability to be confirmed by counsel',
    ],
    disclosures: [],
    marketingNotes: 'Same caveat as Texas and Arizona.',
  },
];

/**
 * Seed the seven priority states as drafts. Idempotent in effect but not in version: re-seeding
 * publishes a new material version, which is correct - it is a change to the rules of record, and
 * a state already activated goes back to counsel rather than quietly accepting it.
 */
export const seedV1PriorityStates = async (
  tenantId: string,
  publishedBy: string,
  actor: EventActor,
): Promise<number> => {
  let published = 0;

  for (const seed of V1_STATE_SEEDS) {
    const result = await publishStateModule({
      tenantId,
      state: seed.state,
      summary: seed.summary,
      citations: seed.citations,
      disclosures: seed.disclosures,
      changeKind: 'material',
      ...(seed.marketingNotes !== undefined ? { marketingNotes: seed.marketingNotes } : {}),
      publishedBy,
      actor,
    });
    if (result.status === 'ok') published += 1;
  }

  await append({
    tenantId,
    type: 'regulatory.seed.published',
    actor,
    payload: {
      states: V1_STATE_SEEDS.map((seed) => seed.state),
      published,
      note: 'Drafts for counsel review. No state is activated by seeding.',
    },
  });

  return published;
};

// --- State-law change tracker ---------------------------------------------

export interface LawChangeInput {
  readonly tenantId: string;
  readonly state: string;
  readonly summary: string;
  readonly citation: string;
  readonly noticedBy: string;
  readonly noticedAt: Date;
  readonly effectiveOn?: Date;
  readonly actor: EventActor;
}

/**
 * Record that a state's law changed - blueprint 7.2's "state-law change tracker".
 *
 * Recording a change deliberately does **not** alter the state's module or its activation. Noticing
 * that California amended its regulations is not the same as knowing what our module should now
 * say, and auto-deactivating on a notice would let anyone with write access take a state offline by
 * filing a bulletin.
 *
 * The backlog - changes with no module version addressing them - is the useful output.
 */
export const recordLawChange = async (input: LawChangeInput): Promise<{ id: string }> => {
  const row = await db().stateLawChange.create({
    data: {
      tenantId: input.tenantId,
      state: input.state,
      summary: input.summary,
      citation: input.citation,
      noticedBy: input.noticedBy,
      noticedAt: input.noticedAt,
      effectiveOn: input.effectiveOn ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'regulatory.law_change.noticed',
    actor: input.actor,
    payload: {
      state: input.state,
      citation: input.citation,
      noticedBy: input.noticedBy,
      changeId: row.id,
    },
  });

  return { id: row.id };
};

/** Mark a tracked change as incorporated into a module version. */
export const markChangeAddressed = async (input: {
  tenantId: string;
  changeId: string;
  moduleVersion: number;
  actor: EventActor;
  now?: Date;
}): Promise<void> => {
  await db().stateLawChange.updateMany({
    where: { id: input.changeId, tenantId: input.tenantId },
    data: { addressedInVersion: input.moduleVersion, addressedAt: input.now ?? new Date() },
  });

  await append({
    tenantId: input.tenantId,
    type: 'regulatory.law_change.addressed',
    actor: input.actor,
    payload: { changeId: input.changeId, moduleVersion: input.moduleVersion },
  });
};

export interface LawChangeRecord {
  readonly id: string;
  readonly state: string;
  readonly summary: string;
  readonly citation: string;
  readonly noticedAt: string;
  readonly effectiveOn: string | null;
  readonly addressedInVersion: number | null;
}

/** Changes nobody has incorporated yet. The queue that keeps the modules honest. */
export const outstandingLawChanges = async (
  tenantId: string,
  state?: string,
): Promise<readonly LawChangeRecord[]> => {
  const rows = await db().stateLawChange.findMany({
    where: { tenantId, addressedAt: null, ...(state !== undefined ? { state } : {}) },
    orderBy: [{ state: 'asc' }, { noticedAt: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    summary: row.summary,
    citation: row.citation,
    noticedAt: row.noticedAt.toISOString(),
    effectiveOn: row.effectiveOn?.toISOString() ?? null,
    addressedInVersion: row.addressedInVersion,
  }));
};
