/**
 * Reading and changing configuration - blueprint 11.7's "audit trail on every change" and
 * "rollback capability".
 *
 * **There is no table of current values.** The effective value is the latest applied change, or
 * the compiled default when there has never been one. Deriving it means there is no second place a
 * value lives and no job keeping the two in step - the eighth time this codebase has made that
 * choice, and here it also gives the audit trail for free: the history IS the store.
 *
 * Rollback is not an undo. It writes a NEW change restoring the prior value, so the record shows
 * that somebody set it to 120 on Tuesday and put it back on Wednesday. An undo that removed the
 * Tuesday row would answer "what is it now" and lose "what happened".
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { PARAMETERS, checkBounds, invariantFor, parameterFor, type Parameter } from './registry.js';

/** Changing a parameter is a Level 3 human decision. */
export const CHANGE_AUTHORITY_LEVEL = 3;

export interface EffectiveValue {
  readonly key: string;
  readonly value: number;
  /** `compiled_default` when nothing has ever been set, `configured` otherwise. */
  readonly source: 'compiled_default' | 'configured';
  readonly changedAt: string | null;
  readonly changedBy: string | null;
  readonly reason: string | null;
}

/**
 * The value in force.
 *
 * Falls back to the compiled default rather than failing, and SAYS which it is. A caller that
 * could not tell the difference would have no way to know whether a tenant had ever considered
 * the setting.
 */
export const effectiveValue = async (
  tenantId: string,
  key: string,
): Promise<Outcome<EffectiveValue>> => {
  const parameter = parameterFor(key);
  if (!parameter) {
    const invariant = invariantFor(key);
    if (invariant) {
      return refused(
        `'${key}' is not configurable. ${invariant.whyFixed}`,
        'Blueprint 11.7 with ADR-0019 - an admin surface must not be able to turn a control off',
      );
    }
    return noData(
      `'${key}' is not a registered parameter. Configuration is limited to the registry, so a typo cannot create a setting nothing reads.`,
    );
  }

  const latest = await db().configurationChange.findFirst({
    where: { tenantId, key, appliedAt: { not: null } },
    // Tie-broken by `createdAt`, which is the DATABASE's insertion clock and therefore monotonic.
    // `appliedAt` can legitimately collide - a rollback recorded at the same logical instant as the
    // change it undoes is the ordinary case, not a contrived one - and with a single sort key the
    // winner is whichever row Postgres happens to return. That is how this surfaced: the same test
    // passed in CI and failed locally, on the same code.
    orderBy: [{ appliedAt: 'desc' }, { createdAt: 'desc' }],
  });

  if (!latest) {
    return ok({
      key,
      value: parameter.compiledDefault,
      source: 'compiled_default',
      changedAt: null,
      changedBy: null,
      reason: null,
    });
  }

  return ok({
    key,
    value: latest.newValue,
    source: 'configured',
    changedAt: latest.appliedAt?.toISOString() ?? null,
    changedBy: latest.changedBy,
    reason: latest.reason,
  });
};

/** Every parameter with its value in force. The screen blueprint 11.7 describes. */
export const allEffectiveValues = async (
  tenantId: string,
): Promise<readonly (EffectiveValue & { parameter: Parameter })[]> => {
  const values = await Promise.all(
    PARAMETERS.map(async (parameter) => {
      const value = await effectiveValue(tenantId, parameter.key);
      return value.status === 'ok' ? { ...value.value, parameter } : null;
    }),
  );
  return values.filter(
    (entry): entry is EffectiveValue & { parameter: Parameter } => entry !== null,
  );
};

export interface ConfigurationChange {
  readonly id: string;
  readonly key: string;
  readonly previousValue: number;
  readonly newValue: number;
  readonly reason: string;
  readonly changedBy: string;
  readonly staged: boolean;
  readonly appliedAt: string | null;
}

interface ChangeRow {
  id: string;
  key: string;
  previousValue: number;
  newValue: number;
  reason: string;
  changedBy: string;
  staged: boolean;
  appliedAt: Date | null;
}

const toChange = (row: ChangeRow): ConfigurationChange => ({
  id: row.id,
  key: row.key,
  previousValue: row.previousValue,
  newValue: row.newValue,
  reason: row.reason,
  changedBy: row.changedBy,
  staged: row.staged,
  appliedAt: row.appliedAt?.toISOString() ?? null,
});

export interface SetInput {
  readonly tenantId: string;
  readonly key: string;
  readonly value: number;
  /** Required. A parameter change with no reason is indistinguishable from a mistake. */
  readonly reason: string;
  readonly changedBy: string;
  readonly actor: EventActor;
  readonly now?: Date;
}

/**
 * Change a parameter.
 *
 * Four checks, in this order, and the order is the design:
 *
 *   1. is this a parameter at all - an invariant refuses HERE, with its reasoning, rather than
 *      after an authority check that would imply a sufficient level exists
 *   2. is the reason readable
 *   3. is the value in bounds
 *   4. is the actor a Level 3 human
 *
 * A high-risk parameter is STAGED rather than applied: the change is recorded, and takes effect
 * only when promoted. Blueprint 11.7 asks for "staged rollout for high-risk changes", and high
 * risk here means a change that alters what the system does to CLIENTS rather than to internal
 * queues.
 */
