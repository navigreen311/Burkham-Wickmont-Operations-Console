/**
 * 7.2 State-by-State Regulatory Engine — the screen closest to unblocking launch.
 *
 * ## Why this surface matters more than the others in its batch
 *
 * Middleware step 5 refuses every client-facing action whose state is not active, and **no state is
 * activated today**. That is not a bug: ADR-0009 chose it, and the ADR says the cost out loud —
 * _"A client in a state that has not been activated cannot be served. The refusal will block real
 * work, and it is supposed to."_
 *
 * What was missing was any way to clear it. Activation needs a Level 3 human, a named reviewing
 * counsel, a review date and a document reference; until this file there was no surface that could
 * take those four things, so the only route to serving a client was a developer with a shell.
 *
 * ## The activation write does NOT go through `chain()`, and that is deliberate
 *
 * Every other write in this Console goes through the middleware chain with a declared action
 * (ADR-0033). This one cannot: `ACTION_MINIMUM_LEVEL` has no entry for activating a state, and
 * `decideAuthority` refuses an action absent from the catalogue. Adding one is an edit to
 * `packages/core`, which this slice does not own.
 *
 * It ships anyway because **the module's own gate is stronger than the one the chain would apply**,
 * and ADR-0047 records the argument. In short:
 *
 *   chain step 3   compares a number: `actor.authorityLevel >= ACTION_MINIMUM_LEVEL[action]`
 *   ADR-0009       re-reads the actor from the database AND requires `kind === 'human'` AND
 *                  Level 3 AND a counsel review with a named reviewer and a document reference
 *
 * A Level 3 *village agent* passes the first and is refused by the second. So routing activation
 * through the chain would not have added a check; it would have added a weaker one beside a
 * stronger one, and the weaker one is the one somebody would later mistake for the gate.
 *
 * **What the chain WOULD have added is step 2, tenant scope**, which `activateState` does not
 * perform — it resolves the actor by id and never compares tenants. This file performs it
 * explicitly. See `assertInTenant`.
 *
 * **Nothing here weakens the gate to make a form convenient.** Every one of the four required
 * inputs is required by this route too, refused by name, and `reviewedAt` is not defaulted to now:
 * a defaulted review date is a claim about when counsel looked at something (ADR-0035).
 *
 * @see docs/adr/0047-the-gate-that-was-already-stronger-than-the-chain.md
 * @see docs/adr/0009-state-activation-requires-a-human-and-a-document.md
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import {
  V1_PRIORITY_STATES,
  activateState,
  coverage,
  currentModule,
  moduleHistory,
  outstandingLawChanges,
  requiredDisclosures,
  standingFor,
  withdrawState,
} from '@bwc/regulatory';
import { ok, refused } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

/**
 * What a route module needs from the app that hosts it.
 *
 * Declared here rather than imported from a shared module because this slice owns four route files
 * and no fifth one to put it in. The four copies are structurally identical, so `createApp` passes
 * one object to all of them; the duplication is a consequence of the file ownership for this branch
 * and should collapse into `routes/context.ts` the moment anybody owns both.
 */
export interface ConsoleRouteContext {
  readonly app: Express;
  readonly tenantId: string;
  readonly now: () => Date;
  /** Has already replied when it returns undefined. */
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly param: (req: Request, name: string) => string;
  readonly jsonBody: RequestHandler;
}

/** One entry per check this route performed, in the order it performed them. */
interface GateStep {
  readonly check: string;
  readonly outcome: 'passed' | 'blocked';
  readonly detail: string;
}

/**
 * The sentence that travels with every activation attempt.
 *
 * The page shows a middleware trace after a write, and there is none here because there is no
 * chain. Rather than show an empty trace — which would read as "no checks ran" — the route reports
 * the checks it actually performed and says which machinery performed them.
 */
