/**
 * The state activation gate - specification §11.2.
 *
 * > "No state comes online without documented counsel review of the state's Regulatory Engine
 * > module."
 *
 * This file is the module. Everything else in the package is a lookup table, and the gate is what
 * makes the table trustworthy.
 *
 * Three properties, each structural rather than procedural:
 *
 * **A state with no activation row is not active.** Absence resolves to the safe answer, the same
 * default ADR-0007 established for governance standing. There is no "pending" value somebody can
 * edit into "active".
 *
 * **Only a Level 3 human can activate.** Not by policy but by refusal: `activateState` rejects any
 * actor that is not a human at the top authority level. An agent that could activate a state would
 * make the gate decorative, and the whole point of the gate is that it is not.
 *
 * **Activation is derived, not stored.** The row records which module version counsel reviewed;
 * whether the state is active *now* comes from comparing that against the current version. A
 * stored flag and a newer module version drift apart, and the stored one is the one that would
 * silently be wrong.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { currentModule } from './states.js';

export type ActivationStatus =
  'no_module' | 'draft' | 'needs_counsel_review' | 'active' | 'withdrawn';

export interface StateStanding {
  readonly state: string;
  readonly status: ActivationStatus;
  /** True only for `active`. The single question every caller actually asks. */
  readonly permitsClientFacingAction: boolean;
  /** The module version in force. */
  readonly currentVersion: number | null;
  /** The version counsel reviewed, when one has been. */
  readonly reviewedVersion: number | null;
  /** One sentence naming the state, its status, and what would change it. */
  readonly explanation: string;
}

/**
 * Derive a state's standing.
 *
 * The `needs_counsel_review` case is the interesting one: the state was activated, and the module
 * has since been materially republished, so what counsel reviewed is not what the engine would now
 * apply. Reporting that as `active` would be the most dangerous answer this module could give -
 * it asserts a review of rules nobody has read.
 */
export const standingFor = async (tenantId: string, state: string): Promise<StateStanding> => {
  const module = await currentModule(tenantId, state);

  if (module.status !== 'ok') {
    return {
      state,
      status: 'no_module',
      permitsClientFacingAction: false,
      currentVersion: null,
      reviewedVersion: null,
      explanation: `No regulatory module exists for ${state}. Publish one and have counsel review it before serving clients there.`,
    };
  }

  const activation = await db().stateActivation.findFirst({ where: { tenantId, state } });

  if (!activation) {
    return {
      state,
      status: 'draft',
      permitsClientFacingAction: false,
      currentVersion: module.value.version,
      reviewedVersion: null,
      explanation: `${state} has a module at version ${module.value.version} but has never been activated. Specification 11.2 requires documented counsel review before the state comes online.`,
    };
  }

  if (activation.withdrawnAt !== null) {
    return {
      state,
      status: 'withdrawn',
      permitsClientFacingAction: false,
      currentVersion: module.value.version,
      reviewedVersion: activation.activatedModuleVersion,
      explanation: `${state} was withdrawn on ${activation.withdrawnAt.toISOString().slice(0, 10)}: ${activation.withdrawnReason ?? 'no reason recorded'}.`,
    };
  }

  // Only a MATERIAL change since the reviewed version sends the state back. The specification
  // requires "counsel review for material changes", so an editorial one - a corrected section
  // number, a reworded summary - must carry the activation forward.
  //
  // Comparing version numbers alone was the first implementation, and it deactivated on every
  // republish. That is stricter and it is still wrong: it makes `changeKind` decorative, and a
  // rule that punishes a typo fix the same as a rewrite teaches people to batch their typo fixes
  // into rewrites. Caught by a test whose name said "leaves activation intact" while its
  // assertion agreed with the code.
  const materialSince = await db().stateModule.findFirst({
    where: {
      tenantId,
      state,
      version: { gt: activation.activatedModuleVersion },
      changeKind: 'material',
    },
    orderBy: { version: 'asc' },
  });

  if (materialSince) {
    return {
      state,
      status: 'needs_counsel_review',
      permitsClientFacingAction: false,
      currentVersion: module.value.version,
      reviewedVersion: activation.activatedModuleVersion,
      explanation: `${state} was activated against module version ${activation.activatedModuleVersion} and version ${materialSince.version} made a material change. Counsel must review before the state comes back online.`,
    };
  }

  return {
    state,
    status: 'active',
    permitsClientFacingAction: true,
    currentVersion: module.value.version,
    reviewedVersion: activation.activatedModuleVersion,
    explanation: `${state} is active against module version ${activation.activatedModuleVersion}, reviewed by ${activation.activatedBy}.`,
  };
};

export interface ActivateInput {
  readonly tenantId: string;
  readonly state: string;
  /** Must be a human actor at Level 3. Checked, not trusted. */
  readonly actor: EventActor;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
  /** Where the review lives. Required - a review nobody can produce did not happen. */
  readonly documentReference: string;
  readonly notes?: string;
  readonly now?: Date;
}

