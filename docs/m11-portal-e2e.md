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

**Three engines, and they do not run the same thing.**

| Engine                  | Runs                                          | Why                                                                                   |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Chromium**            | Everything                                    | The only engine with a virtual authenticator, so the only one that can hold a passkey |
| **Firefox**, **WebKit** | `cross-browser.spec.ts` and `passkey.spec.ts` | The file written for them, plus the one that reports why it cannot run                |

On the run that introduced them, **every page spec passed in all three and the two new engines found
nothing.** That is the honest result, and it is why their value is concentrated in
`cross-browser.spec.ts` - the file where an engine's own implementation is the subject rather than
the page's.

**What that gives up, plainly:** the portal's own page specs - sign-in, the room, the message path,
the reset path - are no longer exercised in Gecko or WebKit. They found nothing there, and that is a
reason rather than a guarantee.

`passkey.spec.ts` stays in the Firefox and WebKit list although it cannot pass there, because it
**skips itself with a stated reason** and a reported skip is the point: an engine that cannot hold a
passkey should say so rather than have the file silently not exist. A reader counting green ticks
would otherwise conclude the coverage was three times what it is.

| Check                                          | Why an engine is the subject                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **An injected inline script does not run**     | `portal-ui.test.ts` can only assert the header was sent. Chromium, Gecko and WebKit each decide separately whether to enforce it                     |
| **A script from another origin does not load** | What makes "no CDN" a rule rather than a preference                                                                                                  |
| **The no-WebAuthn fallback**                   | Every ceremony in `portal.js` sits behind a capability check, and the Chromium specs all attach an authenticator - so the guard had never been false |

Allowing `'unsafe-inline'` on the page policy fails the injection test in **all three** engines
independently, which is what says the test is real rather than vacuous.

### Two things only CI found

**Firefox resolved `localhost` to `::1`.** The harness bound to `127.0.0.1`, which satisfied
Playwright's own readiness check - Node's fetch picked IPv4 - and then every Firefox navigation hung
until the test timed out. It now listens on both stacks.

### Firefox hanging on `localhost`, and four attempts at it

About **one Firefox navigation in five** hung in CI until the test timed out - on no particular test,
while the ones on either side answered in under a second. Chromium and WebKit never did it. It took
four CI rounds, and the first three guesses were wrong:

| Attempt                                                  | Result                                                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listen on **both stacks** rather than `127.0.0.1`        | Did not fix it. Kept anyway - Playwright's readiness check resolved IPv4 while a browser may not, and the harness should answer on whichever `localhost` means                                             |
| Navigate on **`domcontentloaded`** rather than `load`    | Did not fix it. Kept anyway - `load` waits for every subresource, so it makes a navigation depend on a stylesheet finishing rather than on the page being usable, and every spec waits on its own elements |
| **`network.dns.disableIPv6`** on Firefox                 | Did not fix it. **Kept only because it is harmless, and it is honestly the weakest of the four**                                                                                                           |
| **`network.proxy.allow_hijacking_localhost`** on Firefox | Fixed it                                                                                                                                                                                                   |

**Playwright drives Firefox through an internal proxy, and `localhost` bypasses a proxy by default**,
so a navigation to it took a different path from every other request the harness serves. That is the
documented knob for exactly this.

The harness cannot simply be addressed by IP instead: **a WebAuthn relying party is a domain, never
an address**, so the RP ID has to stay `localhost`.

**Evidence, stated plainly:** two consecutive green CI runs of the browser job after the fix. Against
a roughly one-in-five per-navigation failure that is meaningful rather than conclusive - if it
returns, this table is where to start, and the fourth row is the one that mattered.

**A passwordless sign-in with two resident credentials is ambiguous.** One spec registered a second
key, copied from the test below it that genuinely needs two. A passwordless ceremony sends no
`allowCredentials` at all, so the authenticator is left to choose between them; that passed locally
and timed out on a slower runner. The test needs exactly one key, so it has one.

**It is also the only job that runs against BUILT packages.** The vitest suites alias `@bwc/*` to
`src` deliberately - dist would test stale code - so nothing else notices a package that compiles in
isolation and cannot be imported. The harness resolves them the way a deployment does, which is how
the first CI run of this job failed: `@bwc/tenancy` had no `dist`, and every local run had one lying
around from an earlier build.

---

## Tested

13 specs. `pnpm test:e2e` runs **21 and reports 6 explicit skips** - Chromium 13, Firefox 7,
WebKit 7. It was 33 runs when all three engines ran everything; the twelve dropped were page specs
that had never failed outside Chromium.

**The saving is in execution, not in setup.** CI still installs all three browsers, because Firefox
and WebKit still run the file written for them - and the install is the larger share of that job's
time. The vitest suite is unchanged at **1112** — the two
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

Visual regression. A test for the document download path, which needs a
scanned document in the Vault and is covered server-side by `client-vault-access.test.ts`.
