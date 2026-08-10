/**
 * The Risk Event Timeline - blueprint 6.5.
 *
 * Chronological, per client, risk-classified. Assembled at read time from the Ledger and the
 * observation table; **nothing is copied**. A stored timeline would be a second record of events
 * that already have one, and the two would disagree the first time a projection job failed - with
 * no way to tell which was right.
 *
 * 7.1 already assembles a client file, so the obvious question is whether this duplicates it. It
 * does not, and the difference is the question each answers. 7.1 asks *did we look everywhere*,
 * and its shape is per-module sections with a coverage verdict. 6.5 asks *what has happened to
 * this client*, and its shape is one sequence in time with a severity. The same underlying facts
 * answer both, and neither ordering can be recovered from the other without the classification
 * table this module owns.
 *
 * What the timeline will not do is produce a number. Blueprint 6.5 asks for a chronology, and a
 * "risk score" summarising it would be the thing people read instead of the events - the same
 * argument Decision E makes about compliance state, and the same one 1.2 makes about graph risk.
 */

import { read } from '@bwc/ledger';
import { classify, worstSeverity, type Severity } from './classify.js';
import { observationsFor } from './observations.js';
import { listingHistory } from './listings.js';
import { UNPRODUCED_RISK_SOURCES } from './classify.js';

export interface TimelineEntry {
  /** `ledger` or `observation`. A reader deciding how much to trust a row asks this first. */
  readonly origin: 'ledger' | 'observation';
  readonly at: string;
  readonly severity: Severity;
  /** The ledger event type, or the observation kind. */
  readonly kind: string;
  readonly meaning: string;
  readonly detail: string;
  readonly actorId: string | null;
  /** The ledger sequence number, for a reader who wants to find the event itself. */
  readonly seq: number | null;
  readonly reference: string;
}

export interface Timeline {
  readonly clientId: string;
  readonly entries: readonly TimelineEntry[];
  /** Counts per severity. A tally, not a score - nothing is summed across severities. */
  readonly counts: Readonly<Record<Severity, number>>;
  /** The worst severity present, or `null` for a clean timeline. */
  readonly worst: Severity | null;
  /** The Do Not Fund listing in force, described in one line. `null` when the client is not listed. */
  readonly doNotFund: string | null;
  /**
   * Risk facts nothing in this system produces yet.
   *
   * Present on every timeline, including an empty one - especially an empty one. A timeline with
   * no entries and no caveat reads as a client with no risk history, when what it means is that
   * the four integrations that would find one are not connected.
   */
  readonly unmonitored: readonly { readonly fact: string; readonly awaiting: string }[];
}

export interface TimelineFilter {
  /** Only entries at this severity or worse. `serious` includes `critical`. */
  readonly minimumSeverity?: Severity;
  readonly from?: Date;
  readonly to?: Date;
  /** Case-insensitive substring match across kind, meaning and detail. Blueprint 6.5: searchable. */
  readonly search?: string;
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'serious', 'notable', 'context'];

const atLeast = (severity: Severity, minimum: Severity): boolean =>
  SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(minimum);

/**
 * One line describing a ledger event, built from its payload.
 *
 * Deliberately generic. A per-event-type formatter would be a second place the vocabulary lives,
 * and it would fall behind the classification table the first time somebody added an event and
 * updated only one of them.
 */
const describePayload = (payload: Record<string, unknown>): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no further detail recorded';
};

/**
 * Assemble the timeline.
 *
 * Reads every event for the client and keeps the ones the classification table names. Filtering in
 * memory rather than in SQL because the set of risk-relevant types is the table's to decide, and a
 * `WHERE type IN (...)` built from it would put the same judgement in two places.
 */
export const timelineFor = async (
  tenantId: string,
  clientId: string,
  filter: TimelineFilter = {},
  now: Date = new Date(),
): Promise<Timeline> => {
  const [events, observations, listings] = await Promise.all([
    read({ tenantId, clientId }),
    observationsFor(tenantId, clientId),
    listingHistory(tenantId, clientId, now),
  ]);

  const fromLedger: TimelineEntry[] = [];
  for (const event of events) {
    const classification = classify(event.type);
    if (!classification) continue;
    fromLedger.push({
      origin: 'ledger',
      at: event.createdAt.toISOString(),
      severity: classification.severity,
      kind: event.type,
      meaning: classification.meaning,
      detail: describePayload(event.payload),
      actorId: event.actor.id,
      seq: event.seq,
      reference: `ledger:${event.seq}`,
    });
  }

  const fromObservations: TimelineEntry[] = observations.map((observation) => ({
    origin: 'observation' as const,
    at: observation.occurredAt,
    severity: observation.severity,
    kind: observation.kind,
    meaning: observation.summary,
    detail: `Source: ${observation.source}. Recorded ${observation.recordedAt.slice(0, 10)}.`,
    actorId: observation.recordedBy,
    seq: null,
    reference: `observation:${observation.id}`,
  }));

  let entries = [...fromLedger, ...fromObservations].sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    if (byTime !== 0) return byTime;
    // Two events at the same instant: the ledger's sequence is the tiebreak, because it is the
    // real order. Observations, which have no sequence, sort after - they were written later
    // whatever their occurredAt says.
    return (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER);
  });

  if (filter.minimumSeverity !== undefined) {
    const minimum = filter.minimumSeverity;
    entries = entries.filter((entry) => atLeast(entry.severity, minimum));
  }
  if (filter.from !== undefined) {
    const from = filter.from.toISOString();
    entries = entries.filter((entry) => entry.at >= from);
  }
  if (filter.to !== undefined) {
    const to = filter.to.toISOString();
    entries = entries.filter((entry) => entry.at <= to);
  }
  if (filter.search !== undefined && filter.search.trim() !== '') {
    const needle = filter.search.trim().toLowerCase();
    entries = entries.filter((entry) =>
      `${entry.kind} ${entry.meaning} ${entry.detail}`.toLowerCase().includes(needle),
    );
  }

  const counts: Record<Severity, number> = { critical: 0, serious: 0, notable: 0, context: 0 };
  for (const entry of entries) counts[entry.severity] += 1;

  const active = listings.find((listing) => listing.status === 'listed') ?? null;

  return {
    clientId,
    entries,
    counts,
    worst: worstSeverity(entries.map((entry) => entry.severity)),
    doNotFund: active
      ? `Listed ${active.listedAt.slice(0, 10)} (${active.trigger})${active.reviewOverdue ? ', review overdue' : ''}: ${active.justification}`
      : null,
    unmonitored: UNPRODUCED_RISK_SOURCES,
  };
};
