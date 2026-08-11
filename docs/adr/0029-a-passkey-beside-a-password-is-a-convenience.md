# ADR-0029 — A passkey beside a live password is a convenience; the security property is turning the password off

**Status:** Accepted · **Date:** 2026-08-18 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

ADR-0028 made one sign-in path phishing-resistant and left the other one exactly as it was.

**An account is as strong as the weakest method it will accept.** A client who registers a security
key and keeps password sign-in is still taken by a proxy that collects the password and the TOTP
code — the key is never asked for, so its resistance is never engaged. Adding a resistant path does
not remove a phishable one.

So the feature in this slice is not "sign in with a passkey". It is **"sign in with a passkey and
turn the other way off"**, and everything else here follows from that being the point.

## Decision 1 — a user-verifying discoverable credential is possession and verification in one act

ADR-0028 set `userVerification: 'preferred'` for a second factor, and gave a reason: presented after
a password, a PIN-less key still adds what it is there to add.

**Standing alone it has to carry both halves.** A discoverable credential asserted with user
verification is something the client has plus something they know or are, performed in one gesture —
which is why it can replace a password _and_ the challenge that would have followed one. A key with
no PIN carries one half, and this path refuses it.

Concretely: first-factor credentials are registered `residentKey: 'required'` and
`userVerification: 'required'`, verified with `requireUserVerification: true` at registration and at
every assertion. `discoverable` is stored on the factor, so **a second-factor credential is not
promoted into a password replacement by a later flag** — it was never asked to prove what a first
factor proves.

There is now exactly one place in the codebase where `requireUserVerification` is true, and it is
the passwordless path. That is the difference, in one line.

## Decision 2 — `passwordSignInDisabledAt`, and the refusal says nothing

The switch is a column on the client user, and with it set a **correct** password is refused.

It is refused with **the same sentence every other sign-in failure gets**. A message saying "this
account is passkey-only" would be an oracle telling an attacker which addresses to stop guessing at
and which to keep phishing — the same reasoning that gives ADR-0023's reset endpoint one answer.

Turning it off requires:

- **the password**, because it is a credential change (ADR-0024) and the most consequential one an
  account has;
- **a passkey assertion**, verified exactly as a real passwordless sign-in is, because a client
  should not be able to close the door on the strength of a credential that could not then let them
  back in;
- **two discoverable passkeys**, because switching it off with one is one lost object away from
  having no way in at all, and the remedy for that is a phone call to the firm — the path this
  codebase keeps narrowing.

## Decision 3 — a reset does not re-open the door

Completing a password reset sets a password. It does **not** clear `passwordSignInDisabledAt`.

Otherwise the email channel is a way to undo the client's decision silently. Everything ADR-0027 says
about the address being where recovery goes applies here with more force: an attacker who took the
inbox would get back the phishable path the client deliberately closed, and the client would have no
signal that it had happened.

Re-enabling is its own act, with two routes and no third: **a passkey assertion** — the client still
holds one and has changed their mind — or **a Level 3 human with a recorded verification basis**, for
the client who holds none and is on the telephone.

**The cost is stated rather than hidden.** A client who loses every passkey has one route back and it
is a phone call. That is the trade every advanced-protection programme makes, and this design makes
it the client's to accept rather than one taken on their behalf.

## Decision 4 — the user handle is the client user id

A discoverable credential returns a `userHandle`, which is how an assertion says whose account it is
with nothing typed. It lives on the authenticator and is not secret.

The client user id goes there: already an opaque identifier that appears in the Ledger and in access
records, not guessable, and a second identifier would be a second thing to keep mapped for no gain.

## Consequences

**The challenge for a passwordless ceremony belongs to no user.** That is what discoverable means, so
`ClientWebauthnChallenge.clientUserId` is nullable rather than being given a placeholder somebody
would later have to remember was meaningless.

**Nothing changed for an account that keeps its password.** Invitation, reset, the credential-change
gates and the second-factor flow are untouched, and a test asserts it — this is a slice that adds a
state, not one that moves everybody into it.

**A passkey-only account still holds a password hash**, because the credential-change gates
(ADR-0024, 0026, 0027) all take one and a reset still sets one. The password stops being an
_authentication_ method without ceasing to be a _confirmation_ one. That is a deliberate half-step:
removing it entirely would mean re-plumbing every gate to take an assertion, which is a bigger change
than this and is named rather than half-done.

**Two Ledger types**, `password_sign_in_disabled` and `password_sign_in_enabled`. Reading them as one
would hide which happened, and one of them is the strongest thing a client can do to protect their
account while the other is the strongest thing anybody can do to weaken it.

## Alternatives considered

**Sign in with a passkey and leave the password alone.** The convenience without the property. It is
what "add passkey support" usually means, and it is why the ADR is titled the way it is.

**No password at all on a passkey-only account.** The end state, and it needs every "current
password" gate to take an assertion instead — four call sites, each becoming a two-step challenge
exchange. Worth doing; not in the same slice as the switch itself.

**Let a reset re-enable password sign-in.** Decision 3. It is the difference between a client's
decision and a suggestion.

**One passkey enough to switch off.** Turns the strongest protection available into the most likely
lockout, and hands the recovery to the Concierge Desk.
