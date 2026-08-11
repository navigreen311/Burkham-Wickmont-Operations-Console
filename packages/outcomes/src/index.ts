/**
 * @bwc/outcomes - 5.5 Funding Outcome Ledger.
 *
 * The denominator 9.1 refused to fake.
 *
 * Before this module, every record in this system that touched placement recorded an approval:
 * `billing.funding_outcomes` carries an approved credit limit and an approval date and has no
 * column for a denial. So 9.1 computed no approval rate, and said why in the note it published
 * instead - a rate over a table where every row is an approval reads 100% forever, which is
 * arithmetically correct, meaningless, and the exact sentence 7.4 bans the company from saying.
 *
 * The fix is not arithmetic. It is that a decline has to be a row.
 *
 * What this module owns: the per-attempt record, its lifecycle (submitted, decided, funded), the
 * cohort and provider analyses over it, and the feedback loops into 1.4's refund trigger and 5.2's
 * approval-rate tracking - both written from inside the decision rather than beside it, because a
 * feedback loop a caller has to remember is the defect ADR-0034 is about.
 */

export * from './attempts.js';
export * from './rates.js';
