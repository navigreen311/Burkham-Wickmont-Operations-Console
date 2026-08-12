/**
 * 11.7 Admin Configuration Center, as Console routes.
 *
 * **The one way to get this surface wrong is to make an invariant look editable.**
 *
 * `@bwc/admin`'s registry splits every tunable constant in the codebase into two kinds. A
 * PARAMETER is a policy choice with a defensible range - a review cadence, an inactivity window.
 * An INVARIANT is law, or something the architecture rests on: TCPA quiet hours, the Level 4
 * prohibited-action list, the all-party recording-consent states, the compliance state categories.
 *
 * The registry's own header is exact about the mechanism: **invariants are not permission-gated,
 * they are absent.** There is no code path that writes one. A "Level 4 required" flag would be a
 * permission somebody eventually holds, and the person most likely to hold it is the one under
 * pressure to make a number move.
 *
 * So this route does three things and refuses a fourth.
 *
 *  1. Serves parameters with their bounds, their owner and their `boundsBasis`.
 *  2. Serves invariants **as a separate collection with a different shape**, each carrying
 *     `whyFixed`. Not a parameter list with an `editable: false` flag - a flag is a field somebody
 *     flips, and the two lists must not be one list wearing a boolean.
 *  3. Serves staged changes and history, because a staged change is real and not a label.
 *  4. Offers the parameter writes, through the chain. `setParameter`, `promoteStagedChange` and
 *     `rollback` each emit a Ledger event and so need `chain()` with a declared action -
 *     `change_system_parameter`, Level 3, declared in Batch A. Editing an INVARIANT is still not
 *     here and never will be: there is no function to call, at any level.
 *
 * **`effectiveValue` reads applied changes only**, which is what makes staging real. The route
 * carries both, separately labelled, so a page cannot show a staged value as though it were in
 * force - that would be the staging mechanism working in the store and lying on the screen.
 */

import {
  CHANGE_AUTHORITY_LEVEL,
  INVARIANTS,
  PARAMETERS,
  allEffectiveValues,
  changeHistory,
  promoteStagedChange,
  rollback,
  setParameter,
  stagedChanges,
} from '@bwc/admin';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type AdminRouteContext = ConsoleRouteContext;

/**
 * The writes this surface cannot offer.
 *
 * Note what is NOT here: editing an invariant. That is not a blocked write awaiting an action -
 * there is no function to call, in any package, at any level. Listing it as "blocked" would put it
 * on the same footing as a parameter change that is merely waiting on a decision, and imply that
 * declaring an action would unlock it. It would not. The invariants list says so in its own words.
 */
const AVAILABLE_WRITES = [
  {
    capability: 'Change a parameter, promote a staged change, or roll one back',
    action: 'change_system_parameter',
    note: `Level ${CHANGE_AUTHORITY_LEVEL}. A parameter is not one setting on one file - it is the number every file is computed against, so a wrong one is wrong retroactively and everywhere at once. A reason is required; the module holds the bounds.`,
  },
] as const;

const BLOCKED_WRITES = [] as const;

