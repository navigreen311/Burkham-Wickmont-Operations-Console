# ADR-0027 — The address is where recovery goes, so moving it is the strongest act of the three

**Status:** Accepted · **Date:** 2026-08-16 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

#31 named this as the bigger question, in one line: **the email address is where a reset link goes.**

Changing a password changes what an attacker must know. Changing the address changes **where
recovery goes**, and that is permanent — an attacker who moves it keeps the account after the real
client resets their password, because the reset arrives in the attacker's inbox.

So this is priced above the other two, and three of its decisions run _opposite_ to the
password-change slice that preceded it. Each of those is written down here, because "be consistent
with the last one" is the tempting wrong answer in all three cases.

## Decision 1 — the address moves when the new one answers, not when the request is made

A change applied at request time moves recovery to whatever was typed. **A typo is then not a typo;
it is a lockout the client discovers on the day they need to get back in**, and by then the channel
that would fix it is the one that is wrong.

So `requestEmailChange` writes a pending row and touches nothing. The account keeps its address until
a token delivered to the new one comes back — which is the only thing that proves the address is
reachable.

## Decision 2 — a staff-assisted move is a different fact, and a column says which

#28 solved "email is not gated in" with a Level 3 staff route that hands the token to a human to
convey. **That does not transfer here, and the reason is the whole design.**

A token read to a client over the phone proves the **person**. It proves nothing at all about the
address, and reachability is the only thing the token exists to establish.

So the staff route does not hand out a token. It moves the address on a Level 3 human's assertion,
against a recorded verification basis, and stamps `verifiedBy: 'staff_assertion'` beside the
`'email'` the self-service path produces. **When somebody asks later how an account's recovery
channel moved, the answer is in a column rather than in an inference** — and the two answers mean
genuinely different things about what was checked.

## Decision 3 — this revokes nothing, and that is not an inconsistency with ADR-0026

Change-password revokes every session but the caller's, because the caller knows the new password
and the other sessions do not.

**Nothing about authentication changes here.** Revoking sessions would remove the legitimate owner's
access and leave the attacker — who is the one holding the session doing the changing — exactly
where they were. **It is a control that helps the wrong party.**

The same reasoning leaves outstanding password resets alone. A reset in flight went to the **old**
address, which an attacker does not have; it is the legitimate owner's way back, and cancelling it
would be doing the attacker a favour.

Three sibling operations, three different answers about sessions and resets. Each follows from the
same question — what is known about who is asking, and who is helped by removing what.

## Decision 4 — recovering the account cancels a pending move

The interaction that would otherwise be invisible from either feature.

An attacker with a session requests a move to their own address. The client notices something is
wrong and resets their password. **The attacker then presents the verification token and takes the
recovery channel anyway** — after the client believes they have dealt with it.

So completing a password reset, and changing a password, both cancel every pending move. This is the
second slice running where the finding was a cross-feature interaction rather than a defect in the
feature being built, which is beginning to look like the shape of the risk in this area.

## Consequences

**Both delivery seams report `not_built`, and the one that matters most is the second.**
`deliverEmailChangeVerification` carries the token to the new address; `notifyPreviousAddress` tells
the old one that its account has moved. **That notification is how a hijack is noticed at all**,
because the old address is the only channel the legitimate owner still holds. `oldAddressNotified`
travels out to the caller and into the Ledger as `false` rather than being omitted — a change
recorded as done while nobody was told would be the most misleading answer available.

**The delivery seam is injectable**, following PR #9's lesson about a KEK provider constructed inside
the function that used it. It is how a real provider will be wired in, and it is how a test can watch
the one place the token legitimately travels to — rather than a back door written for the test.

**An address already in use is refused without saying so.** The caller is authenticated, but
confirming that an address belongs to somebody is still a fact about a third party this firm holds.
Re-checked at completion as well as at request, because the column is unique and the alternative is
a database error the caller cannot read.

**A consumed row is the history.** It records the address it replaced and how the move was proved, so
`emailHistory` needs no second table.

**Confirmation is unauthenticated**, on purpose: the link is opened from the new mailbox, which is
not necessarily the browser holding the session. Requiring the session would mean a client who
opened the link on their phone could not finish. The token is the whole of the authorisation, which
is why it is short-lived, single use, and delivered nowhere else.

## Alternatives considered

**Apply the change and let the client undo it.** Undoing needs a channel, and the channel is the
thing that just moved.

**A staff-issued token, as #28 does for resets.** Decision 2 — it proves the person, and the token's
job is to prove the address.

**Revoke sessions for consistency with change-password.** Decision 3. It removes the owner and
leaves the attacker.

**Require the new address to be verified _and_ the old one to confirm.** Strictly better, and it
needs two working mailboxes and a delivery provider. When email is gated in, the notification to the
old address should become a confirmation window rather than only a notice.
