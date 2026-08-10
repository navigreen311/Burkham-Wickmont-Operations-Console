/**
 * The Green Companies register - blueprint 10.1's "automatic tagging when client entity is a
 * Green Companies venture".
 *
 * Pure. The register is data, so who counts as a sibling venture is a fact somebody can read and
 * correct rather than a condition buried in a query.
 *
 * **Why automatic tagging matters more than it looks.** A related-party engagement priced,
 * disclosed and invoiced as though it were ordinary is not a mistake anybody makes deliberately -
 * it is what happens when the person doing the work does not know the counterparty is a sibling.
 * Tagging by hand puts the control behind the knowledge it exists to supply.
 *
 * Detection is deliberately CONSERVATIVE in one direction and loud in the other. A name that
 * matches is tagged. A name that is close but not certain produces a `possible` verdict that
 * REFUSES to proceed until somebody confirms - because the cost of asking is a question, and the
 * cost of missing one is an undisclosed related-party transaction.
 */

export type VentureKey = 'medlink' | 'greenstone' | 'argus' | 'collingswood';

export interface Venture {
  readonly key: VentureKey;
  readonly displayName: string;
  /** Legal-name fragments that identify this venture. Lowercased, matched as substrings. */
  readonly identifiers: readonly string[];
  /** What this venture does, so a disclosure can say what the overlap actually is. */
  readonly businessLine: string;
  /**
   * Why an engagement with this venture is a conflict, in the words the disclosure will use.
   *
   * Per-venture rather than generic, because the conflicts differ. Argus reviews our own vendor
   * security, and Collingswood receives client handoffs from us - those are not the same problem
   * as MedLink simply being a sibling.
   */
  readonly conflictBasis: string;
}

export const GREEN_COMPANIES: readonly Venture[] = [
  {
    key: 'medlink',
    displayName: 'MedLink Pro',
    identifiers: ['medlink'],
    businessLine: 'Healthcare staffing and facility operations software.',
    conflictBasis:
      'Common ownership with Burkham Wickmont. Any advice we give on their capital structure is advice given to our own owner, and any fee we charge moves money between entities with the same beneficial owner.',
  },
  {
    key: 'greenstone',
    displayName: 'Greenstone PCA',
    identifiers: ['greenstone'],
    businessLine: 'Property condition assessment and site inspection.',
    conflictBasis:
      'Common ownership with Burkham Wickmont, and Greenstone supplies assessment work that may appear in a client file we assemble. The conflict runs in both directions.',
  },
  {
    key: 'argus',
    displayName: 'Argus',
    identifiers: ['argus'],
    businessLine: 'Security review and vendor assessment.',
    conflictBasis:
      'Common ownership, AND Argus performs the security reviews that gate our own vendor integrations under Decisions A and B. We are their client and they are ours; an engagement here means the party reviewing our vendors is a party we bill.',
  },
  {
    key: 'collingswood',
    displayName: 'Collingswood',
    identifiers: ['collingswood'],
    businessLine: 'Founder personal financial advisory.',
    conflictBasis:
      'Common ownership, AND Collingswood receives cross-portfolio handoffs from us for founder personal-layer work. We refer clients to them; charging them as a client while referring clients to them is a circular commercial relationship the disclosure has to state plainly.',
  },
];

export const ventureByKey = (key: VentureKey): Venture =>
  GREEN_COMPANIES.find((venture) => venture.key === key) as Venture;

export type DetectionVerdict = 'venture' | 'possible' | 'unrelated';

export interface Detection {
  readonly verdict: DetectionVerdict;
  readonly venture: Venture | null;
  readonly detail: string;
}

/**
 * Words that appear in the ventures' names but do not identify one on their own.
 *
 * Without this list, "Greenstone" would match "Green Valley Landscaping LLC" on the token "green"
 * if the matcher were ever loosened to tokens - and a false venture tag is not harmless. It
 * blocks a normal client behind a conflict process nobody can complete, because there is no
 * sibling to acknowledge the disclosure.
 */
const AMBIGUOUS_TOKENS: readonly string[] = ['green', 'link', 'pro', 'stone', 'wood'];

/**
 * Whether this legal name identifies a Green Companies venture.
 *
 * Exact substring on a distinctive identifier gives `venture`. A name containing an ambiguous
 * token and nothing distinctive gives `possible`, which callers must resolve with a person.
 * Everything else is `unrelated`.
 */
export const detectVenture = (legalName: string): Detection => {
  const normalised = legalName.toLowerCase();

  for (const venture of GREEN_COMPANIES) {
    if (venture.identifiers.some((identifier) => normalised.includes(identifier))) {
      return {
        verdict: 'venture',
        venture,
        detail: `'${legalName}' matches ${venture.displayName}. This is a related-party engagement: ${venture.conflictBasis}`,
      };
    }
  }

  const ambiguous = AMBIGUOUS_TOKENS.filter((token) =>
    new RegExp(`\\b${token}`, 'i').test(normalised),
  );

  if (ambiguous.length > 0) {
    return {
      verdict: 'possible',
      venture: null,
      // Refusing to guess in either direction. Tagging a stranger blocks them behind a conflict
      // process that cannot be completed; missing a sibling is an undisclosed related-party
      // transaction. A question costs less than either.
      detail: `'${legalName}' contains ${ambiguous.map((token) => `'${token}'`).join(', ')}, which appears in a Green Companies name without identifying one. Somebody must confirm whether this is a portfolio venture before the engagement proceeds - guessing wrong is costly in both directions.`,
    };
  }

  return {
    verdict: 'unrelated',
    venture: null,
    detail: `'${legalName}' does not match any Green Companies venture.`,
  };
};

/**
 * Whether Gardner may see this engagement.
 *
 * DERIVED from venture status and nothing else. Blueprint 10.1 lists "Gardner-visibility flags",
 * and a settable flag would eventually be set on a normal client - at which point the common owner
 * of the portfolio is reading the file of somebody who has no relationship with them, and the
 * client's engagement letter says nothing about it.
 *
 * For a venture the position is different and legitimate: Gardner owns both sides, governs the
 * intercompany relationship, and is the party who has to approve its pricing.
 */
export const gardnerMayView = (detection: Detection): boolean => detection.verdict === 'venture';
