# Plan — Client authentication for 11.10 (11.1 Identity & Access)

**Blueprint:** 11.1 with 11.10 · **Branch:** `ai-feature/m11-client-authentication`
**Follows:** the configuration-ordering fix (merged, `1f69499`)

The gap flagged when 11.10 shipped: **nothing authenticates a client user.** The portal takes a
_resolved_ `ClientPrincipal` and something has to resolve it.

---

## Mini-PRD

### Problem

`clientRoom`, `uploadDocument`, `signDisclosure` and `sendMessage` all take a `ClientPrincipal`
supplied by the caller. Whoever calls them decides which client they are. The portal cannot be
exposed until something turns a credential into that principal.

### Success metrics

- A client authenticates with a credential and receives a session that expires.
- A client user **cannot** hold an internal authority level.
- Enrolment requires an internal Level 3 human — a client cannot claim a file.
- Every authentication attempt, success or failure, is on the Ledger.

### Risks

| Risk                                               | Mitigation                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **A client user with an internal authority level** | Client users are a separate principal type, not `Actor` rows — see the key decision            |
| Self-registration claiming a file                  | Enrolment is by invitation, issued by a Level 3 human, single-use and expiring                 |
| Credential storage                                 | scrypt with a per-user salt; the hash is never returned and never logged                       |
| A session outliving its usefulness                 | Absolute expiry and idle expiry, both enforced on every resolve                                |
| Credential stuffing                                | Lockout after repeated failures, and the same answer for a wrong password and an unknown email |

---

## Key decision — a client user is not an Actor with a low authority level

The tempting build is one identity table: give the client an `Actor` row at Authority Level 0.
Level 0 is "observe only", which sounds exactly right for somebody who reads their own file.

**It is not, and the failure is concrete rather than theoretical.**

`vault.read` checks three things: the document's tenant, the actor's authority level against
`MINIMUM_LEVEL_TO_READ`, and the scan status. **It does not check who the document belongs to** —
correctly, because an internal analyst reads many clients' files, and ownership is not what governs
their access.

`MINIMUM_LEVEL_TO_READ` puts `bank_statement`, `profit_and_loss`, `balance_sheet`, `debt_schedule`
and `entity_document` at **level 0**.

So a client holding a Level 0 Actor row in the tenant could read **any client's bank statements**
by document id. Not through a bug — through the system working exactly as designed for the
principal type it was designed for.

The authority ladder answers "what may this member of staff do across the book". A client's
question is different: "may this person act on _this_ file". Those are not the same question at
different heights of the same scale.

So `ClientUser` is its own table, in the `identity` schema because **11.1 owns identity** and a
second identity package would be the second permission model 11.10 already refused. It has no
authority level, and there is no code path that gives it one.

`EventActor.kind` gains `'client'`. A client uploading a statement and a staff member uploading one
on their behalf are different acts, and recording both as `human` would blur exactly the line
`sign_for_client` — a Level 4 prohibited action — is drawn along.

## Key decision — enrolment is an invitation, not a signup

A client cannot create an account and name the file it belongs to. An invitation is issued by an
internal Level 3 human against a specific client, is single-use, and expires.

The invitation token is stored **hashed**. A leaked database gives an attacker the same thing it
gives them for passwords: nothing directly usable.

---

## Architecture

```
packages/identity/src/
  credentials.ts   scrypt hashing, timing-safe verification
  clientUsers.ts   invitation, enrolment, authentication, lockout
  sessions.ts      issue, resolve, revoke; absolute and idle expiry
packages/portal/src/
  session.ts       authenticate -> token; resolve token -> ClientPrincipal
```

Schema `identity`: `ClientUser`, `ClientInvitation`, `ClientSession`.

## Test strategy

- A client user cannot be created as an Actor, and holds no authority level.
- **A client user id is not resolvable by `findActor`** — asserted, because that is the boundary.
- Enrolment needs a valid, unexpired, unused invitation from a Level 3 human.
- A wrong password and an unknown email give the same answer and the same timing shape.
- Lockout after repeated failures, and it clears.
- A session resolves to a principal; expired, idle and revoked sessions do not.
- A resolved principal drives the portal with nothing else supplied.
- Attempts are on the Ledger, and no credential material is.

## Out of scope

Password reset flows and MFA — both real, both larger than this, and neither blocking the portal's
first exposure. Document byte **download** for clients: `vault.read` resolves an internal Actor, and
wiring a client principal through it is the same shape of work as `storeForClient` but on the read
path, which has four gates rather than one.

## Deviation from this plan — `storeForClient` was not built

The plan listed a `storeForClient` in the vault: an ownership check instead of an authority-level
one, so a client could upload. It is not in this slice, and the reason is worth recording rather
than quietly dropping.

Writing it made the size clear. `store` is one gate and would have been small; but a client who can
upload and cannot read has a portal that lists their documents and refuses to open them, which is a
worse surface than one that refuses both. Doing it properly means the same ownership path on
`read`, which has four gates — tenant, level, scan status, legal hold — and each needs a decision
about what it means for a client rather than for staff. Legal hold in particular: a hold blocks
_export_ for staff, and whether a client may read their own document under a hold on their own file
is a question for counsel, not a line of code.

So the portal's upload **refuses**, visibly, rather than being wired to an internal actor that
would have attributed the upload to somebody else. The gap is named in the module doc and in
ADR-0021's consequences.
