/**
 * 5.1 Capital Stack & Monitoring and 5.6 Cost of Capital Calculator, as Console routes.
 *
 * **There is no stack to show, and that is the first thing this surface says.**
 *
 * `@bwc/capital` exports twenty functions and not one of them writes anything. Every one is a pure
 * computation over positions the CALLER supplies - `capitalStackHealth`, `pgExposureMap`,
 * `paymentCalendar`, `promoAlertsDue`, `restackWindows`, `blendedCostOfCapital` all take an array
 * and return a value. There is no position store, deliberately: 9.1 already records why, in
 * `UNPRODUCED_DOMAINS`, and the reason is Decision A. Positions were always going to arrive from
 * Plaid, Plaid is ungated, and inventing a store here would put the client's debt in a dashboard
 * package and make it a second source of truth the day the feed arrives.
 *
 * So a per-client stack view would render an empty stack for every client in the system. **That is
 * worse than no view at all**: an empty stack reads as "this client has no debt", which is the most
 * reassuring possible way to be wrong on the surface a capital operation steers by. `/stack`
 * therefore refuses, names Decision A and the Integration Layer gate, and points at what does work.
 *
 * What does work is the calculator, and it works completely. 5.6 is a calculator by definition -
 * "scenario modeling", "per-product comparison tables", "refi opportunity detection" - and 5.1's
 * health, PG exposure and payment calendar are the same shape over the same supplied positions. So
 * `/model` takes a stack the operator states and returns every one of those analyses.
 *
 * **`/model` is a POST that changes nothing.** It persists no row, emits no Ledger event and needs
 * no Authority Level, because it performs no act - it is a function call whose argument is too
 * large for a query string. Routing it through `chain()` would write an
 * `authority.action_authorised` event for a sum, which is noise in an append-only store. The rule
 * that every WRITE goes through the chain is not weakened by a route that writes nothing; it would
 * be weakened by pretending a calculator is an act so that the shape looks uniform.
 *
 * Every figure it returns is stamped `client_stated` provenance, because that is what it is: the
 * operator typed it. Principle 8 is not satisfied by the numbers being right.
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import {
  blendedCostOfCapital,
  capitalStackHealth,
  compareRefinance,
  costOfCapital,
  paymentCalendar,
  pgExposureMap,
  promoAlertsDue,
  restackWindows,
  stackAsOf,
  totalMonthlyObligation,
  type CapitalPosition,
  type CostOfCapital,
  type ProductKind,
  type RepaymentCadence,
} from '@bwc/capital';
import { ok, refused, toIso, type Provenance } from '@bwc/core';
import { send } from '@bwc/http';
import type { Actor } from '@bwc/identity';

/**
 * What the composer lends a route module.
 *
 * Declared here rather than in a shared file so that each route module states exactly what it
 * needs and nothing else. `capital.ts` is the only one of the five that takes a body.
 */
export interface CapitalRouteContext {
  readonly app: Express;
  readonly requireStaff: (req: Request, res: Response) => Promise<Actor | undefined>;
  readonly asyncRoute: (
    handler: (req: Request, res: Response) => Promise<void>,
  ) => (req: Request, res: Response) => void;
  readonly jsonBody: RequestHandler;
  readonly now: () => Date;
}

/**
 * What the operator typed, and nothing more.
 *
 * `client_stated` rather than `unresearched_default`: nobody assumed these figures, a person
 * entered them from a statement or a conversation. `@bwc/core`'s provenance module draws that
 * distinction specifically to stop a client's own statement being filed as our assumption, and it
 * renders differently on the page for that reason.
 */
const statedBy = (label: string, at: Date): Provenance => ({
  tag: 'client_stated',
  statedBy: label,
  statedAt: toIso(at),
});

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `undefined` means "not a legal value"; `null` is a legal value here and means "no limit". */
const nullableNumber = (value: unknown): number | null | undefined =>
  value === null ? null : (finiteNumber(value) ?? undefined);

const CADENCES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;

const cadenceOf = (value: unknown): RepaymentCadence | null =>
  typeof value === 'string' && (CADENCES as readonly string[]).includes(value)
    ? (value as RepaymentCadence)
    : null;

