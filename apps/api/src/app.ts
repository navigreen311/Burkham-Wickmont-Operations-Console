/**
 * The Express host. Wires routes to modules and serializes Outcome - no business logic here.
 *
 * Every route that acts on a client goes through the middleware chain rather than calling a
 * module directly, because the chain is where authority, tenancy, the Firewall, the
 * compliance gate, and event emission are enforced. A route that bypassed it would be a
 * route with none of those.
 *
 * Actor identity arrives as an `x-actor-id` header. That is a development seam, not
 * authentication: real Identity & Access (11.1) issues and verifies credentials, and this
 * header is replaced when it does. Marked here so it cannot be mistaken for a finished
 * auth story.
 */

import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import {
  create as createClient,
  find as findClient,
  transitionComplianceState,
} from '@bwc/clients';
import { grant as grantConsent, type ConsentKind } from '@bwc/consent';
import { status as firewallStatus, trigger as triggerFirewall } from '@bwc/firewall';
import { findActor } from '@bwc/identity';
import { read as readLedger, verifyIntegrity } from '@bwc/ledger';
import { requestRecommendation } from '@bwc/placement';
import { VENDOR_GATES, isActivated, mode, outstandingPreconditions } from '@bwc/integration';
import { failed, isComplianceState, noData, ok, refused, type ComplianceState } from '@bwc/core';
import { send } from '@bwc/http';

/** Development seam. Replaced by Identity & Access (11.1) credential verification. */
const actorIdOf = (req: Request): string | undefined => {
  const header = req.header('x-actor-id');
  return header && header.trim() !== '' ? header.trim() : undefined;
};

/**
 * Express 5 types a route param as `string | string[]`, because a repeated `:id` in the
 * path yields an array. None of these routes repeat one, so the array case is collapsed
 * here in a single place rather than cast away at each call site - a cast per site is
 * seven opportunities to pick the wrong element silently.
 */
