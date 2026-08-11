# The Client Portal transport layer

App: `apps/portal-api` · Package: `@bwc/http` · **No schema** · ADR: [0022](adr/0022-the-portal-is-a-separate-process.md)

The last thing standing between 11.10 and being exposed. `@bwc/portal` was a library nobody could
call from a browser.

---

## A separate process, because `apps/api` trusts a header

`apps/api` resolved the acting staff member from an `x-actor-id` request header — its own comment
called that _"a development seam, not authentication"_.

> **Since ADR-0032 that header is off unless a deployment sets `CONSOLE_DEV_ACTOR_HEADER`, and the
> Console has a real staff sign-in.** The separation below is not weakened by that and was never
> only about the header: two surfaces with different audiences and different reach belong in two
> processes, and the isolation is structural rather than a rule somebody has to keep.

> **A public surface in that process is a public surface with that header.** A client reaching any
> internal route would send `x-actor-id: <any Level 3 actor id>` and act as staff: approve their own
> Do Not Fund override, activate a state, invite a client user onto somebody else's file.

So `apps/portal-api` is its own process, port and middleware stack, importing `@bwc/portal`,
`@bwc/identity` and `@bwc/vault` and nothing that serves internal capability. **The isolation is
structural** — there is no route to get wrong, because the code is not in the process. The test
asks the portal for the internal app's own routes and gets 404, and sends `x-actor-id` to prove it
does nothing.

`serialize.ts` moved to `@bwc/http` rather than being copied: the `not_built` → 501 contract is
architectural, and two serialisers is how one stops honouring it.

---

## Rate limiting is not lockout

11.1 locks an account after five consecutive failures. That protects the **account**.

**It does nothing against password spraying.** Ten thousand addresses, `Summer2026!` against each
one, once — no account reaches two failures, so lockout never fires, and one weak password anywhere
in that list is a session.

Per-IP limiting counts the **attacker** rather than the victim. The test sprays ten addresses with
one attempt each, precisely because lockout would sleep through it.

The limiter runs **before the body is parsed** — one that parsed first would be doing the attacker's
work.

> **Stated limitation:** the window is in process memory, so two instances means twice the limit and
> a restart clears every counter. Honest for one instance, wrong behind replicas, where it needs a
> shared store. Written in memory rather than reaching for a dependency, because a limiter backed
> by a store this system does not run is a limiter nobody has tested.

---

## Configuration refuses to be guessed

| Variable                                          | Required      | Why there is no default                                                                                                                                                                                                        |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORTAL_TRUST_PROXY`                              | **yes**       | Unset behind a balancer, per-IP limiting collapses to one global bucket. **`true` is refused outright** — Express would take the client-written `X-Forwarded-For`, and the attacker rotates it. Accepts `false` or a hop count |
| `PORTAL_COOKIE_SECURE`                            | **yes**       | On breaks local dev in a way that invites turning it off in a shared config; off ships a session cookie over plaintext                                                                                                         |
| `PORTAL_TENANT_ID`                                | **yes**       | The tenant is deployment configuration, never a request value. A client who chooses their tenant is a client enumerating tenants                                                                                               |
| `PORTAL_PORT`                                     | no (4200)     |                                                                                                                                                                                                                                |
| `PORTAL_MAX_JSON_BYTES`                           | no (64 KiB)   |                                                                                                                                                                                                                                |
| `PORTAL_MAX_UPLOAD_BYTES`                         | no (25 MiB)   |                                                                                                                                                                                                                                |
| `PORTAL_SIGN_IN_WINDOW_SECONDS` / `_MAX_ATTEMPTS` | no (300 / 10) | Transport constants, not 11.7 parameters — the limit runs before the request is associated with a tenant                                                                                                                       |

**No secret is read by the transport.** There is no session secret: sessions are opaque random
tokens stored hashed, so there is nothing to sign. `DATABASE_URL`, `LEDGER_SIGNING_KEY` and
`VAULT_KEK` are read by the packages that own them, from the environment in development and from a
managed secret store in production — `VAULT_KEK` being the one §6.2 wants moved to an HSM. None is
printed.

---

## The session cookie

`httpOnly`, `Secure`, `SameSite=Strict`, and **never in the body or a URL**.

- `httpOnly` — an XSS in a future portal UI cannot exfiltrate it.
- `SameSite=Strict` — the CSRF control: a cross-site request carries no cookie at all.
- Absent from the sign-in response — returning it would hand script the thing `httpOnly` exists to
  keep from script.
- Not accepted from a query string: a token in a URL lands in access logs, browser history and
  `Referer`.

Every authenticated route resolves it through `principalFromToken`, which re-checks both session
expiries **and the user's standing** — so a disabled account stops working on the next request.

---

## Routes

| Route                                           | Notes                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /portal/health`                            | Unauthenticated, deliberately empty. A health endpoint naming degraded components is unauthenticated reconnaissance; 11.8 has that, behind the internal app |
| `POST /portal/sign-in`                          | Rate limited. Malformed input gets the **same sentence** as a wrong password                                                                                |
| `POST /portal/sign-out`                         | Signing out without a session is not an error worth reporting to somebody already signed out                                                                |
| `GET /portal/room`                              |                                                                                                                                                             |
| `GET /portal/documents/:id?action=view\|export` | `Content-Disposition: attachment` for **both** — a PDF rendered inline is one the browser may cache to disk                                                 |
| `POST /portal/documents?kind=&filename=`        | Raw bytes. Multipart needs a parser dependency; base64 inflates a document by a third                                                                       |
| `POST /portal/disclosures`                      |                                                                                                                                                             |
| `POST /portal/messages`                         | Inbound only. There is no outbound route, by 11.10's design                                                                                                 |

Anything else is a 404 that does not enumerate what exists. Errors carry **no cause** — the internal
app includes one because its callers are staff; here it is reconnaissance.

---

## Tested

21 tests in `tests/integration/portal-transport.test.ts`, driving a real socket. Suite total **935**.

Mutation-verified:

| Mutation                                      | Failures |
| --------------------------------------------- | -------- |
| Allow `PORTAL_TRUST_PROXY=true`               | 1        |
| Return the session token in the response body | 3        |
| Skip the rate limit                           | 1        |
