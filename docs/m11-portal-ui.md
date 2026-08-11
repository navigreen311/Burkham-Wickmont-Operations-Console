# The Client Portal's browser UI

Module: 11.10 Client Portal · Served by: `apps/portal-api` · **No dependency, no build step** ·
ADR: [0031](adr/0031-the-api-serves-the-page.md)

**A deliberate departure from a standing decision.** Since PR #1 the note has read _"Never built by
design: the UI for any surface."_ It is set aside here on the owner's instruction, and ADR-0031
records that rather than letting a future reader conclude the rule was forgotten.

The case for lifting it now: **WebAuthn cannot be exercised at all without a browser.**
`navigator.credentials` is the only thing that produces an assertion, so five slices of server-side
work were unreachable by any client this repository contained.

---

## The API serves the page, because the cookie decided it

The session cookie is `SameSite=Strict`. A page on another origin sends **no cookie at all** with a
cross-site request — that is the CSRF control, and it is the whole of the CSRF story.

> A separately hosted UI would have to weaken `SameSite`. **The protection would be paid for by the
> feature that made it necessary.**

So this process serves the page, and the constraint is satisfied by construction.

## Nothing inline, so the policy barely moves

| Directive     | API (`/portal/*`) | The page                        |
| ------------- | ----------------- | ------------------------------- |
| `default-src` | `'none'`          | `'none'`                        |
| `script-src`  | —                 | `'self'`                        |
| `style-src`   | —                 | `'self'` (no `'unsafe-inline'`) |
| `connect-src` | —                 | `'self'`                        |
| `form-action` | `'none'`          | `'none'`                        |

**No nonce**, which is the interesting half: a nonce has to be produced, threaded and matched on
every response, and having no inline code at all is a mechanism that cannot be got wrong.

**The relaxation applies to the document, not to the API** — a JSON route still serves no document,
and a test asserts the two headers differ in exactly that way.

## What building this found

> **`default-src 'none'` was not the strictest policy, and had not been since ADR-0022.**

Helmet merges its defaults _underneath_ whatever directives are named, so the header this API has
been sending all along also carried `script-src 'self'`, `style-src 'self' https: 'unsafe-inline'`,
`img-src 'self' data:` and `form-action 'self'`.

Harmless on a route that renders no document, and **not what the ADR said**. Both policies now set
`useDefaults: false`, so the header in force is the header in the source. Found by writing a test
that asserted the API policy contained no `script-src`, and watching it fail.

## No framework, and where the tests are

Plain ES modules served as files. No bundler, no dependency, no build output to regenerate — and no
supply chain in front of the page that holds a session.

```
apps/portal-api/public/
  index.html      three views, one document, switched by `hidden`
  portal.css      no framework
  encoding.js     base64url <-> ArrayBuffer, and the two ceremony transforms   [tested]
  api.js          one function per route
  portal.js       the DOM
```

**`encoding.js` is where a browser integration is actually wrong or right.** The server sends and
expects base64url strings; `navigator.credentials` sends and expects `ArrayBuffer`s, and it does not
complain about a string — it produces a credential for the wrong challenge, or a signature over bytes
nobody asked for. **The failure looks like a working ceremony.** So the transforms are pure, have no
DOM, and are checked against payloads a real software authenticator produced.

The DOM layer holds nothing worth testing: everything that decides anything is on the server.

## The structural checks

- **Nothing is assigned to a markup-writing property.** Every value goes through `textContent`, and a
  test asserts the alternatives appear nowhere in the directory — including in comments, which is why
  the comment describing the rule does not name them.
- **No inline script, no inline style, no `on…=` attribute** in the document.
- **Nothing is loaded from another host** — no CDN, no font service. `default-src 'none'` would refuse
  them anyway; this says nobody tried, which is the difference between a policy and a rule.
- **Every route the page names exists.** A test reads `api.js` and probes each path with both verbs. A
  page written against a renamed endpoint fails in a browser and passes every server test, and
  nothing else in CI opens one.

---

## Tested

9 unit tests in `tests/invariants/portal-ui-encoding.test.ts`, 8 integration tests in
`tests/integration/portal-ui.test.ts`. Suite total **1112**. **No schema change, so no migration.**

| Mutation                                       | Failures |
| ---------------------------------------------- | -------- |
| Serve the page without its own policy          | 1        |
| Let the page's policy apply to the API         | 1        |
| Leave the registration challenge as a string   | 1        |
| Send a null user handle instead of omitting it | 2        |

## Not built

**Browser end-to-end tests.** Playwright would exercise the DOM layer — the layer with the least in
it — at the cost of a large dependency and a slower CI. Worth revisiting when the page grows past
three views.

The internal Console's UI. A design system. Client-side routing. Anything requiring a build step.