const param = (req: Request, name: string): string => {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
};

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response): void => {
    handler(req, res).catch((error: unknown) => {
      send(
        res,
        failed(
          'Unhandled error while processing the request.',
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  };

export const createApp = (): Express => {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // --- Health -------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', data: { service: 'bwc-console-api', version: '0.1.0' } });
  });

  /**
   * Vendor activation gates - Specification v2 section 11.4. Reports which preconditions
   * are outstanding per vendor, so "why can I not connect a bank" has an answer that names
   * the missing DPA rather than a generic failure.
   */
  app.get('/api/health/integrations', (_req, res) => {
    res.json({
      status: 'ok',
      data: {
        mode: mode(),
        vendors: Object.values(VENDOR_GATES).map((gate) => ({
          vendor: gate.vendor,
          activated: isActivated(gate.vendor),
          outstanding: outstandingPreconditions(gate.vendor),
        })),
      },
    });
  });

  // --- Clients ------------------------------------------------------------

  app.post(
    '/api/clients',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      if (!actorId) {
        send(res, refused('x-actor-id header is required.', 'Specification v2 section 5.5 step 1'));
        return;
      }
      const actor = await findActor(actorId);
      if (!actor) {
        send(res, refused('Unknown actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }

      const body = req.body as { legalName?: unknown };
      if (typeof body.legalName !== 'string' || body.legalName.trim() === '') {
        send(res, refused('legalName is required.', 'Input validation'));
        return;
      }

      const client = await createClient(actor.tenantId, body.legalName.trim(), {
        id: actor.id,
        kind: actor.kind,
      });
      send(res, ok(client));
    }),
  );

  app.get(
    '/api/clients/:clientId',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }
      const clientId = param(req, 'clientId');
      send(res, await findClient(actor.tenantId, clientId));
    }),
  );

  /** Compliance state transition - Decision E. Findings travel with the transition. */
  app.post(
    '/api/clients/:clientId/compliance',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }

      const body = req.body as {
        to?: unknown;
        reason?: unknown;
        findings?: { code: string; summary: string }[];
      };

      if (!isComplianceState(body.to)) {
        send(
          res,
          refused(
            'to must be one of: pending_assessment, pass, pass_with_findings, needs_review, fail. Compliance state is categorical, never numeric (Decision E).',
            'Decision E - categorical compliance state',
          ),
        );
        return;
      }
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        send(res, refused('reason is required for a compliance state transition.', 'Decision E'));
        return;
      }

      const outcome = await transitionComplianceState({
        tenantId: actor.tenantId,
        clientId: param(req, 'clientId'),
        to: body.to as ComplianceState,
        reason: body.reason,
        findings: body.findings ?? [],
        actor: { id: actor.id, kind: actor.kind },
      });
      send(res, outcome);
    }),
  );

  // --- Consent (1.5) ------------------------------------------------------

  app.post(
    '/api/clients/:clientId/consents',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }

      const body = req.body as { kind?: unknown; scope?: unknown };
      if (typeof body.kind !== 'string' || typeof body.scope !== 'string') {
        send(
          res,
          refused('kind and scope are both required.', 'Blueprint 1.5 - per-event consent'),
        );
        return;
      }

      send(
        res,
        await grantConsent({
          tenantId: actor.tenantId,
          clientId: param(req, 'clientId'),
          kind: body.kind as ConsentKind,
          scope: body.scope,
          actor: { id: actor.id, kind: actor.kind },
        }),
      );
    }),
  );

  // --- Firewall (6.2) -----------------------------------------------------

  app.get(
    '/api/clients/:clientId/firewall',
    asyncRoute(async (req, res) => {
      send(res, ok(await firewallStatus(param(req, 'clientId'))));
    }),
  );

  app.post(
    '/api/clients/:clientId/firewall/trigger',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }
      const body = req.body as { reason?: unknown };
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        send(res, refused('reason is required to trigger the Firewall.', 'Principle 7'));
        return;
      }
      send(
        res,
        ok(
          await triggerFirewall(actor.tenantId, param(req, 'clientId'), body.reason, {
            id: actor.id,
            kind: actor.kind,
          }),
        ),
      );
    }),
  );

  // --- Placement (5.3) - the point of the walking skeleton ----------------

  app.post(
    '/api/clients/:clientId/placements',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }

      const body = req.body as { applicationRef?: unknown };
      if (typeof body.applicationRef !== 'string' || body.applicationRef.trim() === '') {
        send(
          res,
          refused(
            'applicationRef is required. Authorization is scoped to a specific application, never blanket.',
            'Blueprint 1.5 - per-application authorization',
          ),
        );
        return;
      }

      const { result, trace } = await requestRecommendation({
        actorId: actor.id,
        tenantId: actor.tenantId,
        clientId: param(req, 'clientId'),
        applicationRef: body.applicationRef,
      });

      // The trace accompanies every response, refusal included: "which step blocked this"
      // should not require reconstructing the chain from logs.
      send(res, result, { trace });
    }),
  );

  // --- Event Ledger (11.3) ------------------------------------------------

  app.get(
    '/api/clients/:clientId/ledger',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }
      const events = await readLedger({
        tenantId: actor.tenantId,
        clientId: param(req, 'clientId'),
      });
      send(res, events.length > 0 ? ok(events) : noData('No ledger events for this client.'));
    }),
  );

  app.get(
    '/api/ledger/integrity',
    asyncRoute(async (req, res) => {
      const actorId = actorIdOf(req);
      const actor = actorId ? await findActor(actorId) : null;
      if (!actor) {
        send(res, refused('Unknown or missing actor.', 'Specification v2 section 5.5 step 1'));
        return;
      }
      send(res, ok(await verifyIntegrity(actor.tenantId)));
    }),
  );

  app.use((_req, res) => {
    send(res, noData('No such route.'));
  });

  return app;
};
