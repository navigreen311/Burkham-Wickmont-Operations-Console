# Changing a password you still know

Module: 11.1 Identity & Access (for 11.10) · Package: `@bwc/identity` · **No schema** ·
ADR: [0026](adr/0026-a-change-is-not-a-reset.md)

Named as out of scope three slices running, each time for the same reason: **changing a password you
know is a different act from recovering one you have lost.**

Without it, a client who simply wants a different password has to pretend they have forgotten it —
which routes routine hygiene through the recovery path, and teaches people that "I want a new
password" and "I have lost access" are the same request.

---

## What it takes

|                          | Required                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------ |
| A live session           | Yes                                                                                  |
| The **current** password | Yes — a session is not a credential (ADR-0024)                                       |
| A **current code**       | Only where a factor is enrolled. There, it is one of the credentials the account has |

**An attacker holding a session and a shoulder-surfed password is exactly the case a second factor
exists for.** The code is **spent** afterwards — one that authorised a credential change and could
still open a session would be a code used twice.

That check lives in one place now: `verifySecondFactor`, called by this route and by factor removal.
Three copies of those ten lines is how one of them stops spending the step.

## Sessions: this keeps the caller's, a reset revokes all

Side by side these look inconsistent, so:

|            | Revokes                               | Because                                                                   |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------- |
| **Reset**  | **Every** session                     | The requester might be anybody — it is completed by whoever holds a token |
| **Change** | Every session **except the caller's** | They proved a session, the current password, and a code where one exists  |

**The difference is not inconsistency. It is that the two paths know different things about who is
asking.** Signing the caller out of the action they just took is how a button stops being used.

The surviving session is `principal.sessionId`, from `resolveSession` — on the principal rather than
a parameter, because a caller who could name a session id could name somebody else's and keep it
alive.

## An outstanding reset dies with the change

The interaction nothing else would have caught.

> A client asks for a reset, then remembers their password and changes it from the portal instead.
> **The reset token is still live in an inbox**, and it sets a password of the holder's choosing over
> the one just chosen — after the client believes they have dealt with it.

Superseded in the same transaction, and the result reports `outstandingResetSpent` so a client who
had one in flight is told it is gone.

## The rest

- **No schema.** The same `passwordHash` column and the same session and reset tables — the first
  slice in this sequence with no migration to verify.
- **The lockout clears**, for the same reason it clears on a reset: the password being guessed no
  longer exists.
- **Rate limited although authenticated**, which no other authenticated route is. Per-account lockout
  counts sign-ins and does not apply, so a caller holding a session could otherwise guess the
  current password from inside it. Counting the source means a hijacked session cannot become a
  guessing loop — **and cannot lock the real owner out either**. Its own scope,
  `portal.password_change`.
- **`identity.client_user.password_changed`** is its own event. One type for both acts would hide
  which happened.

## Route

| Route                   | Body                                      |
| ----------------------- | ----------------------------------------- |
| `POST /portal/password` | `{ currentPassword, newPassword, code? }` |

---

## Tested

13 tests in `tests/integration/client-password-change.test.ts`, 3 more over HTTP. Suite total
**1038**. **Both** session behaviours are asserted in one file, so the difference between change and
reset reads as deliberate rather than as one of them being wrong.

| Mutation                                    | Failures |
| ------------------------------------------- | -------- |
| Revoke the caller's own session too         | 3        |
| Let an outstanding reset survive the change | 1        |
| Skip the code where a factor is enrolled    | 2        |

## Not built

**Changing the email address on an account** — a bigger question, because it moves where a reset link
goes. WebAuthn. A firm-wide MFA mandate.
