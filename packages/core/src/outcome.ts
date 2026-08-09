/**
 * Honest empty states and honest refusals - design principle 9.
 *
 * There is deliberately no "empty success" variant. A function returning `Outcome`
 * cannot silently no-op: it must say which of the four non-success states it is in
 * and why. This is the type-level form of the CapitalForge 501 discipline.
 *
 * `no_data` is a legitimate answer (we looked, there is nothing).
 * `not_built` is an honest refusal (this module does not exist yet).
 * `failed` is an error (we tried, it broke).
 * `refused` is a policy decision (we could, and we will not, for this stated reason).
 *
 * Collapsing any of these into "return []" is the failure mode this type exists to prevent.
 */

/** The action succeeded and produced a value. */
export interface OutcomeOk<T> {
  readonly status: 'ok';
  readonly value: T;
}

/**
 * Policy declined the action. Always carries the governing principle, so the refusal
 * is traceable to the rule that produced it rather than to an anonymous guard.
 */
export interface OutcomeRefused {
  readonly status: 'refused';
  readonly reason: string;
  /** Which design principle or locked decision produced this refusal. */
  readonly principle: string;
}

/** The capability does not exist yet. Distinct from having no data. */
export interface OutcomeNotBuilt {
  readonly status: 'not_built';
  readonly module: string;
  readonly reason: string;
}

/** We looked and there is genuinely nothing. Distinct from not being built. */
export interface OutcomeNoData {
  readonly status: 'no_data';
  readonly reason: string;
}

/** We tried and it broke. Distinct from a policy refusal. */
export interface OutcomeFailed {
  readonly status: 'failed';
  readonly reason: string;
  readonly cause?: string;
}

export type Outcome<T> =
  OutcomeOk<T> | OutcomeRefused | OutcomeNotBuilt | OutcomeNoData | OutcomeFailed;

export type OutcomeStatus = Outcome<unknown>['status'];

/** Every status an Outcome can carry. Used by the HTTP layer to prove each maps distinguishably. */
export const OUTCOME_STATUSES = [
  'ok',
  'refused',
  'not_built',
  'no_data',
  'failed',
] as const satisfies readonly OutcomeStatus[];

export const ok = <T>(value: T): OutcomeOk<T> => ({ status: 'ok', value });

export const refused = (reason: string, principle: string): OutcomeRefused => ({
  status: 'refused',
  reason,
  principle,
});

export const notBuilt = (module: string, reason: string): OutcomeNotBuilt => ({
  status: 'not_built',
  module,
  reason,
});

export const noData = (reason: string): OutcomeNoData => ({ status: 'no_data', reason });

export const failed = (reason: string, cause?: string): OutcomeFailed =>
  cause === undefined ? { status: 'failed', reason } : { status: 'failed', reason, cause };

export const isOk = <T>(outcome: Outcome<T>): outcome is OutcomeOk<T> => outcome.status === 'ok';

/**
 * Narrow to the non-success variants. Useful at boundaries that forward a refusal
 * upward unchanged rather than translating it - translation is where reasons get lost.
 */
export const isNotOk = <T>(
  outcome: Outcome<T>,
): outcome is OutcomeRefused | OutcomeNotBuilt | OutcomeNoData | OutcomeFailed =>
  outcome.status !== 'ok';

/**
 * A human-readable description of any outcome, used in logs and API bodies.
 * Never include PII in the reason strings passed to the constructors above.
 */
export const describeOutcome = (outcome: Outcome<unknown>): string => {
  switch (outcome.status) {
    case 'ok':
      return 'ok';
    case 'refused':
      return `refused (${outcome.principle}): ${outcome.reason}`;
    case 'not_built':
      return `not_built (${outcome.module}): ${outcome.reason}`;
    case 'no_data':
      return `no_data: ${outcome.reason}`;
    case 'failed':
      return outcome.cause === undefined
        ? `failed: ${outcome.reason}`
        : `failed: ${outcome.reason} (cause: ${outcome.cause})`;
  }
};
