# Client access to the Vault (3.2 with 11.10)

Package: `@bwc/vault` (`clientAccess.ts`) + `@bwc/portal` · **No schema change** · ADR: [0021 + amendment](adr/0021-a-client-user-is-not-an-actor.md)

The follow-on ADR-0021 named. A client user is deliberately not an `Actor`, so `store` and `read` —
which resolve one and check its authority level — could not serve them.

---

## One gate differs

For staff, `MINIMUM_LEVEL_TO_READ` decides: a Level 2 analyst reads tax returns across the book, and
ownership is not the question. For a client the level is meaningless and **ownership is the only
question** — this file, and no other.

Everything else is identical, deliberately: the same tenant check, scan-status rule, legal-hold
rule, export watermark, and access log written before the bytes are handed over.

> `MINIMUM_LEVEL_TO_READ.bank_statement` is **0**. A build that reused the staff path for clients
> would grant a client access to every other client's bank statements, because there is no level
> for them to fail. That is the test the file is built around.

**A document belonging to another client answers exactly as one that does not exist.** Anything
else confirms that a document id belongs to somebody — the same enumeration the portal's
`documentInRoom` already refuses to enable. Both refusals are **logged**, because a pattern of
attempts against documents a client does not own is the signal an audit wants.

---

## The legal-hold decision

**A hold blocks export and not view**, for a client exactly as for staff. The reasoning transfers
without modification: a hold stops material being destroyed or leaving, and viewing does neither.

**The client is not told a hold exists.** A litigation-hold notice is frequently confidential and
may concern a dispute with the client asking. So the refusal is truthful, offers a route, and
declines to explain:

> "This document cannot be downloaded at the moment. You can still view it here, and your Concierge
> Desk contact can help if you need a copy."

The real reason — `legal_hold` — goes to the access log. Same shape as authentication's single
answer to every failure: the message withholds what the system knows, because saying it _is_ the
disclosure.

**This is the one assumption for counsel in the client path**, and ADR-0021's amendment records it:
that a client may view but not download their own document under a hold is the consistent reading
of the staff rule, not a settled legal question.

---

## Details worth knowing

- **Scan status blocks the owner too.** A client cannot read their own document until it is scanned
  — 3.2's rule, said in words a client can act on: _"We are still checking this file for malware…
  you do not need to upload it again."_
- **Exports are watermarked with the client user's identity.** A copy leaving the system carries who
  took it and when; that the client owns the document does not change what the watermark is for,
  because the copy still leaves.
- **`uploadedBy` is the client user's own id**, not a service account. A hundred clients sharing one
  actor id would make every access record say the same thing.
- **Which kinds a client may upload stays in the portal.** It is a policy about what a client
  supplies rather than about how bytes are stored, and a second list here would be a second list to
  keep in step.
- **`pdfText` moved to `tests/helpers/pdf.ts`.** It was written for `vault-access.test.ts`; a second
  copy for this test missed pdf-lib's hex-string decoding and failed for a reason unrelated to what
  it asserts. One copy now.

---

## Tested

11 tests in `tests/integration/client-vault-access.test.ts`. Suite total **914**.

One test changed rather than being added: `client-authentication.test.ts` asserted that upload
**refuses**, which was true when authentication shipped and is the thing this slice fixed.

Mutation-verified:

| Mutation                              | Failures |
| ------------------------------------- | -------- |
| Drop the ownership check              | 2        |
| Tell the client the legal-hold reason | 1        |
