/**
 * Recording consent - blueprint 4.3's "every founder-led and Concierge call recorded (with
 * consent)".
 *
 * The parenthesis is doing more work than it looks. Whose consent, and how much of it, is a
 * question of state law, and the answer differs across the states this company operates in.
 *
 * Most US states are **one-party**: one participant on the call may consent to it being recorded,
 * and that participant can be us. About eleven are **all-party**: every participant must consent,
 * and recording a client without their consent is a crime - in the state where the CLIENT is
 * sitting, not where we are.
 *
 * So "with consent" cannot be a checkbox on our side. It is computed from the jurisdiction, the
 * same way 7.2 computes a disclosure obligation, and for the same reason: a rule that varies by
 * state and is applied uniformly is applied wrongly in every state but one.
 *
 * The all-party list is DATA WITH CITATIONS, and it is marked as requiring counsel confirmation -
 * following 7.2's rule that an invented rule is worse than a missing one because it looks
 * reviewed. Several of these states have exceptions, judicial glosses, or an unsettled position on
 * calls that cross state lines, and none of that is resolvable here.
 */

import { forClient as consentsForClient, type ConsentKind } from '@bwc/consent';
import { ok, refused, type Outcome } from '@bwc/core';

/** The consent kind a client grants for a call to be recorded. */
export const CALL_RECORDING_CONSENT_KIND: ConsentKind = 'call_recording';

/**
 * The three answers, and the third is not a shade of the second.
 *
 * `unclassified` is a state nobody has looked at. It is NOT a one-party state, and the whole
 * point of naming it is that the two must not read the same anywhere they are recorded - see
 * `UNCLASSIFIED_STATE_RULE`.
 */
export type ConsentRegime = 'all_party' | 'one_party' | 'unclassified';

export interface RecordingRule {
  readonly state: string;
  readonly regime: ConsentRegime;
  readonly citation: string;
  /** What counsel still has to resolve. Empty means the rule is as stated. */
  readonly openQuestion: string | null;
}

/**
 * States requiring all-party consent.
 *
 * Drafted from public statute references. **Counsel must confirm before a call is recorded in any
 * of these**, and the `openQuestion` field carries what is unresolved rather than smoothing it
 * over - see the module header.
 *
 * A state absent from BOTH lists is unclassified, not one-party: `UNCLASSIFIED_STATE_RULE` is
 * what it gets, and it requires consent. That is the reason both lists have to be maintained
 * rather than only this one - the failure mode of a missing entry is recording without the
 * consent the state requires, and the unclassified rule is what stops a missing entry becoming
 * a permission.
 */
export const ALL_PARTY_CONSENT_STATES: readonly RecordingRule[] = [
  // NEVADA IS HERE BY FOUNDER RULING, NOT BY A READING OF THE STATUTE.
  //
  // Ruling (Ivan Green, 2026-09-16): Nevada is treated as an ALL-PARTY consent state for
  // recorded calls until a lawyer confirms otherwise. The cautious setting is the ruling. It is
  // NOT a legal conclusion, and nothing here should be cited as one.
  //
  // PENDING COUNSEL REVIEW. Nevada previously sat in `CONFIRMED_ONE_PARTY_STATES`, where its
  // effect was to skip the consent ledger entirely - `mayRecord` returns permitted before it
  // reads a single consent row. That is the failure mode the module header calls a criminal
  // exposure, reached by a default rather than by a decision.
  //
  // AND THE WIDER POINT: NO LAWYER HAS CONFIRMED ANY STATE ON `CONFIRMED_ONE_PARTY_STATES`.
  // The word "confirmed" in that constant's name is not backed by a citation, a comment, a doc
  // or a commit message anywhere in this repository - see the note on the constant itself. This
  // ruling moves the one state the founder ruled on; it does not validate the other four.
  {
    state: 'NV',
    regime: 'all_party',
    citation:
      'Founder ruling, 2026-09-16 - pending counsel review. No statute has been confirmed for Nevada.',
    openQuestion:
      'Counsel has not classified Nevada. The all-party treatment is a deliberately cautious default chosen by the founder, not a reading of Nevada law, and counsel should replace this entry with a statutory position either way.',
  },
  {
    state: 'CA',
    regime: 'all_party',
    citation: 'Cal. Penal Code section 632',
    openQuestion: null,
  },
  {
    state: 'FL',
    regime: 'all_party',
    citation: 'Fla. Stat. section 934.03',
    openQuestion: null,
  },
  {
    state: 'IL',
    regime: 'all_party',
    citation: '720 ILCS 5/14-2',
    openQuestion:
      'The Illinois eavesdropping statute was rewritten after its predecessor was held unconstitutional. Counsel should confirm the current scope for a consented business call.',
  },
  {
    state: 'MD',
    regime: 'all_party',
    citation: 'Md. Code, Cts. & Jud. Proc. section 10-402',
    openQuestion: null,
  },
  {
    state: 'MA',
    regime: 'all_party',
    citation: 'Mass. Gen. Laws ch. 272 section 99',
    openQuestion:
      'Massachusetts turns on SECRET recording rather than consent as such. Counsel should confirm whether a disclosed-and-unobjected recording satisfies it.',
  },
  {
    state: 'MT',
    regime: 'all_party',
    citation: 'Mont. Code Ann. section 45-8-213',
    openQuestion: null,
  },
  {
    state: 'NH',
    regime: 'all_party',
    citation: 'N.H. Rev. Stat. Ann. section 570-A:2',
    openQuestion: null,
  },
  {
    state: 'OR',
    regime: 'all_party',
    citation: 'Or. Rev. Stat. section 165.540',
    openQuestion:
      'Oregon distinguishes telephone from in-person conversations. Counsel should confirm which rule governs a video call.',
  },
  {
    state: 'PA',
    regime: 'all_party',
    citation: '18 Pa. Cons. Stat. section 5704',
    openQuestion: null,
  },
  {
    state: 'WA',
    regime: 'all_party',
    citation: 'Wash. Rev. Code section 9.73.030',
    openQuestion: null,
  },
  {
    state: 'CT',
    regime: 'all_party',
    citation: 'Conn. Gen. Stat. section 52-570d',
    openQuestion:
      'Connecticut’s all-party rule is civil rather than criminal and applies to telephonic recordings specifically. Counsel should confirm the scope.',
  },
];

