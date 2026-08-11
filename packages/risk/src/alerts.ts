/**
 * 6.1 Risk & Defense Alerts - the full three-tier system.
 *
 * **The tiers are not specified anywhere, and that is the first thing to say.** Blueprint 6.1
 * asks for "Yellow / Orange / Red alerts per specification; each level defines who is notified,
 * script used, options offered, human review requirement, whether new funding is frozen".
 * `specifications-v2.md` names the three colours exactly once, in a list of Ledger event types.
 * There is no specification behind the phrase "per specification".
 *
 * So `TIER_POLICY` below is a **judgement expressed as data**, in the shape 6.4's
 * `DO_NOT_FUND_PERMITTED_ACTIONS`, 6.5's `RISK_EVENT_CLASSIFICATION` and 6.3's `KIND_POLICY`
 * already use - with the reasoning written beside each entry so the argument is with the reasoning
 * rather than with the colour. **A person should confirm these**, the same way 7.2 seeded state
 * rules as drafts saying "counsel should confirm" instead of inventing a rule.
 *
 * **The `script used` half is deliberately not here.** A script is client-facing copy. Inventing
 * what we say to a client whose cash position is deteriorating would be fabricating the most
 * consequential sentences in the module, and 4.1 owns client communication and its templates go
 * through the Compliance Scanner. `scriptTemplateKey` names the template each tier would use and
 * `NO_SCRIPT_YET` records that none exists, so the gap points somewhere instead of being filled.
 *
 * **The primary source does not exist.** Blueprint 6.1 says alerts are "sourced primarily from
 * Plaid feeds" - utilization changes, NSF events, cash balance deterioration. Plaid is gated
 * pending Argus security review, so none of those can fire. `alertStanding` reports that
 * explicitly, because an empty alert list on a client whose bank feed nobody is reading must not
 * render as a client with nothing wrong. This is `UNPRODUCED_RISK_SOURCES`' argument, applied to
 * the module that would otherwise be the reassuring one.
 *
 * Categorical throughout. `worstTier` takes the worst, never a mean - 6.5's rule, and the reason
 * there is no "risk score" anywhere in this package.
 */

import { db } from '@bwc/db';
import { append } from '@bwc/ledger';
import { findActor } from '@bwc/identity';
import { noData, ok, refused, type EventActor, type Outcome } from '@bwc/core';
import { conductStanding } from './conduct.js';
import { worstSeverity } from './classify.js';
import { observationsFor } from './observations.js';

export const ALERT_TIERS = ['yellow', 'orange', 'red'] as const;
export type AlertTier = (typeof ALERT_TIERS)[number];

export type AlertState = 'open' | 'acknowledged' | 'resolved';

/** Ordinal for comparison only. Never averaged, never published as a number. */
export const tierRank = (tier: AlertTier): number => ALERT_TIERS.indexOf(tier);

/**
 * The worst of a set, or null for an empty set.
 *
 * Null, not `yellow`. A client with no alerts and a client at the mildest tier are different
 * facts, and 6.5's `worstOf` makes the same distinction for the same reason.
 */
export const worstTier = (tiers: readonly AlertTier[]): AlertTier | null =>
  tiers.length === 0
    ? null
    : (tiers.reduce((worst, tier) => (tierRank(tier) > tierRank(worst) ? tier : worst)) ?? null);

/** Resolving an alert is a Level 3 decision at red, and a Level 2 one below it. */
export const RESOLVE_AUTHORITY_LEVEL: Readonly<Record<AlertTier, number>> = {
  yellow: 2,
  orange: 2,
  red: 3,
};

/** No client-facing script exists for any tier. See the header. */
export const NO_SCRIPT_YET =
  '4.1 owns client communication and no template has been written or scanned for this tier. A script invented here would be the most consequential sentences in the module, written by the party with the least standing to write them.';

export interface TierPolicy {
  /** Which Village department the alert goes to. */
  readonly notifies: string;
  /** Whether a human must review before the alert can be resolved at all. */
  readonly humanReviewRequired: boolean;
  /**
   * Whether an open alert at this tier freezes NEW funding.
   *
   * Freezing is not the Firewall (6.2) and not a Do Not Fund listing (6.4) - both of those
   * outrank this and are separate determinations. This is narrower: it stops new placement while
   * a serious unreviewed signal is outstanding.
   */
  readonly freezesNewFunding: boolean;
  /** What the client can be offered. Options, not a script. */
  readonly optionsOffered: readonly string[];
  /** The 4.1 template that would carry this tier's message. None exists yet. */
  readonly scriptTemplateKey: string;
  /** Why this tier is drawn where it is. The argument is with this, not with the colour. */
  readonly rationale: string;
}

