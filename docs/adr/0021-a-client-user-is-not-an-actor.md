# ADR-0021 — A client user is not an Actor with a low authority level

**Status:** Accepted · **Date:** 2026-08-11 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

11.10 shipped taking a **resolved** `ClientPrincipal`. Whoever called the portal decided which
client they were, so the surface could not be exposed. Something had to turn a credential into that
principal.

The obvious build is one identity table. Give the client an `Actor` row at Authority Level 0 —
"observe only", which sounds exactly right for somebody who reads their own file, and it means one
identity mechanism rather than two.

## The concrete reason that is wrong

`vault.read` checks three things: the **document's** tenant, the actor's authority level against
`MINIMUM_LEVEL_TO_READ`, and the scan status.

**It performs no ownership check** — and that is correct. An internal analyst reads many clients'
files; ownership is not what governs their access, the document class and their level are.

`MINIMUM_LEVEL_TO_READ` puts `bank_statement`, `profit_and_loss`, `balance_sheet`, `debt_schedule`
and `entity_document` at **level 0**.

So a client holding a Level 0 `Actor` row in the tenant could read **any client's bank statements**
by document id. Not through a bug — through the vault working exactly as designed for the principal
type it was designed for.

The authority ladder answers _"what may this member of staff do across the book"_. A client's
question is _"may this person act on **this** file"_. Those are not the same question at different
heights of one scale, and a system that treats them as one will keep producing this class of error
wherever a level check stands in for an ownership check.

## Decision

**`ClientUser` is its own table**, in the `identity` schema — because 11.1 owns identity, and a
separate client-identity package would be the second permission model 11.10 already refused.

- It has **no authority level**, and no code path gives it one.
- `findActor` does not resolve a client user id. That boundary is asserted by test.
- One user, one client file. A person needing two files gets two users, so revoking one cannot
  silently leave the other.

**`EventActor.kind` gains `'client'`.** A client uploading a statement and a staff member uploading
one on their behalf are different acts, and recording both as `human` would blur exactly the line
`sign_for_client` — a Level 4 prohibited action — is drawn along.

### Supporting decisions

**Enrolment is an invitation, not a signup.** A client cannot create an account and name the file it
belongs to. A Level 3 human issues an invitation against a specific client; it is single-use and
expires. The token is stored **hashed** — a leaked database yields the same thing it yields for
passwords: nothing directly usable.

**Every authentication failure gives one answer.** Unknown email, wrong password, unenrolled,
disabled — all identical, and a password verification runs against a decoy hash when the user does
not exist so the timing does not answer what the message refuses to. Otherwise the endpoint is an
oracle telling an attacker which addresses are clients of this firm, which is itself the disclosure.

**Sessions have two expiries**, absolute and idle, both checked on every resolve. And
`resolveSession` **re-reads the user** every time rather than trusting what was true at sign-in —
so disabling an account takes effect on the next request rather than whenever a session happens to
lapse.

**Passwords: scrypt, length floor only.** No composition rules; they push people toward
`Password1!`, which is worse at the thing the rule is for.

## Consequences

**Client document upload and read needed an ownership-based path through the vault.** `vault.store`
and `vault.read` resolve an internal `Actor`, and a client user deliberately is not one — so when
this ADR was written the portal's upload refused rather than attributing it to somebody else.

**RESOLVED** by `packages/vault/src/clientAccess.ts`: `storeForClient` and `readForClient`, where
**ownership replaces the authority level** and every other gate is unchanged. The decision this
forced is recorded there and amended below.

**The cost parameters collided with a Node default.** scrypt needs `128·N·r` bytes; at N=2^15 and
r=8 that is exactly 32 MiB, and Node's default `maxmem` is 32 MiB checked strictly. The first run
failed at **runtime**, not compile time, because the two numbers are unrelated and happen to meet.
`SCRYPT_MAX_MEMORY` is now explicit so the relationship is visible to whoever raises the cost next.

**Password reset and MFA are not built.** Both are real; neither blocks the portal's first exposure,
and inventing a reset flow without deciding how a client proves identity out-of-band would be worse
than not having one.

## Alternatives considered

**One Actor table, clients at Level 0.** Rejected — see above. This is the decision.

**One Actor table, clients at a new Level -1.** Rejected: it keeps the ladder as the mechanism, so
every existing `actor.authorityLevel < required` comparison silently acquires a new meaning, and
the vault still has no ownership check.

**A `clients` module owning its own identity.** Rejected: 11.1 owns identity, and the second copy
is the one that drifts.

**Self-service registration with email verification.** Rejected. Verifying an email proves control
of an inbox, not that the person is entitled to a client's financial file.

---

## Amendment, 2026-08-11 — the legal-hold question, answered with an assumption

The client vault path had to decide what a legal hold means for a client reading their own
document. Two sub-questions, and they have different kinds of answer.

**What it blocks.** The same as for staff: **export, not view.** The staff rule's reasoning
transfers without modification — a hold exists to stop material being destroyed or leaving the
system, and viewing does neither.

**What the client is told.** Nothing. A litigation-hold notice is frequently confidential, and the
hold may concern a dispute with the very client asking. So the refusal is truthful, offers a route
(their Concierge Desk contact), and declines to explain. The real reason goes to the access log,
where an auditor reads it. This is the same shape as authentication's single answer to every
failure: the message withholds what the system knows, because saying it _is_ the disclosure.

**This remains an assumption for counsel**, and it is the only one in the client path. That a
client may view but not download their own document under a hold is the consistent reading of the
staff rule; it is not a settled legal question. Counsel should confirm before a hold is placed on a
file whose client has portal access.