/**
 * States nobody has classified.
 *
 * Deliberately not empty-by-construction. A state absent from both lists defaults to one-party,
 * and defaulting is how a rule nobody checked becomes a recording nobody was entitled to make -
 * so `ruleFor` reports an unclassified state as one requiring confirmation rather than as settled.
 *
 * V1's seven priority states are NV, CA, NY, TX, FL, AZ and UT. CA, FL and NV are all-party
 * above - NV by founder ruling of 2026-09-16 rather than by a reading of its statute. The
 * remaining four are one-party on the public reading, and are listed here as confirmed rather
 * than assumed so the distinction between "checked" and "not on the other list" survives.
 *
 * That distinction is currently doing less work than the name claims: see the note on the
 * constant. No lawyer has confirmed any of the four.
 */
//
// NOTHING HAS CONFIRMED THE STATES ON THIS LIST. The name says "confirmed", and no state on it
// carries a citation, a comment, a doc reference or a commit message saying who checked it or
// against what - unlike `ALL_PARTY_CONSENT_STATES`, where every entry cites a statute. Each
// entry here is one state code in a bare string array, and a state on this list skips the
// consent ledger completely. Counsel should source all four or they should move.
//
// NV was removed on 2026-09-16 by founder ruling and is now an all-party entry above.
export const CONFIRMED_ONE_PARTY_STATES: readonly string[] = ['NY', 'TX', 'AZ', 'UT'];

/**
 * What counsel has to answer about every state on that list.
 *
 * Ruling (Ivan Green, 2026-09-16): NY, TX, AZ and UT stay on the one-party list for now, MARKED
 * PENDING COUNSEL REVIEW. No source exists for any of them.
 *
 * Carried as an `openQuestion` on the requirement rather than as a comment, so it travels with
 * the answer to wherever the answer is read. A note in this file is read by whoever opens this
 * file; a field on the requirement is read by the call that relies on it.
 */
export const ONE_PARTY_REVIEW_PENDING = (state: string): string =>
  `No source is on record for ${state}: it is on the one-party list with no citation, no doc and no commit message behind it. Pending counsel review (ruling of 2026-09-16). Until then, recording without the client's consent here rests on an unsourced classification.`;

/**
 * THE RULE FOR A STATE ON NEITHER LIST.
 *
 * The constant the module header used to claim existed under the name `UNCLASSIFIED_STATES`.
 * That name described a LIST, which is the one thing this cannot be: the unclassified states are
 * exactly the ones nobody has enumerated, so the only honest form is the rule they get.
 *
 * Ruling (Ivan Green, 2026-09-16): a state on neither list is recorded as `unclassified`, never
 * `one_party`. It still requires consent and reads the ledger.
 *
 * The behaviour was already right - consent required, ledger read - and the LABEL was wrong. It
 * reported `regime: 'one_party'`, and `beginCall` writes that regime into the append-only Event
 * Ledger, so a state nobody had looked at went onto the permanent record as one somebody had
 * cleared. A refusal that is recorded under the wrong reason is evidence of the wrong thing.
 */
