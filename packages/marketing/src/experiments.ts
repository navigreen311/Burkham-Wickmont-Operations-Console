/**
 * A/B experiments - blueprint 4.5's "A/B test configurations within compliance constraints".
 *
 * The constraint is the module, and it is worth being precise about what it rules out.
 *
 * An A/B test optimises for a metric. If one variant may contain language the Marketing Claim
 * Library bans and the other may not, then the test is measuring whether non-compliant language
 * converts better - and it will usually find that it does, because "guaranteed approval" converts
 * extremely well. Running that test produces a number that argues for saying it.
 *
 * So **every variant must scan clean before the experiment runs**, and a variant that does not is
 * REJECTED rather than registered as the arm we expect to lose. There is no compliant way to hold
 * a losing arm that says something we may not say: while the test runs, real clients read it.
 * See ADR-0016.
 *
 * The scan verdict is stored with the variant, at the time. A later Library change does not
 * rewrite what was true when the variant was admitted - `staleVariants` reports the divergence
 * instead, which is 7.3's staleness argument applied to live copy.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { scanForTenant } from '@bwc/scanner';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';

export interface Variant {
  readonly key: string;
  readonly body: string;
  readonly scanVerdict: string;
  readonly requiredDisclosures: readonly string[];
  readonly scannedAt: string;
}

export interface ExperimentRecord {
  readonly id: string;
  readonly key: string;
  readonly hypothesis: string;
  readonly variants: readonly Variant[];
  readonly startedAt: string | null;
  readonly winningVariantKey: string | null;
}

export const createExperiment = async (input: {
  tenantId: string;
  campaignId: string;
  key: string;
  hypothesis: string;
  createdBy: string;
  actor: EventActor;
}): Promise<Outcome<ExperimentRecord>> => {
  if (input.hypothesis.trim().length < 15) {
    return refused(
      'An experiment needs a hypothesis. Without one the result is whichever variant happened to win, and there is nothing to have been wrong about.',
      'Blueprint 4.5 - A/B test configurations',
    );
  }

  const row = await db().experiment.create({
    data: {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      key: input.key,
      hypothesis: input.hypothesis,
      createdBy: input.createdBy,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.experiment.created',
    actor: input.actor,
    payload: { experimentId: row.id, key: input.key, campaignId: input.campaignId },
  });

  return ok({
    id: row.id,
    key: row.key,
    hypothesis: row.hypothesis,
    variants: [],
    startedAt: null,
    winningVariantKey: null,
  });
};

/**
 * Register a variant, scanning it first.
 *
 * A `blocked` verdict refuses. A `requires_disclosure` verdict refuses unless the disclosure is in
 * the variant body - the same stricter rule 8.1 applies to partner material, and for the same
 * reason: nobody attaches a disclosure to an ad afterwards.
 *
 * The scan happens here rather than at experiment start, so a variant that cannot run is refused
 * to the person writing it, while they are writing it.
 */
