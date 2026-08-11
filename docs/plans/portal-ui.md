# Plan — a browser UI for the Client Portal

**Branch:** `ai-feature/portal-ui` · **Follows:** passwordless accounts (merged, `4aa661e`)

**This is a deliberate departure from a standing decision.** `CLAUDE.md` and every status note have
said the same thing since PR #1: _"Never built by design: the UI for any surface."_ The reason held —
a UI written against a half-built API is a UI rewritten twice. It is being set aside on the owner's
instruction, and the note is here so nobody later reads this directory and concludes the rule was
forgotten.

The identity arc from #25 to #35 is also the strongest possible case for lifting it: **WebAuthn
cannot be used at all without a browser.** `navigator.credentials` is the only thing that can produce
an assertion, so five slices of server-side work are, today, unreachable.

---

## Mini-PRD

### Problem

`apps/portal-api` serves JSON and bytes. Nothing renders it, and three of its capabilities —
registering a passkey, signing in with one, confirming a change with one — **cannot be exercised by
any client that is not a browser.**

### Scope

The identity surface and the client room. Not the internal Console, which has its own missing UI and
a different reader.

### Success metrics

- A client signs in — password, password + code, password + key, or passkey alone — from a page.
- A client registers a passkey and turns their password off, from a page.
- **The page adds no dependency and no build step.**
- The CSP is relaxed exactly as far as serving a document requires and no further.

### Risks

| Risk                                                  | Mitigation                                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **A framework and a build step arriving with the UI** | Plain ES modules, served as files. No bundler, no dependency                              |
| **`default-src 'none'` relaxed too far**              | `script-src 'self'`, `style-src 'self'`, nothing inline — see key decision 2              |
| An XSS in a page that holds a session                 | Nothing is ever assigned to `innerHTML`, and a test asserts the source contains none      |
| The session cookie not reaching the API               | The page is served by the same process, so `SameSite=Strict` is satisfied by construction |
| Untestable browser code                               | The transforms are a pure module with no DOM, unit-tested; the DOM layer stays thin       |

---

## Key decision 1 — the API serves the page, because the cookie says so

The session cookie is `httpOnly`, `Secure` and **`SameSite=Strict`**. A page on another origin sends
no cookie at all with a cross-site request — that is the CSRF control ADR-0022 chose deliberately.

So a separately hosted UI would have to weaken `SameSite`, and the CSRF protection would be paid for
by the feature that made it necessary. **`apps/portal-api` serves the page**, and the cookie
constraint is satisfied by construction rather than by configuration.

## Key decision 2 — nothing inline, so the CSP barely moves

ADR-0022 set `default-src 'none'` and said why: nothing here served a document, so the strictest
policy cost nothing. Serving one changes that, and the interesting question is by how much.

**`script-src 'self'` and `style-src 'self'`, and nothing inline.** No `<script>` bodies, no `style=`
attributes, no `'unsafe-inline'`, no nonce — a nonce is a mechanism to keep correct on every
response, and having no inline code at all is a mechanism that cannot be got wrong.

`default-src 'none'` stays, so an image, a font or a fetch to anywhere else is still refused. `form-
action 'none'` is added: every submission goes through `fetch`, so a form that posted anywhere is a
form nobody wrote.

## Key decision 3 — the transforms are a module, the DOM is a layer

WebAuthn options arrive as base64url strings and must become `ArrayBuffer`s; the response must go
back the other way. **That conversion is where a browser integration is actually wrong or right**, and
it needs no DOM.

So it lives in `encoding.js` — pure, exported, imported by both the page and the test — and is checked
against a real ceremony payload. The DOM layer holds no logic worth testing and is short enough to
read in one sitting.

---

## Architecture

```
apps/portal-api/public/
  index.html      three views, one document
  portal.css      no framework
  encoding.js     base64url <-> ArrayBuffer, and the two ceremony transforms   [tested]
  api.js          fetch wrappers, one per route
  portal.js       the DOM
```

Served by `express.static` under the relaxed policy; every `/portal/*` API route keeps the strict one.

## Test strategy

- The transforms, against a real registration and a real assertion payload.
- The page is served, with the right content type and the relaxed-but-still-strict CSP.
- **The API routes keep `default-src 'none'`** — asserted, because the relaxation must not leak.
- The source contains no `innerHTML` and no inline `<script>`.
- Every route the page calls exists — asserted by reading the page and checking each against the app.

## Out of scope

The internal Console's UI. A design system. Client-side routing beyond three views. Anything
requiring a build step.
