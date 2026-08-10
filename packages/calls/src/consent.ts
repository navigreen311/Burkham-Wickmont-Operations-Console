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

export type ConsentRegime = 'all_party' | 'one_party';

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
 * A state absent from this list is treated as one-party, and that default is the reason the list
 * has to be maintained: the failure mode of a missing entry is recording without the consent the
 * state requires. `UNCLASSIFIED_STATES` exists so a state nobody has looked at is not silently
 * one-party.
 */
export const ALL_PARTY_CONSENT_STATES: readonly RecordingRule[] = [
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
 * V1's seven priority states are NV, CA, NY, TX, FL, AZ and UT. CA and FL are all-party above;
 * the rest are one-party on the public reading, and are listed here as confirmed rather than
 * assumed so the distinction between "checked" and "not on the other list" survives.
 */
export const CONFIRMED_ONE_PARTY_STATES: readonly string[] = ['NV', 'NY', 'TX', 'AZ', 'UT'];

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
      openQuestion: null,
      unclassified: false,
      detail: `${normalised} is a one-party consent state, so our own participation suffices. Disclosing the recording to the client remains good practice and is a separate decision from the legal minimum.`,
    };
  }

  return {
    state: normalised,
    regime: 'one_party',
    clientConsentRequired: true,
    citation: null,
    openQuestion: `No recording-consent rule has been recorded for ${normalised}.`,
    unclassified: true,
    // Treated as requiring consent despite the one-party default. An unclassified state is not a
    // one-party state; it is a state nobody looked at, and the cost of asking for consent we did
    // not strictly need is a mildly awkward sentence at the top of a call.
    detail: `No recording-consent rule is on record for ${normalised}. Client consent is required until counsel classifies it - an unclassified state is not the same as a one-party state, and the difference is a criminal exposure.`,
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
