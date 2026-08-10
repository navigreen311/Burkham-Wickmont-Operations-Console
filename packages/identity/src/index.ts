/**
 * @bwc/identity - 11.1 Identity & Access.
 *
 * Actors (Village agents and humans), their tenant, and their Authority Level.
 *
 * Design principle 4: Authority Levels are enforced by middleware. This package answers
 * "who is this and what level do they hold"; the middleware chain decides whether a given
 * action is within that level. Splitting it this way keeps the enforcement decision in one
 * place while letting any module ask who the actor is.
 */

import { db } from '@bwc/db';
import {
  ACTION_MINIMUM_LEVEL,
  isAuthorityLevel,
  isProhibitedAction,
  ok,
  refused,
  type AuthorityLevel,
  type Outcome,
} from '@bwc/core';

export interface Actor {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'village_agent' | 'human';
  readonly label: string;
  readonly authorityLevel: AuthorityLevel;
  readonly department: string | null;
}

export const findActor = async (id: string): Promise<Actor | null> => {
  const row = await db().actor.findUnique({ where: { id } });
  if (!row) return null;
  if (!isAuthorityLevel(row.authorityLevel)) {
    throw new Error(
      `Actor ${row.id} holds authorityLevel ${row.authorityLevel}, which is not 0-3. Level 4 is the prohibited-action list, not a level any actor may hold.`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    label: row.label,
    authorityLevel: row.authorityLevel,
    department: row.department,
  };
};

export interface CreateActorInput {
  readonly tenantId: string;
  readonly kind: 'village_agent' | 'human';
  readonly label: string;
  readonly authorityLevel: AuthorityLevel;
  readonly department?: string;
}

export const createActor = async (input: CreateActorInput): Promise<Actor> => {
  const row = await db().actor.create({
    data: {
      tenantId: input.tenantId,
      kind: input.kind,
      label: input.label,
      authorityLevel: input.authorityLevel,
      department: input.department ?? null,
    },
  });
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    label: row.label,
    authorityLevel: input.authorityLevel,
    department: row.department,
  };
};

export interface AuthorityDecision {
  readonly action: string;
  readonly prohibited: boolean;
  readonly requiredLevel: AuthorityLevel | null;
  readonly actorLevel: AuthorityLevel;
}

/**
 * Decide whether an actor may attempt an action.
 *
 * Three outcomes, in this order, and the order matters:
 *
 *  1. Prohibited (level 4) - refused for every actor at every level, with no approval path.
 *     Checked first so that a hypothetical level-9 actor could not slip past it.
 *  2. Unknown action - refused. An action absent from the catalogue has no declared level,
 *     and defaulting an unknown to "allowed" is how a new endpoint ships unguarded.
 *  3. Insufficient level - refused.
 *
 * Authority levels are ordinal (3 subsumes 0), unlike compliance state, so `>=` is correct
 * here and only here.
 */
export const decideAuthority = (
  actor: Pick<Actor, 'authorityLevel'>,
  action: string,
): Outcome<AuthorityDecision> => {
  if (isProhibitedAction(action)) {
    return refused(
      `Action '${action}' is Authority Level 4 - never allowed, by any actor, with any approval.`,
      'Principle 4 - Authority Levels enforced by middleware (Specification v2 section 7.1)',
    );
  }

  const required = (ACTION_MINIMUM_LEVEL as Record<string, AuthorityLevel>)[action];

  if (required === undefined) {
    return refused(
      `Action '${action}' is not in the permitted-action catalogue and has no declared Authority Level.`,
      'Principle 4 - an undeclared action is refused, never assumed permitted',
    );
  }

  if (actor.authorityLevel < required) {
    return refused(
      `Action '${action}' requires Authority Level ${required}; actor holds ${actor.authorityLevel}.`,
      'Principle 4 - Authority Levels enforced by middleware',
    );
  }

  return ok({
    action,
    prohibited: false,
    requiredLevel: required,
    actorLevel: actor.authorityLevel,
  });
};

export * from './credentials.js';
export * from './totp.js';
export * from './mfa.js';
export * from './clientUsers.js';
export * from './passwordReset.js';
export * from './sessions.js';
