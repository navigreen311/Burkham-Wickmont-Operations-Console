# ADR-0023 — A reset link is a credential in transit, and an unauthenticated endpoint must not change the account

**Status:** Accepted · **Date:** 2026-08-12 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

A client who forgot their password had no route back. `inviteClientUser` said so in as many words —
_"would be a password reset, which is a different act with a different threat model and is not built
here."_

That threat model is the reason this ADR exists. Every other write path in the Console begins with
somebody proving who they are. **This one begins with an anonymous person typing an email address
into a form, and what it produces is a credential.**

## Decision 1 — delivery does not go through 4.1

The obvious build hands the email to `send`. Read what that does:

- **it writes the message body into `Communication.body`** — a table staff read through
  `communicationsFor`, and one 7.1 assembles into the compliance evidence file. A reset link routed
  through it is **a live credential sitting in a compliance log**;
- it runs the middleware chain, whose step 5 refuses a client in a state 7.2 has not activated, so
  **account recovery would be gated on a regulatory activation**;
- it runs the preference gate, so **a client who opted out of email could never recover their
  account**;
- it runs the compliance scanner, which exists for client-facing marketing claims.

Each of those is right for a communication and wrong for account recovery.

So delivery is `deliverPasswordResetLink` in 11.1: it takes the token, persists nothing, logs
nothing, returns nothing, and reports `not_built` naming the email provider. **Named for the one
thing it carries**, because a general `sendSecurityEmail` is the door somebody routes a newsletter
through in eighteen months — and that newsletter would then bypass 4.1's preference gate, which is
the control this decision is carefully not weakening.

This is not the portal building a second permission model (ADR-0020). Nothing here decides who may
receive what. It is one delivery path for one artifact that must not be retained.

## Decision 2 — requesting a reset changes nothing about the account

Three properties. The middle one is the one that is easy to get wrong while trying to be helpful.

**The current password keeps working.** Otherwise anybody who knows a client's email address ends
their access by typing it into a form — denial of service requiring no authentication at all.

**`failedAttempts` and `lockedUntil` are untouched.** Clearing the lock reads as kindness: the
person is locked out, and they are asking for help. **It is a lockout bypass.** An attacker who has
burned five guesses hits the reset endpoint, the counter goes back to zero, and they guess forever
from an endpoint that asks them for nothing. The lock clears on **completion**, where the caller has
proved they hold the token, and where clearing it is right because the password being guessed no
longer exists — keeping it there would punish the client for the attacker's behaviour.

**Every address gets the same answer** — enrolled, unenrolled, disabled, locked, or not a user at
all. The same rule as sign-in, for the same reason: otherwise the endpoint is a list of who banks
with this firm. The residual is one row insert of timing, stated in the code rather than papered
over; the lookup and the token derivation happen either way.

Today that shared answer is `not_built`, because there is nowhere for the link to go. That is
truthful in both branches, and it is what the same call returns once a provider is gated in, minus
the `not_built`.

## Decision 3 — completing a reset ends every session

The reason a person resets a password is often that somebody else has it. A reset that left sessions
running would leave the attacker holding a valid cookie for up to twelve hours **while the client
believed they had just shut them out** — which is worse than not offering the reset, because the
client stops looking.

## The staff-issued reset

Email is not gated in, so the self-service path cannot deliver anything. A client who phones the
Concierge Desk needs a route that works now, and it is the same shape as the invitation that
enrolled them: a Level 3 human, a token returned once, conveyed out of band.

It requires a recorded **verification basis** — how the staff member satisfied themselves the caller
was who they said. **The attack on helpdesk password reset is social engineering, not
cryptography.** A field nobody can leave blank is the only part of that a system can enforce, and it
goes into the Ledger as well as the row, because it is what somebody would want to read back when
asking how an account was taken over.

**This does not expand what Level 3 can already do.** The same person can invite a client user at an
address they control onto any client's file. The reset makes an existing power auditable rather than
adding a new one — worth stating because the opposite reading is the intuitive one, and because the
power it does not add is one an access review should still be looking at.

`issuedBy` is null for a self-service request, mirroring 6.4's `listedBy`: automatic in, human out,
and no invented name in the field a reviewer reads.

## Consequences

**One live reset at a time.** Issuing supersedes any outstanding one, and completing supersedes the
rest; two live tokens would mean spending one and leaving the other.

**Sixty minutes**, against the invitation's seventy-two hours. An invitation is expected to sit in
an inbox; a reset is used within minutes of being asked for, and every extra hour is an hour a
forwarded email stays live.

**The same password cannot be set back.** It costs one verification on a path already hashing, and
setting it back accomplishes nothing while looking like it accomplished something.

**Consumed, superseded, expired and never-real all answer identically.** Distinguishing them
confirms a token was once real.

**A separate rate limiter on the transport**, tighter than sign-in's and counted separately. Shared
buckets would mean an attacker spraying resets from one address locks legitimate clients out of
signing in — a denial of service assembled from two individually correct controls.

**The token travels in a URL exactly once**, in the link the delivery seam would build, because
email leaves no alternative. It is mitigated by being single-use, short-lived and worthless until
used. The portal takes it back **in a request body**, never a query string, so it does not reach
this server's access logs.

## Alternatives considered

**Route the email through 4.1 and mark it transactional.** A flag on `send` saying "skip the
preference gate, the chain and the scanner" is four exemptions on the path that exists to apply
them, and the body still lands in `Communication.body`.

**Log the client out of nothing, and let sessions live.** Rejected in Decision 3. The variant —
revoke all sessions _except_ the requesting one — assumes the requester is the client, which is
exactly what is in question.

**Invalidate the password at request time**, so a stolen account is frozen immediately. It hands
anybody who knows an email address a way to end a client's access.

**Reuse `ClientInvitation` with a nullable "kind".** The mechanics rhyme and the acts do not: one
gives somebody an account, the other gives somebody back an account they already have. One table
would mean one expiry, one issuing rule and one audit story for two different threat models.

**MFA instead.** Not instead — next. A second factor changes what a reset has to prove, and this
slice deliberately does not pretend to have solved that.
