# WebAuthn as a first factor

Module: 11.1 Identity & Access (for 11.10) · Package: `@bwc/identity` · Schema: `identity` ·
ADR: [0029](adr/0029-a-passkey-beside-a-password-is-a-convenience.md)

ADR-0028 made one sign-in path phishing-resistant and left the other one exactly as it was.

> **An account is as strong as the weakest method it will accept.** A client who registers a key and
> keeps password sign-in is still taken by a proxy that collects the password and the TOTP code — the
> key is never asked for, so its resistance is never engaged.

**The feature is not "sign in with a passkey". It is "sign in with a passkey and turn the other way
off."**

---

## A user-verifying discoverable credential is both halves in one act

|                    | Second factor (#33)                                                              | **First factor**                                                               |
| ------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `residentKey`      | `discouraged`                                                                    | **`required`** — the authenticator can offer it without being told the account |
| `userVerification` | `preferred` — a PIN-less key still adds what it is there to add after a password | **`required`** — standing alone it must carry both halves                      |
| Steps at sign-in   | Password, then the key                                                           | **The key**                                                                    |

`discoverable` is stored on the factor, so **a second-factor credential is not promoted into a
password replacement by a later flag** — it was never asked to prove what a first factor proves.
There is now exactly one place in the codebase where `requireUserVerification` is true, and it is
this path.

## The switch, and what it costs

`passwordSignInDisabledAt` on the client user. With it set, a **correct** password is refused — with
**the same sentence every other sign-in failure gets**, because "this account is passkey-only" is an
oracle telling an attacker which addresses to stop guessing at and which to keep phishing.

Turning it off requires:

| Requirement                   | Why                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| The **password**              | It is a credential change, and the most consequential one an account has                                |
| A **passkey assertion**       | A client should not close the door on the strength of a credential that could not then let them back in |
| **Two** discoverable passkeys | One is one lost object away from having no way in at all                                                |

## A reset does not re-open the door

Completing a reset sets a password and **does not** clear the flag. Otherwise the email channel is a
way to undo the client's decision silently — everything ADR-0027 says about the address being where
recovery goes, with the client's own protection as the thing removed.

Re-enabling has two routes and no third:

- **a passkey assertion** — the client still holds one and has changed their mind;
- **a Level 3 human with a recorded verification basis** — the client who holds none, on the phone.

> **The cost is stated rather than hidden.** A client who loses every passkey has one route back and
> it is a phone call. That is the trade every advanced-protection programme makes, and this design
> makes it the client's to accept rather than one taken on their behalf.

## The rest

- **The user handle is the client user id** — already opaque, already in the Ledger, not guessable,
  and a second identifier would be a second thing to keep mapped.
- **The challenge for a passwordless ceremony belongs to no user.** That is what discoverable means,
  so the column is nullable rather than carrying a placeholder somebody must remember is meaningless.
- **A passkey-only account still holds a password hash.** The credential-change gates all take one
  and a reset still sets one, so the password stops being an _authentication_ method without ceasing
  to be a _confirmation_ one. A deliberate half-step — see "Not built".
- **Nothing changed for an account that keeps its password**, and a test asserts it.

## Routes

| Route                                   | Notes                                                           |
| --------------------------------------- | --------------------------------------------------------------- |
| `POST /portal/sign-in/passkey/options`  | Unauthenticated, account-less. Nothing typed, nothing revealed  |
| `POST /portal/sign-in/passkey`          | `{ response }` → a session. **No second step**                  |
| `POST /portal/mfa/keys/register`        | `{ discoverable }` chooses first- or second-factor registration |
| `GET /portal/password-sign-in`          | Whether the password still works, and whether it could stop     |
| `POST /portal/password-sign-in/disable` | `{ password, response }`                                        |

---

## Tested

12 tests in `tests/integration/passkey-first-factor.test.ts`. Suite total **1081**.

| Mutation                                       | Failures |
| ---------------------------------------------- | -------- |
| Let the password work when sign-in is disabled | 2        |
| Drop the two-passkey rule                      | 1        |
| Drop the user-verification requirement         | 1        |
| Let a second-factor credential sign in alone   | 1        |

## Not built

**Removing the password entirely from a passkey-only account.** The end state, and it needs every
"current password" gate to take an assertion instead — four call sites, each becoming a two-step
challenge exchange. Conditional UI and autofill hints. A browser UI.
