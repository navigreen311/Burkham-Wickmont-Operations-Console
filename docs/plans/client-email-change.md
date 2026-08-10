# Plan — changing the email address on a client account

**Branch:** `ai-feature/client-email-change` · **Follows:** change-password (merged, `d7e1220`)

Named as the bigger question in #31, for a reason worth restating: **the email address is where a
reset link goes.**

---

## Mini-PRD

### Problem

A client whose address changes — a new firm, a new domain, a mailbox that no longer exists — has no
way to move it. Today the only route is a staff member editing a row, which is not a route because
nothing checks anything.

### Why it is the most dangerous of the three

Changing a password changes what an attacker must know. **Changing the address changes where
recovery goes**, and that is permanent: an attacker who moves it keeps the account even after the
real client resets their password, because the reset arrives in the attacker's inbox.

So this act is stronger than a password change and is priced accordingly.

### Success metrics

- The address moves only after the **new** one has been proved reachable.
- The **old** address is told, or the fact that it could not be told is recorded rather than skipped.
- A pending change dies when the client recovers their account.
- A record afterwards can say **which kind of proof** was obtained.

### Risks

| Risk                                                       | Mitigation                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Moving recovery to an address that does not exist**      | The change is pending until a token sent to the new address comes back                  |
| **An attacker with a session taking the recovery channel** | The current password and a code where a factor exists, plus the cancellation rule below |
| **A pending change surviving the client's recovery**       | A password reset or change **cancels** pending email changes                            |
| A staff-assisted change looking like a verified one        | The record says which, in a column, forever                                             |
| The new address already belonging to somebody              | Refused without saying why                                                              |

---

## Key decision 1 — the address moves when the new one answers, not when the request is made

A change to an unreachable address moves the recovery channel to a mailbox nobody reads. That is not
a typo, it is a lockout the client discovers the day they need to get back in.

So `requestEmailChange` writes a **pending** row and nothing else. The account keeps its address
until a token delivered to the new one is presented.

## Key decision 2 — a staff-assisted change is a different fact, and the column says so

Email is not gated in, so the self-service path cannot deliver its token. #28 solved that shape with
a Level 3 staff route.

**It does not transfer here, and the reason matters.** A token read to a client over the phone
proves the person; it proves nothing at all about the address. The whole point of the token is
reachability.

So a staff-assisted change is recorded as exactly what it is: `verifiedBy: 'staff_assertion'` beside
`'email'`. When somebody asks later how an account's recovery channel moved, the answer is in a
column rather than in an inference.

## Key decision 3 — this does NOT revoke other sessions, and that is not an inconsistency

Change-password revokes every session but the caller's, because the caller knows the new password
and the other sessions do not.

**Nothing about authentication changes here.** Revoking sessions would remove the legitimate owner's
access and leave the attacker — who holds the session doing the changing — exactly where they were.
It is a control that helps the wrong party.

The same reasoning leaves **outstanding password resets alone**: a reset in flight went to the old
address, which the attacker does not have, so it is the legitimate owner's way back and killing it
would be doing the attacker a favour.

Three sibling operations, three different answers about sessions and resets, each following from who
is known to be asking.

## Key decision 4 — recovering the account cancels a pending change

The interaction that would otherwise be invisible.

An attacker with a session requests a move to their own address. The client notices something is
wrong and resets their password. **The attacker then presents the verification token and takes the
recovery channel anyway** — after the client believes they have dealt with it.

So completing a password reset, and changing a password, both cancel every pending email change.

---

## Architecture

```
packages/identity/src/emailChange.ts      request, staff issue, complete, cancel, history
packages/portal/src/mfa.ts                thin wrappers, as the others are
apps/portal-api/src/app.ts                POST /portal/email and /portal/email/confirm
prisma/schema.prisma                      ClientEmailChange in the identity schema
```

The consumed row **is** the history: it records the address it replaced.

## Test strategy

- Request → confirm → sign in with the new address; the old one stops working.
- The account keeps its address until the token is presented.
- **A password reset cancels a pending change**, and so does a password change.
- Sessions and outstanding resets survive — asserted, because the tempting build kills both.
- An address already in use is refused without saying so.
- A staff-issued change records `staff_assertion`; a confirmed one records `email`.
- Expiry, single use, and the current password and code requirements.

## Out of scope

Sending anything: both seams report `not_built` naming the provider, and the notification to the old
address is the one that matters most, because it is how a hijack is noticed. WebAuthn. A firm-wide
MFA mandate.
