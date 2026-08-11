/**
 * What may be configured, and what may not - blueprint 11.7.
 *
 * Pure. The registry is data, so the line between a policy choice and a control is something a
 * person can read in one place and argue with.
 *
 * **This is the file that decides whether the admin surface can turn the compliance system off.**
 *
 * Blueprint 11.7 lists what is configurable: "offers, pricing, success fees, templates, playbooks,
 * authority levels, state rules, lender profiles, partner rules, risk thresholds, KPI targets,
 * notification rules, escalation rules". Taken literally, that is a screen where somebody sets the
 * TCPA quiet-hours window to 24 hours, or adds `guarantee_approval` to the permitted-action list,
 * or removes California from the all-party recording-consent states. Each of those is one field on
 * a "non-technical admin surface", and each turns off a control the rest of the system is built
 * around.
 *
 * So every tunable constant in this codebase is one of two kinds:
 *
 *   PARAMETER  a genuine policy choice with a defensible range - a review cadence, an inactivity
 *              window, a KPI target. Configurable, bounded, audited, reversible.
 *
 *   INVARIANT  law, or something the architecture depends on. TCPA quiet hours. The Level 4
 *              prohibited-action list. All-party consent states. Compliance state categories.
 *
 * **Invariants are not permission-gated; they are absent.** A "Level 4 required" flag would be a
 * permission somebody eventually holds - and the person most likely to hold it is the one under
 * pressure to make a number move. There is no code path here that writes an invariant, so the
 * screen cannot show one and the API cannot accept one.
 *
 * Each invariant carries `whyFixed`, so "why can't I change this" is answered by the system rather
 * than by whoever remembers.
 *
 * The one import is two constants from `@bwc/identity`, which owns the code the client MFA mandate
 * governs. The key and the default are declared beside their enforcement rather than here, so the
 * registry entry and the check cannot come to disagree about which key they mean.
 */

/**
 * `flag` is a parameter that is on or off, carried as 0 or 1.
 *
 * It reuses the numeric pipeline rather than introducing a second value type: bounds of 0-1 with
 * the whole-number rule already refuse 2 and 0.5, and the audit trail, staging, rollback and
 * history all keep working unchanged. A boolean column beside `newValue` would have been a second
 * representation of "the value" for every reader of a change row to remember to check.
 */
import { CLIENT_MFA_REQUIRED_DEFAULT, CLIENT_MFA_REQUIRED_KEY } from '@bwc/identity';

export type ParameterKind =
  'days' | 'hours' | 'count' | 'percent' | 'basis_points' | 'ratio' | 'flag';

export interface Parameter {
  /** Stable key. `<package>.<CONSTANT_NAME>`, so a reader can find the code it governs. */
  readonly key: string;
  readonly label: string;
  readonly kind: ParameterKind;
  readonly compiledDefault: number;
  /** Inclusive bounds. A value outside them is refused, naming them. */
  readonly minimum: number;
  readonly maximum: number;
  /** Why the bounds are what they are. A range with no reasoning is a guess with a fence. */
  readonly boundsBasis: string;
  /** Who should be making this call. Not enforced here; shown so the change lands with them. */
  readonly owner: string;
  /**
   * True when a change should be staged rather than taking effect at once.
   *
   * Blueprint 11.7 asks for "staged rollout for high-risk changes". High risk here means a change
   * that alters what the system does to CLIENTS rather than to internal queues.
   */
  readonly highRisk: boolean;
}

/**
 * The configurable parameters.
 *
 * Deliberately shorter than the list of constants in the codebase. Most constants are not policy
 * choices, and a registry that included them all would be a registry nobody could review.
 */
