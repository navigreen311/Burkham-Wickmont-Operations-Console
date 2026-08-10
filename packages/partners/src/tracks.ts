/**
 * The seven partner tracks and what each has to satisfy - blueprint 8.1.
 *
 * A data table, for the reason 6.5's classification is one: which credential a Business Attorney
 * must hold is a judgement Channel Partnerships and Compliance & Evidence should be able to read
 * and argue with, and a judgement spread across a switch statement is not something anybody
 * reviews.
 *
 * Pure. No database, so the qualification rules can be tested and read on their own.
 *
 * The tracks differ in a way that matters more than it looks: some of these partners are
 * REGULATED PROFESSIONALS whose own licensing body constrains what they may say about a referral
 * fee, and some are not. A CPA recommending a client to a paid referral arrangement has an
 * independence problem their state board cares about; a business broker does not. That difference
 * is why `disclosureSensitivity` exists here rather than being handled uniformly downstream.
 */

export const PARTNER_TRACKS = [
  'cpa_bookkeeper',
  'fractional_cfo',
  'business_attorney',
  'wealth_advisor',
  'ma_advisor',
  'cre_business_broker',
  'payroll_hr',
] as const;

export type PartnerTrack = (typeof PARTNER_TRACKS)[number];

export const isPartnerTrack = (value: string): value is PartnerTrack =>
  (PARTNER_TRACKS as readonly string[]).includes(value);

/**
 * How exposed this track's own professional obligations are to a referral arrangement.
 *
 *   `high`      the partner's own regulator has rules about referral compensation and
 *               independence, and getting this wrong costs them their licence, not just us
 *   `standard`  ordinary commercial referral relationship
 *
 * Categorical, not a number. The point is to route to a person, not to rank partners.
 */
export type DisclosureSensitivity = 'high' | 'standard';

export interface TrackRequirements {
  readonly track: PartnerTrack;
  readonly label: string;
  /** What a partner on this track must produce before onboarding can complete. */
  readonly qualifications: readonly string[];
  readonly disclosureSensitivity: DisclosureSensitivity;
  /** Why the sensitivity is what it is, so a reviewer can disagree with the reasoning. */
  readonly sensitivityBasis: string;
}

export const TRACK_REQUIREMENTS: Readonly<Record<PartnerTrack, TrackRequirements>> = {
  cpa_bookkeeper: {
    track: 'cpa_bookkeeper',
    label: 'CPA / Bookkeeper',
    qualifications: [
      'Active CPA licence number and issuing state, or a statement that the partner is a non-licensed bookkeeper',
      'Professional liability insurance certificate',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'high',
    sensitivityBasis:
      'AICPA independence rules and most state boards constrain a CPA receiving a commission or referral fee from a client they also serve. The partner may need to disclose, restructure, or decline - and that is their call to make with their own counsel, not ours to make for them.',
  },
  fractional_cfo: {
    track: 'fractional_cfo',
    label: 'Fractional CFO',
    qualifications: [
      'Engagement history or references covering at least two client engagements',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'standard',
    sensitivityBasis:
      'Not a licensed profession as such. A fractional CFO holding a CPA licence is on the CPA track for this purpose.',
  },
  business_attorney: {
    track: 'business_attorney',
    label: 'Business Attorney',
    qualifications: [
      'Active bar number and admitting jurisdiction',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'high',
    sensitivityBasis:
      'Model Rule 7.2 and its state analogues restrict what a lawyer may give for a recommendation, and fee-sharing with a non-lawyer is prohibited in most jurisdictions. This is the track most likely to need a structure other than a referral fee.',
  },
  wealth_advisor: {
    track: 'wealth_advisor',
    label: 'Wealth Advisor',
    qualifications: [
      'CRD number, or a statement that the partner is not registered',
      'Broker-dealer or RIA affiliation, where one exists',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'high',
    sensitivityBasis:
      "A registered representative or investment adviser representative is subject to their firm's outside-business-activity and compensation rules, and to the SEC cash solicitation requirements where they apply.",
  },
  ma_advisor: {
    track: 'ma_advisor',
    label: 'M&A Advisor',
    qualifications: [
      'Transaction history or references covering at least two closed engagements',
      'Broker-dealer affiliation or the M&A broker exemption relied on, where securities are involved',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'high',
    sensitivityBasis:
      'Whether an M&A advisor needs to be registered depends on the transaction, and the answer is contested. Routing to a person is the honest handling.',
  },
  cre_business_broker: {
    track: 'cre_business_broker',
    label: 'CRE / Business Broker',
    qualifications: [
      'Real estate or business broker licence number and issuing state, where the state requires one',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'standard',
    sensitivityBasis:
      'Licensing is state-specific and the licence governs brokerage, not referrals to a capital advisory firm.',
  },
  payroll_hr: {
    track: 'payroll_hr',
    label: 'Payroll / HR',
    qualifications: [
      'Business entity details and the services provided to shared clients',
      'Written acknowledgement of the referral disclosure obligation',
    ],
    disclosureSensitivity: 'standard',
    sensitivityBasis:
      'Ordinary commercial relationship. Data-sharing is the live issue here rather than compensation, because a payroll provider already holds employee data we must not receive.',
  },
};

export const requirementsFor = (track: PartnerTrack): TrackRequirements =>
  TRACK_REQUIREMENTS[track];

/**
 * The qualifications a partner has not yet produced.
 *
 * Compared by exact string against what was recorded, which is deliberately unforgiving: a
 * qualification satisfied by something "close enough" is a judgement, and the record should show
 * that a person made it rather than that a matcher accepted it.
 */
export const outstandingQualifications = (
  track: PartnerTrack,
  recorded: readonly string[],
): readonly string[] =>
  requirementsFor(track).qualifications.filter((required) => !recorded.includes(required));
