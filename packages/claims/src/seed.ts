/**
 * The founding Marketing Claim Library - 7.4, seeded so that 4.2 can run at all.
 *
 * Until this file existed the library was empty for every tenant, and `scanForTenant` refuses on an
 * empty library ("a scan would report clean without having checked anything"). The consequence was
 * not that scanning was lax. It was that **nothing client-facing could be sent, generated or
 * approved** - contracts, deliverables, campaigns, partner material and every outbound message all
 * run through the same refusal.
 *
 * ## The asymmetry that decides what may be seeded
 *
 * Banning a claim is safe. Over-banning produces a visible complaint from somebody who wanted to
 * say the phrase, and that complaint arrives with the phrase attached and a person to argue it -
 * which is exactly the input the Compliance Review Board is for.
 *
 * Approving a claim is not safe. An approved phrase authorises a promise this firm makes in
 * writing, and nobody complains about a claim that was permitted. The error is silent, it is
 * repeated at scale, and it is the failure 7.4 exists to prevent.
 *
 * So this file seeds **banned and requires-disclaimer entries only**. Not one approved claim is
 * published here. The claims worth approving are in `proposed.ts` and reach the library only
 * through 4.5's proposal queue, decided by a named human at Authority Level 3. A seed that
 * published approved claims would be an agent deciding what this firm may legally say.
 *
 * ## Two matching rules that govern every phrase below
 *
 * The scanner binds each phrase at `\b` on both ends and joins internal whitespace with `\s+`.
 * That has two consequences a phrase author has to know, and both were established by running the
 * real scanner rather than by reading it:
 *
 * 1. **A phrase must begin and end with a word character.** `\b` before `$` asks for a word
 *    character immediately before the `$`, so an entry of `$100K` never fires in "you qualify for
 *    $100K" - the character before `$` is a space. The same is true of a phrase ending in `%` or
 *    `+`. Such an entry publishes, appears in the library, counts toward `libraryEntriesChecked`,
 *    and matches nothing. It is a rule that looks like a control and is not one, which is the
 *    precise failure `scanForTenant` refuses an empty library to avoid - one level down.
 *    `tests/integration/claim-library-seed.test.ts` asserts every seeded phrase satisfies this.
 *
 * 2. **Matching is exact-phrase, so the paraphrase is the work.** "guaranteed approval" and
 *    "approval is guaranteed" are two entries. A shorter entry covers longer text containing it
 *    ("get you funded" catches "we can definitely get you funded"), so the shortest form that is
 *    unambiguous is preferred and the variants that are NOT substrings of one another are all
 *    listed.
 *
 * ## What is deliberately not here
 *
 * **Numeric money promises.** The brief for this slice named "$100K", "a hundred grand" and "six
 * figures" as forms to cover. Two of the three are seeded. `$100K` cannot be, for rule 1 above -
 * and even with the leading `$` dropped, an exact-phrase library would need an entry per amount,
 * which is not a control but a list. 4.3's promise detector (`packages/calls/src/detect.ts`)
 * already matches the SHAPE of a money promise, and its own header says why the Library cannot:
 * "the promise varies by amount ... an exact-phrase library would need an entry for each". The
 * colloquial forms below are seeded because they are fixed strings in marketing register; the
 * numerals are 4.3's job and remain 4.3's job.
 *
 * **Bare "credit repair", "legal advice" and "tax advice".** Each appears inside the standing
 * disclaimers this firm is obliged to print - "Burkham Wickmont is not a lender, investment
 * adviser, or credit repair organization" is `NOT_A_LENDER_DISCLOSURE`, and it would be blocked by
 * its own claim library. A scanner that blocks the disclaimer is a scanner that gets routed
 * around. The offending USES are seeded instead ("credit repair services", "as your attorney").
 *
 * **"average" and "guarantee".** Both are load-bearing in the firm's own compliance prose. Banning
 * a word that appears in the sentence written to satisfy the ban teaches people the scanner is
 * broken, and a scanner believed to be broken protects nothing.
 */

// Type-only, and deliberately: `index.ts` imports the data below to seed it, so a value import here
// would close a runtime cycle between the two modules. `verbatimModuleSyntax` erases this one.
import type { PublishClaimInput } from './index.js';