const GATE_NOTE =
  'These are ADR-0009 module checks, not the middleware chain. Activation has no action in ACTION_MINIMUM_LEVEL, and the module gate is stricter than the chain step it would replace: it re-reads the actor from the database and requires a human at Level 3, which a numeric level check does not.';

/**
 * Tenant scope, performed here because the module does not.
 *
 * `activateState` resolves the actor with `findActor(input.actor.id)` and never compares
 * `actor.tenantId` against the tenant being activated. On this route the actor comes from the
 * session, which `staffFrom` already resolved against `config.tenantId`, so this check is currently
 * redundant — and it stays because the redundancy is the caller's property rather than the module's.
 * A second caller passing an actor id from elsewhere would find nothing standing in the way.
 */
const assertInTenant = (actor: Actor, tenantId: string): GateStep =>
  actor.tenantId === tenantId
    ? { check: 'tenant_scope', outcome: 'passed', detail: `actor is in ${tenantId}` }
    : {
        check: 'tenant_scope',
        outcome: 'blocked',
        detail: 'the acting actor belongs to another tenant',
      };

const asIsoDate = (raw: unknown): Date | null => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const registerRegulatoryRoutes = (context: ConsoleRouteContext): void => {
  const { app, tenantId, now, requireStaff, asyncRoute, param, jsonBody } = context;

  /**
   * The coverage map: every state with a module, and where each stands.
   *
   * **The counts are the headline.** An operator opening this page needs one number before
   * anything else — how many states can be served — because if it is zero the firm cannot act for
   * anybody, and that is the actual condition of the system today.
   *
   * `V1_PRIORITY_STATES` with no module at all are listed separately. They are absent from
   * `coverage()` by construction (it reads published modules), and a coverage map that silently
   * omitted the states V1 is supposed to cover would read as complete.
   */
  app.get(
    '/api/console/regulatory/coverage',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;

      const states = await coverage(tenantId);
      const withModules = new Set(states.map((entry) => entry.state));
      const active = states.filter((entry) => entry.permitsClientFacingAction);

      // Counted by status rather than reduced to a colour or a percentage. `needs_counsel_review`
      // and `draft` both block, and they are cleared by different work.
      const byStatus: Record<string, number> = {};
      for (const entry of states) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;

      send(
        res,
        ok({
          states: states.map((entry) => ({
            state: entry.state,
            status: entry.status,
            permitsClientFacingAction: entry.permitsClientFacingAction,
            currentVersion: entry.currentVersion,
            reviewedVersion: entry.reviewedVersion,
            explanation: entry.explanation,
          })),
          total: states.length,
          activeTotal: active.length,
          activeStates: active.map((entry) => entry.state),
          byStatus,
          /**
           * The sentence the page leads with.
           *
           * Written on the server because it is a statement about what the system can currently
           * do, and the page should not be the place that decides how to phrase "we cannot serve
           * anybody".
           */
          headline:
            active.length === 0
              ? 'No state is active. Every client-facing action is refused at middleware step 5, so no client can be served in any jurisdiction today.'
              : `${active.length} state(s) active: ${active.map((entry) => entry.state).join(', ')}. Clients outside them cannot be served.`,
          priorityStatesWithoutModule: V1_PRIORITY_STATES.filter(
            (state) => !withModules.has(state),
          ),
          priorityStatesWithoutModuleTotal: V1_PRIORITY_STATES.filter(
            (state) => !withModules.has(state),
          ).length,
        }),
      );
    }),
  );

  /**
   * One state: its standing, the module in force, every version, what it obliges, and what the law
   * tracker has noticed that nobody has folded in yet.
   */
  app.get(
    '/api/console/regulatory/states/:state',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      const state = param(req, 'state').toUpperCase();

      const [standing, module, history, disclosures, lawChanges] = await Promise.all([
        standingFor(tenantId, state),
        currentModule(tenantId, state),
        moduleHistory(tenantId, state),
        requiredDisclosures({ tenantId, state }),
        outstandingLawChanges(tenantId, state),
      ]);

      send(
        res,
        ok({
          standing: {
            state: standing.state,
            status: standing.status,
            permitsClientFacingAction: standing.permitsClientFacingAction,
            currentVersion: standing.currentVersion,
            reviewedVersion: standing.reviewedVersion,
            explanation: standing.explanation,
          },
          /**
           * What activation would need, from the module rather than from the form.
           *
           * The page shows this beside the form so an operator reads the requirement before
           * meeting the refusal. It is a description of ADR-0009's gate, not a second copy of it —
           * nothing here decides anything.
           */
          activationRequires: {
            humanActorAtLevel: 3,
            counselName: true,
            reviewDate: true,
            documentReference: true,
            note: 'The Authority Level is read from the recorded actor, never from the caller. A village agent at Level 3 is refused: activation requires a human.',
          },
          module:
            module.status === 'ok'
              ? {
                  version: module.value.version,
                  summary: module.value.summary,
                  citations: module.value.citations,
                  changeKind: module.value.changeKind,
                  changeRationale: module.value.changeRationale,
                  createdBy: module.value.createdBy,
                }
              : null,
          moduleUnavailableReason: module.status === 'ok' ? null : module.reason,
          history: history.map((entry) => ({
            version: entry.version,
            summary: entry.summary,
            changeKind: entry.changeKind,
            changeRationale: entry.changeRationale,
            createdBy: entry.createdBy,
            supersededAt: entry.supersededAt,
          })),
          historyTotal: history.length,
          disclosures: disclosures.map((entry) => ({
            key: entry.key,
            text: entry.text,
            citation: entry.citation,
            // `federal` or the state code, so a reader sees which layer obliges it.
            source: entry.source,
            productKind: entry.productKind,
          })),
          disclosuresTotal: disclosures.length,
          outstandingLawChanges: lawChanges.map((entry) => ({
            id: entry.id,
            state: entry.state,
            summary: entry.summary,
            citation: entry.citation,
            noticedAt: entry.noticedAt,
            effectiveOn: entry.effectiveOn,
          })),
          outstandingLawChangesTotal: lawChanges.length,
        }),
      );
    }),
  );

  /**
   * Bring a state online.
   *
   * **The whole of the value in this batch is this route.** Read the file header before changing
   * anything here, and ADR-0009 before that.
   *
   * The inputs are required and refused by name, and none is defaulted. `reviewedAt` in particular:
   * defaulting it to now would make the system assert that counsel reviewed the module at the
   * moment somebody pressed a button, which is a claim about a person's professional work that
   * nobody made.
   */
  app.post(
    '/api/console/regulatory/states/:state/activation',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const state = param(req, 'state').toUpperCase();
      const gate: GateStep[] = [
        {
          check: 'session',
          outcome: 'passed',
          detail: `${actor.label}, ${actor.kind}, Level ${actor.authorityLevel}`,
        },
      ];

      const scope = assertInTenant(actor, tenantId);
      gate.push(scope);
      if (scope.outcome === 'blocked') {
        send(
          res,
          refused(
            'The acting actor belongs to another tenant.',
            'Principle 5 - multi-tenant isolation is strict',
          ),
          { gate, gateNote: GATE_NOTE },
        );
        return;
      }

      const body = req.body as {
        reviewedBy?: unknown;
        reviewedAt?: unknown;
        documentReference?: unknown;
        notes?: unknown;
      };

      const reviewedAt = asIsoDate(body.reviewedAt);
      const missing: string[] = [];
      if (typeof body.reviewedBy !== 'string' || body.reviewedBy.trim() === '') {
        missing.push('reviewedBy (the name of the reviewing counsel)');
      }
      if (reviewedAt === null) {
        missing.push('reviewedAt (the date counsel reviewed it, as a date this route can parse)');
      }
      if (typeof body.documentReference !== 'string' || body.documentReference.trim() === '') {
        missing.push('documentReference (where the review lives)');
      }

      if (missing.length > 0) {
        gate.push({
          check: 'counsel_review_recorded',
          outcome: 'blocked',
          detail: `missing: ${missing.join('; ')}`,
        });
        send(
          res,
          refused(
            `Activating ${state} needs ${missing.join(', ')}. A review nobody can produce is indistinguishable from one that never happened, and a review date the system supplied is a claim about when counsel looked at something that nobody made.`,
            'Specification 11.2 with ADR-0009 - documented counsel review',
          ),
          { gate, gateNote: GATE_NOTE },
        );
        return;
      }
      gate.push({
        check: 'counsel_review_recorded',
        outcome: 'passed',
        detail: `reviewed by ${String(body.reviewedBy)} on ${reviewedAt?.toISOString().slice(0, 10) ?? ''}`,
      });

      /**
       * The actor is passed through untouched, and the module re-reads it.
       *
       * Nothing here asserts the level. `activateState` looks the actor up and refuses anything
       * that is not a human at Level 3 — a gate that believed its caller about whether the caller
       * is allowed through would not be a gate, and this route is the caller.
       */
      const activated = await activateState({
        tenantId,
        state,
        actor: { id: actor.id, kind: actor.kind },
        reviewedBy: (body.reviewedBy as string).trim(),
        reviewedAt: reviewedAt as Date,
        documentReference: (body.documentReference as string).trim(),
        ...(typeof body.notes === 'string' && body.notes.trim() !== ''
          ? { notes: body.notes.trim() }
          : {}),
        now: now(),
      });

      gate.push(
        activated.status === 'ok'
          ? {
              check: 'module_gate',
              outcome: 'passed',
              detail: `ADR-0009: human at Level 3 with a documented review. ${activated.value.explanation}`,
            }
          : { check: 'module_gate', outcome: 'blocked', detail: activated.reason },
      );

      send(res, activated, { gate, gateNote: GATE_NOTE });
    }),
  );

  /**
   * Take a state back offline.
   *
   * The same authority as activation and no lower. Withdrawal is the safe direction, and it stops
   * client work — a decision that stops client work should be made by somebody who can answer for
   * it.
   */
  app.post(
    '/api/console/regulatory/states/:state/withdrawal',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const state = param(req, 'state').toUpperCase();
      const gate: GateStep[] = [
        {
          check: 'session',
          outcome: 'passed',
          detail: `${actor.label}, ${actor.kind}, Level ${actor.authorityLevel}`,
        },
      ];

      const scope = assertInTenant(actor, tenantId);
      gate.push(scope);
      if (scope.outcome === 'blocked') {
        send(
          res,
          refused(
            'The acting actor belongs to another tenant.',
            'Principle 5 - multi-tenant isolation is strict',
          ),
          { gate, gateNote: GATE_NOTE },
        );
        return;
      }

      const body = req.body as { reason?: unknown };
      if (typeof body.reason !== 'string' || body.reason.trim() === '') {
        gate.push({ check: 'reason_recorded', outcome: 'blocked', detail: 'no reason given' });
        send(
          res,
          refused(
            `Withdrawing ${state} requires a reason. A state taken offline without one cannot be brought back with confidence.`,
            'Blueprint 7.2',
          ),
          { gate, gateNote: GATE_NOTE },
        );
        return;
      }
      gate.push({ check: 'reason_recorded', outcome: 'passed', detail: body.reason.trim() });

      const withdrawn = await withdrawState({
        tenantId,
        state,
        actor: { id: actor.id, kind: actor.kind },
        reason: body.reason.trim(),
        now: now(),
      });

      gate.push(
        withdrawn.status === 'ok'
          ? { check: 'module_gate', outcome: 'passed', detail: withdrawn.value.explanation }
          : { check: 'module_gate', outcome: 'blocked', detail: withdrawn.reason },
      );

      send(res, withdrawn, { gate, gateNote: GATE_NOTE });
    }),
  );
};
