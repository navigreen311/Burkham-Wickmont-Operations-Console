# Plan — the Client Portal transport layer

**Branch:** `ai-feature/portal-transport` · **Follows:** client vault access (merged, `d76343a`)

The last thing standing between 11.10 and being exposed: nothing serves it over HTTP.

---

## Mini-PRD

### Problem

`@bwc/portal` is a library. `signIn`, `principalFromToken`, `clientRoom`, `uploadDocument`,
`downloadDocument`, `signDisclosure` and `sendMessage` are functions nobody can call from a browser.

`apps/api` exists and is the wrong place to put them — see the key decision.

### Success metrics

- A client signs in over HTTP, receives a session cookie, and drives the whole portal with it.
- **No route in the portal app can reach an internal capability**, structurally.
- Sign-in is rate limited per IP, and the limit is not defeated by a proxy.
- The app **refuses to start** on configuration where guessing would be unsafe.

### Risks

| Risk                                       | Mitigation                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **A client reaching internal routes**      | A separate app that cannot import them — see the key decision                                           |
| **Password spraying that lockout misses**  | Per-IP rate limiting on the unauthenticated path, which is a different control from per-account lockout |
| A proxy making per-IP limiting meaningless | `trust proxy` must be configured explicitly; the app refuses to start otherwise                         |
| A session token readable by script         | `httpOnly`, `Secure`, `SameSite=Strict`                                                                 |
| An unbounded upload                        | Byte limits enforced before authentication                                                              |
| A client choosing which tenant to be       | The tenant is deployment configuration, never a request value                                           |

---

## Key decision — the portal is a separate app, because `apps/api` trusts a header

`apps/api` resolves the acting staff member from an `x-actor-id` request header. Its own comment
says so: _"a development seam, not authentication"_.

**A public surface in that process is a public surface with that header.** A client who could reach
any internal route would send `x-actor-id: <any Level 3 actor id>` and act as staff — approve their
own Do Not Fund override, activate a state, invite a client user to somebody else's file. Not a
hypothetical: it is what that header does today.

So the portal is its **own app**, its own process, its own port, its own middleware stack. It
imports `@bwc/portal` and `@bwc/identity` and nothing that serves internal capability. The isolation
is structural rather than a routing rule somebody has to keep right.

The two also want opposite defaults. Internal is a trusted network with a permissive body limit and
no rate limiting; the portal is the public internet, where both are inverted.

## Key decision — rate limiting is not lockout, and neither substitutes for the other

PR #25 added per-account lockout: five consecutive failures locks that account for fifteen minutes.

**It does nothing against password spraying.** An attacker with a list of ten thousand client emails
tries `Summer2026!` against each one, once. No account reaches two failures, so lockout never fires
— and one weak password anywhere in the list is a session.

Per-IP rate limiting on the unauthenticated path is what catches that, because it counts the
attacker rather than the victim. Both controls are needed and they count different things.

## Key decision — refuse to start rather than guess

Two settings are silently catastrophic when wrong, so neither has a default:

**`trust proxy`.** Unset behind a load balancer, every request appears to come from the balancer and
per-IP limiting collapses into one global bucket. Set to `true` in front of one, a client spoofs
`X-Forwarded-For` and evades limiting entirely. Both failures are invisible from inside the process.

**Cookie `Secure`.** Defaulting it on breaks local development in a way that invites somebody to
turn it off in a shared config; defaulting it off ships a session cookie over plaintext.

Both are read from the environment and the app **throws at construction** if they are absent. TLS
itself is terminated upstream — an app that also terminated TLS would be one more thing to get
wrong on a box that already has a proxy in front of it.

---

## Architecture

```
apps/portal-api/
  config.ts    environment, validated at construction; no unsafe defaults
  limiter.ts   fixed-window per-IP limiting, with its own limitation stated
  app.ts       the routes, and the session cookie
  server.ts    listen
```

Reuses `apps/api`'s `serialize.ts` mapping (`Outcome` → 200/409/501/404/500) rather than a second
copy — the distinction between `not_built` and `no_data` survives only if the transport keeps it,
and two mappings is how one of them stops.

No schema.

## Test strategy

- Sign in over HTTP, drive `room`, upload, download, sign and message with the cookie alone.
- The cookie is `HttpOnly`, `Secure`, `SameSite=Strict`.
- No route responds without a session; every unauthenticated call answers identically.
- Rate limiting refuses the eleventh sign-in attempt from one IP, and the window clears.
- **The rate limit fires on spraying that lockout misses** — ten emails, one attempt each.
- The app refuses to construct without `trust proxy` and cookie `Secure` set.
- An oversized upload is refused before authentication runs.
- The portal app exposes no internal route: asserted against the internal app's own paths.

## Out of scope

TLS termination, which belongs to the proxy. A UI. Password reset. **A shared rate-limit store** —
the limiter is per-process, so a multi-instance deployment gets N times the limit; that is stated in
the code rather than hidden, and the fix is a Redis-backed store when there is more than one
instance.
