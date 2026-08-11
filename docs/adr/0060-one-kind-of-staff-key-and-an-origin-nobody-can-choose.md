# ADR-0060 — One kind of staff key, and an origin nobody can choose

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 11.1 Identity & Access, the internal Console transport

## Context

Two decisions this slice could have inherited from the client side without thinking, and one of them
should not be.

**The client has two kinds of key.** A second factor, registered `residentKey: 'discouraged'` and
`userVerification: 'preferred'`; and a passkey, registered `required` and `required`.
`ClientMfaFactor.discoverable` keeps them apart, and ADR-0029 Decision 1 explains what the column is
protecting against:

> a second-factor credential is **not** promoted into a password replacement by a later flag — it was
> never asked to prove what a first factor proves.

**The Console has no relying-party configuration at all.** `apps/api/src/config.ts` had no `rpId` and
no `origin`, because nothing in the Console had ever run a WebAuthn ceremony.

## Decision 1 — there is one kind of staff key, and the flag that could be got wrong does not exist

Every staff key is registered `residentKey: 'required'` and `userVerification: 'required'`, verified
with `requireUserVerification: true` at registration and at **every** assertion afterwards — sign-in,
reauthentication, and the switch.

There is no second-factor mode for staff, because a staff key exists to _remove_ the password
(ADR-0059) rather than to sit beside it. A key that only ever has to be a password replacement must
carry possession and verification in one gesture from the moment it is registered.

**So there is no `discoverable` column on `ActorWebauthnCredential`.** ADR-0029 needed one because it
had two kinds to keep apart; this has one kind, so the state a column would have distinguished cannot
occur, and the way for a credential to end up on the wrong side of it does not exist.

The safest version of a distinction is the one that cannot be drawn.

## Decision 2 — `CONSOLE_RP_ID` and `CONSOLE_ORIGIN`, required, no defaults

ADR-0028 Decision 3's reasoning, copied rather than adapted, because it is not a Console-specific
argument:

> An RP ID a caller could supply is a caller choosing the scope of the credential. **An origin a
> caller could supply is the phishing resistance switched off by the party it exists to stop** — and
> a deployment configured that way passes every test, serves every client, and is not doing the one
> thing it was built for.

Both sit beside `CONSOLE_TENANT_ID` and `CONSOLE_TRUST_PROXY` as settings the process refuses to
start without. `CONSOLE_ORIGIN` is additionally rejected if it carries a path, because a value that
can never match what a browser reports fails as _"every key is broken"_ rather than as a
configuration error — which is a long afternoon.

### `CONSOLE_RP_NAME` does take a default, and the difference is the point

It is a display string. Getting it wrong produces a confusing browser prompt; getting `rpId` or
`origin` wrong produces a working system that is not protecting anybody.

**A default is safe exactly where being wrong is visible.** Stating that beside two settings that
have none is better than leaving the inconsistency for somebody to read as carelessness.

## Consequences

**The user handle is the Actor id.** It is already opaque, already in the Ledger, already what the
middleware chain reads an Authority Level from, and inventing a second identifier would be a second
thing to keep mapped for no gain. Same choice ADR-0029 Decision 4 made with the client user id.

**Two config literals outside this slice's files needed the new fields** — the e2e harness and the
console transport test. The harness genuinely needs a real relying party or the browser journey
cannot run at all; the transport test never runs a ceremony and was given them anyway, because a
config literal missing a required field is one that compiles and lies.

**A browser with no WebAuthn is told so**, rather than being handed a button that fails when pressed.
The password path is still there for exactly that case — until the account turns it off, which is the
trade ADR-0059 states.

## Alternatives considered

**Let staff register a second-factor key too, as clients can.** It is the shape that produces the
promotion problem ADR-0029's `discoverable` column exists to prevent, in exchange for a mode that has
no use here: a staff key beside a live password is the decoration ADR-0059 refuses.

**Derive the origin from the request.** The failure mode is silent and total, and it is the exact
attack the mechanism exists to stop. It would also pass every test in this repository.

**Default `CONSOLE_RP_ID` to `localhost`.** Convenient in development and a credential scoped to the
wrong domain in production — and the symptom would be keys that work on a developer's machine and
nowhere else, discovered by whoever deployed it.

**Reuse `PORTAL_RP_ID` and `PORTAL_ORIGIN`.** The Console and the portal are separate processes on
separate trust boundaries (ADR-0022), and a shared relying party would mean a credential registered
for a client's room is scoped to the staff console as well.
