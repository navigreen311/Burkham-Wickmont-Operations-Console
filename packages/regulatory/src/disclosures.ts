/**
 * Required disclosures per state per product - blueprint 7.2, "required disclosures auto-attached".
 *
 * Every disclosure carries its citation. That is not decoration: a requirement with no cited basis
 * cannot be reviewed by counsel, cannot be argued with when an agent thinks it is wrong, and cannot
 * be revisited when the statute changes. It calcifies into folklore - the same reasoning the
 * Marketing Claim Library (7.4) applies to a banned phrase.
 *
 * The federal baseline is returned alongside the state layer rather than instead of it. A state
 * with no product-specific rule does not mean "nothing must be disclosed"; it means the national
 * obligations stand alone, and returning an empty list would read as the former.
 */

import { db } from '@bwc/db';
import { ALL_PRODUCTS } from './states.js';

export interface RequiredDisclosure {
  readonly key: string;
  readonly text: string;
  readonly citation: string;
  /** `federal` or a two-letter state code, so a reader can see which layer obliges it. */
  readonly source: string;
  readonly productKind: string;
}

/**
 * Obligations that apply everywhere the company operates.
 *
 * Held in code rather than in a state module because they are not a state's rules and would
 * otherwise have to be duplicated into all fifty - where they would drift, and where removing one
 * from a single state would look like a local decision rather than the error it is.
 *
 * These are the ones the specification's regulatory surface names directly and that principle 1
 * turns into hard invariants: the company is not a lender, does not decide credit, and does not
 * repair credit.
 */
export const FEDERAL_BASELINE: readonly RequiredDisclosure[] = [
  {
    key: 'not_a_lender',
    text: 'Burkham Wickmont is not a lender and does not make credit decisions. Approval, terms and funding are determined solely by the provider.',
    citation: 'FTC Act §5 (deceptive practices); design principle 1',
    source: 'federal',
    productKind: ALL_PRODUCTS,
  },
  {
    key: 'no_guarantee',
    text: 'No approval, credit limit, rate or funding amount is guaranteed. Any figures shown are estimates based on information available at the time of preparation.',
    citation: 'FTC Act §5 (deceptive practices)',
    source: 'federal',
    productKind: ALL_PRODUCTS,
  },
  {
    key: 'not_credit_repair',
    text: 'Burkham Wickmont does not remove, repair or dispute items on any consumer or business credit report, and is not a Credit Repair Organization.',
    citation: 'Credit Repair Organizations Act, 15 U.S.C. §1679',
    source: 'federal',
    productKind: ALL_PRODUCTS,
  },
  {
    key: 'application_authorization',
    text: 'No application is submitted to any provider without the client’s written authorization for that specific application.',
    citation: '18 U.S.C. §1014 and §1344 (false statements on credit applications)',
    source: 'federal',
    productKind: ALL_PRODUCTS,
  },
  {
    key: 'business_purpose',
    text: 'The capital products described are extended for business purposes. Consumer credit protections that apply to personal borrowing generally do not apply.',
    citation: 'Regulation Z, 12 C.F.R. §1026.3(a) (business-purpose exemption)',
    source: 'federal',
    productKind: ALL_PRODUCTS,
  },
];

export interface DisclosureQuery {
  readonly tenantId: string;
  readonly state: string;
  /** Omit for the disclosures that apply to every product in the state. */
  readonly productKind?: string;
}

/**
 * Every disclosure obliged for this state and product.
 *
 * Reads the module **in force**, not the one counsel reviewed. A caller reaching this function has
 * already been told by `standingFor` whether the state permits the action at all; if the module has
 * moved ahead of its review the state is not active and nothing should be being generated. Reading
 * the current module here means that when the state comes back online there is no second place
 * holding stale text.
 */
export const requiredDisclosures = async (
  query: DisclosureQuery,
): Promise<readonly RequiredDisclosure[]> => {
  const module = await db().stateModule.findFirst({
    where: { tenantId: query.tenantId, state: query.state, supersededAt: null },
    orderBy: { version: 'desc' },
    include: { disclosures: true },
  });

  const stateLayer: RequiredDisclosure[] = (module?.disclosures ?? [])
    .filter(
      (disclosure) =>
        disclosure.productKind === ALL_PRODUCTS ||
        query.productKind === undefined ||
        disclosure.productKind === query.productKind,
    )
    .map((disclosure) => ({
      key: disclosure.key,
      text: disclosure.text,
      citation: disclosure.citation,
      source: query.state,
      productKind: disclosure.productKind,
    }));

  // Federal first: it is the layer that applies regardless, and a reader scanning a generated
  // document should meet the unconditional obligations before the jurisdictional ones.
  return [...FEDERAL_BASELINE, ...stateLayer];
};

/**
 * Which of the required disclosures are missing from a piece of client-facing content.
 *
 * Matched on the disclosure's **key** appearing in an explicit attachment list rather than by
 * searching the text for the wording. Substring matching would report a disclosure as present
 * because a paraphrase happened to share a few words, and a disclosure that is nearly there is not
 * there - it is the specific language that discharges the obligation.
 */
export const missingDisclosures = (
  required: readonly RequiredDisclosure[],
  attachedKeys: readonly string[],
): readonly RequiredDisclosure[] => {
  const attached = new Set(attachedKeys);
  return required.filter((disclosure) => !attached.has(disclosure.key));
};
