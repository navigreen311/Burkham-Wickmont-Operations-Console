/**
 * 9.3 Agent Productivity Dashboard - engine only.
 *
 * **This is the module most able to produce a metric that punishes the right behaviour**, and
 * most of the work here is deciding which of blueprint 9.3's nine figures can be made honest.
 * Four can. Five cannot, and they are `unmeasurable` with the reason - 9.1's three refusals are
 * the precedent, and the argument for each refusal is written beside it rather than left as an
 * omission somebody later "fixes".
 *
 * The refusals are not squeamishness. Each names a specific way the number would move in the
 * wrong direction:
 *
 * **Error rate.** There is no record of an agent being wrong. There is a record of a human
 * changing something an agent drafted, which is a different fact - most edits are a human adding
 * context the agent could not have had. Reporting corrections as errors makes the safest possible
 * agent behaviour, drafting and handing over, look like the worst performance.
 *
 * **Human correction rate.** Same denominator problem, and worse incentives: the agents with the
 * highest correction rate are the ones working on the hardest files. Publishing it rewards taking
 * easy work.
 *
 * **Escalation rate.** Escalating is what an agent SHOULD do at the edge of its authority.
 * Principle 4 puts a Level 3 human at every consequential decision, so escalation is the control
 * working. A dashboard that counts escalations as a cost of an agent is a dashboard that teaches
 * agents not to escalate, which is the one failure this system cannot absorb.
 *
 * **Client satisfaction impact per agent.** Nothing measures client satisfaction, and attributing
 * it to one agent would require a causal claim nothing supports.
 *
 * **Cost per workflow.** 11.9 owns cost. Computing it here from a guess at model pricing would be
 * a second cost model, disagreeing with the first.
 *
 * What IS honest: counts of what actually happened. Tasks completed, cycle time from the Ledger's
 * own timestamps, blocked-action counts, and the department rollup of those. All of it is
 * volume and latency, and none of it is quality - which is stated in the note rather than left
 * for the reader to assume.
 */

import { db } from '@bwc/db';
import { measured, unmeasurable, type Metric, type Period } from './metric.js';

/**
 * Figures blueprint 9.3 names that cannot be made honest, and why.
 *
 * Exported so a test can assert the list has not quietly shrunk. A refusal that can be deleted
 * without anything failing is a refusal that will be deleted.
 */
export const REFUSED_PRODUCTIVITY_METRICS: readonly {
  readonly key: string;
  readonly label: string;
  readonly why: string;
  readonly wouldRequire: string;
}[] = [
  {
    key: 'error_rate',
    label: 'Error rate per agent',
    why: 'Nothing records an agent being wrong. What exists is a record of a human changing something an agent drafted, and most such edits are a human adding context the agent could not have had. Reporting corrections as errors makes drafting-and-handing-over - the safest behaviour available to an agent - look like the worst performance.',
    wouldRequire:
      'A human marking a correction as a defect rather than an improvement, at the moment they make it.',
  },
  {
    key: 'human_correction_rate',
    label: 'Human correction rate per agent',
    why: 'The agents with the highest correction rate are the ones working the hardest files. Published per agent, it rewards taking easy work, and the reward is invisible because the metric looks objective.',
    wouldRequire:
      'Case difficulty recorded independently of who worked it, so the rate could be read against it.',
  },
  {
    key: 'escalation_rate',
    label: 'Escalation rate per agent',
    why: 'Escalating at the edge of authority is the control working, not a cost. Principle 4 puts a Level 3 human at every consequential decision. A dashboard that counts escalations against an agent teaches agents not to escalate, and that is the one failure this system cannot absorb.',
    wouldRequire:
      'Nothing. This should not be published per agent at any point. Escalation volume is a department capacity signal and is reported that way below.',
  },
  {
    key: 'client_satisfaction_impact',
    label: 'Client satisfaction impact per agent',
    why: 'Nothing in this system measures client satisfaction, and attributing the experience a client had to one agent requires a causal claim nothing supports - clients are worked by several agents and a human.',
    wouldRequire: 'A satisfaction instrument, and a defensible attribution model. Neither exists.',
  },
  {
    key: 'cost_per_workflow',
    label: 'Cost per workflow per agent',
    why: '11.9 Cost & Performance Governance owns cost. Deriving it here from an assumed model price would be a second cost model that disagrees with the first, and the disagreement would surface in a unit-economics figure somebody had already acted on.',
    wouldRequire: '11.9 recording observed cost per agent action, which it does not yet do.',
  },
];

export interface AgentReading {
  readonly actorId: string;
  readonly department: string | null;
  readonly authorityLevel: number;
  /** Actions this actor completed in the window. A count, not a score. */
  readonly actionsCompleted: number;
  /** Actions the middleware refused. Reported for the DEPARTMENT, never as a per-agent failing. */
  readonly actionsBlocked: number;
  readonly meanSecondsBetweenActions: Metric<number>;
}

const secondsBetween = (timestamps: readonly Date[]): number | null => {
  if (timestamps.length < 2) return null;
  const sorted = [...timestamps].sort((left, right) => left.getTime() - right.getTime());
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return null;
  return Math.round((last.getTime() - first.getTime()) / 1000 / (sorted.length - 1));
};

/**
 * Per-agent volume and latency for a window.
 *
 * Reads the Ledger, which is the only record of what an agent actually did. Note what is absent:
 * there is no ratio here whose numerator is a judgement about quality, because no such judgement
 * is recorded anywhere in this system.
 */
