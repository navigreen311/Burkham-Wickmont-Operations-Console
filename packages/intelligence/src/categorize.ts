/**
 * Transaction categorization — blueprint 3.3, "bank statement transaction tagging".
 *
 * Deterministic rules, not a model. Three reasons this is the right call *here* specifically:
 *
 *   - A category feeds a funding recommendation, and principle 8 requires derived figures to ship
 *     how they were derived. "The classifier said so" is not a derivation anyone can audit.
 *   - A rule can be shown to a client who disputes it. A weight cannot.
 *   - Rules are reviewable by Compliance & Evidence, which is who owns this discipline.
 *
 * The cost is coverage: real bank descriptions are messier than any rule list. `uncategorized` is
 * therefore a first-class outcome rather than a dumping ground, and its share is reported so a
 * revenue figure resting on 40% unknown transactions is visibly weaker than one resting on 5%.
 */

import type { NormalizedTransaction } from './normalized.js';

export const CATEGORIES = [
  'revenue',
  'owner_draw',
  'owner_contribution',
  'payroll',
  'debt_service',
  'nsf_fee',
  'bank_fee',
  'tax_payment',
  'transfer_internal',
  'operating_expense',
  'uncategorized',
] as const;

export type Category = (typeof CATEGORIES)[number];

interface Rule {
  readonly category: Category;
  readonly patterns: readonly RegExp[];
  /** Restricts a rule to money in or money out, since direction disambiguates most of these. */
  readonly direction?: 'in' | 'out';
  /** Why this rule exists, so a disputed category has an answer. */
  readonly basis: string;
}

/**
 * Order matters: the first match wins, so the specific rules precede the general ones.
 * `nsf_fee` before `bank_fee`, and both before `operating_expense`.
 */
const RULES: readonly Rule[] = [
  {
    category: 'nsf_fee',
    patterns: [/\bnsf\b/i, /non[- ]?sufficient/i, /\boverdraft\b/i, /\breturned item\b/i],
    direction: 'out',
    basis: 'Explicit NSF or overdraft language from the institution.',
  },
  {
    category: 'bank_fee',
    patterns: [/\bservice charge\b/i, /\bmonthly fee\b/i, /\bmaintenance fee\b/i, /\bwire fee\b/i],
    direction: 'out',
    basis: 'Institution fee language, excluding NSF which is matched first.',
  },
  {
    category: 'payroll',
    patterns: [
      /\bpayroll\b/i,
      /\bgusto\b/i,
      /\badp\b/i,
      /\bpaychex\b/i,
      /\bdirect dep.*payroll\b/i,
    ],
    direction: 'out',
    basis: 'Payroll processor or explicit payroll language.',
  },
  {
    category: 'debt_service',
    patterns: [
      /\bloan pmt\b/i,
      /\bloan payment\b/i,
      /\bmca\b/i,
      /\bmerchant (cash )?advance\b/i,
      /\bcard payment\b/i,
    ],
    direction: 'out',
    basis: 'Loan, card or advance repayment language.',
  },
  {
    category: 'tax_payment',
    patterns: [/\birs\b/i, /\beftps\b/i, /\bdept of revenue\b/i, /\bfranchise tax\b/i],
    direction: 'out',
    basis: 'Taxing-authority counterparty.',
  },
  {
    category: 'owner_draw',
    patterns: [/\bowner draw\b/i, /\bmember draw\b/i, /\bdistribution\b/i, /\bshareholder dist\b/i],
    direction: 'out',
    basis: 'Explicit owner distribution language.',
  },
  {
    category: 'owner_contribution',
    patterns: [
      /\bowner (contribution|deposit)\b/i,
      /\bcapital contribution\b/i,
      /\bmember contribution\b/i,
    ],
    direction: 'in',
    basis: 'Explicit owner contribution language.',
  },
  {
    category: 'transfer_internal',
    patterns: [/\btransfer (to|from)\b/i, /\binternal transfer\b/i, /\bonline transfer\b/i],
    basis: 'Movement between the client’s own accounts; excluded from revenue.',
  },
  {
    category: 'revenue',
    patterns: [
      /\bdeposit\b/i,
      /\bstripe\b/i,
      /\bsquare\b/i,
      /\bshopify\b/i,
      /\bach credit\b/i,
      /\bcustomer payment\b/i,
      /\binvoice\b/i,
    ],
    direction: 'in',
    basis: 'Inbound payment from a processor or customer.',
  },
  {
    category: 'operating_expense',
    patterns: [
      /\bpurchase\b/i,
      /\bpos debit\b/i,
      /\bcard purchase\b/i,
      /\bsupplier\b/i,
      /\bvendor\b/i,
      /\butility\b/i,
      /\brent\b/i,
    ],
    direction: 'out',
    basis: 'Ordinary outbound operating spend.',
  },
];

export interface Categorized {
  readonly transaction: NormalizedTransaction;
  readonly category: Category;
  /** Empty for `uncategorized`, so an unexplained category is impossible to fake. */
  readonly basis: string;
}

export const categorize = (transaction: NormalizedTransaction): Categorized => {
  const direction = transaction.amount > 0 ? 'in' : 'out';

  for (const rule of RULES) {
    if (rule.direction !== undefined && rule.direction !== direction) continue;
    if (rule.patterns.some((pattern) => pattern.test(transaction.description))) {
      return { transaction, category: rule.category, basis: rule.basis };
    }
  }

  return { transaction, category: 'uncategorized', basis: '' };
};

export interface CategorizationSummary {
  readonly categorized: readonly Categorized[];
  readonly total: number;
  readonly uncategorized: number;
  /** 0 to 1. Reported so a figure resting on mostly-unknown transactions is visibly weaker. */
  readonly coverage: number;
  readonly byCategory: Readonly<Record<Category, number>>;
}

export const categorizeAll = (
  transactions: readonly NormalizedTransaction[],
): CategorizationSummary => {
  const categorized = transactions.map(categorize);

  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
    Category,
    number
  >;
  for (const item of categorized) byCategory[item.category] += 1;

  const uncategorized = byCategory.uncategorized;
  const total = transactions.length;

  return {
    categorized,
    total,
    uncategorized,
    coverage: total === 0 ? 0 : (total - uncategorized) / total,
    byCategory,
  };
};

export const amountIn = (items: readonly Categorized[], category: Category): number =>
  items
    .filter((item) => item.category === category)
    .reduce((sum, item) => sum + item.transaction.amount, 0);
