# Plan — multi-factor authentication for client users

**Branch:** `ai-feature/client-mfa` · **Follows:** password reset (merged, `dff5211`)

The second of the three gaps #27 named, and the larger one. A single factor is currently the whole
of authentication on a surface that reads bank statements.

---

## Mini-PRD

### Problem

A stolen or guessed password is the account. Password reset closed the recovery gap and, read
carelessly, widened this one: **whoever controls a client's email inbox controls the account**,
because the inbox is the only thing standing between an attacker and a password of their choosing.

### Success metrics

- A client enrols an authenticator, and a password alone stops being enough.
- **The half-authenticated state is not a session** — structurally, not by convention.
- A code cannot be used twice.
- A lost authenticator has a route back that is not "phone the firm".
- **Password reset neither satisfies MFA nor removes a factor.**

### Risks

| Risk                                              | Mitigation                                                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **A partial sign-in that behaves like a session** | The challenge is its own table and its own cookie; `issueSession` is not reached until the second factor passes |
| **Enrolling a factor nobody can actually use**    | Enrolment is not complete until a code from the new factor verifies                                             |
| **Code replay inside its validity window**        | The accepted time step is stored; a code at or below it is refused                                              |
| Brute force against six digits                    | Attempts are counted **against the challenge**, which dies and throws the caller back to the password           |
| A lost phone becoming a permanent lockout         | Recovery codes, issued once, hashed, single use                                                                 |
| **A leaked database yielding working factors**    | The TOTP secret is field-encrypted under a key that is not in the database                                      |
| **Reset as an MFA bypass**                        | Completing a reset issues no session and does not touch the factor                                              |

---

## Key decision 1 — the second factor is TOTP, because it is the only one that can work today

SMS needs an SMS provider, which is ungated (11.5) — an MFA that reports `not_built` is not MFA. It
is also the factor with a documented attack against exactly this population: SIM swap, aimed at
people with money.

Email OTP is worse than not doing it: **a second factor delivered to the channel that can reset the
first factor is not a second factor**, it is the same factor twice.

TOTP needs no vendor. It is a shared secret and a clock, RFC 6238, and every authenticator app
already implements it. **The factor that needs nothing gated in is also the strongest of the three
available.**

WebAuthn is stronger still and is the right answer once there is a browser UI to register a
credential from. Named, not built.

## Key decision 2 — the half-authenticated state is not a session

The tempting build issues the session cookie after the password and marks it `mfaSatisfied: false`,
then checks that flag on each route. **Every route then has to remember, and the one that forgets is
a complete bypass** — of the kind that is invisible until somebody goes looking.

So a password produces a `ClientMfaChallenge`: its own table, its own short-lived cookie, and no
principal. `issueSession` is not called until the code verifies. **There is no half-authenticated
session because there is no way to express one.**

## Key decision 3 — a session is not a credential, so changing a credential needs a credential

Enrolling a factor and removing one are credential changes. Made from a session alone, they are
credential changes made by whoever stole the session — and adding a factor to somebody else's
account locks the owner out of their own file.

So confirming enrolment and self-service removal both require **the password**, and removal
additionally requires **a current code**. A staff-assisted removal requires a Level 3 human and a
recorded verification basis, exactly as a staff-issued reset does, and for the same reason.

## Key decision 4 — the shared crypto moves rather than being copied

The TOTP secret must be **recoverable**, unlike a password hash: codes are computed from it. A
leaked database therefore yields working second factors unless the secret is encrypted under a key
that is not in the database.

`@bwc/vault` already has exactly the right field-level construction — and `@bwc/vault` depends on
`@bwc/identity`, so identity cannot import it. The answer is the one #27 already set: move it to a
package both can depend on (`@bwc/crypto`) rather than write a second AES-GCM routine. Two
implementations of one construction is how the two stop agreeing.

---

## Architecture

```
packages/crypto/            KekProvider, envelope + field encryption, moved from @bwc/vault
packages/identity/src/
  totp.ts                   base32, HOTP, TOTP - pure, verified against the RFC's own vectors
  mfa.ts                    enrolment, challenge, verification, recovery codes, removal
packages/portal/src/session.ts   signIn now returns session OR mfa_required
apps/portal-api/src/app.ts       the challenge cookie and the second-step route
prisma/schema.prisma             ClientMfaFactor, ClientMfaChallenge, ClientRecoveryCode
```

`signIn`'s return type becomes a union, which makes every call site a compile error until it handles
the MFA case. That is the point of doing it in the type rather than in a field.

## Test strategy

- **The RFC 6238 test vectors**, so the implementation is checked against the specification rather
  than against itself.
- Enrolment does not activate until a code verifies; the secret is not stored in plaintext.
- Sign-in with a factor returns a challenge and **no session**; the challenge token is not a session
  token.
- A code cannot be used twice. A code from the previous step still works once, and not after a later
  one has been accepted.
- Five wrong codes kill the challenge, not the account.
- A recovery code satisfies the challenge, is single use, and does not disable MFA.
- **Completing a password reset issues no session and leaves the factor in place.**
- Removal needs the password and a code; staff removal needs Level 3 and a basis.

## Out of scope

WebAuthn. A firm-wide mandate that every client user must enrol — that needs a forced-enrolment
state and is a policy decision for the Compliance Review Board, not a default I should pick.
Change-password for a signed-in client, still.
