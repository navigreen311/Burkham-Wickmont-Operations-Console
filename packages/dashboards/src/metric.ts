/**
 * The shape every figure on a dashboard takes - blueprint 9.1 and 9.2.
 *
 * Pure. No database, so the rules about when a number may be shown can be read and tested on
 * their own.
 *
 * Every module before this one refused to produce a figure it could not stand behind: 5.2's
 * approval rate is `null` below ten decided outcomes, 1.3's conversion rate below ten decided
 * leads, 5.1 returns `null` rather than `0` for an uncostable stack, 1.2 gives graph risk no
 * number at all. A dashboard is where that discipline either holds or quietly collapses, because
 * a dashboard's whole job is to put a number in front of somebody who will act on it.
 *
 * So a metric is **a value with its basis, or it is nothing**:
 *
 *   value        the figure, or `null`
 *   basis        numerator, denominator, period, coverage - what the figure was computed from
 *   note         why it is what it is, including when it is null
 *
 * `null` with a note is the honest answer to "what is our approval rate" when four placements have
 * been decided. `0` is not: zero is a measurement, and there is nothing to measure.
 */

/** Minimum decided outcomes before a rate is a rate. Matches 5.2 and 1.3, deliberately. */
export const MINIMUM_DENOMINATOR = 10;

/**
 * A reporting period, half-open: `[from, to)`.
 *
 * Half-open so consecutive periods neither overlap nor leave a gap. A closed interval double-counts
 * anything that happened exactly at midnight on the boundary, which is where automated charges land.
 */
export interface Period {
  readonly from: Date;
  readonly to: Date;
  /** Set when `to` is in the future, so a partial period is never compared with a whole one. */
  readonly partial: boolean;
}

export const periodOf = (from: Date, to: Date, now: Date): Period => ({
  from,
  to,
  partial: to.getTime() > now.getTime(),
});

export const periodDays = (period: Period): number =>
  Math.round((period.to.getTime() - period.from.getTime()) / (24 * 60 * 60 * 1000));

export const withinPeriod = (instant: Date, period: Period): boolean =>
  instant.getTime() >= period.from.getTime() && instant.getTime() < period.to.getTime();

/**
 * How much of what the metric describes could actually be measured.
 *
 *   `complete`     every input existed and was read
 *   `partial`      some inputs are unavailable, and the note says which
 *   `unavailable`  nothing could be measured; the value is null
 */
export type Coverage = 'complete' | 'partial' | 'unavailable';

export interface MetricBasis {
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly period: Period;
  readonly coverage: Coverage;
  /** Inputs that exist in the specification and could not be measured. Empty when complete. */
  readonly unmeasured: readonly string[];
}

export interface Metric<T> {
  readonly key: string;
  readonly label: string;
  readonly value: T | null;
  readonly basis: MetricBasis;
  /** Always present, including on a complete metric. */
  readonly note: string;
}

export const measured = <T>(input: {
  key: string;
  label: string;
  value: T;
  numerator?: number;
  denominator?: number;
  period: Period;
  note: string;
  unmeasured?: readonly string[];
}): Metric<T> => ({
  key: input.key,
  label: input.label,
  value: input.value,
  basis: {
    numerator: input.numerator ?? null,
    denominator: input.denominator ?? null,
    period: input.period,
    coverage: (input.unmeasured ?? []).length > 0 ? 'partial' : 'complete',
    unmeasured: input.unmeasured ?? [],
  },
  note: input.note,
});

/**
 * A metric that could not be computed.
 *
 * Takes the reason as a required argument. A dashboard full of dashes teaches its reader to ignore
 * dashes; a dashboard that says "4 decided placements, 10 needed before this is a rate" teaches
 * them what would make it appear.
 */
export const unmeasurable = <T>(input: {
  key: string;
  label: string;
  period: Period;
  note: string;
  numerator?: number;
  denominator?: number;
  unmeasured?: readonly string[];
}): Metric<T> => ({
  key: input.key,
  label: input.label,
  value: null,
  basis: {
    numerator: input.numerator ?? null,
    denominator: input.denominator ?? null,
    period: input.period,
    coverage: 'unavailable',
    unmeasured: input.unmeasured ?? [],
  },
  note: input.note,
});

/**
 * A rate, or `null` below the minimum denominator.
 *
 * The denominator is DECIDED outcomes, never total. A conversion rate computed over leads still
 * open reports a number that can only rise, and every reader takes it as final.
 */
export const rate = (input: {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  period: Period;
  minimum?: number;
  whatCounts: string;
}): Metric<number> => {
  const minimum = input.minimum ?? MINIMUM_DENOMINATOR;

  if (input.denominator < minimum) {
    return unmeasurable({
      key: input.key,
      label: input.label,
      period: input.period,
      numerator: input.numerator,
      denominator: input.denominator,
      note: `${input.denominator} ${input.whatCounts} in this period; ${minimum} are needed before a rate means anything. ${input.numerator} of ${input.denominator} so far - the counts are shown because they are real, and the rate is withheld because it is not yet.`,
    });
  }

  return measured({
    key: input.key,
    label: input.label,
    value: input.numerator / input.denominator,
    numerator: input.numerator,
    denominator: input.denominator,
    period: input.period,
    note: `${input.numerator} of ${input.denominator} ${input.whatCounts}.`,
  });
};

/**
 * Compare the same metric across two periods.
 *
 * **Refuses on unequal period lengths, and refuses when either is partial.** A month-to-date
 * figure against a full prior month is the most common way a dashboard lies without anybody
 * intending it: the comparison is arithmetically fine and describes nothing, and it always
 * flatters the past.
 */
export interface Comparison {
  readonly comparable: boolean;
  readonly delta: number | null;
  readonly note: string;
}

export const compare = <T extends number>(current: Metric<T>, prior: Metric<T>): Comparison => {
  if (current.basis.period.partial || prior.basis.period.partial) {
    return {
      comparable: false,
      delta: null,
      note: 'One of these periods has not finished. A period-to-date figure compared against a completed one always flatters the completed one, and the arithmetic gives no sign that anything is wrong.',
    };
  }

  const currentDays = periodDays(current.basis.period);
  const priorDays = periodDays(prior.basis.period);
  if (currentDays !== priorDays) {
    return {
      comparable: false,
      delta: null,
      note: `These periods are ${currentDays} and ${priorDays} days long. A difference between them would be partly the difference in length, and nothing in the result would say how much.`,
    };
  }

  if (current.value === null || prior.value === null) {
    return {
      comparable: false,
      delta: null,
      note: 'One of these periods has no measurable value, so there is no difference to state.',
    };
  }

  return {
    comparable: true,
    delta: current.value - prior.value,
    note: `${currentDays}-day periods, both complete.`,
  };
};