/**
 * 5.6's own product vocabulary, which is NOT 5.2's.
 *
 * `@bwc/capital` names five kinds and `@bwc/lenders` names seven, and they are different lists on
 * purpose: 5.2 classifies what a provider offers, 5.6 classifies how a product repays. A route that
 * accepted the lender list here would take 'sba_loan' and hand it to a calculator that has no idea
 * what that repays like.
 */
const KINDS = [
  'credit_card',
  'line_of_credit',
  'term_loan',
  'merchant_cash_advance',
  'equipment_finance',
] as const satisfies readonly ProductKind[];

type ProductKindName = ProductKind;

const kindOf = (value: unknown): ProductKindName | null =>
  typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? (value as ProductKindName)
    : null;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface PositionProblem {
  readonly row: number;
  readonly problem: string;
}

/**
 * Read one position out of the request body.
 *
 * Every failure carries the row it came from rather than collapsing into a single "invalid input".
 * An operator who typed nine positions and mistyped one needs to know which one.
 */
const readPosition = (
  raw: unknown,
  index: number,
  actorLabel: string,
  at: Date,
): { position: CapitalPosition } | { problem: PositionProblem } => {
  const row = index + 1;
  if (typeof raw !== 'object' || raw === null) {
    return { problem: { row, problem: 'not an object' } };
  }
  const input = raw as Record<string, unknown>;

  const kind = kindOf(input['kind']);
  if (kind === null)
    return { problem: { row, problem: `kind must be one of ${KINDS.join(', ')}` } };

  const cadence = cadenceOf(input['cadence']);
  if (cadence === null) {
    return { problem: { row, problem: `cadence must be one of ${CADENCES.join(', ')}` } };
  }

  const provider = typeof input['provider'] === 'string' ? input['provider'].trim() : '';
  const label = typeof input['label'] === 'string' ? input['label'].trim() : '';
  if (provider === '' || label === '') {
    return { problem: { row, problem: 'provider and label are both required' } };
  }

  const outstandingBalance = finiteNumber(input['outstandingBalance']);
  if (outstandingBalance === null || outstandingBalance < 0) {
    return { problem: { row, problem: 'outstandingBalance must be a number of at least zero' } };
  }

  const paymentPerPeriod = finiteNumber(input['paymentPerPeriod']);
  if (paymentPerPeriod === null || paymentPerPeriod < 0) {
    return { problem: { row, problem: 'paymentPerPeriod must be a number of at least zero' } };
  }

  const creditLimit = nullableNumber(input['creditLimit']);
  if (creditLimit === undefined) {
    return {
      problem: {
        row,
        problem: 'creditLimit must be a number, or null for a product with no limit',
      },
    };
  }

  const annualRate = nullableNumber(input['annualRate']);
  const factorRate = nullableNumber(input['factorRate']);
  if (annualRate === undefined || factorRate === undefined) {
    return { problem: { row, problem: 'annualRate and factorRate must each be a number or null' } };
  }

  const asOfRaw = input['asOf'];
  const asOf = typeof asOfRaw === 'string' && ISO_DATE.test(asOfRaw) ? asOfRaw : null;
  if (asOf === null) {
    // Required, and required as a DATE the operator states. Defaulting it to today would stamp a
    // three-month-old statement as observed this morning, and `stackAsOf` exists precisely because
    // a stack is only as current as its stalest position.
    return {
      problem: { row, problem: 'asOf must be the YYYY-MM-DD date this figure was observed' },
    };
  }

  const guaranteeRaw = input['personalGuarantee'];
  let personalGuarantee: CapitalPosition['personalGuarantee'] = null;
  if (typeof guaranteeRaw === 'object' && guaranteeRaw !== null) {
    const guarantee = guaranteeRaw as Record<string, unknown>;
    const ownerName =
      typeof guarantee['ownerName'] === 'string' ? guarantee['ownerName'].trim() : '';
    if (ownerName === '')
      return { problem: { row, problem: 'a personal guarantee needs ownerName' } };
    const limitAmount = nullableNumber(guarantee['limitAmount']);
    if (limitAmount === undefined) {
      return {
        problem: { row, problem: 'guarantee limitAmount must be a number, or null for UNLIMITED' },
      };
    }
    personalGuarantee = { ownerName, limitAmount };
  }

  const promoRaw = input['promo'];
  let promo: CapitalPosition['promo'] = null;
  if (typeof promoRaw === 'object' && promoRaw !== null) {
    const window = promoRaw as Record<string, unknown>;
    const endsOn = typeof window['endsOn'] === 'string' ? window['endsOn'] : '';
    const promoAnnualRate = finiteNumber(window['promoAnnualRate']);
    const goToAnnualRate = finiteNumber(window['goToAnnualRate']);
    if (!ISO_DATE.test(endsOn) || promoAnnualRate === null || goToAnnualRate === null) {
      return {
        problem: {
          row,
          problem: 'a promo window needs endsOn (YYYY-MM-DD), promoAnnualRate and goToAnnualRate',
        },
      };
    }
    promo = { endsOn, promoAnnualRate, goToAnnualRate };
  }

  return {
    position: {
      id: `stated-${row}`,
      provider,
      kind,
      label,
      creditLimit,
      outstandingBalance,
      annualRate,
      factorRate,
      cadence,
      paymentPerPeriod,
      promo,
      personalGuarantee,
      asOf,
      provenance: statedBy(actorLabel, at),
    },
  };
};

