/**
 * Promise detection and recording-consent rules - 4.3, pure, no database.
 *
 * Both are exported as pure functions precisely so this file can exist. The rule that decides
 * whether a client was promised something, and the rule that decides whether we may record them
 * at all, are worth testing exhaustively, and fixtures would make the exhaustive version too
 * expensive to write.
 *
 * The blueprint's own example - "we can probably get you $100K" - is the first assertion, because
 * a detector that misses the sentence the specification names would be a detector nobody should
 * trust with the ones it does not.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PARTY_CONSENT_STATES,
  CONFIRMED_ONE_PARTY_STATES,
  checkDisclosures,
  detectPromises,
  detectSignals,
  ruleFor,
  type TranscriptTurn,
} from '@bwc/calls';

const us = (text: string): TranscriptTurn => ({
  speaker: 'Concierge lead',
  side: 'internal',
  text,
});
const them = (text: string): TranscriptTurn => ({ speaker: 'Client', side: 'client', text });

describe('promise detection', () => {
  it("catches the blueprint's own example", () => {
    // Blueprint 4.3: 'flags when anyone says something like "we can probably get you $100K"'.
    const findings = detectPromises([us('So realistically we can probably get you $100K here.')]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('amount_capability');
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.excerpt).toMatch(/\$100K/);
  });

  it('catches the same promise in the amounts people actually say', () => {
    for (const line of [
      'We should be able to secure a hundred grand for you.',
      'I think we can get you six figures.',
      'We can land you $250,000 without much trouble.',
      'A hundred grand is very doable for a business like yours.',
    ]) {
      expect(detectPromises([us(line)]), line).toHaveLength(1);
    }
  });

  it('does not fire on a capability statement with no amount', () => {
    // The amount is what makes it a promise a client plans around. Without one it is a
    // description of what the company does, which is the sentence every sales call opens with.
    expect(detectPromises([us('We can help you get your business ready for capital.')])).toEqual(
      [],
    );
  });

  it('does not fire on a client saying it', () => {
    // "So you'll get me a hundred grand?" is a question to answer, not a promise to correct.
    // Scanning the wrong side would bury real findings under every hopeful thing a client said.
    expect(detectPromises([them('So you can probably get me $100K, right?')])).toEqual([]);
  });

  it('catches approval predictions and guarantees separately', () => {
    expect(
      detectPromises([us("Honestly, you'll definitely get approved for this.")])[0]?.kind,
    ).toBe('approval_prediction');
    expect(detectPromises([us('I can guarantee the funding outcome on this one.')])[0]?.kind).toBe(
      'guarantee',
    );
  });

  it('catches timeline commitments and rate quotes at serious rather than critical', () => {
    const timeline = detectPromises([us('We will have you funded within three weeks.')]);
    expect(timeline[0]?.kind).toBe('timeline_commitment');
    expect(timeline[0]?.severity).toBe('serious');

    const rate = detectPromises([us('You are looking at a rate of around 9% on that.')]);
    expect(rate[0]?.kind).toBe('rate_or_term_quote');
    expect(rate[0]?.severity).toBe('serious');
  });

  it('reports one sentence once, at its worst severity', () => {
    // "We guarantee you'll get approved for $100K" hits three detectors. A reviewer correcting
    // one sentence does not want it three times.
    const findings = detectPromises([
      us("We guarantee you'll get approved for $100K on this application."),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
  });

  it('carries the sentence as spoken, not a paraphrase', () => {
    const findings = detectPromises([
      us('Right. So we can probably get you $100K. Anyway, about the statements.'),
    ]);
    expect(findings[0]?.excerpt).toBe('So we can probably get you $100K.');
  });

  it('finds every promise across a multi-turn call', () => {
    const findings = detectPromises([
      us('Thanks for making the time.'),
      them('So what kind of numbers are we talking about?'),
      us('We can probably get you $150K.'),
      them('And how fast?'),
      us('We will have you funded by the end of the month.'),
    ]);
    expect(findings.map((finding) => finding.kind)).toEqual([
      'amount_capability',
      'timeline_commitment',
    ]);
    // Ordered by position in the call, so a reviewer reads them in the order they were said.
    expect(findings[0]!.offset).toBeLessThan(findings[1]!.offset);
  });
});

describe('disclosure completeness', () => {
  const required = [
    { key: 'not_a_lender', text: 'We are not a lender and do not make credit decisions' },
    { key: 'fee_disclosure', text: 'Our fees are payable whether or not funding is obtained' },
  ];

  it('names what was missing rather than only that something was', () => {
    // "Disclosures incomplete" sends a reviewer back to the whole call. Naming the one that was
    // not covered tells them what to say next time.
    const check = checkDisclosures(
      [us('Just so you know, we are not a lender and do not make credit decisions.')],
      required,
    );
    expect(check.complete).toBe(false);
    expect(check.missing).toEqual(['fee_disclosure']);
    expect(check.mentioned).toEqual(['not_a_lender']);
    expect(check.detail).toMatch(/fee_disclosure/);
  });

  it('is complete when both were covered', () => {
    const check = checkDisclosures(
      [
        us('We are not a lender and do not make credit decisions.'),
        us('Our fees are payable whether or not funding is obtained.'),
      ],
      required,
    );
    expect(check.complete).toBe(true);
    expect(check.missing).toEqual([]);
  });

  it('does not credit a disclosure the CLIENT said', () => {
    const check = checkDisclosures(
      [them('I know you are not a lender and do not make credit decisions.')],
      required,
    );
    expect(check.missing).toContain('not_a_lender');
  });
});

describe('objections and buying signals', () => {
  it('reads the client side only', () => {
    const signals = detectSignals([
      them('Honestly it sounds too good to be true.'),
      them('But what is the next step if we did go ahead?'),
      us('What is the next step? Well, we would start with statements.'),
    ]);
    expect(signals.objections).toContain('trust');
    expect(signals.buyingSignals).toContain('next_steps');
  });

  it('produces labels and no score', () => {
    // 8.4 owns performance judgements and is V1.5. A "call score" here would be the number
    // people read instead of the transcript.
    const signals = detectSignals([them('That is too expensive for us right now.')]);
    expect(Object.keys(signals).sort()).toEqual(['buyingSignals', 'objections']);
  });
});

describe('recording consent by jurisdiction', () => {
  it('requires the client to consent in an all-party state', () => {
    const rule = ruleFor('CA');
    expect(rule.regime).toBe('all_party');
    expect(rule.clientConsentRequired).toBe(true);
    expect(rule.citation).toMatch(/632/);
  });

  it('does not require it in a confirmed one-party state', () => {
    const rule = ruleFor('TX');
    expect(rule.regime).toBe('one_party');
    expect(rule.clientConsentRequired).toBe(false);
  });

  it('requires consent in a state nobody has classified', () => {
    // An unclassified state is not a one-party state; it is a state nobody looked at, and the
    // difference is a criminal exposure. The cost of asking for consent we did not need is a
    // mildly awkward sentence at the top of a call.
    const rule = ruleFor('WY');
    expect(rule.unclassified).toBe(true);
    expect(rule.clientConsentRequired).toBe(true);
    expect(rule.detail).toMatch(/not the same as a one-party state/);
  });

  it('normalises the state code', () => {
    expect(ruleFor(' ca ').state).toBe('CA');
    expect(ruleFor(' ca ').clientConsentRequired).toBe(true);
  });

  it('gives every all-party entry a citation, and carries open questions rather than hiding them', () => {
    for (const rule of ALL_PARTY_CONSENT_STATES) {
      expect(rule.citation.length, rule.state).toBeGreaterThan(10);
    }
    // An invented rule is worse than a missing one because it looks reviewed - 7.2's lesson.
    // Several of these genuinely are unsettled, and the record says so.
    expect(ALL_PARTY_CONSENT_STATES.some((rule) => rule.openQuestion !== null)).toBe(true);
  });

  it('covers every V1 priority state', () => {
    // NV, CA, NY, TX, FL, AZ, UT are 7.2's priority states. None of them should read as
    // unclassified, because that would mean asking for consent on every call in a state we serve.
    for (const state of ['NV', 'CA', 'NY', 'TX', 'FL', 'AZ', 'UT']) {
      expect(ruleFor(state).unclassified, state).toBe(false);
    }
    expect(CONFIRMED_ONE_PARTY_STATES).toContain('NV');
  });
});
