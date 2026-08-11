# ADR-0061 — The password is kept so recovery is one act, and refused so it cannot be one

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 11.1 Identity & Access

## Context

ADR-0029 stopped a client's password authenticating anybody and deliberately left the hash, naming
the reason: seven gates asked for it. ADR-0030 then closed that half-step — `removePassword` writes
two independent facts, and the hash is overwritten with a value that cannot verify.

The obvious move here is to copy that. It is wrong, and the reason is the whole of this ADR.

**A client whose password is destroyed can get another one.** ADR-0030's `restorePassword` clears
both flags and issues a **reset token**, so the client chooses the new password rather than being
told one — a password read down a telephone is a password two people know.

**Staff have no channel to send a reset token down.** No email provider (ADR-0036), no address on the
credential that anything delivers to, no self-service reset at all. Destroying a staff password would
mean every recovery rebuilds a credential from nothing, and the only way to hand over the new one is
to say it out loud.

## Decision

**The password hash and the TOTP secret survive the switch. They stop authenticating, and they are
refused as a confirmation.**

Two facts, and the second is what stops the first becoming a hole.

### It stops authenticating

`assertPasswordSignInPermitted` refuses before `authenticateStaff` runs. ADR-0059.

### It stops confirming

`confirmStaffIdentity` takes a `password` **or** a `passkey`, and on an account where password
sign-in is off it refuses the password outright.

This is the part that would be easy to get wrong by copying ADR-0029's sentence — _"the password
stops being an authentication method without ceasing to be a confirmation one"_ — into a system that
did not then destroy it.

Concretely: **a phishable secret that can still register a NEW key undoes the switch in one call.**
An attacker who proxies a staff password before the switch, or reads one off a note afterwards, would
add their own authenticator and hold a phishing-resistant credential of their own. The account would
report `phishingResistant: true` the entire time.

So the same end state as ADR-0030 is reached by **refusing** rather than by **destroying**, because
the recovery paths differ:

|                           | client                                   | staff                                       |
| ------------------------- | ---------------------------------------- | ------------------------------------------- |
| password after the switch | destroyed (ADR-0030)                     | kept, refused for auth and for confirmation |
| why                       | a reset can mint a new one               | nothing can mint a new one                  |
| route back                | reset token by email, or a Level 3 human | a Level 3 human, only                       |

### Recovery is therefore one column

`restoreStaffPasswordSignIn` clears `passwordSignInDisabledAt` and nothing else. The password the
person already knows works again, immediately, and nobody had to read one to anybody.

That is the payoff for not destroying it, and it is why the two decisions are one decision.

## Consequences

**A staff account in the passkey-only state still holds a password hash that verifies nothing.** A
reader of the table will see it and should not conclude the account is phishable — the column beside
it is what decides, and both gates read that column rather than the hash.

**`removeStaffKey` refuses the last key**, because on this account there is no password to fall back
to and the hash cannot be promoted back into service without a colleague.

**The confirmation is one union and one function**, per ADR-0030 Decision 1: a gate asks whether the
caller confirmed themselves, it does not decide what confirmation is. Four gates take one here, and
if each grew its own idea of a good answer, the one added in a hurry next year would accept less.

**The confirmation started as a TOTP code and the tests said no.** The browser journey could not
register a key: signing in spends a time step, `verifyTotp` accepts one step of drift, and a code at
or below the last accepted step is a replay — so a second code inside thirty seconds does not exist.
Waiting half a minute per registration would have been a test working around a design.

The design was wrong rather than the test: ADR-0024 says a credential change takes **the password**,
and switching to it removed the collision, removed a duplicated copy of the TOTP replay logic from
this module, and made the staff `Confirmation` union the same shape as the client's. A test that is
hard to write against a design is evidence about the design surprisingly often.

## Alternatives considered

**Destroy the password, as ADR-0030 does.** Every recovery becomes a credential rebuilt over a
telephone, with the new password spoken aloud. It buys nothing that refusing the confirmation does
not already buy.

**Keep the password as a confirmation, as ADR-0029's sentence suggests.** The hole above. That
sentence was written about a system that was one slice away from destroying the hash.

**Let the TOTP code confirm instead of the password.** What this started as. It is still a phishable
factor, so it has the same hole, and it additionally cannot be presented twice inside one time step.

**Make `restoreStaffPasswordSignIn` issue a fresh password.** There is nowhere to send it. The
existing password is the one thing about the account that is already known only to its owner.