/**
 * How many periods it takes to clear a stated balance at a stated payment.
 *
 * A derivation, and a crude one - it ignores interest accruing over the run-off, so it understates
 * the term for an interest-bearing balance. It is used only to give `costOfCapital` a term for a
 * position the operator described by balance and payment rather than by schedule, and the answer
 * is labelled `termIsDerived` wherever it travels so nobody reads it as the contractual term.
 */
const derivedTermPeriods = (position: CapitalPosition): number =>
  position.paymentPerPeriod > 0
    ? Math.max(1, Math.ceil(position.outstandingBalance / position.paymentPerPeriod))
    : 1;

const costFor = (position: CapitalPosition): CostOfCapital =>
  costOfCapital({
    kind: position.kind,
    principal: position.outstandingBalance,
    ...(position.annualRate !== null ? { annualRate: position.annualRate } : {}),
    ...(position.factorRate !== null ? { factorRate: position.factorRate } : {}),
    cadence: position.cadence,
    termPeriods: derivedTermPeriods(position),
    originationFee: 0,
  });

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

export const registerCapitalRoutes = (context: CapitalRouteContext): void => {
  const { app, requireStaff, asyncRoute, jsonBody, now } = context;

  /**
   * The per-client stack, which does not exist.
   *
   * A refusal rather than an empty array, and the difference is the whole point: `[]` renders as a
   * client with no debt, and this system has no idea whether that is true.
   */
  app.get(
    '/api/console/clients/:clientId/stack',
    asyncRoute(async (req, res) => {
      if (!(await requireStaff(req, res))) return;
      send(
        res,
        refused(
          'No feed supplies this client\'s capital positions, so there is no stack to show. Blueprint 5.1 takes monitoring inputs from Plaid (Decision A), the Integration Layer has not activated it, and nothing else records a position. An empty stack would read as "this client has no debt", which is the most reassuring possible way to be wrong on this surface. Model a stack from statement figures instead: the same analyses run over positions you state.',
          'Blueprint 5.1 with Decision A - monitoring inputs flow from Plaid via the Integration Layer',
        ),
      );
    }),
  );

  /**
   * Every 5.1 and 5.6 analysis, over a stack the operator states.
   *
   * One route rather than six, because the analyses share an input and an operator weighing a
   * refinance wants the health score and the payment burden in the same answer. Six routes would be
   * six copies of the same body and six chances for them to disagree about what the stack is.
   */
  app.post(
    '/api/console/capital/model',
    jsonBody,
    asyncRoute(async (req, res) => {
      const actor = await requireStaff(req, res);
      if (!actor) return;

      const at = now();
      const today = isoDay(at);
      const provenance = statedBy(actor.label, at);
      const body = req.body as { positions?: unknown; refinance?: unknown };

      if (!Array.isArray(body.positions) || body.positions.length === 0) {
        send(
          res,
          refused(
            'State at least one position. This is a calculator over figures you supply, not a read of a feed - see the stack route for why there is no feed.',
            'Blueprint 5.6 - scenario modeling over supplied terms',
          ),
        );
        return;
      }

      const positions: CapitalPosition[] = [];
      const problems: PositionProblem[] = [];
      for (const [index, raw] of body.positions.entries()) {
        const read = readPosition(raw, index, actor.label, at);
        if ('problem' in read) problems.push(read.problem);
        else positions.push(read.position);
      }

      if (problems.length > 0) {
        send(
          res,
          refused(
            `${problems.length} position(s) could not be read: ${problems
              .map((entry) => `row ${entry.row} - ${entry.problem}`)
              .join('; ')}.`,
            'Input validation',
          ),
        );
        return;
      }

      const perPosition = positions.map((position) => ({
        id: position.id,
        label: position.label,
        provider: position.provider,
        kind: position.kind,
        /** Derived from balance and payment, not contractual. See `derivedTermPeriods`. */
        termIsDerived: true,
        cost: costFor(position),
      }));

      const blended = blendedCostOfCapital(
        positions.map((position) => ({
          label: position.label,
          outstandingBalance: position.outstandingBalance,
          effectiveApr:
            perPosition.find((entry) => entry.id === position.id)?.cost.effectiveApr ?? null,
        })),
        provenance,
      );

      const health = capitalStackHealth({
        positions,
        blendedApr: blended.blendedApr?.value ?? null,
        today,
        provenance,
      });

      /**
       * The refinance comparison, when the operator asked for one.
       *
       * Optional rather than always-on: `compareRefinance` needs terms for the replacement, and
       * inventing them to fill the field would produce a comparison against a product nobody
       * offered.
       */
      let refinance: ReturnType<typeof compareRefinance> | null = null;
      if (typeof body.refinance === 'object' && body.refinance !== null) {
        const request = body.refinance as Record<string, unknown>;
        const replacingIds = Array.isArray(request['replacingIds'])
          ? request['replacingIds'].filter((value): value is string => typeof value === 'string')
          : [];
        const replaced = positions.filter((position) => replacingIds.includes(position.id));
        const principal = finiteNumber(request['principal']);
        const termPeriods = finiteNumber(request['termPeriods']);
        const cadence = cadenceOf(request['cadence']);
        const kind = kindOf(request['kind']);
        const annualRate = nullableNumber(request['annualRate']);
        const originationFee = finiteNumber(request['originationFee']) ?? 0;

        if (
          replaced.length === 0 ||
          principal === null ||
          termPeriods === null ||
          termPeriods < 1 ||
          cadence === null ||
          kind === null ||
          annualRate === undefined
        ) {
          send(
            res,
            refused(
              'A refinance comparison needs replacingIds naming at least one stated position, plus kind, principal, termPeriods (at least 1), cadence and annualRate for the replacement.',
              'Input validation',
            ),
          );
          return;
        }

        // `compareRefinance` takes computed costs on both sides, not terms - it compares TOTAL COST
        // rather than APR, because a lower rate over a longer term routinely costs more in absolute
        // dollars and a client who refinances into a cheaper-sounding rate and pays more is the
        // failure that module exists to prevent. So the proposal is costed first.
        refinance = compareRefinance(
          replaced.map(costFor),
          costOfCapital({
            kind,
            principal,
            ...(annualRate !== null ? { annualRate } : {}),
            cadence,
            termPeriods,
            originationFee,
          }),
        );
      }

      send(
        res,
        ok({
          /**
           * Restated on every answer.
           *
           * The single most important field here, and the one a reader would otherwise supply from
           * memory: none of this came from a feed. It is arithmetic over what somebody typed.
           */
          basis: {
            source: 'operator_stated',
            statedBy: actor.label,
            statedAt: toIso(at),
            detail:
              'Computed from positions stated by the operator. No feed supplies capital positions - Plaid is ungated under Decision A - so these figures are exactly as good as what was entered and no better.',
          },
          asOf: stackAsOf(positions),
          positionCount: positions.length,
          health,
          blendedCostOfCapital: blended,
          totalMonthlyObligation: totalMonthlyObligation(positions),
          paymentCalendar: paymentCalendar(positions),
          promoAlerts: promoAlertsDue(positions, today),
          restackWindows: restackWindows(positions, today),
          pgExposure: pgExposureMap(positions, provenance),
          perPosition,
          refinance,
        }),
      );
    }),
  );
};