export const UNCLASSIFIED_STATE_RULE = {
  regime: 'unclassified',
  clientConsentRequired: true,
  citation: null,
  // The cost of asking for consent we did not strictly need is a mildly awkward sentence at the
  // top of a call. The cost of the other mistake is a criminal exposure in the state where the
  // client is sitting.
  reason:
    'an unclassified state is not the same as a one-party state, and the difference is a criminal exposure',
} as const;

export interface RecordingRequirement {
  readonly state: string;
  readonly regime: ConsentRegime;
  readonly clientConsentRequired: boolean;
  readonly citation: string | null;
  readonly openQuestion: string | null;
  /** True when nobody has classified this state, so the answer is a default rather than a rule. */
  readonly unclassified: boolean;
  readonly detail: string;
}

/** What recording requires in a given state. */
export const ruleFor = (state: string): RecordingRequirement => {
  const normalised = state.trim().toUpperCase();

  const allParty = ALL_PARTY_CONSENT_STATES.find((rule) => rule.state === normalised);
  if (allParty) {
    return {
      state: normalised,
      regime: 'all_party',
      clientConsentRequired: true,
      citation: allParty.citation,
      openQuestion: allParty.openQuestion,
      unclassified: false,
      detail: `${normalised} requires all-party consent (${allParty.citation}). The client must consent before the call is recorded.`,
    };
  }

  if (CONFIRMED_ONE_PARTY_STATES.includes(normalised)) {
    return {
      state: normalised,
      regime: 'one_party',
      clientConsentRequired: false,
      citation: null,
      // Non-null by ruling. The four states here are unsourced, and a requirement that carried
      // `openQuestion: null` would state that there is nothing outstanding about them.
      openQuestion: ONE_PARTY_REVIEW_PENDING(normalised),
      unclassified: false,
      detail: `${normalised} is a one-party consent state, so our own participation suffices. Disclosing the recording to the client remains good practice and is a separate decision from the legal minimum. This classification is unsourced and pending counsel review.`,
    };
  }

  return {
    state: normalised,
    // `unclassified`, NOT `one_party`. Every field below comes from the rule rather than being
    // written out again here, so the label and the behaviour cannot drift apart.
    regime: UNCLASSIFIED_STATE_RULE.regime,
    clientConsentRequired: UNCLASSIFIED_STATE_RULE.clientConsentRequired,
    citation: UNCLASSIFIED_STATE_RULE.citation,
    openQuestion: `No recording-consent rule has been recorded for ${normalised}.`,
    unclassified: true,
    detail: `No recording-consent rule is on record for ${normalised}. Client consent is required until counsel classifies it - ${UNCLASSIFIED_STATE_RULE.reason}.`,
  };
};

export interface ConsentVerdict {
  readonly permitted: boolean;
  readonly requirement: RecordingRequirement;
  readonly detail: string;
}

/**
 * Whether this call may be recorded.
 *
 * Consent is read live from 1.5 rather than cached with the call, so a revocation takes effect on
 * the next call rather than at the end of some window.
 */
export const mayRecord = async (input: {
  tenantId: string;
  clientId: string;
  /** Two-letter state code where the CLIENT is. Ours does not govern. */
  jurisdiction: string;
  now?: Date;
}): Promise<Outcome<ConsentVerdict>> => {
  const now = input.now ?? new Date();

  if (input.jurisdiction.trim() === '') {
    return refused(
      'No jurisdiction was supplied for this call, so the recording-consent rule cannot be determined. "We could not tell which state" and "no rule applies" are different statements, and only one of them is a check.',
      'Blueprint 4.3 with 7.2 - recording consent is a jurisdiction question',
    );
  }

  const requirement = ruleFor(input.jurisdiction);

  if (!requirement.clientConsentRequired) {
    return ok({ permitted: true, requirement, detail: requirement.detail });
  }

  const consents = await consentsForClient(input.tenantId, input.clientId);
  const live = consents.find(
    (consent) =>
      consent.kind === CALL_RECORDING_CONSENT_KIND &&
      consent.revokedAt === null &&
      (consent.expiresAt === null || consent.expiresAt.getTime() > now.getTime()),
  );

  if (!live) {
    const revoked = consents.some(
      (consent) => consent.kind === CALL_RECORDING_CONSENT_KIND && consent.revokedAt !== null,
    );
    return ok({
      permitted: false,
      requirement,
      detail: revoked
        ? `This client revoked their call-recording authorization. ${requirement.detail}`
        : `This client has not authorized call recording. ${requirement.detail}`,
    });
  }

  return ok({
    permitted: true,
    requirement,
    detail: `Recording is authorized by the client. ${requirement.detail}`,
  });
};
