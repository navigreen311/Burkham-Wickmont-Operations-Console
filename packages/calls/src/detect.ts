/**
 * What a transcript contains - blueprint 4.3's promise tracking, disclosure completeness,
 * objections and buying signals.
 *
 * Pure. No database, no vendor, no network. The transcript is the input and findings are the
 * output, which is the same split 3.3 makes: the capture seam is honest about being unbuilt, and
 * everything that operates on captured data is fully built and exhaustively testable.
 *
 * **This is not the Compliance Scanner, and the difference is the point.**
 *
 * 4.2 matches exact phrases from the Marketing Claim Library and returns `blocked`. That works
 * because it runs BEFORE anything is sent - there is something to stop.
 *
 * A call has already happened. "We can probably get you a hundred grand" was said, the client
 * heard it, and no verdict this module returns will unsay it. So detection here produces an
 * OBLIGATION TO CORRECT rather than a block.
 *
 * It also cannot use the Library, and not for want of trying: the promise varies by amount.
 * "$100K", "a hundred grand", "six figures" and "about eighty" are the same promise, and an
 * exact-phrase library would need an entry for each. So this matches the SHAPE of a statement -
 * a capability assertion near a quantity, a timeline commitment, an approval prediction - and is
 * kept in its own file so that loosening one mechanism cannot silently loosen the other.
 *
 * The cost of shape-matching is false positives, and they are accepted deliberately. A flagged
 * sentence that turns out to be fine costs a reviewer thirty seconds. A missed one costs a
 * client a promise nobody corrected.
 */

export type PromiseKind =
  | 'amount_capability'
  | 'approval_prediction'
  | 'timeline_commitment'
  | 'rate_or_term_quote'
  | 'guarantee';

export type Severity = 'critical' | 'serious' | 'notable';

export interface PromiseFinding {
  readonly kind: PromiseKind;
  readonly severity: Severity;
  /** The sentence as spoken, so a reviewer reads what was said rather than a paraphrase. */
  readonly excerpt: string;
  readonly speaker: string;
  readonly offset: number;
  /** What is wrong with it, in a sentence somebody can put in a correction email. */
  readonly whyItMatters: string;
}

export interface TranscriptTurn {
  readonly speaker: string;
  /** `internal` for us, `client` for them. Only our promises create an obligation. */
  readonly side: 'internal' | 'client';
  readonly text: string;
}

/**
 * A detector: a pattern, what it means, and how serious it is.
 *
 * A table rather than a function body, for the reason 6.5's classification is one - what counts as
 * a promise is a judgement the Compliance Review Board should be able to read and argue with.
 */
interface Detector {
  readonly kind: PromiseKind;
  readonly severity: Severity;
  readonly pattern: RegExp;
  readonly whyItMatters: string;
}

/**
 * A quantity of money, in the forms people actually say it out loud.
 *
 * The SPELLED-OUT branch is not decoration. The first version of this pattern matched digits
 * only, and missed "we should be able to secure a hundred grand for you" - which is how the
 * sentence is most often actually said on a call. A detector that catches only the written form
 * of a spoken promise catches the promises nobody makes.
 */
const WORD_NUMBER =
  '(?:a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|couple)';

const MONEY = `(?:\\$\\s?[\\d,]+(?:\\.\\d+)?\\s?(?:k|m|thousand|million)?|[\\d,]+\\s?(?:k|grand|thousand|million)\\b|(?:${WORD_NUMBER}[- ]){1,3}(?:grand|thousand|million|k)\\b|(?:five|six|seven)[- ]figures?)`;

/** Words that assert we can bring something about. */
const CAPABILITY = '(?:get|secure|land|obtain|arrange|line up|bring in|raise|unlock|deliver)';

