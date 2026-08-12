/**
 * Claims worth approving - **proposed, never published**.
 *
 * `seed.ts` bans language. This file is the other half, and it exists because the other half cannot
 * be done the same way.
 *
 * Every phrase below is one this firm plausibly wants to say. Not one of them is written into the
 * Marketing Claim Library by any code in this package. They are submitted to 4.5's proposal queue,
 * where a named human at Authority Level 3 decides - `approveProposal` reads the reviewer's level
 * from the Actor record and refuses anything less.
 *
 * ## Why a seed may ban but may not approve
 *
 * The two acts are not symmetric and the asymmetry is not about caution, it is about who finds out.
 *
 * A wrong ban surfaces immediately: somebody tries to write the phrase, the scanner blocks it, and
 * they arrive at the Compliance Review Board holding the exact sentence they wanted and a reason
 * they want it. The correction path is the complaint.
 *
 * A wrong approval surfaces never. The phrase is permitted, so nothing blocks it, so nobody
 * queries it - and it is repeated across every deliverable, email and partner deck until the party
 * who notices is a regulator or a plaintiff. An approved claim is an assertion this firm makes in
 * writing about what it can do, and the decision to make it belongs to a person who can be asked
 * why.
 *
 * ## A rejection is not the only "no"
 *
 * `approveProposal` accepts `banned` as a disposition. Somebody asked whether we may say this and
 * the answer was that nobody may - which belongs in the Library as a banned entry with the Board's
 * reasoning attached, and is strictly more useful than a rejected proposal nobody will ever find.
 * Several entries below are expected to come back that way; "no upfront fees" most of all, and it
 * is proposed anyway because the question is real and the answer should be on the record.
 */

import type { Outcome } from '@bwc/core';

export interface ProposedClaim {
  readonly phrase: string;
  /**
   * What it is for. Required by `proposeClaim` and the point of the form: the same sentence can be
   * fine on a landing page and a problem in a mid-application email, and the Board cannot tell
   * which is being asked without being told.
   */
  readonly intendedUse: string;
  /** Why this is being asked now, for the Board's minutes. Not sent to `proposeClaim`. */
  readonly note: string;
}

/**
 * The founding proposals.
 *
 * Chosen to cover what the ordinary sends actually need to say. The message templates in
 * `@bwc/comms` are written to scan clean WITHOUT any of these, so nothing is blocked while the
 * queue is pending - the proposals buy better wording, not the ability to communicate.
 */
export const PROPOSED_CLAIMS: readonly ProposedClaim[] = [
  {
    phrase: 'we work with a panel of vetted providers',
    intendedUse:
      'Outbound introduction email and the About section of the client portal, describing how placement works before any file is opened.',
    note: '"Vetted" is a claim about our own diligence. 8.4 records partner findings and 5.2 records lender outcomes, so it is checkable - but the Board should decide what standard the word asserts.',
  },
  {
    phrase: 'your file is reviewed by a person',
    intendedUse:
      'Onboarding welcome email, to set the expectation that a human reads the file rather than an automated decision engine.',
    note: 'True as built - 3.4 requires human approval on every deliverable and 2.1 gates submission. Proposed rather than assumed because it is a promise about staffing, not about software.',
  },
  {
    phrase: 'we do not submit an application without your written authorization',
    intendedUse:
      'Authorization request email and the standing footer on status updates, stating the control that governs submission.',
    note: 'This is the strongest true thing the firm can say and it is enforced in middleware, not policy. It overlaps the regulatory disclosure library; the Board should decide whether it belongs in both.',
  },
  {
    phrase: 'you will know what a placement costs before you authorize it',
    intendedUse:
      'Fee conversation email and the engagement letter cover note, describing the fee exhibit that accompanies every engagement.',
    note: 'Supported by 1.4, which refuses to ship an empty fee exhibit. A commitment about our own process, so it needs an owner who accepts it.',
  },
  {
    phrase: 'no upfront fees',
    intendedUse:
      'Outbound introduction email and partner-facing material, answering the first question every prospect asks.',
    note: 'Expected to come back BANNED, and proposed for that reason. "no upfront cost" is already banned in the founding library; if the Board wants this one permitted it should say so with the exact conditions, and if not, the banned entry carries the reasoning where the next person will find it.',
  },
  {
    phrase: 'we are compensated by the provider when a placement funds',
    intendedUse:
      'Fee disclosure paragraph in outbound material and the engagement letter, stating how the firm is paid.',
    note: 'Fee transparency stated positively. Needs the Board to confirm it is accurate for every fee arrangement, not only the common one - 1.4 supports several.',
  },
  {
    phrase: 'we help business owners understand their capital options',
    intendedUse:
      'Website hero copy, partner co-brand material under 8.1, and the signature block of outbound email.',
    note: 'Deliberately modest positioning language. Proposed because even modest positioning is a claim about what the service is, and principle 1 turns on exactly that.',
  },
  {
    phrase: 'we do not make credit decisions',
    intendedUse:
      'Standing footer on client-facing email and SMS, as the short form of the not-a-lender disclosure.',
    note: 'Already present inside NOT_A_LENDER_DISCLOSURE. Proposed as a standalone approved phrase so short-form channels can carry it without the full paragraph, which does not fit an SMS.',
  },
  {
    phrase: 'most files reach a decision within two weeks',
    intendedUse:
      'Status update email, answering the question clients ask most and currently get no answer to.',
    note: 'A results claim, and the one entry here with a measurable basis: 5.5 records decided attempts with dates. It should not be approved until that number is computed for a real period - and if approved, it needs the substantiation disclosure and a review cadence.',
  },
  {
    phrase: 'we will tell you if we cannot help',
    intendedUse:
      'Onboarding welcome email and the decline notification, committing to a negative answer rather than silence.',
    note: 'A conduct commitment rather than an outcome claim, which is the category most likely to be safely approvable. Included so the queue is not composed only of the difficult ones.',
  },
];

/**
 * Submit every founding proposal to 4.5.
 *
 * **The intake is injected.** `proposeClaim` lives in `@bwc/marketing`, which already depends on
 * `@bwc/claims`; importing it here would close a package cycle and break `tsc -b`. Taking it as a
 * parameter keeps the dependency pointing the way the module graph already points, and says
 * something true about the split: 7.4 declares which claims it wants considered, and 4.5 owns what
 * happens to them.
 *
 * Idempotent. `proposeClaim` returns the existing row when the same phrase is already pending, and
 * refuses when the phrase is already in the Library - so a re-run neither duplicates a proposal nor
 * resurrects one the Board has already decided.
 *
 * Never runs on import.
 */
export const seedProposedClaims = async (
  tenantId: string,
  submittedBy: string,
  actor: { readonly id: string; readonly kind: 'human' | 'agent' | 'system' },
  propose: (input: {
    tenantId: string;
    phrase: string;
    intendedUse: string;
    submittedBy: string;
    actor: { readonly id: string; readonly kind: 'human' | 'agent' | 'system' };
  }) => Promise<Outcome<{ readonly id: string; readonly status: string }>>,
): Promise<{ readonly submitted: number; readonly refused: readonly string[] }> => {
  let submitted = 0;
  const refusedPhrases: string[] = [];

  for (const claim of PROPOSED_CLAIMS) {
    const result = await propose({
      tenantId,
      phrase: claim.phrase,
      intendedUse: claim.intendedUse,
      submittedBy,
      actor,
    });
    if (result.status === 'ok') submitted += 1;
    else refusedPhrases.push(claim.phrase);
  }

  return { submitted, refused: refusedPhrases };
};
