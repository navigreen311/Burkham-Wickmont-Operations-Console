# ADR-0031 — The API serves the page, and the policy relaxes only for the page

**Status:** Accepted · **Date:** 2026-08-20 · **Modules:** 11.10 Client Portal

## Context

`CLAUDE.md` and every status note since PR #1 have said the same thing: _"Never built by design: the
UI for any surface."_ The reason held — a UI written against a half-built API is a UI rewritten
twice.

**It is being set aside on the owner's instruction**, and this ADR records that rather than letting a
future reader conclude the rule was forgotten.

The identity arc from #25 to #35 is the strongest case for lifting it. **WebAuthn cannot be exercised
at all without a browser**: `navigator.credentials` is the only thing that produces an assertion, so
five slices of server-side work are, today, unreachable by any client this repository contains.

## Decision 1 — this process serves the page, because the cookie decided it

The session cookie is `httpOnly`, `Secure` and **`SameSite=Strict`**. Under `Strict`, a page on
another origin sends no cookie at all with a cross-site request — that is the CSRF control ADR-0022
chose deliberately, and it is the whole of the CSRF story.

A separately hosted UI would therefore have to weaken `SameSite`. **The protection would be paid for
by the feature that made it necessary.**

So `apps/portal-api` serves the page, and the constraint is satisfied by construction rather than by
a configuration somebody has to keep right.

## Decision 2 — nothing inline, so the policy barely moves

ADR-0022 set `default-src 'none'` and gave a reason: nothing here served a document, so the strictest
policy cost nothing. Serving one changes that, and the question worth answering is _by how much_.

**`script-src 'self'` and `style-src 'self'`, with nothing inline.** No `<script>` bodies, no `style=`
attributes, no `'unsafe-inline'` — and **no nonce**, which is the interesting half. A nonce is a
mechanism that has to be produced, threaded and matched on every response; having no inline code at
all is a mechanism that cannot be got wrong.

`default-src 'none'` stays, so an image, a font or a fetch to any other host is still refused.
`form-action 'none'` is added because every submission goes through `fetch` — a form that posted
anywhere would be a form nobody wrote.

**The relaxation applies to the document and not to the API.** A JSON route still serves no document,
so `/portal/*` keeps the strict policy, and a test asserts the two headers differ in exactly that
way. A policy that leaked would be one nobody noticed until it mattered.

## Decision 3 — no framework, no build step

Plain ES modules, served as files. No bundler, no dependency, no build output anybody has to remember
to regenerate — and no supply chain in front of the page that holds a session.

The cost is real and worth naming: there is no component model, no type checking on the browser side,
and the DOM code is written by hand. That is affordable because **the DOM layer holds nothing worth
testing**. Everything that decides anything is on the server; everything that can be subtly wrong is
in `encoding.js`, which has no DOM and is unit-tested against payloads a real software authenticator
produced.

## What this found

**`default-src 'none'` was not the strictest policy, and had not been since ADR-0022.** Helmet merges
its defaults _underneath_ whatever directives are named, so the header this API has been sending all
along also carried `script-src 'self'`, `style-src 'self' https: 'unsafe-inline'`,
`img-src 'self' data:` and `form-action 'self'`.

On a route that renders no document that is harmless, and it is **not what the ADR said**. Both
policies now set `useDefaults: false`, so the header in force is the header in the source.

Found by writing a test that asserted the API policy contained no `script-src` and watching it fail.

## Consequences

**Nothing is ever assigned to a markup-writing property.** Every value reaching the page goes through
`textContent`, and a structural test asserts the alternatives appear nowhere in the directory —
including in comments, which is why the comment describing the rule does not name them.

**Three views in one document**, switched by a `hidden` attribute. No router, no history API, no
deep links. A portal with three screens does not need a routing library, and the one it would need is
the one that would arrive with a bundler.

**A test reads the page's own API module and checks every route it names exists.** A page written
against an endpoint that was renamed fails in a browser and passes every server test — this is the
only cheap defence against that, and it is worth more here than anywhere else in the repository
because nothing else in CI opens a browser.

**No browser test infrastructure.** Playwright would test the DOM layer, which is the layer with the
least in it, at the cost of a large dependency and a slower CI. The transforms are tested; the wiring
is read.

## Alternatives considered

**A separate static host or CDN.** Decision 1 — it costs the `SameSite=Strict` cookie.

**A nonce, so inline scripts stay possible.** Decision 2. A nonce is correct and it is a thing to
keep correct; nothing inline is a thing that cannot break.

**React, or any framework.** A build step, a dependency tree, and a compiled artifact in front of the
session cookie, in exchange for a component model this page has no use for.

**Playwright end-to-end tests.** Named above. Worth revisiting when the page grows past three views.
