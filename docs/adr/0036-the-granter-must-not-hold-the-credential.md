# ADR-0036 — The granter must not hold the credential

**Status:** accepted
**Date:** 2026-08-11
**Supersedes:** `beginStaffEnrolment`, introduced in ADR-0032

## Context

ADR-0032 gave the Console a staff credential and left enrolment as a bootstrap step through the
module. This slice was to add the surface for it, and the surface is where the shape of the module
became a problem.

`beginStaffEnrolment` took this:

```ts
beginStaffEnrolment({ tenantId, actorId, email, password, grantedBy })
  → { secret, uri }
```

**The granter passed the subject's password and received the subject's TOTP secret.** One person
holding both factors of somebody else's account — and nothing downstream can tell a session opened
by the subject from one opened by whoever enrolled them, because it is the same Actor id in the
Ledger either way.

That was survivable as a bootstrap seam invoked from a script by the person setting the system up.
It stops being survivable as a **screen**, because a screen is a routine: it is used every time
somebody joins, by whoever happens to be Level 3 that week, and what it hands them is permanent.

The mistake is the same one ADR-0032 made about the header, one layer in. There the finding was that
a page makes a missing credential exploitable. Here it is that **a page makes a badly-shaped
credential API routine.**

## Decision

**An invitation, and the subject sets both factors themselves.**

```ts
inviteStaff({ tenantId, actorId, email, invitedBy })   → { token, expiresAt }   // granter
enrolStaffFromInvitation({ tenantId, token, password }) → { secret, uri }        // SUBJECT
confirmStaffEnrolment({ tenantId, actorId, password, code })                     // SUBJECT
```

No password crosses `inviteStaff` and no secret comes back from it. The credential row is created
with a stored hash that cannot verify — `verifyPassword` needs six `$`-separated parts beginning
`scrypt`, and `'unenrolled'` is not that — so an invited actor cannot sign in even if somebody
guesses the empty string.

This is not a new pattern. **It is the one 11.1 already uses for clients**
(`inviteClientUser` → `enrolClientUser`), and the staff flow had simply been built without it.

`beginStaffEnrolment` is **removed rather than deprecated**. ADR-0034's rule applies directly: a
control a caller can skip by calling a different function is not a control, and the function that
takes a password and hands back a secret is the convenient one.

### What this does not fix, stated plainly

**Whoever holds an unspent token can spend it**, and with no email provider gated, the token is
handed back to the granter to pass on. So a granter who keeps the code can still enrol the account
themselves before the subject gets to it.

That is **strictly weaker than what they held before** — a token is single-use, expires in 24 hours,
and can only be spent to _set_ a credential rather than to use one, and spending it is recorded
against the subject — but it is not nothing, and calling it solved would be false. What closes it is
delivering the invitation to the subject rather than to the person who created it, and delivery is
the same gap that leaves `deliverPasswordResetLink` reporting `not_built` (ADR-0023). **The page says
so to the granter, in the banner carrying the code**: _"Anyone holding it can spend it."_

### Smaller decisions inside it

**24 hours, not the client's 72.** A client is invited into their own file and may take a few days
to get to it. A colleague being given sight of every file in the firm is starting on Monday, and an
unspent token is the one thing in this flow that anybody else can use.

**Re-inviting spends the earlier token.** Two live tokens for one account would be two ways in, and
the person who kept the first would still have one after the second was issued.

**Inviting somebody already enrolled is refused.** An invitation and a credential reset are different
acts with different threat models — one gives somebody an account, the other gives somebody back an
account they already have. A path that quietly became the other one is a way to take over an account
that already exists. The refusal says which act is wanted instead.

**The token goes in a form field, never the URL.** A token in a URL ends up in browser history,
access logs and the `Referer` header — the same reason the session is a cookie and never a query
parameter.

**The enrolment routes are unauthenticated and rate limited.** The person using them has no
credential yet; that is what they are there to create. They take a bearer token from an anonymous
caller, and a token nobody rate limited is a token somebody guesses. They are on the sign-in
limiter, because they are the same act.

**Every refusal on that path is the same sentence.** A token that never existed, one already spent
and one expired are indistinguishable from outside — as is a missing field, because naming the field
tells an anonymous caller what the endpoint wants.

## Consequences

**The Ledger records two acts with two actors.** `identity.staff.invited` names the granter;
`identity.staff.enrolment_started` names the **subject**, because recording the granter would say
somebody set a password they never saw.

**The first credential is still a bootstrap step.** `inviteStaff` needs a Level 3 human who is
already an Actor, so the very first one comes from a script or a seed. That is deliberate — Console
access is sight of every client file — and it is named rather than papered over.

**Every test that enrolled a staff member changed**, because the flow now involves two people. The
transport and invariant suites call `inviteStaff` and then `enrolStaffFromInvitation` rather than one
function; a helper that collapsed them would be a test that could not tell the difference between the
two designs.

**A browser spec now performs the whole journey** — invite, sign out, enrol, confirm, sign in —
which is the only place the property this ADR is about is visible end to end: the secret appears on
a screen that has no session behind it.

## Alternatives considered

**Keep `beginStaffEnrolment` for scripts, add invitations for the page.** Two ways to create a
credential, one of which hands both factors to somebody else. ADR-0034 in one sentence.

**Have the granter set a temporary password the subject must change.** Common, and it does not help:
the granter still knows a password that works, and the window between setting it and the change is
exactly when nobody is watching. It also does nothing about the TOTP secret, which is the half that
does not expire.

**Show the secret as a QR code only, so the granter cannot read it off the screen.** Security by
inconvenience — a QR code is a picture of the secret, and the `otpauth://` URI is in the page either
way. The fix is who is looking at the screen, not what is drawn on it.

**Deliver the invitation by email now.** The right answer, and it needs the email provider that
4.1's send path also reports `not_built` for. Named as the thing that closes the remaining gap rather
than quietly left out.