export const PARAMETERS: readonly Parameter[] = [
  {
    key: 'governance.MAXIMUM_REVIEW_CADENCE_DAYS',
    label: 'Capital provider review cadence (maximum)',
    kind: 'days',
    compiledDefault: 90,
    minimum: 30,
    maximum: 90,
    boundsBasis:
      'Blueprint 5.4 states a quarterly minimum, so 90 is a ceiling and not a default to raise. A tenant may review more often; it may not review less often than the specification requires.',
    owner: 'Capital Product Governance Board',
    highRisk: true,
  },
  {
    key: 'risk.DEFAULT_REVIEW_CADENCE_DAYS',
    label: 'Do Not Fund listing review cadence',
    kind: 'days',
    compiledDefault: 90,
    minimum: 30,
    maximum: 365,
    boundsBasis:
      'A listing that outruns its cadence keeps blocking (ADR-0013), so a long cadence costs review attention rather than safety. A year is the point at which nobody remembers the original decision.',
    owner: 'Risk & Defense',
    highRisk: false,
  },
  {
    key: 'sales.INACTIVITY_DAYS',
    label: 'Lead inactivity before escalation',
    kind: 'days',
    compiledDefault: 45,
    minimum: 7,
    maximum: 120,
    boundsBasis:
      'Under a week escalates leads that are simply waiting on a document. Over four months, the escalation arrives after the lead is cold.',
    owner: 'Concierge Desk',
    highRisk: false,
  },
  {
    key: 'sales.RENEWAL_WINDOW_DAYS',
    label: 'Renewal window before committed term ends',
    kind: 'days',
    compiledDefault: 60,
    minimum: 14,
    maximum: 180,
    boundsBasis:
      'Long enough to have the conversation, short enough that the prompt is about this renewal rather than a general reminder.',
    owner: 'Concierge Desk',
    highRisk: false,
  },
  {
    key: 'sales.READINESS_DELTA_THRESHOLD',
    label: 'Readiness improvement that triggers an expansion prompt',
    kind: 'count',
    compiledDefault: 10,
    minimum: 5,
    maximum: 40,
    boundsBasis:
      'Below 5 points the prompt fires on measurement noise. Above 40 it fires for almost nobody, which is the same as switching it off without saying so.',
    owner: 'Concierge Desk',
    highRisk: false,
  },
  {
    key: 'partners.RECERTIFICATION_CADENCE_DAYS',
    label: 'Partner recertification cadence',
    kind: 'days',
    compiledDefault: 365,
    minimum: 90,
    maximum: 365,
    boundsBasis:
      'Blueprint 8.3 says "annual", so a year is the ceiling. Shortening it is a tightening a tenant may choose; lengthening it would let a partner speak for us on year-old training.',
    owner: 'Channel Partnerships',
    highRisk: true,
  },
  {
    key: 'governance.COMPLAINT_FLAG_THRESHOLD',
    label: 'Weighted provider complaint score that raises a flag',
    kind: 'count',
    compiledDefault: 5,
    minimum: 1,
    maximum: 20,
    boundsBasis:
      'Complaints are severity-weighted 1/2/5, so a threshold of 1 flags on a single minor complaint and 20 requires four serious ones. Both ends are defensible; beyond them the flag stops meaning anything.',
    owner: 'Capital Product Governance Board',
    highRisk: false,
  },
  {
    key: 'dashboards.HEALTHY_SHARE_TARGET',
    label: 'Compliance KPI target (share in Pass or Pass with Findings)',
    kind: 'ratio',
    compiledDefault: 0.9,
    minimum: 0.9,
    maximum: 1,
    boundsBasis:
      'Blueprint 9.1 states "Target: 90%+", so 0.9 is a floor. A tenant may hold itself to a higher standard; lowering the target would be moving the goalposts on the metric the specification set.',
    owner: 'Founder / Executive',
    highRisk: true,
  },
  {
    key: 'calls.CORRECTION_WINDOW_HOURS.critical',
    label: 'Correction window for a critical call promise',
    kind: 'hours',
    compiledDefault: 24,
    minimum: 4,
    maximum: 72,
    boundsBasis:
      'The client is making plans on what they heard. Beyond three days the correction arrives after they have told somebody else.',
    owner: 'Concierge Desk',
    highRisk: true,
  },
  {
    key: 'workflow.DEFAULT_LEASE_SECONDS',
    label: 'Task queue lease duration',
    kind: 'count',
    compiledDefault: 300,
    minimum: 30,
    maximum: 3600,
    boundsBasis:
      'Shorter than the longest task means a task is reclaimed while still running and executes twice. Longer than an hour means a crashed worker holds its work for an hour.',
    owner: 'CapitalForge Ops',
    highRisk: false,
  },
  {
    key: 'graph.GUARANTOR_CONCENTRATION_THRESHOLD',
    label: 'Guarantees by one person before concentration is raised',
    kind: 'count',
    compiledDefault: 3,
    minimum: 2,
    maximum: 10,
    boundsBasis:
      'Two guarantees is a person with two businesses. The threshold is about when to ASK, and a finding that fires at ten has stopped being a warning.',
    owner: 'Risk & Defense',
    highRisk: false,
  },
  {
    key: CLIENT_MFA_REQUIRED_KEY,
    label: 'Require a second factor for Client Portal sign-in',
    kind: 'flag',
    compiledDefault: CLIENT_MFA_REQUIRED_DEFAULT,
    minimum: 0,
    maximum: 1,
    boundsBasis:
      'On or off, and off is the compiled default. Staff MFA is mandatory in code and is not this setting (ADR-0032); this one governs CLIENTS, who cannot escalate to anybody but us when they are locked out. It is a parameter rather than an invariant because it can only turn a control ON: unset, the system behaves exactly as it did before, and no value of it removes a check that exists today.',
    owner: 'Compliance & Evidence',
    highRisk: true,
  },
];

export const parameterFor = (key: string): Parameter | null =>
  PARAMETERS.find((parameter) => parameter.key === key) ?? null;

export interface Invariant {
  readonly key: string;
  readonly label: string;
  /** The value, as a string, so a reader can see it without it being settable. */
  readonly value: string;
  /** Why it is not configurable. Answered by the system rather than by whoever remembers. */
  readonly whyFixed: string;
}

