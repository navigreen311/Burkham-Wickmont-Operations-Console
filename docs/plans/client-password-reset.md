# Plan — password reset for client users

**Branch:** `ai-feature/client-password-reset` · **Follows:** the portal transport (merged, `87b231e`)

The first of the three things #27 said were missing before the portal faces the internet.

---

## Mini-PRD

### Problem

A client who forgets their password has no route back. `inviteClientUser` refuses an enrolled user
with a message that says so in as many words — _"would be a password reset, which is a different act
with a different threat model and is not built here."_ That message stops being true in this slice
and has to change with it.

### Success metrics

- A client who holds a valid reset token sets a new password and signs in with it.
- **The request endpoint says the same thing to every address**, known or not.
- **Requesting a reset changes nothing about the account** — not the password, not the lockout.
- Completing one **ends every session**.
- The token never reaches a log, a communication record, or an HTTP response body.

### Risks

| Risk                                                           | Mitigation                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A reset link sitting in the communications log**             | Delivery is its own seam in 11.1 and never persists the token — see key decision 1 |
| **An unauthenticated endpoint locking a client out**           | Requesting does not invalidate the current password                                |
| **Reset used as a lockout bypass**                             | Requesting does not clear `failedAttempts` or `lockedUntil`; completion does       |
| **An attacker who already has the password staying signed in** | Completion revokes every session                                                   |
| Email enumeration                                              | One answer for every address, as at sign-in                                        |
| Helpdesk social engineering                                    | A staff-issued reset requires a recorded verification basis                        |
| Token brute force                                              | 256 bits, hashed at rest, single use, 60-minute window, rate limited               |

---

## Key decision 1 — a reset link is a credential in transit, and 4.1 is not the path for it

The obvious build routes the email through 4.1's `send`. Read what that does:

- **it writes the message body into `Communication.body`** — a table staff read through
  `communicationsFor`, and one 7.1 assembles into the compliance evidence file. A reset link routed
  through it is **a live credential in a compliance log**;
- it runs the middleware chain, whose step 5 refuses a client in a state 7.2 has not activated — so
  account recovery would be gated on a regulatory activation;
- it runs the preference gate, so **a client who opted out of email could never recover their
  account**;
- it runs the compliance scanner, which exists for client-facing marketing claims.

Every one of those is right for a communication and wrong for account recovery.

So delivery is a narrow seam in 11.1 — `deliverPasswordResetLink` — that takes the token, persists
nothing, logs nothing, returns nothing, and reports `not_built` naming the email provider. Named for
the one thing it carries so the next person cannot quietly route anything else through it.

## Key decision 2 — an unauthenticated endpoint must not change the account

Three properties, and the middle one is the one that is easy to get wrong while trying to be kind.

**Requesting a reset does not invalidate the current password.** Otherwise anybody who knows a
client's email address can end their access by typing it into a form — denial of service with no
authentication at all.

**Requesting a reset does not clear `failedAttempts` or `lockedUntil`.** Clearing the lock reads as
helpful: the person is locked out and is asking for help. It is **a lockout bypass** — an attacker
who has burned five guesses hits the reset endpoint, the counter resets, and they guess forever. The
lock clears on **completion**, where the person has proved they hold the token, and where clearing
it is right because the password being guessed no longer exists.

**Every address gets the same answer** — enrolled, unenrolled, disabled, locked, or not a user at
all. The residual is one insert of timing, and it is stated in the code rather than papered over.

## Key decision 3 — completing a reset ends every session

The reason a person resets a password is often that somebody else has it. A reset that leaves
sessions running leaves the attacker holding a valid cookie for up to twelve hours, while the client
believes they have just shut them out.

## The staff-issued reset

Email is not gated in, so the self-service path cannot deliver anything today. A client who phones
the Concierge Desk needs a route that works now, and it is the same shape as the invitation that
enrolled them: a Level 3 human, a token returned once, conveyed out of band.

It requires a recorded **verification basis** — how the staff member satisfied themselves the caller
is who they say. The real attack on helpdesk password reset is social engineering, not cryptography,
and a field nobody can leave blank is the only part of that a system can enforce.

**This does not expand what Level 3 can already do.** They can already invite a client user at an
address they control onto any client's file. The reset makes an existing power auditable rather than
adding a new one — worth stating because the opposite reading is the intuitive one.

`issuedBy` is null for a self-service request, mirroring 6.4's `listedBy: null`: automatic in, human
out, and no invented name in the field a reviewer reads.

---

## Architecture

```
packages/identity/src/passwordReset.ts   request, staff issue, complete, delivery seam
packages/portal/src/session.ts           thin wrappers, as signIn already is
apps/portal-api/src/app.ts               two routes, own rate limiter
prisma/schema.prisma                     ClientPasswordReset in the identity schema
```

## Test strategy

- Request → issue → complete → sign in with the new password.
- The request answers identically for a known address, an unknown one, an unenrolled user and a
  disabled one, **and creates a row only for the first**.
- Requesting does not clear a lockout; completing does.
- Completion revokes every live session.
- The old password stops working; the same password cannot be set again.
- A second use of the same token is refused; issuing a new reset spends the outstanding one.
- Expiry.
- A user disabled between request and completion cannot complete.
- A staff-issued reset needs a Level 3 human and a verification basis.
- No token appears in any Ledger payload.

## Out of scope

**MFA**, which is the next gap and a larger one. **Change-password for a signed-in client**, which
is a different act with a different threat model — it needs the current password, not a token.
Notifying a client that their password changed, because that needs the delivery seam this slice
proves is not built.
