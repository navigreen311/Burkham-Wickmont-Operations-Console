/**
 * The health vocabulary - blueprint 11.8.
 *
 * Pure. The states and the way they combine are worth reading without a database, because the
 * whole module turns on one distinction.
 *
 * **`unmonitored` is a state, and it is not green.**
 *
 * 9.1 established that `null` is not zero. The same argument lands harder here, because the
 * default rendering of "no data" on a health dashboard is a green tick, and the person reading it
 * is deciding whether to go home. A component with no probe must say so, in the same place and the
 * same shape as a component that is failing - not by being absent from the list, which reads as
 * nothing to report.
 *
 * There is deliberately no way to construct a `healthy` verdict without a probe having run. The
 * only functions that produce one take a measurement.
 */

export type HealthState = 'failing' | 'degraded' | 'healthy' | 'unmonitored';

/** Worst first. Order is used for `worstOf`, never for an average - see below. */
export const HEALTH_STATES: readonly HealthState[] = [
  'failing',
  'degraded',
  'unmonitored',
  'healthy',
];

/**
 * `unmonitored` sits between `degraded` and `healthy`, and the placement is a judgement worth
 * stating.
 *
 * It is not worse than `degraded`: a component nobody watches is not evidence of a problem. It is
 * worse than `healthy`, because "we are not looking" cannot be reported as "it is fine". Placing
 * it above `healthy` would make an unmonitored system look worse than a broken one; placing it
 * below would make it look fine.
 */
export const healthRank = (state: HealthState): number => HEALTH_STATES.indexOf(state);

export interface ComponentHealth {
  readonly key: string;
  readonly label: string;
  readonly state: HealthState;
  /** The measurement behind the verdict, when there is one. */
  readonly measurement: string | null;
  /** Always present, including on `healthy`. On `unmonitored` it says what would monitor it. */
  readonly detail: string;
}

/**
 * A component that is measured and fine.
 *
 * Takes the measurement as a required argument. That is the structural half of the decision: there
 * is no way to say `healthy` without saying what was measured, so a component nobody probed cannot
 * accidentally be reported as working.
 */
export const healthy = (input: {
  key: string;
  label: string;
  measurement: string;
  detail: string;
}): ComponentHealth => ({
  key: input.key,
  label: input.label,
  state: 'healthy',
  measurement: input.measurement,
  detail: input.detail,
});

export const degraded = (input: {
  key: string;
  label: string;
  measurement: string;
  detail: string;
}): ComponentHealth => ({
  key: input.key,
  label: input.label,
  state: 'degraded',
  measurement: input.measurement,
  detail: input.detail,
});

export const failing = (input: {
  key: string;
  label: string;
  measurement: string;
  detail: string;
}): ComponentHealth => ({
  key: input.key,
  label: input.label,
  state: 'failing',
  measurement: input.measurement,
  detail: input.detail,
});

/**
 * A component nothing watches.
 *
 * `wouldRequire` is required, so an unmonitored component names what would monitor it. "Uptime:
 * unmonitored" teaches a reader to ignore the row; "Uptime: unmonitored - no metrics backend is
 * connected" tells them what to build.
 */
export const unmonitored = (input: {
  key: string;
  label: string;
  wouldRequire: string;
}): ComponentHealth => ({
  key: input.key,
  label: input.label,
  state: 'unmonitored',
  measurement: null,
  detail: `Not monitored. ${input.wouldRequire}`,
});

/**
 * The worst state present.
 *
 * Never an average, for 6.5's reason: averaging one failing component with nine healthy ones
 * produces "mostly fine", and the one that is failing is the only one anybody needed to know
 * about.
 */
export const worstOf = (components: readonly ComponentHealth[]): HealthState => {
  if (components.length === 0) {
    // An empty check is not a healthy system. It is a system nobody checked.
    return 'unmonitored';
  }
  return components.reduce<HealthState>(
    (worst, component) =>
      healthRank(component.state) < healthRank(worst) ? component.state : worst,
    'healthy',
  );
};

export interface HealthSummary {
  readonly overall: HealthState;
  readonly components: readonly ComponentHealth[];
  readonly counts: Readonly<Record<HealthState, number>>;
  readonly checkedAt: string;
  readonly detail: string;
}

export const summarise = (
  components: readonly ComponentHealth[],
  checkedAt: Date,
): HealthSummary => {
  const counts = Object.fromEntries(HEALTH_STATES.map((state) => [state, 0])) as Record<
    HealthState,
    number
  >;
  for (const component of components) counts[component.state] += 1;

  const overall = worstOf(components);

  return {
    overall,
    components: [...components].sort(
      (a, b) => healthRank(a.state) - healthRank(b.state) || a.key.localeCompare(b.key),
    ),
    counts,
    checkedAt: checkedAt.toISOString(),
    detail: `${counts.failing} failing, ${counts.degraded} degraded, ${counts.unmonitored} unmonitored, ${counts.healthy} healthy. Overall is the WORST component, never an average - a system with one failing component is not "mostly fine".`,
  };
};