/**
 * The per-tier decision, in one table so that adding a tier means making the decision.
 *
 * **These five judgements are not in the specification and a person should confirm them.**
 */
export const TIER_POLICY: Readonly<Record<AlertTier, TierPolicy>> = {
  yellow: {
    notifies: 'risk_and_defense',
    humanReviewRequired: false,
    freezesNewFunding: false,
    optionsOffered: ['monitoring_continues', 'client_check_in'],
    scriptTemplateKey: 'risk.alert.yellow',
    rationale:
      'Something moved that is worth watching and is not yet worth acting on. Freezing funding here would mean a client with one soft signal cannot be placed, which turns the mildest tier into the most expensive one and teaches everybody to avoid raising it.',
  },
  orange: {
    notifies: 'risk_and_defense',
    humanReviewRequired: true,
    freezesNewFunding: true,
    optionsOffered: ['restructure_review', 'capital_pause', 'client_check_in'],
    scriptTemplateKey: 'risk.alert.orange',
    rationale:
      'A human owes this client a decision. New funding waits for that decision rather than racing it - placing more capital into a position somebody is about to say is unsuitable is the specific harm 6.2 exists to prevent, arriving through a door 6.2 does not watch.',
  },
  red: {
    notifies: 'compliance_and_evidence',
    humanReviewRequired: true,
    freezesNewFunding: true,
    optionsOffered: ['immediate_restructure_review', 'capital_freeze', 'escalate_to_firewall'],
    scriptTemplateKey: 'risk.alert.red',
    rationale:
      'Routed to Compliance & Evidence rather than Risk & Defense, because at this tier the question is whether the Firewall should fire and only Compliance & Evidence can clear one. Resolution takes Level 3 for the same reason.',
  },
};

/**
 * Facts blueprint 6.1 names as the PRIMARY alert source that nothing produces.
 *
 * Every one of them is a Plaid feed. The module is therefore currently fed by conduct breaches
 * and hand-recorded observations only, which is a fraction of what it is supposed to watch.
 */
export const UNAVAILABLE_ALERT_SOURCES: readonly {
  readonly signal: string;
  readonly awaiting: string;
}[] = [
  {
    signal: 'Utilization change',
    awaiting: 'Plaid transaction feed (11.5), gated pending Argus security review and a DPA',
  },
  {
    signal: 'NSF event',
    awaiting: 'Plaid transaction feed (11.5), gated pending Argus security review and a DPA',
  },
  {
    signal: 'Cash balance deterioration',
    awaiting: 'Plaid balance feed (11.5), gated pending Argus security review and a DPA',
  },
];

export interface RiskAlert {
  readonly id: string;
  readonly clientId: string;
  readonly tier: AlertTier;
  readonly state: AlertState;
  readonly source: string;
  readonly summary: string;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
}

interface Row {
  id: string;
  clientId: string;
  tier: string;
  state: string;
  source: string;
  summary: string;
  detectedAt: Date;
  resolvedAt: Date | null;
}

const toAlert = (row: Row): RiskAlert => ({
  id: row.id,
  clientId: row.clientId,
  tier: row.tier as AlertTier,
  state: row.state as AlertState,
  source: row.source,
  summary: row.summary,
  detectedAt: row.detectedAt.toISOString(),
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
});

export interface RaiseInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly tier: AlertTier;
  readonly source: string;
  readonly summary: string;
  readonly detectedAt: Date;
  readonly actor: EventActor;
}

/**
 * Raise an alert.
 *
 * Automatic in: a detector raises this unattended, at any authority level, because the asymmetry
 * runs the same way 6.4's fail-closed allow-list does - an alert raised in error is visible
 * immediately and costs a human five minutes, and an alert nobody raised is the one that mattered.
 */
