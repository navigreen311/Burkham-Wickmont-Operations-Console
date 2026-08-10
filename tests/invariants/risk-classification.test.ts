/**
 * The risk classification table - 6.5, pure, no database.
 *
 * Tests the judgements rather than the plumbing: that severity never averages, that an unlisted
 * event type is not a risk event, and that the unmonitored list actually names where each gap
 * would be filled from. The last one matters because a gap that points nowhere is a shrug.
 */

import { describe, expect, it } from 'vitest';
import {
  RISK_EVENT_CLASSIFICATION,
  SEVERITIES,
  UNPRODUCED_RISK_SOURCES,
  classify,
  isRiskEvent,
  worstSeverity,
  type Severity,
} from '@bwc/risk';

describe('risk classification', () => {
  it('takes the worst severity and never the average', () => {
    // A fraud indicator alongside two trivia is a fraud indicator. Averaging would produce
    // "notable", which describes neither event and reassures the reader about the wrong one.
    expect(worstSeverity(['context', 'critical', 'notable'])).toBe('critical');
    expect(worstSeverity(['context', 'context'])).toBe('context');
  });

  it('reports null for a clean timeline rather than the best severity', () => {
    // `null` is "nothing happened". Returning `context` would be a claim about an event that
    // does not exist.
    expect(worstSeverity([])).toBeNull();
  });

  it('does not treat an unlisted event type as a risk event', () => {
    // The Ledger carries every state change. A timeline that included all of them would bury the
    // four events that matter under four hundred that do not.
    expect(isRiskEvent('workflow.task_dispatched')).toBe(false);
    expect(classify('workflow.task_dispatched')).toBeNull();
  });

  it('classifies every Do Not Fund event, because the listing is the point of the timeline', () => {
    for (const type of [
      'risk.do_not_fund.listed',
      'risk.do_not_fund.removed',
      'risk.do_not_fund.override_granted',
      'risk.do_not_fund.override_consumed',
    ]) {
      expect(isRiskEvent(type), type).toBe(true);
    }
    expect(classify('risk.do_not_fund.listed')?.severity).toBe('critical');
  });

  it('gives every classified event a meaning a reader can act on', () => {
    for (const [type, classification] of Object.entries(RISK_EVENT_CLASSIFICATION)) {
      expect(SEVERITIES, type).toContain(classification?.severity as Severity);
      // A meaning of "firewall.triggered" would be the event name again, which tells a reviewer
      // nothing they did not already have.
      expect(classification?.meaning.length, type).toBeGreaterThan(20);
      expect(classification?.meaning, type).not.toContain(type);
    }
  });

  it('names where each unmonitored risk fact would come from', () => {
    expect(UNPRODUCED_RISK_SOURCES.length).toBeGreaterThan(0);
    for (const source of UNPRODUCED_RISK_SOURCES) {
      // "We do not monitor missed payments" is a shrug. "Awaiting Plaid, pending security review"
      // is a gap somebody can close.
      expect(source.awaiting.length, source.fact).toBeGreaterThan(15);
    }
    expect(UNPRODUCED_RISK_SOURCES.map((source) => source.fact)).toContain('Missed payments');
  });
});