export const registerAdminRoutes = (context: AdminRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId } = context;

  /**
   * What may be configured, what may not, and what is currently in force.
   *
   * One answer rather than three routes, because the question an operator actually has is "can I
   * change X" - and that is answered by looking in both lists at once. Two routes would let a page
   * render the parameters and forget the invariants, which is precisely the failure the invariants
   * list exists to prevent: a setting that is silently absent reads as a setting somebody hid.
   */
  app.get(
    '/api/console/admin/configuration',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const [effective, staged, history] = await Promise.all([
        allEffectiveValues(tenantId),
        stagedChanges(tenantId),
        changeHistory(tenantId),
      ]);

      send(
        res,
        ok({
          /**
           * Parameters, with what is in force and where that value came from.
           *
           * `source` distinguishes a compiled default from a tenant change. An operator looking at
           * 45 days needs to know whether somebody chose it or nobody has.
           */
          parameters: effective.map((entry) => ({
            key: entry.parameter.key,
            label: entry.parameter.label,
            kind: entry.parameter.kind,
            value: entry.value,
            source: entry.source,
            changedAt: entry.changedAt,
            changedBy: entry.changedBy,
            compiledDefault: entry.parameter.compiledDefault,
            minimum: entry.parameter.minimum,
            maximum: entry.parameter.maximum,
            boundsBasis: entry.parameter.boundsBasis,
            owner: entry.parameter.owner,
            highRisk: entry.parameter.highRisk,
          })),

          /**
           * Invariants, in their own collection with their own shape.
           *
           * **Deliberately not a parameter with `editable: false`.** A boolean on a shared shape is
           * a field somebody can flip, and a page written against that shape has a code path that
           * renders an input for an invariant - a path that is one truthy value away from running.
           * A different shape has no such path.
           *
           * Every entry carries `whyFixed`, so "why can't I change this" is answered by the system
           * rather than by whoever remembers.
           */
          invariants: INVARIANTS.map((invariant) => ({
            key: invariant.key,
            label: invariant.label,
            value: invariant.value,
            whyFixed: invariant.whyFixed,
          })),

          /**
           * Staged changes, which are real.
           *
           * A high-risk change is recorded with `appliedAt` null, and `effectiveValue` reads
           * applied changes only - so a staged change genuinely is not in force. The page shows
           * these apart from the parameter values for that reason: rendering a staged value in the
           * parameter row would be the staging mechanism working in the store and lying on screen.
           */
          staged: staged.map((change) => ({
            id: change.id,
            key: change.key,
            previousValue: change.previousValue,
            newValue: change.newValue,
            reason: change.reason,
            changedBy: change.changedBy,
            inForce: false,
          })),

          history: history.map((change) => ({
            id: change.id,
            key: change.key,
            previousValue: change.previousValue,
            newValue: change.newValue,
            reason: change.reason,
            changedBy: change.changedBy,
            staged: change.staged,
            appliedAt: change.appliedAt,
            inForce: change.appliedAt !== null,
          })),

          totals: {
            parameters: effective.length,
            /**
             * Both counts, because they answer different questions.
             *
             * `parametersInRegistry` is what the registry declares; `parameters` is how many
             * resolved a value. A gap between them means a parameter the registry knows about
             * that `allEffectiveValues` dropped, which is a defect rather than a state.
             */
            parametersInRegistry: PARAMETERS.length,
            invariants: INVARIANTS.length,
            staged: staged.length,
            history: history.length,
          },

          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /**
   * Change a parameter, promote a staged change, or roll one back.
   *
   * A parameter is not one client's setting: it is the number every client's file is computed
   * against, so a wrong one is wrong retroactively and everywhere at once.
   */
  app.post(
    '/api/console/admin/parameters',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'change_system_parameter' });
      if (!permitted) return;

      const body = req.body as { key?: unknown; value?: unknown; reason?: unknown };
      const value = Number(body.value);
      if (!Number.isFinite(value)) {
        // The module holds the range and the invariant; this holds only the shape. A NaN reaching
        // `setParameter` would be refused there too, with a message about a bound rather than
        // about the value not being a number.
        send(res, refused('value must be a number.', 'Input validation'));
        return;
      }

      send(
        res,
        await setParameter({
          tenantId,
          key: String(body.key ?? ''),
          value,
          reason: String(body.reason ?? ''),
          changedBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  app.post(
    '/api/console/admin/changes/:changeId/promotion',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'change_system_parameter' });
      if (!permitted) return;

      send(
        res,
        await promoteStagedChange({
          tenantId,
          changeId: param(req, 'changeId'),
          promotedBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** Rolling back is a change too, and is recorded as one rather than as an undo. */
  app.post(
    '/api/console/admin/changes/:changeId/rollback',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'change_system_parameter' });
      if (!permitted) return;

      const body = req.body as { reason?: unknown };
      send(
        res,
        await rollback({
          tenantId,
          changeId: param(req, 'changeId'),
          reason: String(body.reason ?? ''),
          rolledBackBy: permitted.actor.id,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
        }),
        { trace: permitted.trace },
      );
    }),
  );
};
