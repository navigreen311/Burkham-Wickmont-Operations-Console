# WebAuthn as a second factor

Module: 11.1 Identity & Access (for 11.10) · Package: `@bwc/identity` · Schema: `identity` ·
ADR: [0028](adr/0028-phishing-resistance-is-the-property.md)

ADR-0024 named this as the stronger answer and did not build it, because there was no browser UI to
register from. There still is not — and **a UI cannot be written against an endpoint that does not
exist.**

---

## The reason is phishing resistance, not "stronger crypto"

TOTP is a shared secret and six digits. A proxy site takes the password and the code and presents
both to the real portal inside the code's thirty-second window.

**Everything 11.1 does about replay is downstream of a code typed into the wrong site, and none of it
helps** — the attacker uses the code once, immediately, and that is its first use.

A WebAuthn signature covers `clientDataJSON`, which contains **the origin the browser was actually
on**. An assertion produced at the proxy says the proxy. There is nothing a client can be persuaded
to do at the wrong site that produces a signature the right site accepts.

## A reviewed library here, hand-rolled TOTP there — the same principle

`totp.ts` says a dependency in the credential path is a dependency to avoid. Read carelessly that
decides this too. It does not.

> **The strength of `totp.ts` is not that it is small; it is that RFC 6238 publishes vectors**, so an
> off-by-one cannot hide.

WebAuthn has no equivalent vector set. A hand-rolled verifier tested only by the signer written
beside it agrees with itself perfectly and proves nothing — the exact failure `totp.ts` avoided.

So `@simplewebauthn/server`, and the test builds a **software authenticator** (real P-256 key, real
`clientDataJSON`, real `authenticatorData`, real DER signature) so the **library is the external
reference**. The relationship is inverted rather than abandoned.

## Configuration

| Variable         | Required | Why                                                                                                                                                            |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORTAL_RP_ID`   | **yes**  | The domain a credential is scoped to. One a caller could supply is a caller choosing that scope                                                                |
| `PORTAL_ORIGIN`  | **yes**  | The exact origin. **One a caller could supply is the phishing resistance switched off by the party it exists to stop** — and that deployment passes every test |
| `PORTAL_RP_NAME` | no       | What the authenticator shows                                                                                                                                   |

`PORTAL_ORIGIN` is rejected if it carries a path: a value that can never match what a browser reports
fails as "every key is broken" rather than as a configuration error.

## More than one factor per account

One factor was right when the only factor was an app. **A security key with no second key and no app
is one lost object away from a lockout**, and the remedy is a phone call to the firm.

- A key **and** an app, or two keys — allowed and encouraged.
- Only one authenticator **app**: two secrets for one account is a second thing to keep in sync for
  no gain, where a second key is redundancy.

## The signature counter, and why zero is not a violation

A counter that does not advance means two authenticators are answering for one credential — a clone.
**Many authenticators never implement one and always report zero** (every passkey, every Touch ID
credential), so enforcing "must advance" unconditionally rejects all of them.

The verifier enforces it, given the stored counter. This module's remaining job is to **classify**
that refusal so a clone produces a signal rather than looking like a mistyped touch.

> **A surviving mutation found this was dead code.** The check sat after the verifier's own, where it
> could never run, and the test passed because the library refused. It now runs on the failure path
> and reads a counter from bytes the signature check already rejected — used to decide what to write
> down, never what to allow.

## What a key stores, and what it does not

`secretCiphertext` is **null** for a WebAuthn factor. The column it fills is a **public** key: a
leaked database yields the value that verifies a signature, never the one that produces it. That is
strictly better than the encrypted TOTP secret beside it — and worth noticing that the encryption
exists because TOTP cannot be in that position.

Registration and confirmation are **one step**, unlike TOTP's two: the ceremony _is_ the proof that
the authenticator works.

Attestation is `none` (it identifies the model, which matters to a firm mandating hardware and not to
this one). User verification is `preferred` (this is a second factor after a password; requiring UV
excludes PIN-less keys for a property the password already supplies). Every key is **named**, because
a factor a client cannot identify is one they will not dare remove.

## Scope: sign-in

Password change, address change and factor removal still take a code — a TOTP code where an app is
enrolled, or a recovery code. Making those take an assertion means turning each into a two-step
exchange for a challenge; that is a separate change, and it is another reason to hold both kinds of
factor.

## Routes

| Route                              | Notes                                            |
| ---------------------------------- | ------------------------------------------------ |
| `POST /portal/mfa/keys/register`   | Registration options. Session required           |
| `POST /portal/mfa/keys`            | `{ password, label, response }`                  |
| `GET /portal/mfa/keys`             | The keys on this account                         |
| `POST /portal/sign-in/key/options` | Assertion options, from the **challenge** cookie |
| `POST /portal/sign-in/key`         | `{ response }` → a session                       |

---

## Tested

15 tests in `tests/integration/client-webauthn.test.ts`. Suite total **1069**.

| Mutation                                                   | Failures |
| ---------------------------------------------------------- | -------- |
| Take the origin from the response instead of configuration | 2        |
| Never spend the ceremony challenge                         | 1        |
| Skip the clone classification                              | 1        |
| Register without the password                              | 2        |

**Two tests in this file initially passed for the wrong reason**, and mutation testing is what
showed it: the replay test was satisfied first by the counter check and then by a fresh challenge
being issued, never by the property it is named for. It now runs against `verifyWebauthnAssertion`
directly with a counterless authenticator, so only the spent challenge can refuse it.

## Not built

**WebAuthn as a first factor** (passkeys replacing the password) — the end state, and a much larger
change, because recovery, invitation and every "current password" gate assume a password exists.
Attestation verification. A browser UI.