export const agentProductivity = async (
  tenantId: string,
  period: Period,
): Promise<readonly AgentReading[]> => {
  const [actors, events] = await Promise.all([
    db().actor.findMany({
      where: { tenantId, kind: 'village_agent' },
      select: { id: true, department: true, authorityLevel: true },
      orderBy: { id: 'asc' },
    }),
    db().ledgerEvent.findMany({
      where: { tenantId, createdAt: { gte: period.from, lt: period.to } },
      select: { actorId: true, type: true, createdAt: true },
    }),
  ]);

  return actors.map((actor) => {
    const mine = events.filter((event) => event.actorId === actor.id);
    const blocked = mine.filter((event) => event.type === 'authority.action_blocked').length;
    const completed = mine.length - blocked;

    const gap = secondsBetween(mine.map((event) => event.createdAt));

    return {
      actorId: actor.id,
      department: actor.department,
      authorityLevel: actor.authorityLevel,
      actionsCompleted: completed,
      actionsBlocked: blocked,
      meanSecondsBetweenActions:
        gap !== null
          ? measured<number>({
              key: 'agent_mean_seconds_between_actions',
              label: 'Mean seconds between actions',
              value: gap,
              denominator: mine.length,
              period,
              note: `Mean gap across ${mine.length} action(s). This is pace, not productivity: an agent working one hard file slowly and an agent idle between easy ones produce the same number.`,
            })
          : unmeasurable<number>({
              key: 'agent_mean_seconds_between_actions',
              label: 'Mean seconds between actions',
              period,
              denominator: mine.length,
              note: `${mine.length} action(s) in the window - at least two are needed for a gap. One action is not infinite speed and it is not zero.`,
            }),
    };
  });
};

export interface DepartmentRollup {
  readonly department: string;
  readonly agents: number;
  readonly actionsCompleted: number;
  /**
   * Escalations and refusals, at DEPARTMENT level only.
   *
   * Deliberately not attributed to an agent. See `REFUSED_PRODUCTIVITY_METRICS`: an escalation is
   * the authority model working, and counting it against the agent who escalated teaches agents
   * not to. At department level it is a capacity signal - a department escalating more than it
   * used to may be under-resourced or may be seeing harder work, and both are worth asking about.
   */
  readonly actionsBlocked: number;
  readonly note: string;
}

export const departmentRollup = async (
  tenantId: string,
  period: Period,
): Promise<readonly DepartmentRollup[]> => {
  const readings = await agentProductivity(tenantId, period);

  const byDepartment = new Map<string, { agents: number; completed: number; blocked: number }>();
  for (const reading of readings) {
    const key = reading.department ?? 'unassigned';
    const current = byDepartment.get(key) ?? { agents: 0, completed: 0, blocked: 0 };
    byDepartment.set(key, {
      agents: current.agents + 1,
      completed: current.completed + reading.actionsCompleted,
      blocked: current.blocked + reading.actionsBlocked,
    });
  }

  return [...byDepartment.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([department, totals]) => ({
      department,
      agents: totals.agents,
      actionsCompleted: totals.completed,
      actionsBlocked: totals.blocked,
      note: `${totals.completed} action(s) across ${totals.agents} agent(s). Blocked actions are a department capacity signal, not a per-agent failing - the authority model refusing an action is the control working.`,
    }));
};

export interface ProductivityView {
  readonly period: Period;
  readonly agents: readonly AgentReading[];
  readonly departments: readonly DepartmentRollup[];
  /** Every figure 9.3 names that this module will not compute, with the reason. */
  readonly refused: readonly (typeof REFUSED_PRODUCTIVITY_METRICS)[number][];
  readonly note: string;
}

/**
 * The whole view.
 *
 * The `note` says what this dashboard is not, because a productivity dashboard is read as a
 * performance review whatever its header says, and the reader deserves to know that everything in
 * it is volume and latency.
 */
export const productivityView = async (
  tenantId: string,
  period: Period,
): Promise<ProductivityView> => {
  const [agents, departments] = await Promise.all([
    agentProductivity(tenantId, period),
    departmentRollup(tenantId, period),
  ]);

  return {
    period,
    agents,
    departments,
    refused: REFUSED_PRODUCTIVITY_METRICS,
    note: `Everything here is volume and latency. Nothing here is quality: this system records what an agent did and does not record whether it was any good, and the ${REFUSED_PRODUCTIVITY_METRICS.length} figures blueprint 9.3 asks for that would imply otherwise are listed with what would be needed to compute them honestly.`,
  };
};

/**
 * Degradation detection - blueprint 9.3's "degradation detection over time".
 *
 * Compares two windows and reports the DIRECTION of change in volume, with no threshold and no
 * verdict. A threshold here would be a number under which nobody looks, and the whole point of
 * degradation detection is the slow change nobody notices.
 *
 * It reports `unknown` rather than `steady` when either window is too thin to compare, because
 * "no change detected" and "not enough to detect a change in" are different statements and the
 * first is the reassuring one.
 */
export type Direction = 'increased' | 'decreased' | 'steady' | 'unknown';

/** Below this many actions in a window, a comparison is noise. */
export const MINIMUM_ACTIONS_TO_COMPARE = 10;

export const volumeDirection = (current: number, prior: number): Direction => {
  if (current < MINIMUM_ACTIONS_TO_COMPARE || prior < MINIMUM_ACTIONS_TO_COMPARE) return 'unknown';
  if (current === prior) return 'steady';
  return current > prior ? 'increased' : 'decreased';
};