export const setParameter = async (input: SetInput): Promise<Outcome<ConfigurationChange>> => {
  const now = input.now ?? new Date();

  const parameter = parameterFor(input.key);
  if (!parameter) {
    const invariant = invariantFor(input.key);
    return refused(
      invariant
        ? `'${input.key}' cannot be changed. ${invariant.whyFixed}`
        : `'${input.key}' is not a registered parameter. Configuration is limited to the registry, so a mistyped key cannot create a setting nothing reads.`,
      'Blueprint 11.7 with ADR-0019 - an admin surface must not be able to turn a control off',
    );
  }

  if (input.reason.trim().length < 10) {
    return refused(
      `Changing '${input.key}' needs a reason somebody can read back. A parameter change with no reason is indistinguishable from a mistake, and the person who finds it six months later has to guess.`,
      'Blueprint 11.7 - audit trail on every change',
    );
  }

  const bounds = checkBounds(parameter, input.value);
  if (!bounds.withinBounds) {
    return refused(bounds.detail, 'Blueprint 11.7 - per-domain configuration with safe ranges');
  }

  const actor = await findActor(input.changedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < CHANGE_AUTHORITY_LEVEL) {
    return refused(
      `Changing a configuration parameter requires a human at Authority Level ${CHANGE_AUTHORITY_LEVEL}. It changes how the system behaves for every client in the tenant.`,
      'Blueprint 2.1 with 11.7 - founder / senior operators',
    );
  }

  const current = await effectiveValue(input.tenantId, input.key);
  if (current.status !== 'ok') return current as Outcome<never>;

  if (current.value.value === input.value) {
    return refused(
      `'${input.key}' is already ${input.value}. Recording a change that changes nothing would put noise in the audit trail the trail exists to keep readable.`,
      'Blueprint 11.7 - audit trail on every change',
    );
  }

  const row = await db().configurationChange.create({
    data: {
      tenantId: input.tenantId,
      key: input.key,
      previousValue: current.value.value,
      newValue: input.value,
      reason: input.reason,
      changedBy: input.changedBy,
      staged: parameter.highRisk,
      // A high-risk change is recorded but not applied. `appliedAt` null is what makes it staged
      // in effect rather than only in name - `effectiveValue` reads applied changes only.
      appliedAt: parameter.highRisk ? null : now,
      // `createdAt` is deliberately NOT set from the caller's `now`. It is the audit record's own
      // insertion time, and a caller-supplied value would let a change be back-dated in the trail
      // that exists to say when it happened. It is also what breaks the tie above.
    },
  });

  await append({
    tenantId: input.tenantId,
    type: parameter.highRisk ? 'admin.configuration.staged' : 'admin.configuration.changed',
    actor: input.actor,
    payload: {
      changeId: row.id,
      key: input.key,
      previousValue: current.value.value,
      newValue: input.value,
      staged: parameter.highRisk,
      changedBy: input.changedBy,
    },
  });

  return ok(toChange(row));
};

/**
 * Promote a staged change into effect.
 *
 * A second Level 3 human is NOT required, and that is worth stating rather than leaving as an
 * omission. Staging exists so a high-risk change is deliberate and visible before it bites, not to
 * introduce four-eyes approval - which this codebase does elsewhere, by name, where it belongs
 * (Do Not Fund overrides, conflict disclosures). Adding it implicitly here would make the two
 * mechanisms harder to tell apart.
 */
export const promoteStagedChange = async (input: {
  tenantId: string;
  changeId: string;
  promotedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ConfigurationChange>> => {
  const now = input.now ?? new Date();

  const row = await db().configurationChange.findFirst({
    where: { tenantId: input.tenantId, id: input.changeId },
  });
  if (!row) return noData(`No configuration change ${input.changeId} is on record.`);
  if (row.appliedAt !== null) {
    return refused(
      'This change is already in effect.',
      'Blueprint 11.7 - staged rollout for high-risk changes',
    );
  }

  const actor = await findActor(input.promotedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < CHANGE_AUTHORITY_LEVEL) {
    return refused(
      `Promoting a staged change requires a human at Authority Level ${CHANGE_AUTHORITY_LEVEL}.`,
      'Blueprint 2.1 with 11.7',
    );
  }

  const updated = await db().configurationChange.update({
    where: { id: row.id },
    data: { appliedAt: now, promotedBy: input.promotedBy },
  });

  await append({
    tenantId: input.tenantId,
    type: 'admin.configuration.changed',
    actor: input.actor,
    payload: {
      changeId: row.id,
      key: row.key,
      previousValue: row.previousValue,
      newValue: row.newValue,
      promotedFromStaged: true,
      promotedBy: input.promotedBy,
    },
  });

  return ok(toChange(updated));
};

/**
 * Roll a parameter back to the value before a given change.
 *
 * Writes a NEW change rather than deleting the old one. The record then shows that somebody set it
 * to 120 on Tuesday and put it back on Wednesday - an undo that removed the Tuesday row would
 * answer "what is it now" and lose "what happened", which is the question an audit asks.
 */
export const rollback = async (input: {
  tenantId: string;
  changeId: string;
  reason: string;
  rolledBackBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<ConfigurationChange>> => {
  const row = await db().configurationChange.findFirst({
    where: { tenantId: input.tenantId, id: input.changeId },
  });
  if (!row) return noData(`No configuration change ${input.changeId} is on record.`);

  return setParameter({
    tenantId: input.tenantId,
    key: row.key,
    value: row.previousValue,
    reason: `Rollback of change ${row.id}: ${input.reason}`,
    changedBy: input.rolledBackBy,
    actor: input.actor,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
};

/** The change history for one key, or the whole tenant. Blueprint 11.7's audit trail. */
export const changeHistory = async (
  tenantId: string,
  key?: string,
): Promise<readonly ConfigurationChange[]> => {
  const rows = await db().configurationChange.findMany({
    where: { tenantId, ...(key !== undefined ? { key } : {}) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toChange);
};

/** Changes recorded and not yet in effect. */
export const stagedChanges = async (tenantId: string): Promise<readonly ConfigurationChange[]> => {
  const rows = await db().configurationChange.findMany({
    where: { tenantId, appliedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toChange);
};
