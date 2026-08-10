# Plan — WebAuthn as a second factor

**Branch:** `ai-feature/client-webauthn` · **Follows:** email-address change (merged, `7ab770a`)

ADR-0024 named this as the stronger answer and did not build it, for one reason: there was no browser
UI to register a credential from. That is still true, and it is no longer a reason to leave the
server side missing — a portal UI cannot be written against an endpoint that does not exist.

---

## Mini-PRD

### Problem

TOTP is a shared secret and six digits. **It is not phishing-resistant**: a proxy site relays the
code to the real one inside its thirty-second window, and the client sees a normal sign-in.

WebAuthn is bound to the origin. A signature produced at `evil.example` carries `evil.example` in the
signed data, and the portal rejects it. **That property is the whole reason to build this.**

### Success metrics

- A client registers a security key and signs in with it as their second factor.
- **An assertion produced for the wrong origin is refused**, asserted directly.
- A client may hold **more than one** factor — two keys, or a key and an authenticator app.
- A cloned authenticator is detectable.

### Risks

| Risk                                                | Mitigation                                                     |
| --------------------------------------------------- | -------------------------------------------------------------- |
| **A subtly wrong verifier is a silent auth bypass** | A reviewed library, not a hand-rolled one — see key decision 1 |
| An attacker choosing the relying party              | RP ID and origin are deployment configuration with no defaults |
| A replayed assertion                                | Server-generated challenge, stored, single use, short-lived    |
| A cloned authenticator                              | The signature counter is stored and must not go backwards      |
| A lost key becoming a lockout                       | Multiple factors, and recovery codes as before                 |

---

## Key decision 1 — a reviewed library here, and hand-rolled TOTP there, are the same principle

`totp.ts` is hand-rolled with a stated reason: "a dependency here would be a dependency in the path
that mints credentials." That looks like it decides this too. It does not, and the difference is
worth being explicit about.

TOTP is twenty lines of HMAC and truncation, **and it has published test vectors**. The strength of
that file is not that it is small — it is that it is checked against an external reference, so an
off-by-one cannot hide.

WebAuthn verification is CBOR, COSE keys, attestation formats, flag bits and signature algorithms,
and **there is no equivalent vector set to check a hand-rolled version against**. A verifier tested
only by the signer I wrote alongside it agrees with itself perfectly and proves nothing. That is
precisely the failure mode `totp.ts` avoided by having the RFC.

So: `@simplewebauthn/server`. The library becomes the external reference — the test builds a
software authenticator and the library is what says whether it produced something real.

## Key decision 2 — the relying party is deployment configuration, never a request value

`PORTAL_RP_ID` and `PORTAL_ORIGIN`, required, no defaults, exactly as `PORTAL_TENANT_ID` is.

A relying-party ID taken from a request is an attacker choosing the scope of a credential, and an
origin taken from a request is the phishing resistance switched off by the party it exists to stop.
Both failures look like a working system.

## Key decision 3 — more than one factor per account

The existing model allows one. That was right when the only factor was an authenticator app, and it
is wrong now: **a security key with no second key and no app is one lost object away from a
lockout**, and the recovery path for that is a phone call to the firm.

So `activeFactorFor` becomes `activeFactorsFor`, and a client may register several. Every factor
still costs the password to add and to remove.

## Key decision 4 — the counter is stored, and zero is not a violation

Some authenticators keep a monotonic signature counter; a value that does not advance means two
authenticators are answering for one credential — a clone.

**Many authenticators do not implement it and always report zero.** Refusing a non-increasing
counter unconditionally would reject every Touch ID and passkey credential in existence. So: a
counter is enforced only once the credential has shown it uses one.

---

## Architecture

```
packages/identity/src/webauthn.ts    options, verification, the credential records
packages/identity/src/mfa.ts         multi-factor: activeFactorsFor, verify by kind
apps/portal-api/src/config.ts        PORTAL_RP_ID, PORTAL_ORIGIN
prisma/schema.prisma                 ClientMfaFactor gains credential columns; a challenge table
```

## Scope: sign-in, not every credential change

WebAuthn answers the **sign-in** challenge, which is where phishing happens. Password change, address
change and factor removal still take a code — a TOTP code where an app is enrolled, or a recovery
code. A key-only account uses a recovery code there, which is also the reason those paths are worth
having a second factor registered for.

Making those three take an assertion means turning each into a two-step exchange for a challenge.
That is a separate change and it is named rather than half-done.

## Test strategy

- A software authenticator: a P-256 key, real `clientDataJSON`, real `authenticatorData`, a real
  DER signature. The library verifies it, so the library is the reference.
- Register, then sign in with the key.
- **An assertion for the wrong origin is refused**, and one for the wrong RP ID.
- A replayed challenge is refused; an expired one is refused.
- A counter that goes backwards is refused; a counter that stays at zero is not.
- Two factors on one account; either satisfies sign-in.
- Registration takes the password.

## Out of scope

WebAuthn as a **first** factor (passkeys replacing the password). Attestation verification beyond
`none` — it identifies the authenticator model, which matters for a firm that mandates particular
hardware and not for this one yet. A browser UI.
