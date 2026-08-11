# An account with no password

Module: 11.1 Identity & Access (for 11.10) · Package: `@bwc/identity` · Schema: `identity` ·
ADR: [0030](adr/0030-a-passwordless-account-has-no-password.md)

ADR-0029 stopped the password authenticating anybody and deliberately left the hash, naming the
reason: **seven gates asked for it.** This closes that half-step.

---

## One type, one function, seven gates

Each gate could have grown its own "or a passkey" branch. **Seven gates each deciding what a good
answer looks like is how one of them ends up accepting less than the others** — and it will be the
one somebody adds in a hurry.

```ts
type Confirmation =
  { kind: 'password'; password: string } | { kind: 'passkey'; response: Record<string, unknown> };
```

**A gate asks whether the caller confirmed themselves; it does not decide what confirmation is.** A
union rather than two optional fields, so a call site cannot supply neither — nor both, and leave the
module to pick.

| Gate                                                                                             | Takes                                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confirm an authenticator, remove one, register a key, regenerate recovery codes, move an address | `Confirmation`                                                                                                                                   |
| **Change the password**                                                                          | The **current password**, still — the one gate where the thing being replaced is the thing being asked for. On a passwordless account it refuses |

## A passkey confirmation is user-verified, and it IS the second factor

**User verification is required.** A confirmation stands in for the password a gate would otherwise
have taken, and a touch without a PIN is less than that password.

> Found by a surviving mutation, not by design review: dropping `requireUserVerification` from the
> re-authentication path changed no test. The property was real and implemented, and nothing was
> watching it.

**And it satisfies the second-factor step.** Two gates asked for a confirmation _and_ a code — which
for a key-only account is asking for something that does not exist. A user-verifying assertion is
possession and verification in one act, so asking for a code on top is asking the same category
twice.

> Found by a test, not by reading: a passwordless client could not change their own address.

## The password is destroyed, not disregarded

`removePassword` writes **two independent facts**:

| Fact                       | Role                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `passwordRemovedAt`        | What every gate reads                                                                                |
| `passwordHash = 'removed'` | A value nothing verifies against — `verifyPassword` needs six `$`-separated parts beginning `scrypt` |

**The weaker fact cannot undo the stronger one.** A column somebody edits back to null does not
resurrect a credential.

Only after password sign-in is off, and only with two passkeys and an assertion. Removing it from an
account whose password still signs people in would be a way to lock somebody out in one call.

## Recovery is one recorded act

A reset has nothing to reset.

- **Self-service refuses without saying so** — distinguishing a passwordless account from an unknown
  address hands an attacker a list of which accounts to stop guessing at.
- **The staff path says so plainly** and names the act that fixes it, because its reader is a
  colleague.

`restorePassword`: a Level 3 human, a recorded verification basis, and in one call it clears both
flags and issues a reset token — so **the client chooses the password rather than being told one**. A
password read down a telephone is a password two people know.

One call rather than three, because an account found halfway between "sign-in re-enabled" and "a
password exists" is worse than either end.

## Routes

| Route                                           | Body                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Every credential gate                           | `{ password }` **or** `{ passkey }` — one reader, `confirmationFrom` |
| `POST /portal/password-sign-in/remove-password` | `{ response }` — only a passkey can authorise it                     |

---

## Tested

14 tests in `tests/integration/passwordless-accounts.test.ts`. Suite total **1095**.

| Mutation                                           | Failures                                     |
| -------------------------------------------------- | -------------------------------------------- |
| Leave the hash in place when removing the password | 1                                            |
| Allow removal while password sign-in is still on   | 1                                            |
| Accept the old password after removal              | 1                                            |
| Drop user verification on a confirming passkey     | 1 _(after the test that mutation asked for)_ |

## Not built

Conditional UI and autofill hints. A browser UI. Removing the password **column** — the sentinel plus
the flag is two checks where a nullable column would have been one, and that is deliberate.
