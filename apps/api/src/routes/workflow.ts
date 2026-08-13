/**
 * 2.2 Workflow Engine and 2.4 Human Approval Console, as Console routes.
 *
 * **The approval queue is 11.4's, and it is already surfaced.** 2.4's "console" is not a second
 * store: a workflow step that needs a person raises a task notification, and those are read at
 * `/api/console/queue`. Building a parallel list here would be a second answer to "what is waiting
 * on me", and the two would disagree the first time one of them was filtered.
 *
 * What is genuinely missing, and is named rather than worked around:
 *
 * **`@bwc/workflow` has no tenant-scoped list read.** It exposes `findInstance(instanceId)` and
 * nothing that answers "what is running for this tenant". A route could query the table directly
 * and produce that list in ten lines - and it would be a module read living in the transport, which
 * is the thing this repository has refused everywhere else. So this surface reads ONE instance by
 * id, and the list is a gap in 2.2 rather than a gap in this file.
 */

import {
  completeExternalTask,
  definitionForInstance,
  findInstance,
  publishPlaybook,
  start,
} from '@bwc/workflow';
import { noData, ok } from '@bwc/core';
import { send } from '@bwc/http';

import type { ConsoleRouteContext } from './context.js';

export type WorkflowRouteContext = ConsoleRouteContext;

const AVAILABLE_WRITES = [
  {
    capability: 'Publish a playbook',
    action: 'publish_playbook',
    note: 'Level 3. It changes how the firm serves every client who starts on it afterwards - the rules themselves, not one file. Publish a new VERSION rather than editing one: an instance is pinned to the version it began on.',
  },
  {
    capability: 'Start an instance, or complete an external task',
    action: 'run_workflow',
    note: 'Level 1. The daily work of running playbooks. The consequential acts inside one are gated where they happen - a task that transitions a compliance state still needs transition_compliance_state.',
  },
] as const;

const BLOCKED_WRITES = [
  {
    capability: 'List what is running',
    module: '@bwc/workflow',
    missingAction: 'no module read exists',
    why: 'Not blocked by an Authority Level - there is no function to call. `findInstance` takes an id and nothing answers "what is running for this tenant". Querying the table from this route would put a module read in the transport, so the gap is left where it belongs.',
  },
] as const;

export const registerWorkflowRoutes = (context: WorkflowRouteContext): void => {
  const { app, requireStaff, authorised, asyncRoute, jsonBody, param, tenantId, now } = context;

  /**
   * One instance, with the definition version it PINNED at start.
   *
   * The pinned version rather than the current one, and that is 2.2's rule rather than this file's:
   * a playbook republished today does not change what a running instance is doing, because an
   * instance that silently followed a new definition would be a workflow nobody chose.
   */
  app.get(
    '/api/console/workflow/instances/:instanceId',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const instanceId = param(req, 'instanceId');

      const instance = await findInstance(instanceId);
      if (!instance || instance.tenantId !== tenantId) {
        // Tenant-checked here because `findInstance` is keyed by id alone. An id from another
        // tenant is `no_data` rather than a refusal - a caller must not learn that it exists.
        send(res, noData(`No workflow instance ${instanceId} in this tenant.`));
        return;
      }

      // Takes the instance, not its id: the pinned key and version live on the instance, and
      // passing them together is what makes "the version this instance started on" unforgeable.
      const definition = await definitionForInstance(instance);

      send(
        res,
        ok({
          instance,
          definition,
          writes: { available: AVAILABLE_WRITES, blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );

  // --- Writes -------------------------------------------------------------

  /**
   * Publish a playbook.
   *
   * A NEW version, always. `publishPlaybook` upserts on (key, version) and an instance is pinned to
   * the version it started on, so republishing a live version rewrites the graph under everybody
   * currently running it.
   */
  app.post(
    '/api/console/workflow/playbooks',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'publish_playbook' });
      if (!permitted) return;

      const body = req.body as Record<string, unknown>;
      send(
        res,
        await publishPlaybook({
          key: String(body['key'] ?? ''),
          version: Number(body['version']),
          phase: Number(body['phase']),
          definition: body['definition'] as never,
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** Start an instance on the latest active version. */
  app.post(
    '/api/console/workflow/instances',
    jsonBody,
    asyncRoute(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : undefined;

      const permitted = await authorised(req, res, {
        action: 'run_workflow',
        ...(clientId !== undefined ? { clientId } : {}),
      });
      if (!permitted) return;

      send(
        res,
        await start({
          tenantId,
          playbookKey: String(body['playbookKey'] ?? ''),
          ...(clientId !== undefined ? { clientId } : {}),
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
          now: now(),
        }),
        { trace: permitted.trace },
      );
    }),
  );

  /** Complete a parked task, optionally writing a fact the graph below it will branch on. */
  app.post(
    '/api/console/workflow/tasks/:taskId/completion',
    jsonBody,
    asyncRoute(async (req, res) => {
      const permitted = await authorised(req, res, { action: 'run_workflow' });
      if (!permitted) return;

      const body = req.body as { contextPatch?: unknown };
      send(
        res,
        await completeExternalTask(
          tenantId,
          param(req, 'taskId'),
          { id: permitted.actor.id, kind: permitted.actor.kind },
          (typeof body.contextPatch === 'object' && body.contextPatch !== null
            ? body.contextPatch
            : {}) as Record<string, unknown>,
          now(),
        ),
        { trace: permitted.trace },
      );
    }),
  );
};
