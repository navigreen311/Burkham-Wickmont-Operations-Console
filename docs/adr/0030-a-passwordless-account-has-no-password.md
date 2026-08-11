# ADR-0030 — A passwordless account has no password, and one function decides what confirmation means

**Status:** Accepted · **Date:** 2026-08-19 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

ADR-0029 stopped the password authenticating anybody and deliberately left the hash, naming the
reason: **seven gates asked for it.** Enrolling a factor, removing one, registering a key,
regenerating recovery codes, moving an address, changing the password and switching password sign-in
off all took `password: string`.

An account in that state is passkey-only at sign-in and still has a password in the database, which
is a half-step. This closes it.

## Decision 1 — one type and one function, not seven answers

Each of those gates could have grown its own "or a passkey" branch. **Seven gates each deciding what
a good answer looks like is how one of them ends up accepting less than the others** — and the one
that does will be the one somebody adds in a hurry, next year.

So `Confirmation` is a union — `{kind:'password'}` or `{kind:'passkey'}` — and `confirmIdentity` is
the only thing that checks it. **A gate asks whether the caller confirmed themselves; it does not
decide what confirmation is.**

A union rather than two optional fields, so a call site cannot supply neither, and cannot supply both
and leave the module to pick which it prefers.

The one gate that keeps taking a bare password is `changeClientPassword`, and it keeps it because it
is the only place where **the thing being replaced is the thing being asked for**. On an account with
no password it refuses, because there is nothing to change.

## Decision 2 — a passkey confirmation is verified with user verification required

A confirmation stands in for the password a gate would otherwise have taken. **A touch without a PIN
is less than that password**, so `verifyReauthentication` requires user verification, exactly as the
passwordless sign-in path does.

This was found by a surviving mutation rather than by design review: dropping
`requireUserVerification` from the re-authentication path changed no test. The property was real and
implemented, and nothing was watching it. There is now a test that presents a non-verifying assertion
and expects a refusal.

## Decision 3 — a passkey confirmation IS the second factor

Two gates asked for a confirmation _and_ a second-factor code. For a key-only account that is asking
for something that does not exist — no authenticator app, and recovery codes are issued by TOTP
enrolment rather than by key registration.

A user-verifying assertion is possession and verification in one act (ADR-0029). **Asking for a code
on top is asking the same category twice**, so where the confirmation was a passkey, the code step is
skipped.

This was found by a test, not by reading: a passwordless client could not change their own address.

## Decision 4 — the password is destroyed, not disregarded

`removePassword` writes **two independent facts**. `passwordRemovedAt` is what every gate reads, and
the hash is overwritten with a value that cannot verify — `verifyPassword` needs six `$`-separated
parts beginning `scrypt`, and `'removed'` is not that.

**The weaker fact cannot undo the stronger one.** A column somebody edits back to null does not
resurrect a credential; it produces an account whose password is a string nothing matches.

Only ever after password sign-in has been switched off, and only with two passkeys and an assertion.
Removing it from an account whose password still signs people in would be a way to lock somebody out
in one call.

## Decision 5 — recovery is one recorded act

A reset has nothing to reset. The self-service path refuses **without saying so** — distinguishing a
passwordless account from an unknown address would hand an attacker a list of which accounts to stop
guessing at. The staff path says so plainly and names the act that fixes it, because its reader is a
colleague.

`restorePassword` is that act: a Level 3 human, a recorded verification basis, and in one call it
clears both flags and issues a reset token so **the client chooses the password rather than being
told one** — a password read down a telephone is a password two people know.

One call rather than three, because an account found halfway between "sign-in re-enabled" and "a
password exists" is in a state worse than either end.

## Consequences

**The transport has one reader too.** `confirmationFrom` turns `{password}` or `{passkey}` into a
`Confirmation` for every gate, so a route cannot accidentally accept less than its neighbour.

**Nothing changed for an account that keeps its password**, and a test says so. This slice adds a
state; it does not move anybody into one.

**A passwordless account can still be locked out**, and the route back is a telephone call to a
Level 3 human. That was true after ADR-0029 and is unchanged — what is new is that the act at the
other end of the call is one function with one basis rather than three calls somebody has to
sequence correctly.

## Alternatives considered

**A nullable `passwordHash`.** Cleaner in the model and worse in practice: every read would have to
remember the null, and `verifyPassword` already returns false for anything that is not a scrypt
string. The sentinel plus the column is two checks where one would have done, which is the point.

**Let each gate accept a passkey in its own way.** Decision 1.

**Keep asking for a second-factor code alongside a passkey.** Decision 3 — it locks a key-only client
out of their own settings.

**Let a reset silently create a password for a passwordless account.** It would hand the email
channel a credential the client deliberately removed, which is ADR-0029's Decision 3 with the last
protection removed rather than the first.