/**
 * The constants that are NOT configurable, and why.
 *
 * Present so the admin surface can show them as fixed with their reasoning, rather than being
 * silently absent - "I couldn't find the setting" and "the setting does not exist because it is
 * the law" are different answers, and only one of them stops somebody looking for a workaround.
 *
 * Nothing in this package writes to any of these. There is no code path, no permission level and
 * no override flag.
 */
export const INVARIANTS: readonly Invariant[] = [
  {
    key: 'comms.QUIET_HOURS',
    label: 'Calling and texting window',
    value: '08:00-21:00 local to the recipient',
    whyFixed:
      "TCPA. This is a statutory restriction on calls and texts, not a company policy, and the window is defined in the recipient's time zone rather than ours. A configurable version of this field is a configurable version of breaking the law.",
  },
  {
    key: 'core.PROHIBITED_ACTIONS',
    label: 'Level 4 prohibited actions',
    value:
      'sign_for_client, fabricate_revenue, alter_client_document, submit_without_consent, guarantee_approval, promise_credit_repair, mislabel_card_as_loan, hide_fees, give_legal_or_tax_advice_without_professional_review',
    whyFixed:
      'Specification v2 section 7.1: never allowed, by any actor, at any level, with any approval. There is no authority level that permits these, so there is no authority level that could edit the list.',
  },
  {
    key: 'core.AUTHORITY_LEVELS',
    label: 'Authority levels 0-3',
    value: '0 observe, 1 draft, 2 send with approval, 3 human approval',
    whyFixed:
      'The levels are the shape of the authority model, not a setting within it. Adding a level would mean every existing action comparison silently means something different.',
  },
  {
    key: 'calls.ALL_PARTY_CONSENT_STATES',
    label: 'All-party call-recording consent states',
    value: 'CA, FL, IL, MD, MA, MT, NH, OR, PA, WA, CT',
    whyFixed:
      'State criminal law. Recording a client without their consent in one of these states is a crime in the state where the CLIENT is sitting. The list changes when the law changes, which is a counsel review and a code change, not an admin screen.',
  },
  {
    key: 'core.COMPLIANCE_STATES',
    label: 'Compliance states',
    value: 'pending_assessment, pass, pass_with_findings, needs_review, fail',
    whyFixed:
      'Decision E. The states are categorical and deliberately have no ordering; a configurable set would invite a numeric one, which is the thing the decision exists to prevent.',
  },
  {
    key: 'dashboards.MINIMUM_DENOMINATOR',
    label: 'Minimum denominator before a rate is published',
    value: '10 decided outcomes',
    whyFixed:
      'ADR-0017. The denominator is smallest exactly when the temptation to quote a rate is highest, so a tenant able to lower it would lower it at the worst moment. A 100% approval rate over four decisions is the number most likely to end up in a marketing claim.',
  },
  {
    key: 'graph.CONTROLLING_OWNERSHIP_PERCENT',
    label: 'Controlling ownership threshold',
    value: '25 percent',
    whyFixed:
      "FinCEN's beneficial-ownership line. Underwriters run the same test, so a different number here would produce a graph that disagrees with the one the lender builds.",
  },
  {
    key: 'partners.MINIMUM_COHORT',
    label: 'Minimum cohort before a partner sees a stage breakdown',
    value: '5 referrals',
    whyFixed:
      'ADR-0014. It is the only thing standing between a partner and the identity of the individual clients they referred, and the pressure to lower it comes from the partner who has referred four.',
  },
  {
    key: 'billing.MONEY_UNIT',
    label: 'Money is integer cents; rates are basis points',
    value: 'cents; basis points',
    whyFixed:
      'ADR-0011. Not a setting - a representation the whole billing package depends on. A configurable unit would mean two figures in the same table meaning different things.',
  },
];

export const invariantFor = (key: string): Invariant | null =>
  INVARIANTS.find((invariant) => invariant.key === key) ?? null;

/** Whether this key names something the admin surface may write. */
export const isConfigurable = (key: string): boolean => parameterFor(key) !== null;

export interface BoundsCheck {
  readonly withinBounds: boolean;
  readonly detail: string;
}

/** Whether a proposed value is inside the parameter's declared bounds. */
export const checkBounds = (parameter: Parameter, value: number): BoundsCheck => {
  if (!Number.isFinite(value)) {
    return { withinBounds: false, detail: `${value} is not a finite number.` };
  }
  if (parameter.kind !== 'ratio' && !Number.isInteger(value)) {
    return {
      withinBounds: false,
      detail: `'${parameter.key}' is measured in ${parameter.kind} and takes a whole number; ${value} is not one.`,
    };
  }
  if (value < parameter.minimum || value > parameter.maximum) {
    return {
      withinBounds: false,
      detail: `${value} is outside the permitted range ${parameter.minimum}-${parameter.maximum} for '${parameter.key}'. ${parameter.boundsBasis}`,
    };
  }
  return {
    withinBounds: true,
    detail: `${value} is within ${parameter.minimum}-${parameter.maximum}.`,
  };
};
