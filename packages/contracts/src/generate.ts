/**
 * Generation - blueprint 7.3.
 *
 * The assembly order is the design:
 *
 *   1. the Regulatory Engine gate  - may we act in this state at all
 *   2. the template                - reviewed by counsel at this version
 *   3. clauses                     - scoped by jurisdiction, tier and channel
 *   4. disclosures                 - inserted from 7.2 by key, never retyped
 *   5. the compliance scan         - banned language must not reach a signed document
 *   6. the content model + hash    - the artifact, and the evidence of it
 *
 * The gate runs first for the same reason governance runs before eligibility in 5.3: when the
 * answer is "we may not act in this state", the client's tier and product have nothing to do with
 * it, and computing a document to then throw away invites somebody to reach for the intermediate
 * result.
 *
 * **What is generated is frozen.** Blueprint 7.3 lists "auto-updates when Regulatory Engine flags
 * rule changes", and the careless reading of that would have this module rewrite issued documents.
 * A document a client signed must never change afterwards - it is the only evidence of what was
 * agreed. What updates is what is generated next, plus a derived staleness report over what was
 * issued. See `staleness.ts`.
 */

import { createHash } from 'node:crypto';
import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { canonicalJson } from '@bwc/deliverables';
import { scanForTenant } from '@bwc/scanner';
import { checkJurisdiction, type RequiredDisclosure } from '@bwc/regulatory';
import { failed, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { applicableClauses, type ClauseRecord } from './clauses.js';
import { currentTemplate, templateIsGenerable, type ContractKind } from './templates.js';

export interface ContractSection {
  readonly heading: string;
  readonly body: string;
  /** Clauses spliced into this section, each with the citation that put it there. */
  readonly clauses: readonly { key: string; text: string; citation: string }[];
  /** Disclosures spliced into this section, from 7.2. */
  readonly disclosures: readonly { key: string; text: string; citation: string; source: string }[];
}

export interface ContractDocument {
  readonly title: string;
  readonly kind: ContractKind;
  readonly state: string;
  readonly offerTier: string | null;
  readonly channel: string | null;
  readonly sections: readonly ContractSection[];
  /** Pinned at generation, so the document explains itself without reconstructing the world. */
  readonly provenance: {
    readonly templateKey: string;
    readonly templateVersion: number;
    readonly stateModuleVersion: number;
    readonly generatedAt: string;
  };
}

export interface GeneratedContractRecord {
  readonly id: string;
  readonly clientId: string;
  readonly kind: ContractKind;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly state: string;
  readonly stateModuleVersion: number;
  readonly content: ContractDocument;
  readonly contentHash: string;
  readonly clauseKeys: readonly string[];
  readonly disclosureKeys: readonly string[];
  readonly issuedAt: string;
}

/** sha256 over the canonical JSON of the content model - ADR-0005, applied to a binding document. */
export const hashDocument = (document: ContractDocument): string =>
  createHash('sha256').update(canonicalJson(document)).digest('hex');

export interface GenerateInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly templateKey: string;
  readonly state: string;
  readonly offerTier?: string;
  readonly channel?: string;
  readonly productKind?: string;
  /** Substituted into section bodies as `{{name}}`. Values are inserted verbatim. */
  readonly variables?: Readonly<Record<string, string>>;
  readonly generatedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Generate and record a contract.
 *
 * Every refusal names what would fix it, because the operator hitting one is usually mid-way
 * through onboarding a client and the difference between "activate the state" and "get the
 * template reviewed" is the difference between a five-minute fix and a two-week one.
 */
export const generateContract = async (
  input: GenerateInput,
): Promise<Outcome<GeneratedContractRecord>> => {
  // 1. The gate. First, so a state we may not act in never has a document computed for it.
  const clearance = await checkJurisdiction({
    tenantId: input.tenantId,
    state: input.state,
    ...(input.productKind !== undefined ? { productKind: input.productKind } : {}),
  });
  if (clearance.status !== 'ok') {
    return clearance as Outcome<GeneratedContractRecord>;
  }

  const { state, standing, requiredDisclosures } = clearance.value;

  // 2. The template, at a version counsel has seen.
  const template = await currentTemplate(input.tenantId, input.templateKey);
  if (template.status !== 'ok') return template as Outcome<GeneratedContractRecord>;

  const generable = await templateIsGenerable(
    input.tenantId,
    input.templateKey,
    template.value.version,
  );
  if (!generable.generable) {
    return refused(
      generable.reason,
      'Specification versioning - contract templates require counsel review for material changes',
    );
  }

  // 3. Clauses, scoped to this jurisdiction, tier and channel.
  const wantedKeys = template.value.sections.flatMap((section) => section.insertClauseKeys ?? []);
  const clauses = await applicableClauses({
    tenantId: input.tenantId,
    jurisdiction: state,
    ...(input.offerTier !== undefined ? { offerTier: input.offerTier } : {}),
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(wantedKeys.length > 0 ? { keys: wantedKeys } : {}),
  });

  const byKey = new Map(clauses.map((clause) => [clause.key, clause]));

  // A template naming a clause that does not resolve is a hole in a signed document. Refusing is
  // the only safe answer: generating without it produces an agreement missing a term somebody
  // deliberately wrote, and nothing in the output would show the gap.
  const missing = wantedKeys.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    return refused(
      `Template '${input.templateKey}' inserts clause(s) ${missing.join(', ')}, which are not published for ${state}${input.offerTier !== undefined ? ` at tier ${input.offerTier}` : ''}. Generating without them would produce an agreement silently missing a term.`,
      'Blueprint 7.3 - jurisdiction-aware clause insertion',
    );
  }

  // 4. Assemble.
  const now = input.now ?? new Date();
  const sections = template.value.sections.map((section) => ({
    heading: section.heading,
    body: substitute(section.body, input.variables ?? {}),
    clauses: (section.insertClauseKeys ?? []).map((key) => {
      const clause = byKey.get(key) as ClauseRecord;
      return {
        key: clause.key,
        text: substitute(clause.text, input.variables ?? {}),
        citation: clause.citation,
      };
    }),
    disclosures:
      section.insertDisclosures === true
        ? requiredDisclosures.map((disclosure: RequiredDisclosure) => ({
            key: disclosure.key,
            text: disclosure.text,
            citation: disclosure.citation,
            source: disclosure.source,
          }))
        : [],
  }));

  const document: ContractDocument = {
    title: template.value.title,
    kind: template.value.kind,
    state,
    offerTier: input.offerTier ?? null,
    channel: input.channel ?? null,
    sections,
    provenance: {
      templateKey: template.value.key,
      templateVersion: template.value.version,
      stateModuleVersion: standing.currentVersion ?? 0,
      generatedAt: now.toISOString(),
    },
  };

  // 5. The scanner. A banned phrase in a marketing email is a compliance finding; the same phrase
  // in a signed agreement is a term of the contract.
  const scan = await scanForTenant({
    tenantId: input.tenantId,
    text: scannableContractText(document),
    actor: input.actor,
    clientId: input.clientId,
    jurisdiction: state,
    context: `contract:${template.value.key} v${template.value.version} (${state})`,
  });
  if (scan.status !== 'ok') return scan as Outcome<GeneratedContractRecord>;

  if (scan.value.verdict === 'blocked') {
    return refused(
      `The assembled document contains language the Marketing Claim Library bans: ${scan.value.findings
        .filter((finding) => finding.disposition === 'banned')
        .map((finding) => finding.phrase)
        .join(
          ', ',
        )}. A banned phrase in a signed agreement is not a compliance finding - it is a term of the contract.`,
      'Blueprint 7.4 with 7.3 - approved language applies to contracts, not only to marketing',
    );
  }

  // `requires_disclosure` is not a refusal here, and that is the one place this module treats the
  // scanner differently from a marketing email. A contract that trips a requires-disclaimer phrase
  // is fine PROVIDED the disclosure it obliges is in the document - and the disclosures from 7.2
  // are already spliced in above. What would be wrong is generating the document while the
  // obligation is unmet, so that is what is checked.
  const attached = new Set(sections.flatMap((s) => s.disclosures.map((d) => d.key)));
  const unmet = scan.value.requiredDisclosures.filter((needed) => !attached.has(needed));
  if (unmet.length > 0) {
    return refused(
      `The assembled document uses language requiring disclosure(s) ${unmet.join(', ')}, which the template does not insert. Add a section with insertDisclosures, or publish the disclosure for ${state}.`,
      'Blueprint 7.4 - a requires_disclaimer phrase must travel with the disclosure it obliges',
    );
  }

  // 6. Record. Nothing updates this row afterwards.
  const contentHash = hashDocument(document);
  const disclosureKeys = requiredDisclosures.map((disclosure) => disclosure.key);
  const clauseKeys = [...byKey.keys()].sort();

  let row;
  try {
    row = await db().generatedContract.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        kind: template.value.kind as never,
        templateKey: template.value.key,
        templateVersion: template.value.version,
        state,
        stateModuleVersion: standing.currentVersion ?? 0,
        offerTier: input.offerTier ?? null,
        channel: input.channel ?? null,
        content: document as never,
        contentHash,
        clauseKeys,
        disclosureKeys,
        generatedBy: input.generatedBy,
        issuedAt: now,
      },
    });
  } catch (error) {
    return failed(
      'The generated contract could not be recorded.',
      error instanceof Error ? error.message : String(error),
    );
  }

  await append({
    tenantId: input.tenantId,
    type: 'contract.generated',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      contractId: row.id,
      kind: template.value.kind,
      templateKey: template.value.key,
      templateVersion: template.value.version,
      state,
      stateModuleVersion: standing.currentVersion ?? 0,
      contentHash,
      clauseKeys,
      disclosureKeys,
    },
  });

  return ok({
    id: row.id,
    clientId: row.clientId,
    kind: template.value.kind,
    templateKey: template.value.key,
    templateVersion: template.value.version,
    state,
    stateModuleVersion: standing.currentVersion ?? 0,
    content: document,
    contentHash,
    clauseKeys,
    disclosureKeys,
    issuedAt: now.toISOString(),
  });
};

