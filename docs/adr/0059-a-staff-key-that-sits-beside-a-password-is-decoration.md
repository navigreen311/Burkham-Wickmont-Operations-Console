# ADR-0059 — A staff key that sits beside a password is decoration

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 11.1 Identity & Access, the internal Console

## Context

ADR-0032 gave staff a password and a TOTP code, and called that the credential a Console needed
before it could have a page. It was right about the ordering and it left the harder half undone.

**TOTP is not phishing resistant.** A proxy puts up a copy of the sign-in page, takes the password
and the six digits, and presents both to the real Console inside the code's thirty-second window.
Every replay guard in `staff.ts` — the spent time step, the lockout — is downstream of a code
somebody typed into the wrong site, and none of it helps, because the attacker uses the code once,
immediately, and it is the first use.

The reach makes it worse than the client case. A client session opens one file. **A staff session
opens every client file in the firm**, plus the Firewall trigger, the compliance transition and the
placement path.

ADR-0029 already settled what to do about this, one surface along:

> An account is as strong as the weakest method it will accept.

## Decision

**A staff key replaces the password and the code. It does not sit beside them.**

`passwordSignInDisabledAt` on `ActorCredential`, and with it set a **correct** password and a
**correct** code are refused — in the same sentence a wrong password gets, because a distinct message
would be an oracle telling an attacker which addresses to stop phishing.

The switch requires three things, and each removes a different way for this to become a lockout or a
lie:

| | why |
| --- | --- |
| **two keys** | one is one lost object away from no way in at all, and the remedy is a colleague |
| **a live assertion** | proving a key that could let them back in works *right now*, not that one is on record. ADR-0029 refuses to let somebody close the door on the strength of a credential they cannot demonstrate |
| **a session** | the Console's own gate, applied by the route |

The confirmation for the switch must be a **key**, never the password. A password would prove the
factor being retired still works, which is not what needs proving.

### The lockout, stated rather than hidden

**A staff member who turns password sign-in off and then loses every key cannot get into the Console,
and there is no self-service route back.** There is no email provider (ADR-0036 records that gap), no
reset token, and no address to send one to.

That is the trade, and it is affordable for a reason the client case does not have: **staff have a
Level 3 colleague who is already authenticated inside the firm.**
`restoreStaffPasswordSignIn` is one recorded act — a named human at Authority Level 3, a written
verification basis, never the subject themselves — and it is precisely ADR-0029's *second* permitted
route rather than its forbidden first one. That ADR refuses to let an **email channel** re-open the
door because an attacker can take an inbox; it explicitly permits a Level 3 human with a recorded
basis. Staff have the second without having the first at all.

So the recovery path is stronger here than on the client side, which is what makes requiring two keys
and no fallback a reasonable thing to ask of a colleague rather than a trap.

### Removing the last key is refused

On an account that no longer accepts a password, removing the only remaining key is not removing a
key — it is locking somebody out of the firm in one call. The module refuses it and names the route
back.

## Consequences

**One route in `app.ts` changed, and it is the load-bearing line.**
`assertPasswordSignInPermitted` runs before `authenticateStaff` on the existing sign-in route.
Without it the column is one nothing reads, which is the shape of every security feature that turns
out to be a setting — and it is exactly what "add passkey support" would have shipped.

**The event pair is two types, not one.** `identity.staff.password_sign_in_disabled` and
`identity.staff.password_sign_in_restored`. Reading them as one would hide which happened, and one is
the strongest thing a staff member can do to protect an account that opens every client file while
the other is the strongest thing a colleague can do to weaken one. The same reasoning the client pair
records.

**`phishingResistant` is a computed property and it is false while a password still signs in**, however
many keys are registered. The page prints the server's sentence rather than a key count, because a
count shown as a finished state would tell an operator they hold a property they do not. A browser
spec asserts the page says "Not phishing resistant yet" with one key registered.

**Nothing changed for an account that keeps its password**, and the suite says so. This slice adds a
state; it does not move anybody into one.

## Alternatives considered

**Register keys and leave the password alone.** The convenience without the property, and the thing
the brief explicitly refused. It is what "add passkey support" usually means: the proxy never asks
for the key, so its resistance is never engaged.

**One key enough to switch off.** Turns the strongest protection available into the most likely
lockout, and hands the recovery to whoever is on the telephone. ADR-0029 rejected it for a client
who *had* an email channel; the case is stronger here.

**Keep TOTP as a fallback on a passkey-only account.** It is the phishable factor. A fallback that
defeats the property is not a fallback, it is the original problem with a longer name.

**Destroy the password, as ADR-0030 does for clients.** See ADR-0061: it would turn every recovery
into rebuilding a credential from nothing, over a telephone, with no reset channel to do it through.

**A break-glass account nobody uses.** A shared credential with total reach, held for an emergency,
is the thing an attacker looks for first — and 11.1's own data model calls break-glass access an
audited exception rather than a spare key.
