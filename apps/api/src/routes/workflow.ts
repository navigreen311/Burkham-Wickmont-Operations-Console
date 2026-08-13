/**
 * 2.2 Workflow Engine and 2.4 Human Approval Console, as Console routes.
 *
 * **The approval queue is 11.4's, and it is already surfaced.** 2.4's "console" is not a second
 * store: a workflow step that needs a person raises a task notification, and those are read at
 * `/api/console/queue`. Building a parallel list here would be a second answer to "what is waiting
 * on me", and the two would disagree the first time one of them was filtered.
 *
 * **The list read exists now.** This file used to say `@bwc/workflow` had none - it exposed
 * `findInstance(instanceId)` and nothing that answered "what is running for this tenant" - and
 * refused to produce one by querying the table here, because a module read living in the transport
 * is the thing this repository has refused everywhere else. The gap was reported on the panel and
 * has been closed in the module where it belonged: `instancesFor(tenantId, filter)`.
 */

import {
  completeExternalTask,
  definitionForInstance,
  findInstance,
  instancesFor,
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

/**
 * Empty, and the entry that was here is worth remembering.
 *
 * It read: "Not blocked by an Authority Level - there is no function to call." That was true, and
 * it was the last such entry on any panel in the Console. `instancesFor` exists now, so the surface
 * answers "what is running" from a module read rather than from a query the transport invented.
 */
const BLOCKED_WRITES = [] as const;

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

  /**
   * What is running for this tenant.
   *
   * Newest first and capped. An unbounded list of every instance a tenant has ever run is a page
   * nobody can use and a query that gets slower every month.
   */
  app.get(
    '/api/console/workflow/instances',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const query = req.query as Record<string, unknown>;
      const instances = await instancesFor(tenantId, {
        ...(typeof query['status'] === 'string' ? { status: query['status'] as never } : {}),
        ...(typeof query['clientId'] === 'string' ? { clientId: query['clientId'] } : {}),
        ...(typeof query['playbookKey'] === 'string' ? { playbookKey: query['playbookKey'] } : {}),
      });

      send(
        res,
        ok({
          instances,
          total: instances.length,
          /**
           * Counted here rather than left to the page, because "12 instances" hides the only
           * distinction an operator cares about: a waiting instance is fine and a failed one is not.
           */
          summary: {
            running: instances.filter((instance) => instance.status === 'running').length,
            waiting: instances.filter((instance) => instance.status === 'waiting').length,
            failed: instances.filter((instance) => instance.status === 'failed').length,
          },
          detail:
            instances.length === 0
              ? 'No workflow instance matches. That is an answer rather than an empty screen: no client is mid-playbook under this filter.'
              : `${instances.length} instance(s), newest first.`,
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
          // Attribution is required by the module now, and this is the caller that made it matter:
          // a Level 3 button on an act that changes how the firm serves every client afterwards.
          tenantId,
          actor: { id: permitted.actor.id, kind: permitted.actor.kind },
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
