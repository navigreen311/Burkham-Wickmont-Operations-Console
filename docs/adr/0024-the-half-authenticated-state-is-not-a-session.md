# ADR-0024 — The half-authenticated state is not a session, and a session is not a credential

**Status:** Accepted · **Date:** 2026-08-13 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

A single factor was the whole of authentication on a surface that reads bank statements. ADR-0023
closed the recovery gap and, read carelessly, widened this one: **whoever controls a client's inbox
controls the account**, because the inbox was the only thing between an attacker and a password of
their choosing.

## Decision 1 — TOTP, because it is the only second factor that can work here

**SMS** needs an SMS provider, which is ungated (11.5). An MFA that reports `not_built` is not MFA.
It is also the factor with a documented attack against exactly this population — SIM swap, aimed at
people with money.

**Email OTP** is worse than not doing it. A second factor delivered to the channel that can reset the
first factor is not a second factor; it is the same factor twice, and it would make the inbox
sufficient rather than merely necessary.

**TOTP** needs no vendor. It is a shared secret and a clock, and every authenticator app already
implements it. The factor that needs nothing gated in is also the strongest of the three available.

RFC 6238 over RFC 4226, HMAC-SHA1. SHA-1's weakness is collision resistance, which is not the
property HMAC depends on — and the choice is not really free: authenticator apps overwhelmingly
implement SHA-1 only, and a secret they cannot read is a factor the client cannot enrol.

**The implementation is verified against the RFC's own published test vectors**, not against itself.
An off-by-one in the counter encoding or the dynamic truncation produces six digits that look
exactly like the right six digits and agree with themselves perfectly. Only an external reference
catches that.

## Decision 2 — the half-authenticated state is not a session

The tempting build issues the session cookie once the password is right and marks it
`mfaSatisfied: false`, then checks the flag on every route.

**Every route then has to remember, and the route that forgets is a complete bypass** — of the kind
that is invisible until somebody goes looking for it, because everything works.

So a correct password produces a `ClientMfaChallenge`: its own table, its own cookie, no principal.
`issueSession` is not called until a code verifies. **There is no half-authenticated session because
there is no way to express one**, which is the same move as 11.8's `healthy` constructor requiring a
measurement.

`signIn` returns a union rather than gaining a boolean, so every call site in the packages and apps
is a compile error until it handles the second factor. A field would have let the transport keep
compiling and quietly treat a half-authenticated caller as signed in.

## Decision 3 — a session is not a credential

Enrolling a factor and removing one are credential changes. Made from a session alone they are
credential changes made by whoever stole the session — and **adding a factor to somebody else's
account locks its owner out of their own file**.

So confirming an enrolment takes the password, and removing a factor takes the password **and** a
current code. Either alone is one of the two things the factor exists to require: a password-only
removal means a stolen password removes the factor and then walks past it; a code-only removal means
a borrowed phone does.

## Decision 4 — the replay window is closed by storing the step

A code is valid for at least thirty seconds. Somebody who reads one over a shoulder, or relays it
through a phishing proxy, has that long.

The accepted time step is stored on the factor and anything at or below it is refused. That also
stops one code opening two sessions, and it composes with the ±1-step drift allowance: the previous
step is accepted until a later one has been, and never after.

Wrong codes are counted **against the challenge**, which dies at five. Not against the account:
killing the challenge throws the caller back to the password, which is rate limited at the transport
and locks out at 11.1. **The brute-force defence for six digits is that failing them costs a password
attempt.**

## Decision 5 — the secret is encrypted, and the shared crypto moves rather than being copied

Unlike a password hash, the TOTP secret **must be recoverable** — codes are computed from it — so the
protection cannot be a one-way function. A leaked database without the key yields ciphertext; with
the key it yields working second factors, which is why the key belongs in a secret manager and
ultimately in the HSM §6.2 wants.

`@bwc/vault` already had exactly the right construction, and **`@bwc/vault` depends on
`@bwc/identity`**, so identity could not import it. Rather than write a second AES-GCM routine, the
primitives moved to `@bwc/crypto` and the Vault re-exports them — the same move `serialize.ts` made
into `@bwc/http`, for the same reason: two implementations of one construction is how they stop
agreeing.

`MFA_SECRET_KEY` is a **different** key from `VAULT_KEK`. One key for both would mean a compromise of
either reaches the other, and rotating one would force rotating the other. **Enrolment refuses
outright when the key is missing** — storing the secret in the clear instead would be worse, because
nobody would know it had happened.

## Consequences

**Recovery codes exist, or a lost phone is a permanent lockout** whose only remedy is a phone call to
the firm — the social-engineering path ADR-0023 exists to constrain. Eight codes, shown once, stored
hashed, single use. Regenerating retires the previous set, so a printout the client has replaced
cannot still open the account. **A recovery code satisfies one sign-in; it does not disable the
factor.** Its use is a Ledger event, because a run of them is the signal that somebody has phished a
printout.

**Removing a factor retires the recovery codes with it.** Leaving them live would leave a way past a
factor that is no longer there to be got past, and they would silently apply to the next one.

**A staff-assisted removal needs a Level 3 human and a recorded verification basis**, exactly as a
staff-issued reset. It signs nobody in — the client still needs their password — so it is not a
takeover on its own. Combined with a staff-issued reset it would be, which is a property of what
Level 3 already holds rather than one this adds, and it is why both acts carry a basis into the
Ledger.

**Password reset is not an MFA bypass**, and this is asserted rather than assumed: completing a reset
issues no session and leaves the factor in place. The two features were built a slice apart, and the
bypass would have been invisible from either one.

**MFA is per user and optional.** Whether the firm mandates it is a policy decision with a
forced-enrolment state behind it, and it belongs to the Compliance Review Board rather than to a
default I picked.

## Alternatives considered

**WebAuthn / passkeys.** Stronger — phishing-resistant in a way TOTP is not, because the credential
is bound to the origin. The right answer once there is a browser UI to register one from. Named, not
built.

**A `mfaSatisfied` flag on the session.** Decision 2. It is the smaller change and it distributes the
check across every route that exists and every route that will exist.

**A wider drift window.** Convenience bought with exactly the property the factor exists for: more
steps means more codes an attacker's guess could match, and longer for an observed one to stay live.

**Storing the secret as a hash.** Impossible — the server computes codes from it.

**Locking the account on failed codes rather than the challenge.** It makes six digits a denial-of-
service weapon against any account whose email address an attacker knows.
