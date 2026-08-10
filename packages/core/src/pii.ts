/**
 * PII discipline.
 *
 * This system handles the most sensitive data class in the portfolio: SSNs, EINs, full bank
 * statements, tax returns, government IDs, and credit reports. Field-level encryption protects
 * data at rest; this module protects it from the place encryption does not reach - logs, error
 * messages, and ledger payloads, all of which are retained indefinitely for compliance.
 *
 * A false negative writes an SSN into an append-only store that, by design, cannot be edited. That
 * is the failure these detectors exist to prevent, and it justifies erring toward redaction.
 *
 * What twice-burned experience has added: **a false positive is not cheap either.** It does not
 * cost "a redacted log line" - the same redactor runs on Ledger payloads, so a false positive
 * destroys an identifier in that same uneditable store, and destroys it silently. Both directions
 * are data loss; only one of them announces itself.
 *
 * The resolution is not a looser detector but a more precise one. Value-shape matching is a
 * backstop; the primary defences are the field-name list below and `assertNoPii` on write paths,
 * and neither is weakened by making the shape rules stop matching identifiers.
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

/**
 * 8-17 consecutive digits standing alone as a number - the bank account and card number range.
 *
 * The boundaries are **not** `\b`, and that is the whole point. `\b` sits between a word and a
 * non-word character, and `-` and `_` are non-word characters, so `\b\d{8,17}\b` matched the digit
 * run inside `escalate-test-wf-listen-12345678` - an identifier - and `redactPii` then replaced the
 * entire value with `[REDACTED]`.
 *
 * This is the second time the same class of defect has been found here. The first was full UUIDs
 * (see `UUID_PATTERN` below); the fix stripped them before shape-matching, which does nothing for a
 * *truncated* UUID or for any identifier that merely ends in digits. A tenant slug carries eight
 * hex characters, all-digits 2.3% of the time, and every payload field containing that slug -
 * `playbookKey`, `scope`, `applicationRef` - was destroyed on those runs. In an append-only store.
 *
 * It surfaced as an intermittent test failure at roughly the same 2.3%: a listener test that
 * matched a fired trigger by `playbookKey` found `[REDACTED]` instead. Two hypotheses were
 * eliminated first - unawaited appends and a truncated ledger read - before the arithmetic matched.
 *
 * So the run must be delimited by something that is not an identifier character. `Account
 * 123456789012 was debited` still redacts; `order-123456789012` does not.
 */
const LONG_DIGIT_RUN = /(?<![A-Za-z0-9_-])\d{8,17}(?![A-Za-z0-9_-])/;

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
 *
 * Kept after the `LONG_DIGIT_RUN` boundaries were narrowed, though the narrowing alone would now
 * spare a full UUID: the two guards fail differently, and the cost of keeping this one is a string
 * replace. Removing a guard because another one currently happens to cover the same case is how a
 * fixed defect comes back.
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