/**
 * Substitute `{{name}}` placeholders.
 *
 * An unresolved placeholder is left visibly in place rather than blanked. A contract reading
 * "between Burkham Wickmont and {{clientLegalName}}" is obviously broken and gets caught; one
 * reading "between Burkham Wickmont and " looks like a formatting slip and gets signed.
 */
const substitute = (text: string, variables: Readonly<Record<string, string>>): string =>
  text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => variables[name] ?? match);

/** Everything a human would read, flattened for the compliance scanner. */
export const scannableContractText = (document: ContractDocument): string =>
  [
    document.title,
    ...document.sections.flatMap((section) => [
      section.heading,
      section.body,
      ...section.clauses.map((clause) => clause.text),
      ...section.disclosures.map((disclosure) => disclosure.text),
    ]),
  ].join('\n\n');

/** Placeholders a document still carries, so a caller can refuse to send it. */
export const unresolvedPlaceholders = (document: ContractDocument): readonly string[] => {
  const found = new Set<string>();
  for (const match of scannableContractText(document).matchAll(/\{\{(\w+)\}\}/g)) {
    found.add(match[1] as string);
  }
  return [...found].sort();
};

export const findContract = async (
  tenantId: string,
  contractId: string,
): Promise<GeneratedContractRecord | null> => {
  const row = await db().generatedContract.findFirst({ where: { tenantId, id: contractId } });
  if (!row) return null;

  return {
    id: row.id,
    clientId: row.clientId,
    kind: row.kind as ContractKind,
    templateKey: row.templateKey,
    templateVersion: row.templateVersion,
    state: row.state,
    stateModuleVersion: row.stateModuleVersion,
    content: row.content as unknown as ContractDocument,
    contentHash: row.contentHash,
    clauseKeys: row.clauseKeys,
    disclosureKeys: row.disclosureKeys,
    issuedAt: row.issuedAt.toISOString(),
  };
};

/**
 * Every contract issued to a client, oldest first.
 *
 * Added for the Compliance Evidence Vault (7.1). Superseded and current documents both appear:
 * a client's file is the history of what they signed, not only the latest of it.
 */
export const contractsForClient = async (
  tenantId: string,
  clientId: string,
): Promise<readonly GeneratedContractRecord[]> => {
  const rows = await db().generatedContract.findMany({
    where: { tenantId, clientId },
    orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    kind: row.kind as ContractKind,
    templateKey: row.templateKey,
    templateVersion: row.templateVersion,
    state: row.state,
    stateModuleVersion: row.stateModuleVersion,
    content: row.content as unknown as ContractDocument,
    contentHash: row.contentHash,
    clauseKeys: row.clauseKeys,
    disclosureKeys: row.disclosureKeys,
    issuedAt: row.issuedAt.toISOString(),
  }));
};