export const registerVariant = async (input: {
  tenantId: string;
  experimentId: string;
  key: string;
  body: string;
  jurisdiction?: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<Variant>> => {
  const now = input.now ?? new Date();

  const experiment = await db().experiment.findFirst({
    where: { tenantId: input.tenantId, id: input.experimentId },
  });
  if (!experiment) return noData(`No experiment ${input.experimentId} is on record.`);
  if (experiment.startedAt !== null) {
    return refused(
      'This experiment has already started. Adding a variant mid-flight changes what the result means, and the arm that ran for half the window is not comparable with the one that ran for all of it.',
      'Blueprint 4.5 - A/B test configurations',
    );
  }

  const scan = await scanForTenant({
    tenantId: input.tenantId,
    text: input.body,
    actor: input.actor,
    context: `A/B variant ${input.key} of experiment ${experiment.key}`,
    ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
  });
  if (scan.status !== 'ok') return scan as Outcome<never>;

  if (scan.value.verdict === 'blocked') {
    return refused(
      `Variant '${input.key}' contains language the Marketing Claim Library bans: ${scan.value.findings
        .map((finding) => `'${finding.phrase}'`)
        .join(
          ', ',
        )}. It cannot be registered as a losing arm either - while the test runs, real clients read it.`,
      'Blueprint 4.5 - A/B testing constrained by the Marketing Claim Library',
    );
  }

  const missing = scan.value.requiredDisclosures.filter(
    (disclosure) => !input.body.includes(disclosure),
  );
  if (missing.length > 0) {
    return refused(
      `Variant '${input.key}' uses language requiring disclosure, and the disclosure is not in the variant: ${missing.join(' | ')}. Nobody attaches a disclosure to an advertisement afterwards.`,
      'Blueprint 7.4 with 4.5 - a required disclosure travels with the claim',
    );
  }

  const row = await db().experimentVariant.upsert({
    where: {
      experimentId_key: { experimentId: input.experimentId, key: input.key },
    },
    create: {
      tenantId: input.tenantId,
      experimentId: input.experimentId,
      key: input.key,
      body: input.body,
      scannedAt: now,
      scanVerdict: scan.value.verdict,
      requiredDisclosures: [...scan.value.requiredDisclosures],
    },
    update: {
      body: input.body,
      scannedAt: now,
      scanVerdict: scan.value.verdict,
      requiredDisclosures: [...scan.value.requiredDisclosures],
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.variant.registered',
    actor: input.actor,
    payload: {
      experimentId: input.experimentId,
      variantKey: input.key,
      verdict: scan.value.verdict,
      libraryEntriesChecked: scan.value.libraryEntriesChecked,
    },
  });

  return ok({
    key: row.key,
    body: row.body,
    scanVerdict: row.scanVerdict,
    requiredDisclosures: row.requiredDisclosures,
    scannedAt: row.scannedAt.toISOString(),
  });
};

/**
 * Start the experiment.
 *
 * Refuses below two variants - a one-armed A/B test is a piece of copy with a hypothesis attached,
 * and calling it a test means somebody will later report its conversion rate as a result.
 */
export const startExperiment = async (input: {
  tenantId: string;
  experimentId: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ experimentId: string; variants: number }>> => {
  const now = input.now ?? new Date();

  const experiment = await db().experiment.findFirst({
    where: { tenantId: input.tenantId, id: input.experimentId },
    include: { variants: true },
  });
  if (!experiment) return noData(`No experiment ${input.experimentId} is on record.`);
  if (experiment.variants.length < 2) {
    return refused(
      `Experiment '${experiment.key}' has ${experiment.variants.length} variant(s). A one-armed test is a piece of copy with a hypothesis attached, and its conversion rate will be reported as a result.`,
      'Blueprint 4.5 - A/B test configurations',
    );
  }

  await db().experiment.update({
    where: { id: experiment.id },
    data: { startedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.experiment.started',
    actor: input.actor,
    payload: { experimentId: experiment.id, variants: experiment.variants.length },
  });

  return ok({ experimentId: experiment.id, variants: experiment.variants.length });
};

/**
 * Variants whose admitting scan no longer reflects the Library.
 *
 * 7.3's staleness argument applied to live copy: nothing rewrites a variant when the Library
 * changes, because a running experiment's arms should not mutate underneath it. What this does is
 * report which arms would no longer be admitted, so somebody can stop the test rather than
 * discover it in a review.
 *
 * Derived at read time. A stored flag would need a job, and a job that stops leaves every variant
 * reading as currently compliant.
 */
export const staleVariants = async (
  tenantId: string,
  experimentId: string,
  actor: EventActor,
  jurisdiction?: string,
): Promise<Outcome<readonly { key: string; wasVerdict: string; nowVerdict: string }[]>> => {
  const variants = await db().experimentVariant.findMany({
    where: { tenantId, experimentId },
  });
  if (variants.length === 0) return noData('This experiment has no variants.');

  const stale: { key: string; wasVerdict: string; nowVerdict: string }[] = [];

  for (const variant of variants) {
    const scan = await scanForTenant({
      tenantId,
      text: variant.body,
      actor,
      context: `staleness re-scan of variant ${variant.key}`,
      ...(jurisdiction !== undefined ? { jurisdiction } : {}),
    });
    if (scan.status !== 'ok') return scan as Outcome<never>;
    if (scan.value.verdict !== variant.scanVerdict) {
      stale.push({
        key: variant.key,
        wasVerdict: variant.scanVerdict,
        nowVerdict: scan.value.verdict,
      });
    }
  }

  return ok(stale);
};

/**
 * Declare a winner.
 *
 * Records which arm won. It deliberately does NOT adopt the copy anywhere - adopting a winning
 * variant into a campaign or the Library is a separate decision, made by a person, and one that
 * goes through `proposeClaim` if it introduces wording the Library does not have.
 *
 * A conversion number is a reason to consider a claim. It is not a review of it.
 */
export const declareWinner = async (input: {
  tenantId: string;
  experimentId: string;
  variantKey: string;
  basis: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<{ experimentId: string; winningVariantKey: string }>> => {
  const now = input.now ?? new Date();

  const variant = await db().experimentVariant.findFirst({
    where: { tenantId: input.tenantId, experimentId: input.experimentId, key: input.variantKey },
  });
  if (!variant) {
    return noData(`Variant '${input.variantKey}' is not part of this experiment.`);
  }
  if (input.basis.trim().length < 15) {
    return refused(
      'Declaring a winner needs the basis - what was measured, over what period. Without it "this one won" is a preference with a timestamp.',
      'Blueprint 4.5 - A/B test configurations',
    );
  }

  await db().experiment.update({
    where: { id: input.experimentId },
    data: { winningVariantKey: input.variantKey, endedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'marketing.experiment.concluded',
    actor: input.actor,
    payload: {
      experimentId: input.experimentId,
      winningVariantKey: input.variantKey,
      basis: input.basis,
    },
  });

  return ok({ experimentId: input.experimentId, winningVariantKey: input.variantKey });
};
