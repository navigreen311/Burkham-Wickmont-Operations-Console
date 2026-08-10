# ADR-0026 — A change is not a reset, and the two revoke different sessions on purpose

**Status:** Accepted · **Date:** 2026-08-15 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

Three slices named this as out of scope, each time for the same reason: **changing a password you
know is a different act from recovering one you have lost.** ADR-0023 built the recovery path. This
is the other one.

Without it a client who simply wants a different password has to pretend they have forgotten it,
which routes routine hygiene through the recovery path — today, a phone call to the Concierge Desk,
since email is not gated in. Worse as a habit: it teaches clients that "I want a new password" and
"I have lost access" are the same request, and their consequences are not.

## Decision 1 — a credential change needs a credential, and a second factor is one of them

ADR-0024 settled the rule for enrolling and removing a factor. It decides this route too.

The current password is definitional. The second factor is the interesting half: where one is
enrolled, changing the password takes a current code as well. **An attacker holding a session and a
shoulder-surfed password is exactly the case a second factor exists for**, and the account they
would be taking over is the one it is protecting.

Where no factor is enrolled there is no code to ask for, and asking would be a refusal nobody could
satisfy.

The code is **spent** — `lastUsedStep` moves, exactly as at sign-in. A code that authorised a
credential change and could then still open a session would be a code used twice.

That check now lives in one place. `verifySecondFactor` is called by removal and by this route;
three copies of those ten lines is how one of them stops spending the step.

## Decision 2 — this revokes every session except the one asking; a reset revokes all

Read side by side these look inconsistent, so the reason is written down.

**A reset revokes everything** because the requester might be anybody. It is completed by whoever
holds a token, and the point is to end an attacker's session.

**A change keeps the caller's own** because they have proved three things: a live session, the
current password, and a code where one exists. Revoking their session would sign them out of the
action they just took — and a button that logs you out is a button people stop pressing, which
costs more than it protects.

**The difference is not inconsistency. It is that the two paths know different things about who is
asking.**

The surviving session is `principal.sessionId`, which comes from `resolveSession`. It is on the
principal rather than a parameter because a caller who could name a session id could name somebody
else's and keep it alive.

## Decision 3 — an outstanding reset dies with the change

The interaction nothing else would have caught.

A client asks for a reset, then remembers their password and changes it from the portal instead.
**The reset token is still live in an inbox**, and it sets a password of the holder's choosing over
the one just chosen — silently, and after the client believes they have dealt with it.

`completePasswordReset` already spends outstanding resets; the change path now does the same, in the
same transaction, and `supersedeOutstanding` is exported for that third caller. The result reports
`outstandingResetSpent`, because a client who had a reset in flight should be told it is gone.

## Consequences

**No schema.** Nothing here is a new fact — the same `passwordHash` column, the same session and
reset tables. The first slice in this sequence with no migration to verify.

**The lockout clears**, for the same reason it clears on a reset: the password being guessed no
longer exists.

**The route is rate limited although it is authenticated**, which no other authenticated route is.
Per-account lockout counts sign-ins and does not apply here, so a caller holding a session could
otherwise guess the current password from inside it. Counting the source instead means a hijacked
session cannot become a guessing loop — **and cannot lock the real owner out either**, which is what
counting the account would have allowed.

Its own scope, `portal.password_change`, so a client changing a password cannot exhaust the sign-in
budget for everybody behind the same address.

**`ClientPrincipal` gained `sessionId`.** Additive, and it is what the principal always was: a
resolved session.

**The Ledger gets `identity.client_user.password_changed`**, separate from
`password_reset_completed`. One event type for both would hide which happened, and they are
different acts.

## Alternatives considered

**Reuse the reset path with the current password as the token.** It would collapse two threat models
into one and lose the distinction the Ledger and the session behaviour both depend on.

**Revoke every session, including the caller's.** Consistent with reset at the cost of being wrong
here: the caller has proved who they are, and signing them out trains them not to use it.

**Require re-authentication when the session is old.** A reasonable escalation and a second
mechanism to keep right; the current password is already being asked for, which is what
re-authentication would have asked for.

**Skip the second factor when the password is correct.** It would make the factor irrelevant for the
one act that changes what an attacker can keep.
