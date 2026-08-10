# Plan — WebAuthn as a first factor

**Branch:** `ai-feature/passkey-first-factor` · **Follows:** WebAuthn as a second factor (merged, `e2d9ef8`)

ADR-0028 called this "the end state, and a much larger change: account recovery, the invitation flow
and every 'current password' gate assume a password exists."

That is still the shape of the problem, and it is answerable.

---

## Mini-PRD

### Problem

A passkey as a _second_ factor makes one path phishing-resistant and leaves the other one as it was.
**An account is as strong as the weakest method it will accept**, so a client who registers a key and
keeps password sign-in is still phished by a proxy that takes the password and the TOTP code.

Adding a phishing-resistant path does not remove a phishable one. **That is the whole problem this
slice exists to fix**, and it is why the feature is not "sign in with a passkey" but "sign in with a
passkey _and turn the other way off_".

### Success metrics

- A client signs in with a passkey alone — no email typed, no password, no second step.
- A client with **two** passkeys can switch password sign-in off, and then a correct password is
  refused.
- Turning it off does not create a new lockout, and does not create a way to turn it back on quietly.
- Nothing about the invitation flow, reset, or the credential-change gates breaks.

### Risks

| Risk                                                                | Mitigation                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A phishable path left enabled beside the resistant one**          | The point of the slice: password sign-in can be switched off per account         |
| **Switching it off becomes a lockout**                              | Two discoverable passkeys required before it can be switched off                 |
| **A reset quietly re-opening the phishable path**                   | Completing a reset sets the password and does **not** re-enable password sign-in |
| A non-verifying key standing in for a password                      | User verification is **required** for first-factor sign-in, and only there       |
| Password sign-in refusals revealing which accounts are passkey-only | The same generic refusal as every other sign-in failure                          |

---

## Key decision 1 — a UV passkey is possession and verification in one act

A second factor is presented after a password, so ADR-0028 set user verification to `preferred`: a
PIN-less key still adds what it was there to add.

**Standing alone, it has to carry both halves.** A discoverable credential with user verification is
something the client has plus something they know or are, performed in one gesture — which is why it
can replace a password rather than accompany one. A key with no PIN cannot, and this path refuses it.

So first-factor credentials are registered `residentKey: 'required'`, `userVerification: 'required'`,
and asserted with `requireUserVerification: true`. A credential registered as a second factor is not
promoted into a first-factor one by accident: the flag is stored at registration.

## Key decision 2 — the feature is turning the password off, not adding a button

Sign-in with a passkey while a password still works is a convenience, not a security property.

`passwordSignInDisabledAt` on the client user is what makes it one. With it set, `authenticateClientUser`
refuses a correct password — **with the same sentence every other sign-in failure gets**, because a
message saying "this account is passkey-only" tells an attacker which accounts to stop guessing and
which to keep phishing.

Switching it off requires the password **and** a passkey assertion — it is a credential change
(ADR-0024) and the most consequential one — plus **two** discoverable passkeys, because switching it
off with one is one lost object away from having no way in at all.

## Key decision 3 — a reset does not re-open the door

Completing a password reset sets a password. It does **not** re-enable password sign-in.

Otherwise the email channel is a way to undo the client's decision silently, and everything ADR-0027
says about the address being where recovery goes applies with more force: an attacker who took the
inbox would get back the phishable path the client deliberately closed.

Re-enabling is its own act: a passkey assertion, or a Level 3 human with a recorded verification
basis. **The cost is stated rather than hidden** — a client who loses every passkey has one route
back and it is a phone call. That is the same trade every advanced-protection programme makes, and it
is the client's to accept.

## Key decision 4 — the user handle is the client user id

A discoverable credential returns a `userHandle`, which is how the assertion says whose account it
is without an email being typed. It is stored on the authenticator and is not secret.

The client user id goes there. It is already an opaque identifier that appears in the Ledger and in
access logs, it is not guessable, and inventing a second one would be a second identifier to keep
mapped for no gain.

---

## Architecture

```
packages/identity/src/webauthn.ts    discoverable registration, passwordless sign-in
packages/identity/src/clientUsers.ts authenticateClientUser refuses when disabled
packages/identity/src/passwordless.ts  enabling and disabling password sign-in
prisma/schema.prisma                 ClientUser.passwordSignInDisabledAt, factor.discoverable,
                                     ClientWebauthnChallenge.clientUserId now nullable
```

The challenge for a passwordless ceremony belongs to **no user yet** — that is what discoverable
means — so the column has to admit that rather than being given a placeholder.

## Test strategy

- Register a discoverable passkey, sign in with it alone, get a session.
- **A correct password is refused once password sign-in is off**, with the generic sentence.
- Two passkeys are required to switch it off; one is refused.
- **A completed reset sets the password and leaves password sign-in off.**
- An assertion without user verification is refused on the first-factor path.
- A second-factor credential cannot be used for passwordless sign-in.
- Re-enabling needs a passkey or a Level 3 human with a basis.
- The whole existing suite still passes: nothing about invitation, reset or the credential gates
  changes for an account that keeps its password.

## Out of scope

Removing the password column. Conditional UI / autofill hints. A browser UI.
