/**
 * USPS state codes, as a closed vocabulary.
 *
 * **The check this replaces was `length !== 2` applied after `toUpperCase()`.** That refuses
 * `NewYork` and `N.Y.` correctly and accepts `12`, `N-` and `$$` - anything two characters wide.
 * A jurisdiction is not a two-character string; it is a member of a list, and the difference is a
 * parse boundary (specification 3.3): the moment an outside value becomes a domain value is the
 * moment to check it is one.
 *
 * The consequence of getting it wrong is not cosmetic. `checkJurisdiction` decides whether the firm
 * may act in a state at all, and a code nothing recognises resolves to no module - which reads on a
 * surface as "no state rule applies" when the truth is "we could not tell which state".
 *
 * Fifty states plus the District of Columbia. Territories are deliberately absent: the firm has no
 * regulatory module for any of them, and offering a code the Regulatory Engine cannot answer for
 * would move the refusal from the input, where it is legible, to a lookup where it is not.
 */
export const USPS_STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

export type UspsStateCode = (typeof USPS_STATE_CODES)[number];

/** The exact refusal the surface shows, kept here so client and server say the same sentence. */
export const JURISDICTION_REFUSAL =
  'Jurisdiction must be a 2-letter USPS state code (e.g., NY, CA, TX)';

/**
 * Is this a state code?
 *
 * Case is normalised before the check because `ny` is unambiguous and refusing it teaches nothing -
 * but `n.y.`, `12` and `NewYork` are refused, because each is a different value that happens to be
 * near one.
 */
export const isUspsStateCode = (value: unknown): value is UspsStateCode =>
  typeof value === 'string' &&
  (USPS_STATE_CODES as readonly string[]).includes(value.trim().toUpperCase());

/** The normalised code, or null. One place decides, so no caller re-implements the rule. */
export const toUspsStateCode = (value: unknown): UspsStateCode | null =>
  isUspsStateCode(value) ? ((value as string).trim().toUpperCase() as UspsStateCode) : null;
