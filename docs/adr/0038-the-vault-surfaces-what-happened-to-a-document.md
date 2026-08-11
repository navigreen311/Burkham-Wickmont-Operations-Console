# ADR-0038 — The Vault surfaces what happened to a document, not the document

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 3.2 Secure Document Vault

## Context

`@bwc/vault` can hand over a document. `read` decrypts the envelope, watermarks an export with the
viewer's identity, logs the access before returning a single byte, and refuses on any of four gates.
It is the most carefully built read path in the repository, and it works.

The obvious Console surface puts a **View** button beside each row.

## Decision

**No route on this surface returns document content — not to view, not to export — and the page says
so in a sentence rather than by having no button.**

The surface is document metadata (`forClient`) and the access log (`accessLog`). That is all.

### The objection is not that the gates would fail

They would not. The reasoning is the one ADR-0032 used to order the credential ahead of the UI, and
it applies harder here.

A gap reachable by somebody with a shell has a small population. **A page is an invitation**: it is
discoverable, it is bookmarkable, it is what somebody leaves open on a laptop, and it is what gets
screen-shared. The Vault holds the most sensitive data class in the portfolio — bank statements, tax
returns, government IDs, credit reports, signed authorizations — and §10.5 makes "zero data
breaches" a success criterion.

`MINIMUM_LEVEL_TO_READ` already applies least privilege per document class, and most staff hold
Level 3. **The gate that would actually be doing the work for a Console operator is not the
Authority Level; it is the absence of a button.** Naming that plainly is better than implying the
level is protecting something it is not.

Watermarking makes the point rather than answering it: §6.2 requires the viewer's identity stamped
on every export because exports are expected to leak, and the control is attribution after the fact.
That is the right trade for a document somebody has a reason to hold. It is the wrong trade for a
document nobody asked for, opened from a list because the button was there.

### What the log is for, and why it is the interesting half

`logAccess` records refusals as carefully as successes — `cross_tenant`, `below_level`,
`scan_pending`, `legal_hold`, `decrypt_failed`. A granted read is unremarkable. **A pattern of
below-level or cross-tenant attempts against one client's file is the signal an audit wants, and it
exists only if somebody can see it.** Nothing in the system displayed it before this slice.

So the surface counts granted and refused separately, and the page prints the refusal reason beside
each entry.

### `minimumLevelToRead` is surfaced; `readable` is not

The page says "reading it needs Authority Level 2" beside "you hold Level 3". Both are facts.

It does **not** compute a `readable` boolean, and the distinction matters: `read` gates on tenant,
then level, then scan status, then legal hold, in a fixed order. A boolean computed in the transport
would be a second implementation of that ordering, and — per `packages/core/src/authority.ts`'s own
header — a local copy of a rule drifts from it, silently. Reporting the constant is quoting the
module. Reporting a verdict would be re-deciding.

The same reasoning keeps `scanStatus` as a word. `pending` and `scan_unavailable` are distinct from
`clean` and neither means clean; a tick beside either would be the shortest possible lie.

## Consequences

**An operator who needs a document goes somewhere else, and there is nowhere else yet.** This is a
real cost and it is the point of writing it down: the answer is a deliberate flow — a reason, a
scope, an expiry — not a button that was easier to add. When one is built it should be its own slice
with its own argument.

**A test asserts a canary that lives only in the seeded document's ciphertext never appears in a
response or on the page.** A structural check, because the rule survives a rewrite only if something
watches it — and the honest note is that the browser half of that check did not catch the mutation
that added a content field. The page ignored the field, so nothing rendered; **the transport
assertion is what caught it.** The browser caught the same mutation through the declared
`bytesAvailableHere` flag instead, which is a different assertion doing a different job.

**The first version of the canary was a substring of legitimate copy.** It looked for the word
"synthetic" from the payload and matched a health component explaining that uptime monitoring would
need "a synthetic check hitting the API from outside". It failed rather than passed, which is the
safe direction, and the lesson holds either way: **an absence assertion is only as good as the
uniqueness of what it looks for.**

## Alternatives considered

**View but not export.** Halves nothing that matters. The disclosure risk is the content reaching a
screen; export adds a watermark and a second event, and the watermark is a control on the copy
rather than on the sight.

**View behind a re-authentication prompt.** Better than nothing and still the wrong shape: it gates
on who is asking, when the missing gate is *why*. It also trains people to type their password into
a prompt that appears when they click things.

**View for `bank_statement` only, since it is already Level 0.** The lowest-sensitivity class is
still a client's complete transaction history, and Level 0 is where the widest population sits.

**Ship the button and rely on the access log.** The log is a control on accountability, not on
disclosure. It tells you afterwards who read the tax return.
