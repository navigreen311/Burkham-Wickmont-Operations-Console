# ADR-0022 — The Client Portal is a separate process, and rate limiting is not lockout

**Status:** Accepted · **Date:** 2026-08-11 · **Modules:** 11.10 Client Portal, 11.1 Identity & Access

## Context

`@bwc/portal` was a library nobody could call from a browser. Serving it needs HTTP, and `apps/api`
already exists — an Express 5 app on port 4100 wired to the internal modules.

Adding portal routes to it is the small change.

## Decision 1 — a separate app, because `apps/api` trusts a header

`apps/api` resolves the acting staff member from an `x-actor-id` request header. Its own comment
says what that is: _"a development seam, not authentication"_.

**A public surface in that process is a public surface with that header.** A client who could reach
any internal route would send `x-actor-id: <any Level 3 actor id>` and act as staff — approve their
own Do Not Fund override, activate a state, invite a client user onto somebody else's file. That is
not a hypothetical risk; it is what the header does today.

The obvious reply is "so fix the header first". That would be right and it would not be enough: the
next time somebody adds an internal route to a shared app, the question of whether it is reachable
from the public internet is a routing question, and routing questions are answered wrongly for
years without anybody noticing.

So `apps/portal-api` is its own process, port and middleware stack. It imports `@bwc/portal`,
`@bwc/identity` and `@bwc/vault`, and nothing that serves internal capability. **The isolation is
structural: there is no route to get wrong, because the code is not in the process.**

The two also want opposite defaults. Internal is a trusted network — permissive bodies, no rate
limiting, causes in error responses because the reader is a colleague. The portal is the public
internet, where all three invert.

`serialize.ts` moved to `@bwc/http` rather than being copied. The `not_built` → 501 contract is
architectural (ADR-0002), and two serialisers is how one of them stops honouring it.

## Decision 2 — rate limiting is not lockout, and neither substitutes for the other

11.1 locks an account after five consecutive failures. That protects **the account**.

**It does nothing against password spraying.** An attacker with ten thousand client email addresses
tries `Summer2026!` against each one, once. No account reaches two failures, so lockout never
fires — and one weak password anywhere in that list is a session.

Per-IP rate limiting on the unauthenticated path counts **the attacker** rather than the victim,
which is why it catches the case lockout cannot. Both exist and they count different things. The
test for this sprays ten addresses with one attempt each, precisely because lockout would sleep
through it.

The limiter runs **before the body is parsed**. One that parsed first would be doing the attacker's
work for them.

**Its limitation is stated in its own header:** the window lives in process memory, so two instances
means twice the limit and a restart clears every counter. That is honest for a single-instance
deployment and wrong behind a load balancer with replicas, where it needs a shared store. Written
in memory rather than reaching for a dependency, because a limiter backed by a store this system
does not yet run is a limiter nobody has tested.

## Decision 3 — refuse to start rather than guess

Two settings are silently catastrophic when wrong, so neither has a default and the app throws at
construction without them.

**`PORTAL_TRUST_PROXY`.** Unset behind a load balancer, every request appears to come from the
balancer and per-IP limiting collapses into one global bucket. `true` in front of one, and Express
takes the leftmost `X-Forwarded-For` entry — which the client writes — so an attacker rotates the
header and evades limiting entirely. **`true` is refused outright**; the accepted values are `false`
or a hop count.

**`PORTAL_COOKIE_SECURE`.** Defaulting it on breaks local development in a way that invites somebody
to turn it off in a shared config; defaulting it off ships a session cookie over plaintext.

**`PORTAL_TENANT_ID`** is required for a different reason: the tenant is deployment configuration
and never a request value. A header or subdomain naming the tenant is a value the client chooses,
and a client who chooses their tenant is a client enumerating tenants.

## Consequences

**Two processes to deploy and only one goes near a public load balancer.** That is the operational
cost and it is the point.

**The session travels as an `httpOnly`, `Secure`, `SameSite=Strict` cookie**, never in the body,
never in a URL. `httpOnly` means an XSS in a future portal UI cannot exfiltrate it; `SameSite=Strict`
is the CSRF control, because a cross-site request carries no cookie at all. The token is
deliberately absent from the sign-in response body — returning it would hand script the thing
`httpOnly` exists to keep from script.

**Errors carry no cause.** The internal app includes one because its callers are staff. Here a stack
trace or a database message is reconnaissance, so the cause goes to stderr and the client gets one
sentence.

**Uploads are raw bytes with metadata in the query string.** Multipart needs a parser dependency;
base64 inflates a document by a third for no gain.

**TLS is terminated upstream.** An app that also terminated TLS would be one more thing to get wrong
on a box that already has a proxy in front of it — and `PORTAL_TRUST_PROXY` exists because there is
one.

## Alternatives considered

**Portal routes in `apps/api`, behind a path prefix and a guard.** Rejected — see Decision 1. The
guard is a routing rule, and the header it would have to defend against is still in the process.

**Fix `x-actor-id` first and share the app.** Necessary anyway, and still not sufficient. Two trust
boundaries in one process is the durable problem; the header is today's instance of it.

**`express-rate-limit`.** Reasonable, and it would still be in-memory by default with the same
limitation. The forty lines here are testable against a controllable clock and carry their own
caveat.

**Bearer token in an `Authorization` header.** Correct for a machine client and wrong for a browser:
script must hold the token to send it, which is exactly what `httpOnly` prevents.
