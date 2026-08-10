/**
 * Outcome -> HTTP. The one place the mapping lives.
 *
 * Moved out of `apps/api` when the Client Portal got its own process. Two apps serialising the
 * same union two ways is how `not_built` becomes a 200 on one of them - and the distinction
 * between "we looked and there is nothing" and "the capability does not exist" survives only if
 * the transport keeps it.
 *
 * Design principle 9 requires that `not_built`, `no_data` and `failed` be distinguishable
 * at a glance, and the CapitalForge 501 pattern requires an endpoint that cannot fulfil its
 * contract to refuse with an explicit reason. Both survive only if the transport preserves
 * the distinction, so each variant gets its own status code and every response carries the
 * status name in the body as well - a client reading JSON should not have to infer meaning
 * from a number.
 *
 * 501 for `not_built` is the load-bearing one. The tempting alternative - 200 with an empty
 * array - is exactly the silent no-op the principle forbids, and it is indistinguishable
 * from a real empty result.
 */

import type { Response } from 'express';
import { type Outcome, type OutcomeStatus } from '@bwc/core';

export const STATUS_CODES: Record<OutcomeStatus, number> = {
  ok: 200,
  /** Policy declined. Not a client error to be corrected by retrying with different input. */
  refused: 409,
  /** The capability does not exist. Same contract CapitalForge uses. */
  not_built: 501,
  /** We looked; there is nothing. Distinct from the capability being absent. */
  no_data: 404,
  failed: 500,
};

export interface ErrorBody {
  readonly status: Exclude<OutcomeStatus, 'ok'>;
  readonly reason: string;
  readonly principle?: string;
  readonly module?: string;
  readonly cause?: string;
}

export const send = <T>(
  res: Response,
  outcome: Outcome<T>,
  extra?: Record<string, unknown>,
): void => {
  const code = STATUS_CODES[outcome.status];

  if (outcome.status === 'ok') {
    res.status(code).json({ status: 'ok', data: outcome.value, ...extra });
    return;
  }

  const body: ErrorBody =
    outcome.status === 'refused'
      ? { status: 'refused', reason: outcome.reason, principle: outcome.principle }
      : outcome.status === 'not_built'
        ? { status: 'not_built', reason: outcome.reason, module: outcome.module }
        : outcome.status === 'no_data'
          ? { status: 'no_data', reason: outcome.reason }
          : {
              status: 'failed',
              reason: outcome.reason,
              ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
            };

  res.status(code).json({ ...body, ...extra });
};
