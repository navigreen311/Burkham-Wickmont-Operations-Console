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

import type { Express, Request, Response } from 'express';
import { definitionForInstance, findInstance } from '@bwc/workflow';
import { noData, ok } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

export interface WorkflowRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly tenantId: string;
}

const BLOCKED_WRITES = [
  {
    capability: 'Publish a playbook, start an instance, or complete an external task',
    module: '@bwc/workflow publishPlaybook, start, completeExternalTask',
    missingAction: 'none declared',
    why: 'Each writes to the Ledger and needs a declared action; none exists for workflow authoring. Starting an instance is the consequential one - it sets work in motion against a client - and naming its Authority Level is a judgement that belongs in packages/core.',
  },
  {
    capability: 'List what is running',
    module: '@bwc/workflow',
    missingAction: 'no module read exists',
    why: 'Not blocked by an Authority Level - there is no function to call. `findInstance` takes an id and nothing answers "what is running for this tenant". Querying the table from this route would put a module read in the transport, so the gap is left where it belongs.',
  },
] as const;

export const registerWorkflowRoutes = (context: WorkflowRouteContext): void => {
  const { app, requireStaff, asyncRoute, param, tenantId } = context;

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
          writes: { available: [], blocked: BLOCKED_WRITES },
        }),
      );
    }),
  );
};
