# Browser end-to-end tests for the Client Portal

Runner: Playwright (Chromium) · Specs: `tests/e2e/*.spec.ts` · CI: a **fifth job** ·
Follows: [the portal UI](m11-portal-ui.md), ADR-0031

ADR-0031 named this as the honest gap in the UI slice: _"the transforms are tested; the wiring is
read."_

**The reason to add it is not coverage of the DOM.** It is that a virtual authenticator can do what
nothing else in this repository can — register and use a **real passkey**, through a real browser,
against the real routes.

---

## What only a browser can check

|                                             | Why nothing else could                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **A passkey is registered and used**        | `navigator.credentials` is the only thing that produces a WebAuthn credential. Five slices (#31–#35) had no client that could exercise them |
| **The CSP permits the page to run**         | A policy is a header until a browser enforces it. A header saying `script-src 'self'` proves nothing about whether the module loaded        |
| **A value carrying markup arrives as text** | The source check says nothing is assigned to a markup-writing property; only a browser says whether the result is what that was for         |

The authenticator is a Chrome DevTools Protocol virtual one — resident credentials, user
verification, automatic presence. **It is not a stub of the browser's API**: the browser really runs
the ceremony and the server really verifies the signature.

## What it found

> **A success message was wiped by the refresh that proved it worked.**

`registerKey` set "Key registered." and then called `enterSettings()`, which cleared the notice. The
message appeared and vanished in the same frame, so a client had no way to tell a success from
nothing happening. **Reading the source could not show that; running it could.** The refresh now
carries the message through.

Two smaller things the run taught, both now written into the specs:

- **One authenticator cannot register two credentials for one account** — and is right not to.
  `excludeCredentials` carries what the account already holds, so an authenticator already
  registered declines rather than silently creating a credential the client cannot tell from the
  first. A client with two keys has two authenticators, and the spec now models that.
- **Chrome allows only one `internal` authenticator per environment**, so the second is a roaming
  one — which is what a second key usually is: a phone and a USB key rather than two phones.

## The harness

`tests/e2e/server.ts` seeds a **fresh tenant per run** — the Ledger is append-only and hash-chained,
so reusing one would mean writing into somebody else's chain — and serves the page and the API from
one process, which ADR-0031 requires anyway.

`localhost` is deliberate: **WebAuthn needs a secure context, and `localhost` is one without a
certificate.** Any other host would mean TLS in a test harness, which is a thing to keep working
rather than a thing being tested.

**One account per test that changes an account.** Registering a key, and above all turning the
password off, are permanent. A spec sharing an account with the next one leaves it in a state the
next did not ask for — and that failure looks like a flake rather than like two tests fighting over
one row. This was not a prediction: the first full run failed exactly that way.

## Where it runs

A **fifth CI job**, because it needs a browser binary and the other three do not. Splitting it keeps
their runtime where it was and makes a failure here say _the page_ rather than appearing as one red
test among a thousand. Traces are uploaded on failure only, and kept seven days — **a trace is a copy
of the page, and this page shows a client's file.**

Chromium only. The virtual authenticator is a CDP feature; a Firefox or WebKit run would cover the
DOM layer, which is the layer with the least in it, at the cost of two more browser downloads on
every run.

---

## Tested

9 specs: 3 passkey, 6 page. `pnpm test:e2e`. The vitest suite is unchanged at **1112** — the two
runners never see each other's files (`*.test.ts` against `*.spec.ts`).

| Spec                                        | Asserts                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| registers, and the account then reports it  | A real attestation object parsed, origin checked, public key stored            |
| signs in with nothing but the passkey       | No email, no password, no second step                                          |
| turns the password off, and then refuses it | The phishable path stops working, with the same sentence a wrong password gets |
| loads its module under the policy           | No CSP violation on the console, and the script ran                            |
| says what it is withholding                 | The section exists whether or not anything is in it                            |
| refuses a wrong password                    | The server's sentence, not reworded on the way to the screen                   |
| renders a body carrying a tag as text       | No element created, no handler run                                             |
| the reset path answers identically          | The one place a UI can quietly break a server's guarantee                      |

## Not built

Firefox and WebKit runs. Visual regression. A test for the document download path, which needs a
scanned document in the Vault and is covered server-side by `client-vault-access.test.ts`.
