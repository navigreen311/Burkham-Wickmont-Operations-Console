/**
 * Contract templates and the clause library - blueprint 7.3.
 *
 * Specification versioning: "Contract templates - versioned in Contract & Disclosure Builder,
 * counsel review required for material changes." The same sentence it applies to state modules,
 * so the discipline here mirrors 7.2's: required `changeKind`, a review naming a document, and a
 * material republish that stops generation until somebody looks again.
 *
 * **Mirrored rather than shared, deliberately.** The subject differs (a document versus a
 * jurisdiction), the blocking effect differs (one document type versus all client action in a
 * state), and sharing would couple state activation to template publishing. Two similar things are
 * not yet a pattern; the trigger to extract is a third reviewable artifact type.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export type ContractKind =
  | 'service_agreement'
  | 'fee_exhibit'
  | 'application_authorization'
  | 'bureau_pull_authorization'
  | 'plaid_connection_authorization'
  | 'refund_policy'
  | 'partner_disclosure'
  | 'product_disclosure';

export const CONTRACT_KINDS = [
  'service_agreement',
  'fee_exhibit',
  'application_authorization',
  'bureau_pull_authorization',
  'plaid_connection_authorization',
  'refund_policy',
  'partner_disclosure',
  'product_disclosure',
] as const satisfies readonly ContractKind[];

export type TemplateChangeKind = 'material' | 'editorial';

/** Sentinel for a clause that applies in every jurisdiction. */
export const ALL_JURISDICTIONS = '*';

export interface TemplateSection {
  readonly heading: string;
  readonly body: string;
  /**
   * Where a clause or disclosure is spliced in. A section names the keys it expects rather than
   * carrying their text, so the wording lives in exactly one place.
   */
  readonly insertClauseKeys?: readonly string[];
  readonly insertDisclosures?: boolean;
}

export interface ContractTemplateRecord {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly kind: ContractKind;
  readonly title: string;
  readonly sections: readonly TemplateSection[];
  readonly changeKind: TemplateChangeKind;
  readonly changeRationale: string | null;
  readonly supersededAt: string | null;
  readonly createdBy: string;
}

interface TemplateRow {
  id: string;
  key: string;
  version: number;
  kind: string;
  title: string;
  sections: unknown;
  changeKind: string;
  changeRationale: string | null;
  supersededAt: Date | null;
  createdBy: string;
}

const toTemplate = (row: TemplateRow): ContractTemplateRecord => ({
  id: row.id,
  key: row.key,
  version: row.version,
  kind: row.kind as ContractKind,
  title: row.title,
  sections: (row.sections ?? []) as readonly TemplateSection[],
  changeKind: row.changeKind as TemplateChangeKind,
  changeRationale: row.changeRationale,
  supersededAt: row.supersededAt?.toISOString() ?? null,
  createdBy: row.createdBy,
});

