# Plan — change password for a signed-in client

**Branch:** `ai-feature/client-password-change` · **Follows:** the shared rate-limit store (merged, `e5ebe69`)

Named as out of scope three slices running, because it is a different act with a different threat
model from reset. This is that act.

---

## Mini-PRD

### Problem

A client who **knows** their password and wants a different one has to pretend they have forgotten
it. That routes a routine hygiene action through the recovery path — which today means a phone call
to the Concierge Desk, since email is not gated in.

Worse as a habit: it teaches clients that "I want a new password" and "I have lost access" are the
same request, and those two have very different consequences.

### Success metrics

- A signed-in client changes their password without touching the reset path.
- Every **other** session ends. The one making the request does not.
- **An outstanding reset is spent**, so a token in an inbox cannot undo the change.
- Nothing new is stored: no schema, no migration.

### Risks

| Risk                                                  | Mitigation                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| **A live reset token surviving a deliberate change**  | Outstanding resets are superseded in the same transaction                   |
| A stolen session changing the password                | The current password, and a code where a factor exists                      |
| Guessing the current password from a session          | Rate limited on its own scope, and each attempt costs a scrypt verification |
| Other devices staying signed in on the old password   | Every other session is revoked                                              |
| Logging the client out of the act they just performed | Their own session survives — see key decision 2                             |

---

## Key decision 1 — a credential change needs a credential, and where a second factor exists it is one

ADR-0024 settled this for enrolment and removal: **a session is not a credential.** The same rule
decides this route.

The current password is definitional. The second factor is the interesting half: if the account has
one, changing the password takes a current code too. An attacker holding a session and a
shoulder-surfed password is exactly the case a second factor exists for, and the account they would
be taking over is the one it is protecting.

Where no factor is enrolled there is no code to ask for, and asking would be a refusal nobody can
satisfy.

## Key decision 2 — this revokes every session except the one asking, and reset revokes all

Reset revokes everything (ADR-0023) because **the requester might be anybody**: a reset is completed
by whoever holds a token, and the point is to end an attacker's session.

Here the requester has proved three things — a live session, the current password, and a code where
one exists. Revoking their own session would sign them out of the action they just took, which
teaches people to avoid the button.

**That is not an inconsistency between the two paths; it is that the two paths know different things
about who is asking.** Worth writing down, because the next person to read them side by side will
see two rules and one of them will look wrong.

## Key decision 3 — an outstanding reset dies with the change

The interaction nothing else would catch. A client requests a reset, then remembers their password
and changes it from the portal instead. **The reset token is still live in an inbox**, and it sets a
password of the holder's choosing over the one just chosen.

`completePasswordReset` already spends outstanding resets. The change path has to do the same, and
that only happens if somebody goes looking for the interaction — so it gets a test named after it.

---

## Architecture

```
packages/identity/src/passwordChange.ts   changeClientPassword
packages/portal/src/session.ts            a thin wrapper, as the others are
apps/portal-api/src/app.ts                POST /portal/password, on its own limiter scope
```

**No schema.** Nothing here is a new fact; it is the same `passwordHash` column and the same session
and reset tables.

## Test strategy

- Change, then sign in with the new password and fail with the old.
- Other sessions die; **the requesting session survives** and still works.
- **An outstanding reset is refused afterwards.**
- The current password is required; the same password is refused; the length floor applies.
- With a factor enrolled, a code is required and a spent code is refused.
- A disabled user cannot change their password.
- Over HTTP: the route needs a session, and the limiter counts it separately from sign-in.

## Out of scope

Changing the email address on an account, which is a bigger question: it moves where a reset link
goes. WebAuthn. A firm-wide MFA mandate.