export const PROMISE_DETECTORS: readonly Detector[] = [
  {
    kind: 'amount_capability',
    severity: 'critical',
    // "we can probably get you $100K", "we should be able to secure a hundred grand"
    //
    // The gaps between the parts are permissive on purpose, because HEDGES DO NOT SOFTEN A
    // PROMISE. "Probably", "should be able to" and "no problem" all sit inside them and none of
    // them changes what the client heard - which is a number. A pattern that required an
    // unhedged assertion would miss every promise anybody was careful about, which is most of
    // them; the careless ones were never the hard case.
    pattern: new RegExp(
      `\\b(?:we|i)\\b[^.!?]{0,40}\\b(?:can|could|will|'ll|should)\\b[^.!?]{0,30}?\\b${CAPABILITY}\\b[^.!?]{0,40}?${MONEY}`,
      'gi',
    ),
    whyItMatters:
      "A stated amount we can obtain is a prediction about a third party's credit decision. We are not the decision-maker, and a client who heard a number will hold us to it whether or not it was hedged.",
  },
  {
    kind: 'amount_capability',
    severity: 'critical',
    // The reversed form: "$100K is realistic for you", "a hundred grand is very doable"
    pattern: new RegExp(
      `${MONEY}[^.!?]{0,30}\\b(?:is|are|would be|should be)\\b[^.!?]{0,20}\\b(?:realistic|achievable|doable|no problem|comfortable|conservative)\\b`,
      'gi',
    ),
    whyItMatters:
      'A stated amount described as realistic is the same prediction in the other word order, and lands on the client identically.',
  },
  {
    kind: 'approval_prediction',
    severity: 'critical',
    pattern: new RegExp(
      `\\b(?:you|we|they)\\b[^.!?]{0,30}\\b(?:will|'ll|are going to|gonna|definitely|certainly)\\b[^.!?]{0,25}\\b(?:get approved|be approved|approve you|qualify|get funded|be funded)\\b`,
      'gi',
    ),
    whyItMatters:
      'Predicting approval states an outcome only the capital provider decides. It is on the prohibited-actions list and is the claim regulators treat as the clearest deceptive-practice marker.',
  },
  {
    kind: 'guarantee',
    severity: 'critical',
    pattern:
      /\b(?:guarantee|guaranteed|guaranteeing)\b[^.!?]{0,40}\b(?:approv\w+|fund\w+|result\w*|outcome\w*|amount\w*)\b/gi,
    whyItMatters:
      'A guarantee of an outcome we do not control. Level 4 prohibited action; it cannot be corrected by softening, only by retracting.',
  },
  {
    kind: 'timeline_commitment',
    severity: 'serious',
    pattern:
      /\b(?:we|i)\b[^.!?]{0,30}\b(?:will|'ll|can|should)\b[^.!?]{0,25}\b(?:have|get)\b[^.!?]{0,30}\b(?:funded|approved|closed|done|wrapped up)\b[^.!?]{0,30}\b(?:by|within|in)\b[^.!?]{0,25}\b(?:days?|weeks?|months?|friday|monday|tuesday|wednesday|thursday|end of \w+)\b/gi,
    whyItMatters:
      'A funding timeline depends on the provider, on documents the client has not produced, and on an underwriting queue we do not see. A date said out loud becomes the date the client planned around.',
  },
  {
    kind: 'rate_or_term_quote',
    severity: 'serious',
    pattern:
      /\b(?:rate|apr|interest|factor)\b[^.!?]{0,25}\b(?:of|at|around|about|roughly)\b[^.!?]{0,15}\d+(?:\.\d+)?\s?%?/gi,
    whyItMatters:
      'A rate quoted before an offer exists is a term we cannot hold. 5.6 exists because these figures are not comparable across products, and a number said casually will be compared anyway.',
  },
];

const sentenceAround = (text: string, index: number): string => {
  const start = Math.max(0, text.lastIndexOf('.', index - 1) + 1);
  const endMarker = text.slice(index).search(/[.!?]/);
  const end = endMarker === -1 ? text.length : index + endMarker + 1;
  return text.slice(start, end).trim();
};

/**
 * Promises made on our side of the call.
 *
 * Only `internal` turns are scanned. A client saying "so you'll get me a hundred grand?" is a
 * question to answer, not a promise to correct - and treating it as one would bury the real
 * findings under every hopeful thing a client ever said.
 */
export const detectPromises = (turns: readonly TranscriptTurn[]): readonly PromiseFinding[] => {
  const findings: PromiseFinding[] = [];
  let runningOffset = 0;

  for (const turn of turns) {
    if (turn.side === 'internal') {
      for (const detector of PROMISE_DETECTORS) {
        // `lastIndex` is per-regex and these are module-level, so reset before each use.
        detector.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = detector.pattern.exec(turn.text)) !== null) {
          findings.push({
            kind: detector.kind,
            severity: detector.severity,
            excerpt: sentenceAround(turn.text, match.index),
            speaker: turn.speaker,
            offset: runningOffset + match.index,
            whyItMatters: detector.whyItMatters,
          });
          if (match.index === detector.pattern.lastIndex) detector.pattern.lastIndex += 1;
        }
      }
    }
    runningOffset += turn.text.length + 1;
  }

  // Two detectors can fire on one sentence - "we can guarantee you'll get approved for $100K" hits
  // three. Reported once, at the worst severity, because a reviewer correcting one sentence does
  // not want it three times.
  const bySentence = new Map<string, PromiseFinding>();
  for (const finding of findings) {
    const existing = bySentence.get(finding.excerpt);
    if (!existing || rank(finding.severity) < rank(existing.severity)) {
      bySentence.set(finding.excerpt, finding);
    }
  }

  return [...bySentence.values()].sort((a, b) => a.offset - b.offset);
};

