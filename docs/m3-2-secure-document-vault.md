# 3.2 Secure Document Vault

Encrypted storage for the most sensitive data class in the portfolio: bank statements, tax
returns, government IDs, credit reports, debt schedules, signed authorizations, adverse-action
notices.

Everything built before this protects _decisions_, which can be corrected. This protects
_documents_, and a leaked tax return cannot be.

## What is enforced

| Blueprint 3.2 feature          | State                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| At-rest encryption             | Envelope encryption, AES-256-GCM, DEK per document (ADR-0006)           |
| Role-based access              | Authority Level, minimum set **per document class**                     |
| Access logs                    | Every access is a row **and** a ledger event — refusals included        |
| Watermarking on export         | Real PDF stamping with viewer identity, timestamp, document id          |
| Legal hold with export lockout | Implemented; human actor required to set or release                     |
| Retention rules                | Enforced where resolvable; **refuses to delete** when unresolvable      |
| Redaction / field encryption   | `encryptField` / `decryptField` for SSN, EIN, account, tax ID           |
| Virus scanning on upload       | **Seam only** — no engine available; unscanned documents are unreadable |

## The read path

```
read(actor, documentId)
  ├─ tenant           refuse + log   (principle 5)
  ├─ authority level  refuse + log   (principle 4, minimum by document class)
  ├─ virus scan       refuse + log   (pending and scan_unavailable both block)
  ├─ legal hold       refuse + log   (export only; viewing stays permitted)
  ├─ decrypt + verify GCM tag, then verify sha256 of the plaintext
  └─ log access, THEN return bytes
```

Logging happens **before** the bytes are returned. If the log write fails the caller gets nothing —
an access nobody recorded did not happen, as far as an audit is concerned.

Refusals are logged as carefully as successes. A pattern of denied cross-tenant attempts is exactly
the signal an audit wants, and it exists only if the failures are recorded.

## Least privilege by document class

`MINIMUM_LEVEL_TO_READ` puts government IDs at level 3, tax returns and credit reports at 2, and
ordinary financial statements at 0. Those are the documents whose disclosure is least recoverable
and least often actually needed by an agent doing analytical work — §6.2's least privilege applied
per class rather than as one blanket setting.

## Two integrity checks, not one

The GCM auth tag catches tampering with _this_ ciphertext. A sha256 of the plaintext catches a blob
that decrypts perfectly but is not the document that was stored — a swap, or a metadata row pointed
at the wrong blob key. That second failure never touches the ciphertext, so cryptography alone
would not see it.

## Honest gaps rather than silent ones

- **No virus scanner exists.** Documents land `pending` and are **unreadable** until a scan result
  is recorded. `scan_unavailable` is a distinct status from `clean`, so "we could not check" never
  reads as "we checked and it was fine".
- **Retention rules come from 7.2 and 7.5, neither built.** Deleting a document with no resolved
  schedule returns `not_built` naming those modules. Over-retention is a liability (§6.2), but
  destroying a document a regulator was entitled to see is irreversible — only one of the two
  failures cannot be undone.
- **The KEK lives in an environment variable.** §6.2 wants an HSM. `KekProvider` is the seam.
- **Local filesystem storage only.** S3 needs credentials and an Argus vendor review (§11.4).

## Configuration

| Variable          | Purpose                                  |
| ----------------- | ---------------------------------------- |
| `VAULT_KEK`       | 32-byte hex key-encryption key           |
| `VAULT_BLOB_ROOT` | Where ciphertext blobs land (gitignored) |

Generate a KEK:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Tests

```bash
pnpm test    # 203 tests
```

The encryption-at-rest test writes to a real temporary directory and **reads the file back**,
searching for a canary string from the plaintext. Asserting against an in-memory double would only
prove the double stores ciphertext, which is not the claim — the claim is about disk.

The watermark test inflates the PDF's Flate-compressed content streams _and_ decodes the hex text
operands, because that is where the viewer identity actually lives. The weaker assertion — "the
export got bigger" — would pass just as happily if the added bytes said nothing.

Also covered: one flipped ciphertext bit fails; a truncated ciphertext fails; an altered auth tag
fails; a correct ciphertext with the wrong digest fails; a different KEK fails; identical plaintext
produces different ciphertext; field encryption is non-deterministic, so read access cannot become
an equality oracle; a blob key that climbs out of the store root is refused.

## Next

**3.3 Document Intelligence Pipeline**, which consumes this. It is the most vendor-blocked module
in V1 — Plaid, business bureau and personal credit are all ungated — so expect structure,
normalisation and provenance preservation, with the vendor calls reporting `not_built`.
