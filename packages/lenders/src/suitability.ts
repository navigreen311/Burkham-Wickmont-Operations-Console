/**
 * Funding Product Suitability Matrix - blueprint 5.2.
 *
 * Eligibility asks whether a client *can* get a product. Suitability asks whether they
 * *should*, and the two answers differ often enough that keeping them in one function
 * would hide the disagreement.
 *
 * The matrix exists because the products easiest to qualify for are frequently the worst
 * fit. A merchant cash advance will fund a 45-day receivables gap in three days, and a
 * client who takes one for a five-year expansion is servicing a 90% APR obligation long
 * after the reason for it ended. That mismatch is not caught by any underwriting box - the
 * client qualified. It is caught here or not at all.
 *
 * Scores are a small integer scale rather than a percentage, deliberately: a percentage
 * invites arithmetic it cannot support, and would read as a probability, which it is not.
 */

import type { CapitalNeed } from './profile.js';

export type ProductKind =
  | 'business_credit_card'
  | 'line_of_credit'
  | 'term_loan'
  | 'merchant_cash_advance'
  | 'invoice_factoring'
  | 'equipment_finance'
  | 'sba_loan';

export const PRODUCT_KINDS = [
  'business_credit_card',
  'line_of_credit',
  'term_loan',
  'merchant_cash_advance',
  'invoice_factoring',
  'equipment_finance',
  'sba_loan',
] as const satisfies readonly ProductKind[];

/**
 * -2 to 3. Negative means the product actively works against the need rather than merely
 * fitting it poorly, and a negative score is reported as a *caution*, not filtered out -
 * a client with no other option may still take one, and they are entitled to be told why
 * it is a poor fit rather than to have it quietly removed from the list.
 */
export type SuitabilityScore = -2 | -1 | 0 | 1 | 2 | 3;

interface MatrixEntry {
  readonly score: SuitabilityScore;
  readonly rationale: string;
}

type Matrix = Readonly<Record<CapitalNeed, Readonly<Record<ProductKind, MatrixEntry>>>>;

const entry = (score: SuitabilityScore, rationale: string): MatrixEntry => ({ score, rationale });

/**
 * The matrix. Every cell carries its reasoning, because the score alone is unarguable in
 * the bad sense - a reviewer who disagrees needs something to disagree *with*.
 */
