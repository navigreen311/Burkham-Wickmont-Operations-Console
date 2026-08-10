# Multi-factor authentication for client users

Module: 11.1 Identity & Access (for 11.10) · Packages: `@bwc/identity`, new `@bwc/crypto` ·
Schema: `identity` · ADR: [0024](adr/0024-the-half-authenticated-state-is-not-a-session.md)

The second gap #27 named, and the larger one. A single factor was the whole of authentication on a
surface that reads bank statements.

---

## Why TOTP

|               | Verdict                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **SMS**       | Needs an ungated provider, so it would report `not_built` — and SIM swap is the documented attack against exactly this population     |
| **Email OTP** | **Worse than not doing it.** A second factor delivered to the channel that can reset the first factor is the same factor twice        |
| **TOTP**      | Needs no vendor. A shared secret and a clock. **The factor that needs nothing gated in is also the strongest of the three available** |
| **WebAuthn**  | Stronger still, and the right answer once there is a browser UI. Named, not built                                                     |

The implementation is **verified against RFC 6238's own published test vectors**. An off-by-one in
the counter encoding produces six digits that look exactly right, agree with themselves perfectly,
and match no authenticator app on earth — only an external reference catches it.

---

## The half-authenticated state is not a session

The tempting build issues the session cookie after the password and marks it unsatisfied, then
checks that flag on each route. **Every route then has to remember, and the one that forgets is a
complete bypass.**

```
password OK ──► ClientMfaChallenge  (own table, own cookie, NO principal)
                       │
                  code verifies
                       │
                       ▼
                  issueSession
```

`signIn` returns a **union**, not a boolean field, so every call site in the packages and apps is a
compile error until it handles the second factor.

## A session is not a credential

Enrolling and removing are credential changes, and a credential change from a session alone is one
made by whoever stole the session — adding a factor to someone else's account locks its owner out of
their own file.

| Act                   | Requires                                                     |
| --------------------- | ------------------------------------------------------------ |
| Begin enrolment       | A session                                                    |
| **Confirm enrolment** | Session + **password** + a code from the new authenticator   |
| **Remove (self)**     | Session + **password** + a current code (or a recovery code) |
| **Remove (staff)**    | Level 3 human + a **recorded verification basis**            |
| New recovery codes    | Session + **password**                                       |

**A factor nobody has proved they can use is not a factor; it is a lockout waiting for the next
sign-in.** Enrolment does not activate until a code from the new authenticator verifies.

## Replay and brute force

**The accepted time step is stored.** A code stays valid for at least thirty seconds, so somebody who
read it over a shoulder or relayed it through a phishing proxy has that long — anything at or below
the last accepted step is refused. It also stops one code opening two sessions, and it composes with
the ±1-step drift allowance: the previous step is accepted until a later one has been, never after.

**Wrong codes are counted against the challenge**, which dies at five. Not against the account:
killing the challenge throws the caller back to the password, which is rate limited at the transport
and locks out at 11.1. **The brute-force defence for six digits is that failing them costs a password
attempt.** Locking the account instead would make six digits a denial-of-service weapon against any
address an attacker knows.

## The secret is encrypted, and the crypto moved rather than being copied

Unlike a password hash the TOTP secret **must be recoverable** — codes are computed from it — so the
protection cannot be a one-way function.

`@bwc/vault` had the right construction and **depends on `@bwc/identity`**, so identity could not
import it. The primitives moved to **`@bwc/crypto`** and the Vault re-exports them: the same move
`serialize.ts` made into `@bwc/http`, for the same reason.

`MFA_SECRET_KEY` is a **different key from `VAULT_KEK`** — one key for both would mean a compromise
of either reaches the other. **Enrolment refuses outright when it is missing**, because storing the
secret in the clear would be worse: nobody would know.

## Recovery codes

Eight, shown once, stored hashed, single use. Without them a lost phone is a permanent lockout whose
only remedy is a phone call to the firm — the social-engineering path ADR-0023 exists to constrain.

- **A recovery code satisfies one sign-in. It does not disable the factor.**
- Its use is a Ledger event: a run of them is the signal somebody has phished a printout.
- Regenerating retires the previous set.
- **Removing a factor retires them with it** — otherwise they are a way past a factor that is no
  longer there, and they would silently apply to the next one.

## Password reset is not an MFA bypass

Asserted, not assumed. Completing a reset issues no session and leaves the factor in place. The two
were built a slice apart and the bypass would have been invisible from either one.

## Routes

| Route                             | Notes                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `POST /portal/sign-in`            | Returns `mfaRequired` and sets a **challenge** cookie — never a session cookie |
| `POST /portal/sign-in/mfa`        | `{ code }`, challenge cookie. On the sign-in limiter: it is the same act       |
| `GET /portal/mfa`                 | Enrolled, pending, recovery codes remaining                                    |
| `POST /portal/mfa/enrol`          | The secret and the `otpauth://` URI, once                                      |
| `POST /portal/mfa/enrol/confirm`  | `{ password, code }` → recovery codes, once                                    |
| `POST /portal/mfa/remove`         | `{ password, code }`                                                           |
| `POST /portal/mfa/recovery-codes` | `{ password }`                                                                 |

The challenge cookie is a **different cookie** (`bwc_portal_session_mfa`). One cookie meaning "either
a session or a half-authentication, depending" is the shape that ends with a route reading the wrong
one.

---

## Tested

32 unit tests in `tests/invariants/totp.test.ts` (RFC 4226, RFC 6238 and RFC 4648 vectors), 16
integration tests in `tests/integration/client-mfa.test.ts`, 3 more over HTTP. Suite total **1010**.

| Mutation                                     | Failures |
| -------------------------------------------- | -------- |
| Drop the replay guard on the challenge path  | 1        |
| Sign-in ignores an active factor             | 10       |
| A factor is active before a code proves it   | 16       |
| A spent or retired recovery code still works | 2        |

## Not built

**WebAuthn.** **A firm-wide mandate** that every client user must enrol — that needs a
forced-enrolment state and is a Compliance Review Board decision, not a default to pick.
**Change-password for a signed-in client**, still.
