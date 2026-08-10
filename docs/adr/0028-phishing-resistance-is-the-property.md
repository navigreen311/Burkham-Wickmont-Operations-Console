# ADR-0028 — Phishing resistance is the property, and a reviewed verifier is how you get it

**Status:** Accepted · **Date:** 2026-08-17 · **Modules:** 11.1 Identity & Access, 11.10 Client Portal

## Context

ADR-0024 chose TOTP because it was the only second factor that could work without a vendor, and
named WebAuthn as the stronger answer that needed a browser UI to register from.

There is still no UI. That is no longer a reason to leave the server side missing: **a UI cannot be
written against an endpoint that does not exist.**

## Decision 1 — the reason to build this is phishing resistance, not "stronger crypto"

TOTP is a shared secret and six digits. A proxy site puts up a copy of the sign-in page, takes the
password and the code, and presents both to the real portal inside the code's thirty-second window.
Everything 11.1 does about replay - the spent time step, the challenge attempt limit - is downstream
of a code the client typed into the wrong site, and **none of it helps**, because the attacker uses
the code once, immediately, and it is the first use.

A WebAuthn signature covers `clientDataJSON`, and `clientDataJSON` contains **the origin the browser
was actually on**. An assertion produced at the proxy says the proxy, and this module compares it
with the origin the deployment is configured with. There is nothing the client can be persuaded to
do at the wrong site that produces a signature the right site accepts.

That is the whole reason, and it is worth stating as the reason, because "a security key is more
secure" would leave somebody free to conclude that a longer TOTP code is equivalent.

## Decision 2 — a reviewed library here, and hand-rolled TOTP there, are the same principle

`totp.ts` is hand-rolled and says why: "a dependency here would be a dependency in the path that
mints credentials." Read carelessly, that decides this one too.

It does not. **The strength of `totp.ts` is not that it is small; it is that RFC 6238 publishes test
vectors**, so an off-by-one in the counter encoding cannot hide. The file's own header says so.

WebAuthn verification is CBOR, COSE keys, attestation formats, flag bits and signature algorithms,
and there is no equivalent vector set to check a hand-rolled implementation against. A verifier
tested only by the signer written beside it agrees with itself perfectly and proves nothing — which
is precisely the failure `totp.ts` avoided by having an external reference.

So `@simplewebauthn/server`. And the test builds a **software authenticator** — a real P-256 key,
real `clientDataJSON`, real `authenticatorData`, a real DER signature — so that the library is the
external reference the hand-written half is checked against. The relationship is inverted rather
than abandoned.

## Decision 3 — the relying party is deployment configuration

`PORTAL_RP_ID` and `PORTAL_ORIGIN`, required, no defaults, exactly as `PORTAL_TENANT_ID` and
`PORTAL_TRUST_PROXY` are.

An RP ID a caller could supply is a caller choosing the scope of the credential. **An origin a caller
could supply is the phishing resistance switched off by the party it exists to stop** — and a
deployment configured that way passes every test, serves every client, and is not doing the one
thing it was built for. `PORTAL_ORIGIN` is additionally rejected if it carries a path, because a
value that can never match what a browser reports fails as "every key is broken" rather than as a
configuration error.

## Decision 4 — more than one factor per account

The model allowed one. That was right when the only factor was an authenticator app and it is wrong
now: **a security key with no second key and no app is one lost object away from a lockout**, and the
remedy for that is a phone call to the firm — the path ADR-0023 spends its length constraining.

So `activeFactorsFor` replaces `activeFactorFor`, and a client may hold a key and an app, or two
keys. Only one authenticator **app** is still allowed: two apps holding two secrets for one account
is a second thing to keep in sync for no gain, where a second key is redundancy.

## Decision 5 — the signature counter, and why zero is not a violation

Some authenticators keep a monotonic counter; a value that does not advance means two authenticators
are answering for one credential, which is a clone.

**Many authenticators never implement it and always report zero** - every passkey, every Touch ID
credential. Enforcing "must advance" unconditionally rejects all of them.

The verifier does the enforcement, given the stored counter, and refuses only when the credential has
shown it uses one. This module's remaining job is to **classify** that refusal so a clone produces a
signal somebody can act on rather than looking like a mistyped touch.

**A surviving mutation found that this was originally dead code.** The check had been written after
the verifier's own, where it could never be reached, and the test asserting "a stale counter is
refused" passed because the library refused it. The branch now runs on the failure path, reads the
counter from bytes the signature check has already rejected, and uses it only to decide what to write
down — never what to allow.

## Consequences

**Scope is sign-in.** Password change, address change and factor removal still take a code: a TOTP
code where an app is enrolled, or a recovery code. Making those take an assertion means turning each
into a two-step exchange for a challenge, which is a separate change and is named rather than
half-done. It is also a reason for a client to hold both kinds of factor.

**Registration and confirmation are one step**, unlike TOTP's two. The ceremony _is_ the proof that
the authenticator works, so there is no unproved state to leave a client in — ADR-0024's "a factor
nobody has proved they can use is not a factor" is satisfied by the protocol rather than by a second
call.

**A key has no secret at all.** `secretCiphertext` is null for a WebAuthn factor, and the column it
does fill is a **public** key: a leaked database yields the value that verifies a signature, never
the one that produces it. That is a strictly better position than the encrypted TOTP secret next to
it, and it is worth noticing that the encryption exists because TOTP cannot be in that position.

**Attestation is `none`.** Attestation identifies the authenticator model, which matters to a firm
that mandates particular hardware. This one does not, and requesting a certificate in order to ignore
it is theatre.

**User verification is `preferred`, not `required`.** This is a second factor presented after a
password, so a key without a PIN still adds what it is here to add; requiring UV would exclude those
keys for a property the password already supplies.

**Every key is named.** Two keys are indistinguishable without one, and a factor a client cannot
identify is one they will not dare remove.

## Alternatives considered

**Hand-roll the verifier.** Decision 2. Consistent with `totp.ts`'s letter and against its reasoning.

**WebAuthn as a first factor - passkeys replacing the password.** The end state, and a much larger
change: account recovery, the invitation flow and every "current password" gate assume a password
exists. Not in a slice whose point is the second factor.

**Keep one factor per account and let a key replace the app.** It makes a lost key a lockout and
sends the client to the Concierge Desk, which is the path this codebase keeps narrowing.

**Require user verification.** Excludes hardware keys with no PIN for a property the password already
provides at this position in the flow.