export const SUITABILITY_MATRIX: Matrix = {
  working_capital: {
    line_of_credit: entry(3, 'Draw and repay as the need moves; interest only on what is drawn.'),
    business_credit_card: entry(
      2,
      'Revolving and fast to obtain, though the limit is usually smaller than a line of credit.',
    ),
    term_loan: entry(
      1,
      'Workable but blunt: a fixed sum amortised on a fixed schedule against a need that fluctuates.',
    ),
    sba_loan: entry(1, 'Cheap capital, but the timeline rarely matches a working-capital need.'),
    merchant_cash_advance: entry(
      -1,
      'Daily remittances against ongoing working capital compound the cash-flow pressure they were taken to relieve.',
    ),
    invoice_factoring: entry(
      0,
      'Fits only if the working-capital gap is specifically receivables-driven.',
    ),
    equipment_finance: entry(
      -2,
      'Proceeds are restricted to equipment and cannot fund operations.',
    ),
  },
  receivables_gap: {
    invoice_factoring: entry(
      3,
      'Priced and structured against the invoices themselves, and closes when they pay.',
    ),
    line_of_credit: entry(2, 'Draw against the gap and repay on collection.'),
    business_credit_card: entry(1, 'Bridges a small gap if the counterparty accepts cards.'),
    merchant_cash_advance: entry(
      0,
      'Fast, and expensive for a gap that is by definition short - the cost lands before the receivable does.',
    ),
    term_loan: entry(
      -1,
      'A multi-year obligation against a 30-to-90-day gap leaves debt outstanding long after the gap closes.',
    ),
    sba_loan: entry(-1, 'Timeline is far longer than the gap it would fund.'),
    equipment_finance: entry(-2, 'Proceeds cannot be applied to receivables.'),
  },
  equipment_purchase: {
    equipment_finance: entry(
      3,
      'Secured by the asset, so pricing reflects the collateral and the term matches its useful life.',
    ),
    sba_loan: entry(2, 'SBA 504 is built for fixed-asset purchases at long amortisation.'),
    term_loan: entry(2, 'Matches a one-time purchase to a fixed repayment.'),
    line_of_credit: entry(
      0,
      'Possible, but consumes revolving capacity better reserved for operations.',
    ),
    business_credit_card: entry(0, 'Only for small equipment, and rarely accepted by vendors.'),
    merchant_cash_advance: entry(
      -2,
      'A depreciating asset funded at short-term advance pricing is the most expensive way to buy equipment.',
    ),
    invoice_factoring: entry(-2, 'Unrelated to an equipment purchase.'),
  },
  expansion: {
    sba_loan: entry(3, 'Longest amortisation and lowest cost for a multi-year investment.'),
    term_loan: entry(3, 'Fixed sum, fixed term, matched to a project with a defined end.'),
    line_of_credit: entry(1, 'Useful alongside a term facility, weak as the primary source.'),
    equipment_finance: entry(1, 'Fits the equipment portion of an expansion, not the rest of it.'),
    business_credit_card: entry(0, 'Limits are rarely material at expansion scale.'),
    merchant_cash_advance: entry(
      -2,
      'Repayment begins immediately while an expansion produces revenue months later.',
    ),
    invoice_factoring: entry(-1, 'Unrelated to an expansion project.'),
  },
  refinance_existing: {
    term_loan: entry(
      3,
      'Consolidates short-term obligations onto a schedule the client can service.',
    ),
    sba_loan: entry(3, 'The cheapest refinance available where the client and use qualify.'),
    line_of_credit: entry(1, 'Helps only if the balance being refinanced is itself revolving.'),
    business_credit_card: entry(
      0,
      'A balance-transfer promotion can help, and becomes a cliff at expiry.',
    ),
    equipment_finance: entry(0, 'Only where existing equipment can be refinanced against.'),
    invoice_factoring: entry(-1, 'Does not retire existing debt.'),
    merchant_cash_advance: entry(
      -2,
      'Refinancing into an advance almost always raises total cost - the stacking pattern the Funding Ethics Firewall exists to stop.',
    ),
  },
  startup_launch: {
    business_credit_card: entry(
      2,
      'Personal-credit-driven underwriting is often the only door open before revenue exists.',
    ),
    sba_loan: entry(
      1,
      'Possible with a strong plan and injection, though slow and paperwork-heavy.',
    ),
    equipment_finance: entry(1, 'Available where the asset itself carries the security.'),
    line_of_credit: entry(0, 'Most issuers require operating history a launch does not have.'),
    term_loan: entry(0, 'Same history requirement.'),
    invoice_factoring: entry(-1, 'There are no receivables yet.'),
    merchant_cash_advance: entry(
      -2,
      'Priced against card receipts a launch has not generated, and the most expensive capital a new entity can take.',
    ),
  },
};

export interface SuitabilityAssessment {
  readonly productKind: ProductKind;
  readonly need: CapitalNeed;
  readonly score: SuitabilityScore;
  readonly rationale: string;
  /** True when the product works against the need. Surfaced, never silently filtered. */
  readonly caution: boolean;
}

export const assessSuitability = (
  productKind: ProductKind,
  need: CapitalNeed,
): SuitabilityAssessment => {
  const cell = SUITABILITY_MATRIX[need][productKind];
  return {
    productKind,
    need,
    score: cell.score,
    rationale: cell.rationale,
    caution: cell.score < 0,
  };
};

/** Products ranked for a need, best first. Cautions rank last but are still present. */
export const rankProductsForNeed = (need: CapitalNeed): readonly SuitabilityAssessment[] =>
  PRODUCT_KINDS.map((kind) => assessSuitability(kind, need)).sort((a, b) => b.score - a.score);