const rank = (severity: Severity): number =>
  severity === 'critical' ? 0 : severity === 'serious' ? 1 : 2;

export interface DisclosureCheck {
  readonly complete: boolean;
  readonly mentioned: readonly string[];
  readonly missing: readonly string[];
  readonly detail: string;
}

/**
 * Blueprint 4.3's "disclosure completeness check".
 *
 * Matches on a distinctive fragment of each required disclosure rather than the whole text,
 * because nobody reads a disclosure verbatim on a phone call and requiring it would mark every
 * call incomplete - which is the same as marking none of them.
 *
 * What it names is what was MISSING. "Disclosures incomplete" tells a reviewer to listen to the
 * whole call again; naming the two that were not covered tells them what to say next time.
 */
export const checkDisclosures = (
  turns: readonly TranscriptTurn[],
  required: readonly { readonly key: string; readonly text: string }[],
): DisclosureCheck => {
  const spoken = turns
    .filter((turn) => turn.side === 'internal')
    .map((turn) => turn.text.toLowerCase())
    .join(' ');

  const mentioned: string[] = [];
  const missing: string[] = [];

  for (const disclosure of required) {
    // The first substantial clause, which is the part somebody would actually paraphrase.
    const fragment = disclosure.text.toLowerCase().split(/[.,;]/)[0]?.trim();
    if (fragment !== undefined && fragment.length > 0 && spoken.includes(fragment)) {
      mentioned.push(disclosure.key);
    } else {
      missing.push(disclosure.key);
    }
  }

  return {
    complete: missing.length === 0,
    mentioned,
    missing,
    detail:
      missing.length === 0
        ? `All ${required.length} required disclosure(s) were covered.`
        : `Not covered on this call: ${missing.join(', ')}.`,
  };
};

export interface ConversationSignals {
  readonly objections: readonly string[];
  readonly buyingSignals: readonly string[];
}

const OBJECTION_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'price',
    pattern: /\b(?:too expensive|can'?t afford|costs? too much|out of my budget)\b/i,
  },
  {
    label: 'timing',
    pattern: /\b(?:not right now|maybe next (?:quarter|year|month)|bad timing)\b/i,
  },
  {
    label: 'trust',
    pattern: /\b(?:how do i know|too good to be true|been burned|scam|not sure i believe)\b/i,
  },
  {
    label: 'authority',
    pattern: /\b(?:talk to my (?:partner|wife|husband|accountant|board)|not my decision)\b/i,
  },
  {
    label: 'alternative',
    pattern: /\b(?:already (?:working with|talking to)|another (?:firm|broker))\b/i,
  },
];

const BUYING_SIGNAL_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'next_steps',
    pattern:
      /\b(?:what(?:'s| is) the next step|how do (?:we|i) (?:start|begin)|where do i sign)\b/i,
  },
  { label: 'timeline', pattern: /\b(?:how (?:soon|quickly|long)|when could we)\b/i },
  {
    label: 'pricing_detail',
    pattern: /\b(?:what does (?:it|this) cost|how much (?:is|do you charge))\b/i,
  },
  {
    label: 'documents',
    pattern: /\b(?:what do you need from me|send you (?:my|the) (?:statements|documents))\b/i,
  },
];

/**
 * Objections and buying signals, from the CLIENT's turns.
 *
 * The mirror of promise detection: a promise is something we said, an objection is something they
 * said, and scanning the wrong side produces confident nonsense in both directions.
 *
 * These feed 1.3's sales motion as prompts. They are labels on things the client actually said,
 * not an assessment of how the call went - 8.4 owns performance judgements and is V1.5, and a
 * "call score" here would be the number people read instead of the transcript.
 */
export const detectSignals = (turns: readonly TranscriptTurn[]): ConversationSignals => {
  const clientText = turns.filter((turn) => turn.side === 'client').map((turn) => turn.text);

  const found = (patterns: readonly { label: string; pattern: RegExp }[]): string[] => {
    const labels = new Set<string>();
    for (const text of clientText) {
      for (const entry of patterns) {
        if (entry.pattern.test(text)) labels.add(entry.label);
      }
    }
    return [...labels].sort();
  };

  return {
    objections: found(OBJECTION_PATTERNS),
    buyingSignals: found(BUYING_SIGNAL_PATTERNS),
  };
};
