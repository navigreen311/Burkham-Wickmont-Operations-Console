# ADR-0006 — Envelope encryption and a ciphertext-only blob store

**Status:** Accepted
**Date:** 2026-08-10
**Context documents:** Blueprint 3.2; Specification v2 §5.7, §6.1, §6.2, §10.5

## Context

The Secure Document Vault holds the most sensitive data class in the portfolio — bank statements,
tax returns, government IDs, credit reports. §10.5 lists "zero data breaches" and "zero
cross-tenant data leaks" as success criteria.

Everything built before this protects _decisions_, which can be corrected. This protects
_documents_, and a leaked tax return cannot be.

## Decision 1 — envelope encryption, AES-256-GCM

**Rejected: one key, AES-256-CBC.** Two independent problems. CBC is unauthenticated, so a flipped
ciphertext bit decrypts to plausible garbage rather than failing — for a bank statement, silently
producing altered numbers that parse is worse than an error. And a single key means rotation
requires decrypting and re-encrypting every document in the system, which is precisely the
operation that gets deferred indefinitely.

**Chosen: a random 256-bit DEK per document, wrapped by a KEK.** GCM's auth tag turns tampering
into a failure. Rotation re-wraps DEKs, which is cheap. A DEK compromise is scoped to one document.

`KekProvider` is the seam. `EnvKekProvider` runs today and is honest about being a development
posture — §6.2 wants an HSM, and that becomes a provider swap rather than a rewrite. The interface
is `async` because a real HSM call is, and discovering that at integration time would mean changing
every call site.

**Two independent integrity checks, not one.** The GCM tag catches tampering with _this_
ciphertext; a sha256 of the plaintext catches a blob that decrypts perfectly but is not the
document that was stored — a swap, or a metadata row pointed at the wrong key. The second failure
never touches the ciphertext, so cryptography alone would not see it.

## Decision 2 — the blob store handles ciphertext only

`BlobStore` takes and returns ciphertext. Encryption happens _above_ it.

The distinction matters: "the store encrypts things" is a guarantee that depends on the store being
correct. "The store never receives plaintext" holds even if the store is wrong. The stronger
property is available for free here, so it is the one taken.

Blob keys are `sha256(tenantId)[0:4]/uuid` — no filename, no client name, no document kind. A
directory listing should reveal nothing about whose documents these are, because the store may end
up on infrastructure with a broader access list than the database.

Only a local filesystem store ships. S3 is the obvious production choice, but there are no
credentials and no Argus vendor review (§11.4), and an untested adapter would be the
fake-completeness this codebase keeps refusing.

## Decision 3 — watermarks are on the bytes

§6.2: "every document viewed or exported ... is watermarked with viewer identity and timestamp".
That is a property of the bytes the viewer receives. A watermark recorded only as a log line would
be a watermark in name — the point is that a document later found where it should not be can be
traced to who took it out.

`pdf-lib`, because `pdfkit` creates PDFs and cannot modify existing ones, and these are documents
the client uploaded. Non-PDF content (Plaid JSON, per Decision A) cannot be stamped, and reports
`watermarked: false` rather than implying otherwise — so "was this export watermarked?" has a
truthful answer for every export.

**Verifying this honestly took work.** PDF text is written as hex-encoded strings inside
Flate-compressed content streams, so neither the raw bytes nor the inflated stream contains the
viewer id as ASCII. The test inflates the streams _and_ decodes the hex operands. The tempting
weaker assertion — "the exported file got bigger" — would pass just as happily if the added bytes
said nothing at all.

## Consequences

**Good.** Plaintext never reaches disk, and the test proves it by reading the actual file. Rotation
is cheap. Tampering fails loudly. Access refusals are logged as carefully as successes, which is
what makes a pattern of denied cross-tenant attempts visible.

**Bad.** The KEK is in an environment variable, which is a real weakness and is documented as one.
Local filesystem storage is not a production posture. Both are seams rather than designs.

**Honest gaps, not silent ones.** No virus scanner exists, so documents land `pending` and are
**unreadable** until scanned — defaulting to `clean` would assert a check that never ran. Retention
rules come from modules that do not exist (7.2, 7.5), so deletion without a resolved schedule
returns `not_built`: over-retention is a liability, but destroying a document a regulator was
entitled to see is irreversible, and only one of those two failures cannot be undone.

**Revisit when:** the Argus vendor gate clears for a KMS/HSM and object store. Both are provider
swaps; no call site changes.
