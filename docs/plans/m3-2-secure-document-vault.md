# Plan — 3.2 Secure Document Vault

**Blueprint:** 3.2 Secure Document Vault · **Specification:** §5.7, §6.1, §6.2
**Branch:** `ai-feature/m3-2-secure-document-vault`
**Follows:** Category 3 slice A (merged, `027f386`)

---

## Mini-PRD

### Problem

This module holds the most sensitive data class in the Green Companies portfolio: bank statements,
tax returns, government IDs, credit reports, debt schedules, signed authorizations, adverse-action
notices. Specification §6.1 names it directly, and §10.5 makes "zero data breaches" and "zero
cross-tenant data leaks" success criteria rather than aspirations.

Everything built so far has protected _decisions_. This protects _documents_, and the failure mode
is categorically different: a wrong decision can be corrected, a leaked tax return cannot.

### Blueprint 3.2 key features, and what each becomes

| Feature                                  | This slice                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| At-rest and in-transit encryption        | Envelope encryption, AES-256-GCM, DEK per document                       |
| Role-based access from Identity & Access | Authority Level + department, checked on every read                      |
| Watermarking on view/export              | Real PDF stamping with viewer identity and timestamp                     |
| Download controls, access logs           | Every access is a row **and** a ledger event                             |
| Document expiration, retention rules     | Stored and enforced where resolvable; **gated honestly** on 7.2 / 7.5    |
| Legal hold with export lockout           | Implemented — blocks export and deletion                                 |
| Redaction tools                          | Field-level encryption for SSN / EIN / account / tax ID                  |
| Virus scanning on upload                 | **Seam only** — no scanner available; unscanned documents cannot be read |

### Risks

| Risk                                          | Mitigation                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Plaintext reaches disk                        | The store never receives plaintext; encryption happens above it, and a test greps the actual bytes on disk             |
| Silent decryption of tampered data            | AES-**GCM**, not CBC — the auth tag makes tampering a failure rather than garbage                                      |
| A leaked key file decrypts everything forever | Envelope encryption: per-document DEKs wrapped by a KEK, so KEK rotation does not require re-encrypting every document |
| Access happens without a record               | Read returns through one function that logs before returning bytes                                                     |
| "Scanned for viruses" implied but not done    | The gate refuses reads of unscanned documents rather than defaulting them clean                                        |

---

## Key decision — encryption scheme

**A. Single key, AES-256-CBC.** Simplest. Rejected on two counts: CBC is unauthenticated, so a
flipped ciphertext bit decrypts to plausible garbage rather than failing; and one key for every
document means rotation is a full re-encrypt.

**B. Envelope encryption, AES-256-GCM.** _(chosen)_ A random 256-bit **DEK** per document encrypts
the content; the DEK is itself encrypted by a **KEK** and stored beside the ciphertext. GCM
authenticates, so tampering fails loudly. Rotation re-wraps DEKs — cheap — rather than
re-encrypting payloads.

**C. Per-document keys in a KMS.** Correct at scale, but requires a live KMS to run anything
locally, and the Argus vendor gate has not cleared for any external provider.

**Decision: B**, with `KekProvider` as the seam. `EnvKekProvider` today; an HSM/KMS provider drops
in without touching call sites, matching §6.2's "key management with hardware security modules".

## Key decision — blob storage

`BlobStore` interface with a **local encrypted filesystem** implementation. An S3 implementation is
the obvious production choice, but there are no credentials and no Argus vendor review, so shipping
one would be the fake-completeness this codebase keeps refusing. The interface is the seam; the
local store is real and complete.

Ciphertext only ever crosses this interface — the store cannot leak plaintext because it never
receives any.

## Watermarking

`pdf-lib` stamps uploaded PDFs on export with viewer identity, timestamp, and document id.
`pdfkit` creates PDFs but cannot edit them, so a second library is genuinely required.

A watermark that is only a log line would be a watermark in name. §6.2 says "every document viewed
or exported from the Secure Document Vault is watermarked with viewer identity and timestamp" —
that is a property of the bytes the viewer receives, so it is implemented on the bytes.

Non-PDF exports cannot be stamped; those record the access and return an explicit
`watermarked: false` rather than implying otherwise.

---

## Architecture

```
packages/vault/
  crypto.ts    envelope encryption, KEK provider seam, field-level encryption
  store.ts     BlobStore interface + local encrypted filesystem store
  vault.ts     3.2 - upload, scan gate, access-controlled read, export, hold, retention
  watermark.ts pdf-lib stamping
```

Access control combines three checks, all required: **tenant** (principle 5), **Authority Level**
(principle 4, minimum by document classification), and **legal hold** (export lockout).

### Data model — schema `vault`

- `VaultDocument` — tenant, client, kind, classification, filename, contentType, byteSize,
  `sha256`, `blobKey`, `wrappedDek`, `iv`, `authTag`, scan status, retention, `legalHold`
- `VaultAccessLog` — every read/export: who, when, why, whether watermarked

### The read path

```
read(actor, documentId)
  ├─ tenant check          -> refuse (principle 5)
  ├─ authority check       -> refuse (principle 4)
  ├─ virus-scan gate       -> refuse if not clean
  ├─ legal-hold check      -> export only
  ├─ fetch ciphertext, unwrap DEK, decrypt+verify
  ├─ verify sha256 against the recorded digest
  └─ log access (row + ledger event) BEFORE returning bytes
```

Logging before returning is deliberate: if the log write fails, the caller does not get the
document. An access that was not recorded did not happen, as far as an audit is concerned.

---

## Test strategy

- **The bytes on disk contain no plaintext** — asserted against the actual file, not a mock.
- Tampering with one ciphertext byte fails decryption (GCM auth tag).
- A wrong KEK fails rather than returning garbage.
- Every successful read writes an access-log row and a ledger event.
- Cross-tenant read refused; below-level read refused; both logged.
- An unscanned or infected document cannot be read.
- Legal hold blocks export and deletion; the underlying document survives.
- Retention: deleting before the retention date refuses.
- PDF export carries the viewer's identity and a timestamp in the bytes.
- Non-PDF export reports `watermarked: false` rather than implying a stamp.
- Field-level encryption round-trips and the ciphertext does not contain the plaintext.

---

## Out of scope

Real virus scanning (no engine available — the gate is honest about it), S3, HSM/KMS providers,
7.5 Legal Hold & Record Retention as a module (V1.5; this slice implements the hold _flag_ and the
export lockout it requires), and 3.3 Document Intelligence Pipeline, which consumes this next.