export type SeedClaim = Omit<PublishClaimInput, 'tenantId' | 'actor' | 'approvedBy'>;

/* -------------------------------------------------------------------------- */
/* Disclosures, named once                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A required disclosure is a string a template has to contain **verbatim**.
 *
 * 8.1 and 4.5 both check `text.includes(disclosure)` and refuse when it is missing, rather than
 * letting the content through on a promise that somebody attaches it later. So these are constants:
 * a disclosure retyped by hand in a template is a disclosure that fails an exact-match check for a
 * missing comma, and the failure would look like the template being wrong rather than the copy.
 */
export const DISCLOSURE_ESTIMATE =
  'Estimates are based on the information available at the time of preparation and are not an offer or commitment of credit.';

export const DISCLOSURE_MAXIMUM =
  'Amounts shown are maximums for the product described and are not an indication of the amount any particular applicant will be approved for.';

export const DISCLOSURE_PROJECTION =
  'Projections are modelled from information available at the time of preparation. They are not a prediction of any provider decision and are not an offer or commitment of credit.';

export const DISCLOSURE_PREQUALIFICATION =
  'Pre-qualification is our own assessment of fit against published provider criteria. It is not an offer of credit, does not bind any provider, and is not a commitment to lend.';

export const DISCLOSURE_LOWEST_RATE =
  'Rates shown are the lowest published for the product and are offered only to applicants meeting the provider strongest credit tier. The rate offered to any particular applicant may be higher.';

export const DISCLOSURE_PROMOTIONAL_RATE =
  'A promotional rate applies for a stated period only. The rate that applies after that period is set by the provider and is ordinarily higher.';

export const DISCLOSURE_TIMELINE =
  'Funding timelines are set by the provider and depend on document completeness and verification. Burkham Wickmont does not commit to a funding date.';

export const DISCLOSURE_NOT_TYPICAL =
  'Results described are not typical and are not a prediction of the outcome of any particular file.';

export const DISCLOSURE_SOFT_INQUIRY =
  'A soft inquiry does not affect a credit score. A formal application requires the provider to make a hard inquiry, which may.';

export const DISCLOSURE_SUBSTANTIATION =
  'Any figure describing past results is drawn from our own records for the period stated and is not a prediction of future results.';

/* -------------------------------------------------------------------------- */
/* Banned - approval promises                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The claim `PROHIBITED_ACTIONS` calls `guarantee_approval`, in the word orders people write.
 *
 * A Level 4 action is one no actor may take at any level with any approval. Saying it is the same
 * act as doing it: a client who has been told in writing that approval is guaranteed has been given
 * the promise, whatever the sender's authority was.
 */