export interface PublishTemplateInput {
  readonly tenantId: string;
  readonly key: string;
  readonly kind: ContractKind;
  readonly title: string;
  readonly sections: readonly TemplateSection[];
  /** Required, for the reason set out in 7.2: a default is inherited silently forever after. */
  readonly changeKind: TemplateChangeKind;
  readonly changeRationale?: string;
  readonly publishedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

export const publishTemplate = async (
  input: PublishTemplateInput,
): Promise<Outcome<ContractTemplateRecord>> => {
  if (input.sections.length === 0) {
    return refused(
      `Template '${input.key}' was published with no sections.`,
      'Blueprint 7.3 - an empty contract template cannot be reviewed or generated from',
    );
  }
  if (input.changeKind === 'editorial' && (input.changeRationale ?? '').trim() === '') {
    return refused(
      `An editorial change to template '${input.key}' needs a rationale. Declaring a change non-material suppresses a counsel review of language a client will sign.`,
      'Specification versioning - counsel review required for material changes',
    );
  }

  const current = await db().contractTemplate.findFirst({
    where: { tenantId: input.tenantId, key: input.key, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });

  if (current === null && input.changeKind === 'editorial') {
    return refused(
      `The first version of template '${input.key}' cannot be editorial - there is no prior version for it to be editorially different from.`,
      'Specification versioning - the claim would let a whole template skip its first review',
    );
  }

  const now = input.now ?? new Date();
  const version = (current?.version ?? 0) + 1;

  const row = await db().$transaction(async (tx) => {
    if (current) {
      await tx.contractTemplate.update({ where: { id: current.id }, data: { supersededAt: now } });
    }
    return tx.contractTemplate.create({
      data: {
        tenantId: input.tenantId,
        key: input.key,
        version,
        kind: input.kind as never,
        title: input.title,
        sections: input.sections as never,
        changeKind: input.changeKind as never,
        changeRationale: input.changeRationale ?? null,
        createdBy: input.publishedBy,
      },
    });
  });

  await append({
    tenantId: input.tenantId,
    type: 'contract.template.published',
    actor: input.actor,
    payload: {
      templateKey: input.key,
      version,
      kind: input.kind,
      changeKind: input.changeKind,
      publishedBy: input.publishedBy,
    },
  });

  return ok(toTemplate(row));
};

export const currentTemplate = async (
  tenantId: string,
  key: string,
): Promise<Outcome<ContractTemplateRecord>> => {
  const row = await db().contractTemplate.findFirst({
    where: { tenantId, key, supersededAt: null },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
  });
  return row ? ok(toTemplate(row)) : noData(`No contract template published under '${key}'.`);
};

/**
 * Record counsel's review of a template version.
 *
 * Level 3 human only, and the level is read from the recorded actor rather than the `EventActor`
 * the caller supplied - the same reasoning as state activation. This is the language a client
 * signs; an agent able to approve it would make the review a formality.
 */
export const reviewTemplate = async (input: {
  tenantId: string;
  templateKey: string;
  templateVersion: number;
  actor: EventActor;
  reviewedBy: string;
  reviewedAt: Date;
  documentReference: string;
  notes?: string;
}): Promise<Outcome<{ templateKey: string; templateVersion: number }>> => {
  if (input.documentReference.trim() === '' || input.reviewedBy.trim() === '') {
    return refused(
      'A template review requires the reviewing counsel and a document reference.',
      'Specification versioning - counsel review is documented, not asserted',
    );
  }

  const actor = await findActor(input.actor.id);
  if (actor === null || actor.kind !== 'human' || actor.authorityLevel < 3) {
    return refused(
      `Reviewing contract language requires a human at Authority Level 3. This is the text a client signs; an agent able to approve it would make the review a formality.`,
      'Design principle 4 with specification versioning',
    );
  }

  const template = await db().contractTemplate.findFirst({
    where: {
      tenantId: input.tenantId,
      key: input.templateKey,
      version: input.templateVersion,
    },
  });
  if (!template) {
    return noData(`No version ${input.templateVersion} of template '${input.templateKey}'.`);
  }

  await db().templateReview.upsert({
    where: {
      tenantId_templateKey_templateVersion: {
        tenantId: input.tenantId,
        templateKey: input.templateKey,
        templateVersion: input.templateVersion,
      },
    },
    create: {
      tenantId: input.tenantId,
      templateKey: input.templateKey,
      templateVersion: input.templateVersion,
      reviewedBy: input.reviewedBy,
      reviewedAt: input.reviewedAt,
      documentReference: input.documentReference,
      notes: input.notes ?? null,
    },
    update: {
      reviewedBy: input.reviewedBy,
      reviewedAt: input.reviewedAt,
      documentReference: input.documentReference,
      notes: input.notes ?? null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'contract.template.reviewed',
    actor: input.actor,
    payload: {
      templateKey: input.templateKey,
      version: input.templateVersion,
      reviewedBy: input.reviewedBy,
      documentReference: input.documentReference,
    },
  });

  return ok({ templateKey: input.templateKey, templateVersion: input.templateVersion });
};

/**
 * Whether a template version may generate.
 *
 * Derived: a review exists for this exact version, or the version is editorially descended from a
 * reviewed one. Same rule as a state module - an editorial change carries the review forward, a
 * material one does not, and an editorial patch on top of an unreviewed material change cannot
 * launder it.
 */
export const templateIsGenerable = async (
  tenantId: string,
  key: string,
  version: number,
): Promise<{ generable: boolean; reason: string; reviewedVersion: number | null }> => {
  const reviews = await db().templateReview.findMany({
    where: { tenantId, templateKey: key, templateVersion: { lte: version } },
    orderBy: [{ templateVersion: 'desc' }, { id: 'asc' }],
  });

  const latestReview = reviews[0];
  if (!latestReview) {
    return {
      generable: false,
      reason: `Template '${key}' version ${version} has never been reviewed by counsel, so it cannot generate a document a client would sign.`,
      reviewedVersion: null,
    };
  }

  if (latestReview.templateVersion === version) {
    return {
      generable: true,
      reason: `Reviewed at version ${version} by ${latestReview.reviewedBy}.`,
      reviewedVersion: version,
    };
  }

  const materialSince = await db().contractTemplate.findFirst({
    where: {
      tenantId,
      key,
      version: { gt: latestReview.templateVersion, lte: version },
      changeKind: 'material',
    },
    orderBy: [{ version: 'asc' }, { id: 'asc' }],
  });

  return materialSince
    ? {
        generable: false,
        reason: `Template '${key}' was reviewed at version ${latestReview.templateVersion}; version ${materialSince.version} made a material change that counsel has not seen.`,
        reviewedVersion: latestReview.templateVersion,
      }
    : {
        generable: true,
        reason: `Reviewed at version ${latestReview.templateVersion}; every version since has been editorial.`,
        reviewedVersion: latestReview.templateVersion,
      };
};
