/**
 * PII discipline.
 *
 * This system handles the most sensitive data class in the portfolio: SSNs, EINs, full bank
 * statements, tax returns, government IDs, and credit reports. Field-level encryption protects
 * data at rest; this module protects it from the place encryption does not reach - logs, error
 * messages, and ledger payloads, all of which are retained indefinitely for compliance.
 *
 * The detectors are deliberately conservative. A false positive costs a redacted log line.
 * A false negative writes an SSN into an append-only store that, by design, cannot be edited.
 */

/** Field names whose values must never be written to a log, error, or ledger payload. */
export const PII_FIELD_NAMES = [
  'ssn',
  'socialSecurityNumber',
  'ein',
  'employerIdentificationNumber',
  'taxId',
  'tin',
  'accountNumber',
  'bankAccountNumber',
  'routingNumber',
  'dateOfBirth',
  'dob',
  'driversLicense',
  'passportNumber',
  'plaidAccessToken',
] as const;

const PII_FIELD_SET = new Set<string>(PII_FIELD_NAMES.map((name) => name.toLowerCase()));

export const isPiiFieldName = (name: string): boolean => PII_FIELD_SET.has(name.toLowerCase());

/**
 * Value-shaped detectors, for the case where PII arrives under an innocent key
 * (`value`, `identifier`, `note`) rather than a recognised one.
 */
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;
const EIN_PATTERN = /\b\d{2}-\d{7}\b/;
/** 8-17 consecutive digits: bank account and card number range. */
const LONG_DIGIT_RUN = /\b\d{8,17}\b/;

/**
 * UUIDs are identifiers, not PII, and must be excluded before the value-shape detectors run.
 *
 * A UUID's first group is 8 hex characters, and roughly 2.3% of the time all eight happen to be
 * digits - `12345678-90ab-...`. That matches `LONG_DIGIT_RUN`, so the redactor replaced the whole
 * value with `[REDACTED]`.
 *
 * The consequence was not cosmetic. Instance ids, document ids and task ids travel in ledger
 * payloads, so roughly one in forty was silently destroyed in an append-only store that cannot be
 * corrected, and any code reading the id back got the string `[REDACTED]`. It surfaced as an
 * unrelated Prisma error ("invalid character ... found `[`") in a workflow test, which is the
 * only reason it was noticed at all.
 *
 * Stripped rather than short-circuited, so a real SSN sitting next to a UUID in the same string
 * is still caught.
 */
const UUID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

export const looksLikePii = (value: string): boolean => {
  const withoutIdentifiers = value.replace(UUID_PATTERN, '');
  return (
    SSN_PATTERN.test(withoutIdentifiers) ||
    EIN_PATTERN.test(withoutIdentifiers) ||
    LONG_DIGIT_RUN.test(withoutIdentifiers)
  );
};

export const REDACTED = '[REDACTED]';

/**
 * Deep-redact a payload before it reaches a log sink or the Event Ledger.
 *
 * Redacts on field name first, then on value shape, so a recognised key is redacted even
 * when its value looks harmless, and an unrecognised key is redacted when its value does not.
 * Recurses through arrays and plain objects; leaves other types alone.
 */
export const redactPii = (input: unknown): unknown => {
  if (typeof input === 'string') {
    return looksLikePii(input) ? REDACTED : input;
  }
  if (Array.isArray(input)) {
    return input.map(redactPii);
  }
  if (typeof input === 'object' && input !== null) {
    if (input instanceof Date) return input;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = isPiiFieldName(key) ? REDACTED : redactPii(value);
    }
    return output;
  }
  return input;
};

/**
 * Assertion for test and write paths: throws if the payload still carries anything
 * PII-shaped after redaction should have run.
 */
export function assertNoPii(payload: unknown, context: string): void {
  const findings: string[] = [];

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (node !== REDACTED && looksLikePii(node)) findings.push(path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof node === 'object' && node !== null && !(node instanceof Date)) {
      for (const [key, value] of Object.entries(node)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        if (isPiiFieldName(key) && value !== REDACTED) {
          findings.push(childPath);
          continue;
        }
        walk(value, childPath);
      }
    }
  };

  walk(payload, '');

  if (findings.length > 0) {
    throw new Error(
      `PII detected in ${context} at: ${findings.join(', ')}. PII must never reach logs, errors, or the Event Ledger.`,
    );
  }
}