const APPROVAL_PROMISES: readonly SeedClaim[] = [
  {
    phrase: 'guaranteed approval',
    disposition: 'banned',
    rationale:
      'Burkham Wickmont is not the decision-maker on any application. Promising approval both misstates the relationship and is the claim regulators treat as the clearest deceptive-practice marker (FTC Act). Level 4 prohibited action `guarantee_approval`.',
  },
  {
    phrase: 'guarantee approval',
    disposition: 'banned',
    rationale: 'Verb form of "guaranteed approval"; same reasoning.',
  },
  {
    phrase: 'approval is guaranteed',
    disposition: 'banned',
    rationale:
      'Inverted form of "guaranteed approval", and the one a person writes naturally in a sentence. Found while building 4.1: a message reading "Your approval is guaranteed once you sign" passed the scanner cleanly, because the library held only the noun-phrase order. The scanner is exact-phrase by design - substring matching would flag "no guarantee of approval" - so covering a paraphrase means adding it here, which is what the Compliance Review Board owns this list for.',
  },
  {
    phrase: 'approval guaranteed',
    disposition: 'banned',
    rationale: 'Reversed form of the same claim; same reasoning as the entry above.',
  },
  {
    phrase: 'we guarantee approval',
    disposition: 'banned',
    rationale:
      'First-person form. Named separately because "guarantee approval" alone does not match "we guarantee approvals" and the plural is how it is written in partner decks.',
  },
  {
    phrase: 'we guarantee approvals',
    disposition: 'banned',
    rationale:
      'Plural of the first-person form. The scanner binds at word boundaries, so the singular entry does not cover it.',
  },
  {
    phrase: 'guaranteed to be approved',
    disposition: 'banned',
    rationale: 'Passive construction of the same promise, and the one used in SMS.',
  },
  {
    phrase: 'guaranteed funding',
    disposition: 'banned',
    rationale:
      'Promises the outcome rather than the decision, which is the same misstatement one step later. Funding is a provider act.',
  },
  {
    phrase: 'funding is guaranteed',
    disposition: 'banned',
    rationale: 'Sentence order of "guaranteed funding".',
  },
  {
    phrase: 'guaranteed to fund',
    disposition: 'banned',
    rationale: 'Verb form of the funding promise.',
  },
  {
    phrase: 'you will be approved',
    disposition: 'banned',
    rationale:
      'A prediction of a third party decision stated as fact. Bound to "you" deliberately: "no assurance that any application will be approved" is a disclosure this firm prints, and a bare ban on "will be approved" would block it.',
  },
  {
    phrase: 'you will get approved',
    disposition: 'banned',
    rationale: 'Colloquial form of the same prediction.',
  },
  {
    phrase: 'get you approved',
    disposition: 'banned',
    rationale:
      'Asserts we bring the approval about. Covers "we can get you approved" and "I will get you approved" as the shorter contained phrase.',
  },
  {
    phrase: 'approval is a formality',
    disposition: 'banned',
    rationale:
      'Says the decision has effectively been made. Worse than an outright guarantee because it also discourages the client from reading the terms.',
  },
  {
    phrase: 'approval is certain',
    disposition: 'banned',
    rationale: 'Synonym for the guarantee, avoiding the banned word.',
  },
  {
    phrase: 'everyone gets approved',
    disposition: 'banned',
    rationale:
      'Universal approval claim. False on its face for a product set in which declines are recorded (5.5), and unsubstantiable in principle.',
  },
  {
    phrase: 'everyone qualifies',
    disposition: 'banned',
    rationale: 'Same universal claim about the earlier stage.',
  },
  {
    phrase: 'we never get declined',
    disposition: 'banned',
    rationale:
      'The same universal claim about our own record. 5.5 records declines precisely so this sentence is checkable, and it is false.',
  },
  {
    phrase: '100% approval',
    disposition: 'banned',
    rationale:
      'A universal claim in numeric form. Note the phrase ends in a word character; an entry written as "approval rate of 100%" would never fire, because the scanner binds at word boundaries and the character after "%" is a space.',
  },
  {
    phrase: '100 percent approval',
    disposition: 'banned',
    rationale: 'Spelled form of the same claim, which is how it survives a naive symbol filter.',
  },
  {
    phrase: 'instant approval',
    disposition: 'banned',
    rationale:
      'Compresses a provider underwriting decision into a promise about our own speed. No decision on this product set is instant, and the phrase sets an expectation every subsequent message has to walk back.',
  },
  {
    phrase: 'automatic approval',
    disposition: 'banned',
    rationale: 'Asserts the decision requires no underwriting; same reasoning as instant approval.',
  },
  {
    phrase: 'no credit check',
    disposition: 'banned',
    rationale:
      'False for every product this firm places, all of which involve a provider inquiry. It is also the phrase that most reliably attracts applicants who are being deceived elsewhere.',
  },
  {
    phrase: 'bad credit no problem',
    disposition: 'banned',
    rationale:
      'Says the credit profile does not affect the outcome, which is untrue and is the exact expectation a decline then contradicts.',
  },
  {
    phrase: 'bad credit is no problem',
    disposition: 'banned',
    rationale: 'Sentence form of the entry above; not a substring of it.',
  },
  {
    phrase: 'regardless of your credit',
    disposition: 'banned',
    rationale: 'The same claim in the register used in written material rather than headlines.',
  },
  {
    phrase: 'no matter your credit',
    disposition: 'banned',
    rationale: 'Colloquial form of "regardless of your credit".',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - money promises                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The colloquial money forms only. See the header for why the numerals are 4.3's job.
 *
 * These are seeded because they are fixed strings that appear in marketing register and almost
 * nowhere else: nobody writes "six figures" in a document request. A numeral does appear in
 * ordinary correspondence - "you were approved for 100k" is a fact about a decision that happened -
 * so banning bare numerals would block the true statements alongside the promised ones.
 */
const MONEY_PROMISES: readonly SeedClaim[] = [
  {
    phrase: 'six figures',
    disposition: 'banned',
    rationale:
      'A capital amount promised in marketing register. 4.3 flags this on a call as a critical promise; the same words in writing are the promise itself rather than a record of one.',
  },
  {
    phrase: 'six figure',
    disposition: 'banned',
    rationale:
      'The adjectival form, as in "six figure funding". Listed separately because word-boundary matching means the plural entry does not cover the singular.',
  },
  {
    phrase: 'hundred grand',
    disposition: 'banned',
    rationale:
      'The spoken form of an amount, carried into writing. Covers "a hundred grand" and "one hundred grand" as the shorter contained phrase.',
  },
  {
    phrase: 'get you funded',
    disposition: 'banned',
    rationale:
      'Asserts we bring funding about. The generic form matters more than any amount: it is the promise a numeral only quantifies.',
  },
  {
    phrase: 'get you the money',
    disposition: 'banned',
    rationale: 'Plain-language form of the funding promise.',
  },
  {
    phrase: 'guaranteed to get you',
    disposition: 'banned',
    rationale:
      'Catches the guarantee attached to any object - funding, an amount, a rate - without needing an entry for each.',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - credit repair (CROA)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Credit repair language would recharacterize the firm as a Credit Repair Organization under CROA -
 * principle 1, and the single fastest way to change what the company legally is.
 *
 * **Bare "credit repair" is deliberately absent.** It appears inside the standing disclaimer this
 * firm prints on every deliverable ("is not a lender, investment adviser, or credit repair
 * organization"), and an entry that blocks the sentence written to satisfy the rule is an entry
 * that gets the scanner switched off. The uses are banned; the noun is not.
 */
const CREDIT_REPAIR: readonly SeedClaim[] = [
  {
    phrase: 'we can remove negative items',
    disposition: 'banned',
    rationale:
      'Credit repair language. Saying it would recharacterize Burkham Wickmont as a Credit Repair Organization under CROA - principle 1.',
  },
  {
    phrase: 'remove negative items',
    disposition: 'banned',
    rationale:
      'Shorter form of the credit repair claim; same reasoning. Bound as a phrase, so "negative items cannot be removed by anyone, including us" - which is true and which we do print - is unaffected.',
  },
  {
    phrase: 'delete negative items',
    disposition: 'banned',
    rationale: 'Synonym of the removal claim.',
  },
  {
    phrase: 'dispute negative items',
    disposition: 'banned',
    rationale:
      'Dispute handling is the defining CROA activity. Burkham Wickmont does not dispute items on any report and may not offer to.',
  },
  {
    phrase: 'remove late payments',
    disposition: 'banned',
    rationale: 'The removal claim about a specific tradeline type.',
  },
  {
    phrase: 'remove collections',
    disposition: 'banned',
    rationale: 'The removal claim about a specific tradeline type.',
  },
  {
    phrase: 'fix your credit',
    disposition: 'banned',
    rationale: 'Credit repair framing; same CROA exposure.',
  },
  {
    phrase: 'repair your credit',
    disposition: 'banned',
    rationale: 'The CROA activity named directly, in the second person.',
  },
  {
    phrase: 'credit repair services',
    disposition: 'banned',
    rationale:
      'Offering the service by name. Seeded as the two-word use rather than as bare "credit repair" so the standing disclaimer, which contains "credit repair organization", still passes.',
  },
  {
    phrase: 'credit repair program',
    disposition: 'banned',
    rationale: 'Same offer under a different noun.',
  },
  {
    phrase: 'clean up your credit',
    disposition: 'banned',
    rationale: 'Colloquial form of the repair claim, and the one used verbally.',
  },
  {
    phrase: 'erase your bad credit',
    disposition: 'banned',
    rationale: 'Colloquial form asserting deletion of accurate reported history.',
  },
  {
    phrase: 'boost your credit score',
    disposition: 'banned',
    rationale:
      'Promises a score outcome this firm does not control and does not measure. Score movement is the bureau consequence of a client acting, not a service we render.',
  },
  {
    phrase: 'raise your credit score',
    disposition: 'banned',
    rationale: 'Synonym of the score-outcome promise.',
  },
  {
    phrase: 'improve your credit score',
    disposition: 'banned',
    rationale:
      'The mildest of the score-outcome promises and the most likely to be written in good faith, which is why it is listed. A factual variant - what generally moves a score - is a legitimate thing to say and should be proposed to the Board rather than assumed.',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - recharacterization (principle 1)                                   */
/* -------------------------------------------------------------------------- */

const RECHARACTERIZATION: readonly SeedClaim[] = [
  {
    phrase: 'we are a lender',
    disposition: 'banned',
    rationale:
      'Burkham Wickmont facilitates placement and is not a lender. Principle 1 - no communication may recharacterize the company.',
  },
  {
    phrase: 'we fund you directly',
    disposition: 'banned',
    rationale: 'Asserts we are the source of funds, which is the lender relationship.',
  },
  {
    phrase: 'we will fund you',
    disposition: 'banned',
    rationale: 'Same assertion in the future tense, and the form used in a closing email.',
  },
  {
    phrase: 'we are lending',
    disposition: 'banned',
    rationale: 'Present participle of the lender claim.',
  },
  {
    phrase: 'our loan to you',
    disposition: 'banned',
    rationale:
      'Describes the placement as our own credit. The provider is the counterparty on every product this firm places.',
  },
  {
    phrase: 'investment advice',
    disposition: 'banned',
    rationale: 'Would recharacterize the company as an investment adviser. Principle 1.',
  },
  {
    phrase: 'investment opportunity',
    disposition: 'banned',
    rationale:
      'Frames a capital placement as a security. The firm arranges business credit and offers nothing to invest in.',
  },
  {
    phrase: 'guaranteed return',
    disposition: 'banned',
    rationale: 'Investment-adviser language and an unconditional promise at once.',
  },
  {
    phrase: 'guaranteed returns',
    disposition: 'banned',
    rationale: 'Plural of the entry above; not covered by it under word-boundary matching.',
  },
  {
    phrase: 'debt settlement',
    disposition: 'banned',
    rationale:
      'Would recharacterize the firm as a debt settlement company, a regulated category with its own disclosure and fee regime. Principle 1.',
  },
  {
    phrase: 'settle your debt',
    disposition: 'banned',
    rationale: 'The debt settlement offer in the second person.',
  },
  {
    phrase: 'settle your debts',
    disposition: 'banned',
    rationale: 'Plural form; listed because word-boundary matching does not cover it.',
  },
  {
    phrase: 'reduce your debt',
    disposition: 'banned',
    rationale:
      'Debt settlement framing. A factual statement about refinancing into a lower cost of capital is a different claim and belongs in front of the Board with its basis (5.6 computes it).',
  },
  {
    phrase: 'cut your payments in half',
    disposition: 'banned',
    rationale:
      'A quantified settlement promise. The number makes it worse rather than better - it is unsubstantiated and specific.',
  },
  {
    phrase: 'stop paying your creditors',
    disposition: 'banned',
    rationale:
      'Advice to default. It is the debt-settlement practice regulators pursue most consistently, and it exposes the client to acceleration and litigation.',
  },
  {
    phrase: 'credit card loan',
    disposition: 'banned',
    rationale:
      'Mislabels a revolving line as a term loan - Level 4 prohibited action `mislabel_card_as_loan`. The two have different cost structures, and a client budgeting a card as a loan budgets wrongly.',
  },
  {
    phrase: 'card loan',
    disposition: 'banned',
    rationale: 'Shorter form of the same mislabel.',
  },
  {
    phrase: 'business grant',
    disposition: 'banned',
    rationale:
      'A grant is not repaid. Nothing this firm places is a grant, and the word is the standard bait in advance-fee fraud aimed at small businesses.',
  },
  {
    phrase: 'grant money',
    disposition: 'banned',
    rationale: 'Same misdescription in the form used verbally.',
  },
  {
    phrase: 'free money',
    disposition: 'banned',
    rationale: 'Describes repayable capital as a gift, and describes fees as absent at once.',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - fees (Level 4 `hide_fees`)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fee claims are banned rather than disclosure-gated on purpose.
 *
 * A fee statement is checkable against 1.4's fee exhibit, which is generated per engagement. So the
 * accurate sentence is always available and always specific ("the fees for this engagement are set
 * out in the attached exhibit"), and the generic reassurance is never necessary. Where a generic
 * claim is genuinely true it can be proposed - "no upfront fees" is in `proposed.ts` for exactly
 * that reason, and the Board may well approve it as banned anyway.
 */
const FEES: readonly SeedClaim[] = [
  {
    phrase: 'no fees',
    disposition: 'banned',
    rationale:
      'Level 4 prohibited action `hide_fees`. This firm is compensated on placement, so the unqualified claim is false; where a specific fee is genuinely absent, 1.4 fee exhibit states which.',
  },
  {
    phrase: 'zero fees',
    disposition: 'banned',
    rationale: 'Numeric form of "no fees".',
  },
  {
    phrase: 'no hidden fees',
    disposition: 'banned',
    rationale:
      'Reads as reassurance and asserts something unverifiable about our own conduct. The substantive version is the fee exhibit itself, which lists every fee - so this sentence adds nothing except an implication that others hide fees. Bound as three words, so "we disclose every fee" and similar accurate statements are unaffected.',
  },
  {
    phrase: 'no cost to you',
    disposition: 'banned',
    rationale:
      'Almost always false and, where the client pays nothing directly, still misleading: a success fee paid by the provider is priced into the offer.',
  },
  {
    phrase: 'free of charge',
    disposition: 'banned',
    rationale: 'Same claim in formal register.',
  },
  {
    phrase: 'no out of pocket',
    disposition: 'banned',
    rationale: 'Same claim in the register used verbally.',
  },
  {
    phrase: 'no upfront cost',
    disposition: 'banned',
    rationale:
      'A timing claim about fees rather than an amount claim, and a true-sounding one. Banned pending the Board deciding the accurate wording - see the "no upfront fees" proposal.',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - signing, consent, documents                                        */
/* -------------------------------------------------------------------------- */

/**
 * Four Level 4 prohibited actions - `sign_for_client`, `fabricate_revenue`, `alter_client_document`
 * and `submit_without_consent` - said out loud.
 *
 * Middleware hard-blocks each of these as an ACT. None of that reaches an email offering to do it,
 * and the offer is where the client's expectation is set. A message saying "we can just round the
 * revenue up" is evidence of intent whether or not anybody then did it.
 */
const CONDUCT: readonly SeedClaim[] = [
  {
    phrase: 'sign for you',
    disposition: 'banned',
    rationale:
      'Level 4 prohibited action `sign_for_client`. Offering it in writing is evidence of intent regardless of whether the signature was ever applied.',
  },
  {
    phrase: 'sign on your behalf',
    disposition: 'banned',
    rationale: 'Formal form of the same offer.',
  },
  {
    phrase: 'adjust your revenue',
    disposition: 'banned',
    rationale:
      'Level 4 prohibited action `fabricate_revenue`. Revenue on an application is a representation to the provider and comes from the client and their statements, unaltered.',
  },
  {
    phrase: 'inflate your revenue',
    disposition: 'banned',
    rationale: 'The same act named plainly.',
  },
  {
    phrase: 'round your revenue up',
    disposition: 'banned',
    rationale:
      'The form in which fabrication is actually proposed - as a small courtesy rather than as a misstatement.',
  },
  {
    phrase: 'edit your bank statements',
    disposition: 'banned',
    rationale:
      'Level 4 prohibited action `alter_client_document`. A statement is the provider evidence base; editing one is fraud on the provider.',
  },
  {
    phrase: 'change your bank statements',
    disposition: 'banned',
    rationale: 'Synonym of the alteration offer.',
  },
  {
    phrase: 'without your signature',
    disposition: 'banned',
    rationale:
      'Level 4 prohibited action `submit_without_consent`. Per-application written authorization is required before any submission, and a message describing submission without one describes a prohibited act.',
  },
  {
    phrase: 'no signature needed',
    disposition: 'banned',
    rationale: 'The same claim as reassurance.',
  },
  {
    phrase: 'no paperwork required',
    disposition: 'banned',
    rationale:
      'Untrue for every product placed, and it sets an expectation that makes the document chase feel like a change of terms.',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - legal and tax advice                                               */
/* -------------------------------------------------------------------------- */

/**
 * Level 4 prohibited action `give_legal_or_tax_advice_without_professional_review`.
 *
 * The bans are on the ADVICE, never on the words "legal advice" or "tax advice" - which appear in
 * the disclaimer that says we do not give it. Banning the disclaimer would be the clearest possible
 * demonstration of a rule written without reading what it would block.
 */
const PROFESSIONAL_ADVICE: readonly SeedClaim[] = [
  {
    phrase: 'you can write this off',
    disposition: 'banned',
    rationale:
      'Tax advice, given casually and in the form clients most often act on. Deductibility depends on facts nobody here has reviewed.',
  },
  {
    phrase: 'write it off on your taxes',
    disposition: 'banned',
    rationale: 'The same advice in the register used verbally.',
  },
  {
    phrase: 'this is tax deductible',
    disposition: 'banned',
    rationale: 'A tax conclusion stated as fact about a specific transaction.',
  },
  {
    phrase: 'as your attorney',
    disposition: 'banned',
    rationale:
      'Asserts a relationship that does not exist and that carries duties this firm cannot discharge.',
  },
  {
    phrase: 'as your accountant',
    disposition: 'banned',
    rationale: 'Same false relationship on the accounting side.',
  },
  {
    phrase: 'we recommend you incorporate',
    disposition: 'banned',
    rationale:
      'Entity structuring is legal advice with tax consequences. 1.2 maps a structure that exists; it does not prescribe one.',
  },
];

/* -------------------------------------------------------------------------- */
/* Banned - risk                                                               */
/* -------------------------------------------------------------------------- */

const RISK: readonly SeedClaim[] = [
  {
    phrase: 'no risk',
    disposition: 'banned',
    rationale:
      'Every capital placement carries risk, and personal guarantees make some of it personal. The phrase is false on its face for this product set.',
  },
  {
    phrase: 'risk free',
    disposition: 'banned',
    rationale: 'Variant of "no risk"; same reasoning.',
  },
  {
    phrase: 'pre-approved',
    disposition: 'banned',
    rationale:
      'A term of art with a specific meaning under FCRA firm-offer rules that this service does not satisfy.',
  },
];

/* -------------------------------------------------------------------------- */
/* Requires disclaimer                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Phrases that may be used, and only alongside a stated disclosure.
 *
 * The check is `text.includes(disclosure)` at the point of use (7.3 contracts, 8.1 partner
 * material, 4.5 assets), so the disclosure has to be IN the body. "Somebody will attach it" is a
 * hope, not a control - 8.1 says so in as many words, and it is right.
 */
const REQUIRES_DISCLAIMER: readonly SeedClaim[] = [
  {
    phrase: 'estimated',
    disposition: 'requires_disclaimer',
    rationale:
      'An estimate presented without its basis reads as a commitment. Blueprint 3.1 requires derived figures to ship how they were derived.',
    requiredDisclosure: DISCLOSURE_ESTIMATE,
  },
  {
    phrase: 'up to',
    disposition: 'requires_disclaimer',
    rationale:
      'Ceiling language implies attainability. Requires the qualifying disclosure so the figure is not read as an expectation.',
    requiredDisclosure: DISCLOSURE_MAXIMUM,
  },
  {
    phrase: 'projected',
    disposition: 'requires_disclaimer',
    rationale:
      'A projection is a model output. Without its basis it reads as a plan the firm is committing to.',
    requiredDisclosure: DISCLOSURE_PROJECTION,
  },
  {
    phrase: 'pre-qualified',
    disposition: 'requires_disclaimer',
    rationale:
      'Distinct from "pre-approved", which is banned: pre-qualification is our own fit assessment and is a real and useful thing to tell a client, provided it is not read as a provider decision.',
    requiredDisclosure: DISCLOSURE_PREQUALIFICATION,
  },
  {
    phrase: 'prequalified',
    disposition: 'requires_disclaimer',
    rationale: 'Unhyphenated spelling of the entry above; word-boundary matching separates them.',
    requiredDisclosure: DISCLOSURE_PREQUALIFICATION,
  },
  {
    phrase: 'as low as',
    disposition: 'requires_disclaimer',
    rationale:
      'Names the best available rate as though it were the offered one. The disclosure states who actually receives it.',
    requiredDisclosure: DISCLOSURE_LOWEST_RATE,
  },
  {
    phrase: '0% interest',
    disposition: 'requires_disclaimer',
    rationale:
      'A promotional rate described without its expiry. 5.6 exists because the go-to rate after the promotional window is the number that matters, and it is the one nobody quotes.',
    requiredDisclosure: DISCLOSURE_PROMOTIONAL_RATE,
  },
  {
    phrase: 'introductory rate',
    disposition: 'requires_disclaimer',
    rationale: 'Same promotional-window problem, named directly.',
    requiredDisclosure: DISCLOSURE_PROMOTIONAL_RATE,
  },
  {
    phrase: 'same day funding',
    disposition: 'requires_disclaimer',
    rationale:
      'A timing claim about a provider process. Permitted with the disclosure because some products genuinely do fund same-day; the disclosure states who decides.',
    requiredDisclosure: DISCLOSURE_TIMELINE,
  },
  {
    phrase: 'same-day funding',
    disposition: 'requires_disclaimer',
    rationale: 'Hyphenated spelling of the entry above.',
    requiredDisclosure: DISCLOSURE_TIMELINE,
  },
  {
    phrase: 'within 24 hours',
    disposition: 'requires_disclaimer',
    rationale: 'A timing commitment stated in the form used in outbound material.',
    requiredDisclosure: DISCLOSURE_TIMELINE,
  },
  {
    phrase: 'typical',
    disposition: 'requires_disclaimer',
    rationale:
      'Describes an outcome as representative. Requires the statement that it is not, which is the standard the FTC applies to testimonial and results claims.',
    requiredDisclosure: DISCLOSURE_NOT_TYPICAL,
  },
  {
    phrase: 'soft pull',
    disposition: 'requires_disclaimer',
    rationale:
      'Accurate and materially incomplete on its own: the soft inquiry is followed by a hard one at application, and that is the part the client cares about.',
    requiredDisclosure: DISCLOSURE_SOFT_INQUIRY,
  },
  {
    phrase: 'success rate',
    disposition: 'requires_disclaimer',
    rationale:
      'A results claim. 5.5 makes one computable for the first time; the disclosure states the period it is drawn from and that it does not predict.',
    requiredDisclosure: DISCLOSURE_SUBSTANTIATION,
  },
];

/* -------------------------------------------------------------------------- */
/* The library                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The founding library: banned and requires-disclaimer entries only.
 *
 * Not one entry is `approved`. That is the point of this slice and it is asserted in
 * `tests/integration/claim-library-seed.test.ts` rather than left to review.
 */
export const FOUNDING_CLAIMS: readonly SeedClaim[] = [
  ...APPROVAL_PROMISES,
  ...MONEY_PROMISES,
  ...CREDIT_REPAIR,
  ...RECHARACTERIZATION,
  ...FEES,
  ...CONDUCT,
  ...PROFESSIONAL_ADVICE,
  ...RISK,
  ...REQUIRES_DISCLAIMER,
];

/**
 * Every phrase that would be an inert rule, computed rather than asserted.
 *
 * A phrase whose first or last character is not a word character cannot match: the scanner binds
 * `\b` at both ends, and `\b` before `$` demands a word character immediately before the `$`. Such
 * an entry publishes cleanly, appears in the library, and counts toward `libraryEntriesChecked`
 * while matching nothing.
 *
 * Exported so a test can assert it is empty for the seeded library, and so that a future author
 * adding "$100K" gets a failing test naming the reason rather than a rule that quietly never fires.
 */
export const inertPhrases = (claims: readonly SeedClaim[]): readonly string[] =>
  claims.filter((claim) => !/^\w[\s\S]*\w$|^\w$/.test(claim.phrase)).map((claim) => claim.phrase);