/**
 * Activate a state, recording the counsel review that permits it.
 *
 * The authority check reads the actor from the database rather than trusting the `EventActor`
 * handed in: the caller supplies that value, and a gate that believes its caller about whether the
 * caller is allowed through is not a gate.
 */
export const activateState = async (input: ActivateInput): Promise<Outcome<StateStanding>> => {
  if (input.documentReference.trim() === '') {
    return refused(
      `Activating ${input.state} requires a document reference for the counsel review. A review nobody can produce is indistinguishable from one that never happened.`,
      'Specification 11.2 - documented counsel review',
    );
  }
  if (input.reviewedBy.trim() === '') {
    return refused(
      `Activating ${input.state} requires the name of the reviewing counsel.`,
      'Specification 11.2 - documented counsel review',
    );
  }

  const actor = await findActor(input.actor.id);
  if (actor === null) {
    return refused(
      'The actor attempting to activate this state could not be identified.',
      'Design principle 4 - Authority Levels are enforced against the recorded actor',
    );
  }

  if (actor.kind !== 'human' || actor.authorityLevel < 3) {
    return refused(
      `${actor.label} cannot activate ${input.state}. Bringing a state online requires a human at Authority Level 3; an agent able to do it would make the counsel-review gate decorative.`,
      'Specification 11.2 with design principle 4 - state activation is a human decision',
    );
  }

  const module = await currentModule(input.tenantId, input.state);
  if (module.status !== 'ok') {
    return refused(
      `No regulatory module exists for ${input.state}, so there is nothing for counsel to have reviewed.`,
      'Specification 11.2 - the review is of a specific module version',
    );
  }

  const now = input.now ?? new Date();

  const review = await db().counselReview.create({
    data: {
      tenantId: input.tenantId,
      state: input.state,
      moduleVersion: module.value.version,
      reviewedBy: input.reviewedBy,
      reviewedAt: input.reviewedAt,
      documentReference: input.documentReference,
      notes: input.notes ?? null,
    },
  });

  await db().stateActivation.upsert({
    where: { tenantId_state: { tenantId: input.tenantId, state: input.state } },
    create: {
      tenantId: input.tenantId,
      state: input.state,
      activatedModuleVersion: module.value.version,
      activatedBy: actor.label,
      activatedAt: now,
      counselReviewId: review.id,
    },
    update: {
      activatedModuleVersion: module.value.version,
      activatedBy: actor.label,
      activatedAt: now,
      counselReviewId: review.id,
      // Re-activating clears a withdrawal. The withdrawal itself stays in the Ledger.
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawnReason: null,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'regulatory.state.activated',
    actor: input.actor,
    payload: {
      state: input.state,
      moduleVersion: module.value.version,
      reviewedBy: input.reviewedBy,
      documentReference: input.documentReference,
      activatedBy: actor.label,
    },
  });

  return ok(await standingFor(input.tenantId, input.state));
};

/**
 * Withdraw a state.
 *
 * Deliberately available to the same authority as activation and no lower. Taking a state offline
 * is the safe direction, but it stops client work, and a decision that stops client work should be
 * made by someone who can answer for it.
 */
export const withdrawState = async (input: {
  tenantId: string;
  state: string;
  actor: EventActor;
  reason: string;
  now?: Date;
}): Promise<Outcome<StateStanding>> => {
  if (input.reason.trim() === '') {
    return refused(
      `Withdrawing ${input.state} requires a reason.`,
      'Blueprint 7.2 - a state taken offline without a stated reason cannot be brought back with confidence',
    );
  }

  const actor = await findActor(input.actor.id);
  if (actor === null || actor.kind !== 'human' || actor.authorityLevel < 3) {
    return refused(
      `Withdrawing ${input.state} requires a human at Authority Level 3.`,
      'Design principle 4 - Authority Levels',
    );
  }

  const existing = await db().stateActivation.findFirst({
    where: { tenantId: input.tenantId, state: input.state },
  });
  if (!existing)
    return noData(`${input.state} has never been activated, so there is nothing to withdraw.`);

  await db().stateActivation.update({
    where: { id: existing.id },
    data: {
      withdrawnAt: input.now ?? new Date(),
      withdrawnBy: actor.label,
      withdrawnReason: input.reason,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'regulatory.state.withdrawn',
    actor: input.actor,
    payload: { state: input.state, reason: input.reason, withdrawnBy: actor.label },
  });

  return ok(await standingFor(input.tenantId, input.state));
};

/** Every state with a module, and where each stands. The operator's coverage map. */
export const coverage = async (tenantId: string): Promise<readonly StateStanding[]> => {
  const rows = await db().stateModule.findMany({
    where: { tenantId, supersededAt: null },
    select: { state: true },
    orderBy: { state: 'asc' },
  });

  return Promise.all(rows.map((row) => standingFor(tenantId, row.state)));
};

/** The states a client may currently be served in. */
export const activeStates = async (tenantId: string): Promise<readonly string[]> =>
  (await coverage(tenantId))
    .filter((standing) => standing.permitsClientFacingAction)
    .map((standing) => standing.state);