export const raiseAlert = async (input: RaiseInput): Promise<Outcome<RiskAlert>> => {
  if (input.summary.trim().length < 10) {
    return refused(
      'An alert needs a summary somebody can read. A tier with no description is a colour on a screen that nobody can act on.',
      'Blueprint 6.1 - alert history and response workflow',
    );
  }

  if (input.source.trim().length < 3) {
    return refused(
      'An alert needs a source. A risk fact with no provenance is a rumour - 6.5 makes the same demand of an observation.',
      'Principle 8 - provenance on output',
    );
  }

  const row = await db().riskAlert.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      tier: input.tier,
      source: input.source,
      summary: input.summary,
      detectedAt: input.detectedAt,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.alert.raised',
    actor: input.actor,
    clientId: input.clientId,
    payload: {
      alertId: row.id,
      tier: input.tier,
      source: input.source,
      freezesNewFunding: TIER_POLICY[input.tier].freezesNewFunding,
    },
  });

  return ok(toAlert(row));
};

/** A human has seen it. Explicitly NOT resolution - acknowledging is not fixing. */
export const acknowledgeAlert = async (input: {
  tenantId: string;
  alertId: string;
  acknowledgedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<RiskAlert>> => {
  const now = input.now ?? new Date();

  const row = await db().riskAlert.findFirst({
    where: { tenantId: input.tenantId, id: input.alertId },
  });
  if (!row) return noData(`No risk alert ${input.alertId} is on record.`);
  if (row.state !== 'open') {
    return refused(
      `That alert is already '${row.state}'.`,
      'Blueprint 6.1 - response workflow states',
    );
  }

  const updated = await db().riskAlert.update({
    where: { id: row.id },
    data: { state: 'acknowledged', acknowledgedBy: input.acknowledgedBy, acknowledgedAt: now },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.alert.acknowledged',
    actor: input.actor,
    clientId: row.clientId,
    payload: { alertId: row.id, tier: row.tier, acknowledgedBy: input.acknowledgedBy },
  });

  return ok(toAlert(updated));
};

/**
 * Resolve an alert.
 *
 * Human out, and the level rises with the tier. A resolution note is required: "it stopped
 * mattering" is a decision somebody makes, and the record has to say who and why. Nothing here
 * lets time resolve an alert - see `alertStanding`.
 */
export const resolveAlert = async (input: {
  tenantId: string;
  alertId: string;
  note: string;
  resolvedBy: string;
  actor: EventActor;
  now?: Date;
}): Promise<Outcome<RiskAlert>> => {
  const now = input.now ?? new Date();

  if (input.note.trim().length < 10) {
    return refused(
      'Resolving an alert needs a note somebody can read back. What made this stop mattering is the whole content of the resolution.',
      'Blueprint 6.1 - resolution records',
    );
  }

  const row = await db().riskAlert.findFirst({
    where: { tenantId: input.tenantId, id: input.alertId },
  });
  if (!row) return noData(`No risk alert ${input.alertId} is on record.`);
  if (row.state === 'resolved') {
    return refused('That alert is already resolved.', 'Blueprint 6.1 - resolution records');
  }

  const tier = row.tier as AlertTier;
  const required = RESOLVE_AUTHORITY_LEVEL[tier];
  const actor = await findActor(input.resolvedBy);
  if (!actor || actor.kind !== 'human' || actor.authorityLevel < required) {
    return refused(
      `Resolving a ${tier} alert requires a human at Authority Level ${required}. ${TIER_POLICY[tier].rationale}`,
      'Principle 4 with blueprint 6.1 - human review requirement per tier',
    );
  }

  const updated = await db().riskAlert.update({
    where: { id: row.id },
    data: {
      state: 'resolved',
      resolvedBy: input.resolvedBy,
      resolvedAt: now,
      resolutionNote: input.note,
    },
  });

  await append({
    tenantId: input.tenantId,
    type: 'risk.alert.resolved',
    actor: input.actor,
    clientId: row.clientId,
    payload: { alertId: row.id, tier: row.tier, resolvedBy: input.resolvedBy },
  });

  return ok(toAlert(updated));
};

export interface AlertStanding {
  readonly clientId: string;
  /** The worst OPEN or ACKNOWLEDGED tier. Null when there are none - null is not `yellow`. */
  readonly worstOpenTier: AlertTier | null;
  readonly openCount: number;
  readonly acknowledgedCount: number;
  /** True when any unresolved alert's tier freezes new funding. */
  readonly freezesNewFunding: boolean;
  /** Signals blueprint 6.1 calls primary that nothing currently produces. */
  readonly unavailableSources: readonly { signal: string; awaiting: string }[];
  readonly explanation: string;
}

/**
 * A client's alert standing.
 *
 * **Staleness hardens here, and the direction is the decision** (ADR-0013, ADR-0044). An alert
 * that has been open for ninety days is not less true than it was on day one - nothing about
 * elapsed time investigates a cash position. If anything an old unreviewed red alert is worse
 * news than a new one, because it says the review nobody did is now ninety days overdue. So there
 * is no expiry, no auto-resolution, and no decay: an alert leaves this set when a human resolves
 * it and in no other way.
 *
 * The opposite choice would have been the comfortable one, and it is exactly the shape that lets
 * a serious signal disappear from a screen without anybody deciding it should.
 */
export const alertStanding = async (tenantId: string, clientId: string): Promise<AlertStanding> => {
  const rows = await db().riskAlert.findMany({
    where: { tenantId, clientId, state: { in: ['open', 'acknowledged'] } },
    orderBy: [{ detectedAt: 'asc' }, { seq: 'asc' }],
  });

  const tiers = rows.map((row) => row.tier as AlertTier);
  const worst = worstTier(tiers);
  const freezes = tiers.some((tier) => TIER_POLICY[tier].freezesNewFunding);

  const open = rows.filter((row) => row.state === 'open').length;
  const acknowledged = rows.filter((row) => row.state === 'acknowledged').length;

  return {
    clientId,
    worstOpenTier: worst,
    openCount: open,
    acknowledgedCount: acknowledged,
    freezesNewFunding: freezes,
    unavailableSources: UNAVAILABLE_ALERT_SOURCES,
    explanation:
      worst === null
        ? `No unresolved alerts. That is not the same as nothing being wrong: ${UNAVAILABLE_ALERT_SOURCES.length} of the signals blueprint 6.1 calls the primary source come from Plaid feeds that are gated pending security review, so nothing is watching for them.`
        : `Worst unresolved tier is ${worst} (${open} open, ${acknowledged} acknowledged). ${freezes ? 'New funding is frozen while it stands.' : 'New funding is not frozen at this tier.'} ${TIER_POLICY[worst].rationale}`,
  };
};

/**
 * Derive alerts a client's existing risk record already justifies.
 *
 * Reads 6.3's conduct standing and 6.5's timeline. This is the whole of what 6.1 can currently
 * see, and it is deliberately a thin mapping rather than a scoring model - the tier comes from
 * the severity somebody already assigned, not from a fresh judgement made here.
 */
export const deriveAlerts = async (
  tenantId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<readonly { tier: AlertTier; source: string; summary: string }[]> => {
  const [standing, observations] = await Promise.all([
    conductStanding(tenantId, clientId, now),
    observationsFor(tenantId, clientId),
  ]);

  const derived: { tier: AlertTier; source: string; summary: string }[] = [];

  // The tier comes from the severity somebody already assigned to the breach, not from a fresh
  // judgement made here. Worst-of over open breaches, never a count and never an average.
  const worstOpen = worstSeverity(standing.openBreaches.map((breach) => breach.severity));

  if (worstOpen === 'critical') {
    derived.push({
      tier: 'red',
      source: '6.3 Client Conduct Monitoring',
      summary: 'An unresolved critical conduct breach is on record for this client.',
    });
  } else if (worstOpen === 'serious') {
    derived.push({
      tier: 'orange',
      source: '6.3 Client Conduct Monitoring',
      summary: 'An unresolved serious conduct breach is on record for this client.',
    });
  }

  const recentCritical = observations.filter((observation) => observation.severity === 'critical');
  if (recentCritical.length > 0) {
    derived.push({
      tier: 'orange',
      source: '6.5 Risk Event Timeline',
      summary: `${recentCritical.length} critical risk observation(s) are on this client's timeline.`,
    });
  }

  return derived;
};

export const alertsFor = async (
  tenantId: string,
  clientId: string,
): Promise<readonly RiskAlert[]> => {
  const rows = await db().riskAlert.findMany({
    where: { tenantId, clientId },
    orderBy: [{ detectedAt: 'desc' }, { seq: 'desc' }],
  });
  return rows.map(toAlert);
};
