# Client authentication for 11.10

Package: `@bwc/identity` (+ `@bwc/portal` bridge) · Schema: `identity` · ADR: [0021](adr/0021-a-client-user-is-not-an-actor.md)

Closes the gap 11.10 shipped with: **nothing authenticated a client user.** The portal took a
_resolved_ `ClientPrincipal`, so whoever called it decided which client they were.

---

## A client user is not an Actor

The obvious build gives the client an `Actor` row at Authority Level 0. The reason that is wrong is
concrete:

`vault.read` checks the document's tenant, the actor's level against `MINIMUM_LEVEL_TO_READ`, and
the scan status. **It performs no ownership check** — correctly, because an internal analyst reads
many clients' files.

`MINIMUM_LEVEL_TO_READ` puts `bank_statement` at **level 0**.

> A client holding a Level 0 Actor row could read **any client's bank statements in the tenant** —
> not through a bug, but through the vault working exactly as designed for the principal type it
> was designed for.

The ladder answers _"what may this member of staff do across the book"_. A client's question is
_"may this person act on **this** file"_. Not the same question at different heights of one scale.

So `ClientUser` is its own table — in the `identity` schema, because **11.1 owns identity** and a
separate client-identity package would be the second permission model 11.10 already refused. It has
no authority level, `findActor` cannot resolve it, and that boundary is the first assertion in the
test file.

`EventActor.kind` gains **`'client'`**. A client uploading a statement and a staff member uploading
one on their behalf are different acts, and recording both as `human` would blur the line
`sign_for_client` is drawn along.

---

## Enrolment is an invitation

A client cannot create an account and name the file it belongs to.

| Rule                                                     | Why                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A **Level 3 human** issues it, against a specific client | It grants a person access to a client's financial file                                     |
| **Single-use**, spent on acceptance                      | A token read from a forwarded email is useless once enrolled                               |
| Expires in 72 hours                                      |                                                                                            |
| Stored **hashed**                                        | A leaked database yields the same as it does for passwords: nothing usable                 |
| One user, one client file                                | A person needing two files gets two users, so revoking one cannot silently leave the other |

---

## One answer to every failure

Unknown email, wrong password, unenrolled, disabled — **identical refusals**. A password
verification runs against a decoy hash when the user does not exist, so the _timing_ does not
answer what the message refuses to.

Otherwise the endpoint is an oracle telling an attacker which addresses are clients of this firm,
which is itself the disclosure.

Lockout after 5 consecutive failures, for 15 minutes, self-clearing. The lockout message **does**
differ — the person being told just failed against that account five times, so it confirms nothing
they did not already know.

Failures are on the Ledger. A run of them against one client file is the signal that matters, and
it is invisible if only successes are recorded.

---

## Sessions

Two expiries, **both checked on every resolve**: absolute (12h — a session that renewed itself
forever means a credential stolen once is held permanently) and idle (30m — the laptop left open in
a coffee shop, which is the more common case).

`resolveSession` **re-reads the user** every time rather than trusting sign-in. Disabling an account
therefore takes effect on the next request, not whenever a session happens to lapse.

Tokens are 256 bits, returned once, stored as SHA-256. scrypt is for passwords; a high-entropy
token has nothing to brute-force, and hashing it at 100ms would just make every request slower.

---

## What this does not do

**Client document upload still refuses**, and that is a consequence rather than an oversight.
`vault.store` resolves an internal `Actor`, and a client user deliberately is not one — so the
portal refuses rather than attributing the upload to somebody else. Wiring a client principal
through the vault needs an ownership-based path alongside the level-based one, on both `store` and
`read`. Named, not half-done.

**Password reset and MFA** are not built. Neither blocks the portal's first exposure, and inventing
a reset flow without deciding how a client proves identity out-of-band would be worse than not
having one.

---

## Tested

25 tests in `tests/integration/client-authentication.test.ts`. Suite total **903**.

Mutation-verified:

| Mutation                                                | Failures |
| ------------------------------------------------------- | -------- |
| Distinguish an unknown email from a wrong password      | 1        |
| Trust sign-in instead of re-reading the user on resolve | 1        |

> **A mutation found a real gap.** Removing the resolve-time user check initially broke nothing:
> `disableClientUser` also revokes sessions, so the revocation alone caught it and the
> defence-in-depth layer was untested. A test now disables a user _without_ touching their
> sessions — the case any future admin path or partial failure would produce.

> **The cost parameters collided with a Node default.** scrypt needs `128·N·r` bytes; at N=2^15,
> r=8 that is exactly 32 MiB, and Node's default `maxmem` is 32 MiB checked strictly. It failed at
> **runtime**, not compile time. `SCRYPT_MAX_MEMORY` is now explicit.
