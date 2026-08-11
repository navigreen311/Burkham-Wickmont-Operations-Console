# The internal Console: staff sign-in and the page

App: `apps/api` · Packages: `@bwc/identity`, `@bwc/clients`, `@bwc/http` · Schema: `identity`
(2 tables) · ADR: [0032](adr/0032-a-console-is-what-makes-a-missing-credential-exploitable.md)

The staff-facing surface, and the credential it could not honestly ship without.

---

## The finding this slice starts from

The internal API has taken the acting staff member from an `x-actor-id` header since the walking
skeleton. Its own comment called that _"a development seam, not authentication"_, and ADR-0022 said
fixing it was _"necessary anyway"_.

> An `Actor` row carries a tenant, an Authority Level and a department. It carries **nothing a
> person has to know or hold.** Anybody who could reach the port was any actor they cared to name.

That was survivable while the callers were a test suite, a worker and a developer with `curl`.

**A page is what makes it exploitable** — not because the header got weaker, but because a console
is discoverable, bookmarkable and left open on a laptop, and because the reach is total: a client
session opens one file, a staff session opens every file in the firm plus the Firewall trigger, the
compliance transition and the placement path.

So the UI and the credential are one slice. The ordering **is** the decision.

---

## What a staff credential is

|                       |                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Bound to**          | the existing `Actor` — no `StaffUser`. The Ledger already names an actor in every event                                           |
| **Factors**           | a password **and** a TOTP code, in one request                                                                                    |
| **Second factor**     | a **precondition**, not a setting. `enrolledAt` is null until a code verifies, and an unenrolled credential cannot sign in at all |
| **Who may hold one**  | a **human** Actor. A Village agent is refused — it acts through the worker, which holds no session                                |
| **Who may grant one** | a Level 3 human, who issues an **invitation** and never sees the password or the secret (ADR-0036)                                |
| **Session**           | 8 hours absolute, 15 minutes idle                                                                                                 |
| **Absence**           | an Actor with no credential row cannot sign in. Absence is not permission                                                         |
| **Invitation**        | single-use, 24 hours, spendable only to SET a credential — never to use one                                                       |

**A client may decide how much friction their own file is worth (ADR-0028); a staff member may
not.** The reason is blast radius rather than seniority, and it is why there is no route that turns
the second factor off.

The shorter windows are the same argument. Eight hours covers a working day; fifteen minutes bounds
an unlocked screen in an office, which is how an internal console is actually used by somebody it
was not issued to.

---

## The seam, kept on purpose and kept visible

`CONSOLE_DEV_ACTOR_HEADER` defaults to **false**, and with it false there is **no code path from a
header to an Actor**.

It survives because the worker, the integration tests and a developer with `curl` use it, and
deleting it in the same slice that adds sign-in would change two things at once. It survives as a
choice a deployment has to make:

```
CONSOLE_DEV_ACTOR_HEADER=true   with   NODE_ENV=production   →   the process refuses to start
```

A throw rather than a warning. A warning is a line in a log nobody reads, and the thing it would be
warning about is authentication being optional.

---

## Configuration with no defaults

The same trade the portal made: a default here is a security decision made by whoever wrote the
default rather than by whoever deployed it.

| Variable                   | Required | Why it has no default                                                                                                                  |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `CONSOLE_TENANT_ID`        | **yes**  | Deployment configuration, never a request value                                                                                        |
| `CONSOLE_COOKIE_SECURE`    | **yes**  | On breaks local development; off ships a session cookie over plaintext                                                                 |
| `CONSOLE_TRUST_PROXY`      | **yes**  | `false` or a hop count. `true` is **refused** — it trusts a header the client writes, and per-IP limiting stops counting anything real |
| `CONSOLE_RATE_LIMIT_STORE` | **yes**  | `memory` counts per process; three replicas would give an attacker three times the limit, invisibly                                    |
| `CONSOLE_DEV_ACTOR_HEADER` | no       | **Off unless set**, and refused in production                                                                                          |

---

## What the page shows

Four views, no framework, no build step, nothing inline — the portal's rules, because they were
right there.

- **Today** — the health picture whole, the signed-in operator's queue, and open correction
  obligations with the overdue ones marked.
- **Clients** — a searchable page with the **total beside it**, because a list showing the first
  twenty-five of four hundred otherwise reads as the whole book.
- **One client file** — compliance state and open findings, the Firewall, the risk timeline, and a
  **Do Not Fund banner above everything else**: a listing is not a status among others.

Two rules the page follows that are easy to break:

**Nothing is rendered as a colour alone.** Health states and compliance states are written out as
words. `unmonitored` is a state and it is not green (ADR-0019) — the default rendering of "no data"
is a green tick, and the person reading this is deciding whether to go home.

**Every value reaches the page through `textContent`.** A client's legal name, a refusal reason and
a risk-event meaning are all strings somebody else wrote.

---

## What it does not do

**Writes are built** — see [`m11-console-writes.md`](m11-console-writes.md). Compliance transitions,
the Firewall trigger, consent and opening a file all have buttons now, and every one of them goes
through the middleware chain, which none of them did before (ADR-0033). Placement has one too, and
adding it turned up two inputs the route had never asked for (ADR-0035).

**Enrolment is built** — see
[ADR-0036](adr/0036-the-granter-must-not-hold-the-credential.md). A Level 3 human invites; the
**subject** sets their own password and receives their own authenticator secret, so the granter
holds neither. The very first credential is still a bootstrap step, because inviting needs a Level 3
human who is already an Actor.

**No WebAuthn for staff.** Better than TOTP, because it is phishing-resistant and TOTP is not
(ADR-0028) — deferred because it needs a relying-party origin the internal deployment has not been
given, and because a staff account with no fallback is a lockout with a firm behind it.

---

## Tests

|                                               |                                                  |
| --------------------------------------------- | ------------------------------------------------ |
| `tests/invariants/staff-identity.test.ts`     | 16 — what it takes to get a session              |
| `tests/integration/console-transport.test.ts` | 41 — what a session is worth, over a real socket |
| `tests/e2e/console.spec.ts`                   | 10 — the page, in a browser                      |

The transport file's guarded-route list is **data**, so a route added without a guard fails there
rather than passing silently.

Three mutations, each killing exactly the test that names the rule:

| Mutation                                  | Result                                                           |
| ----------------------------------------- | ---------------------------------------------------------------- |
| The development header is always accepted | `refuses a header naming a real Level 3 actor` fails             |
| A pending enrolment may sign in           | `refuses a pending enrolment even with the right password` fails |
| A spent code may be presented again       | `refuses the step it already accepted` fails                     |

**The e2e harness seeds one Console account per spec that signs in.** Not tidiness: a spent code
cannot be presented twice, so one authenticator cannot sign in twice inside thirty seconds — which
is the guard working, and exactly what a suite of fast specs would otherwise trip over. The same
shape as `E2E_MUTABLE_ACCOUNTS`, arrived at from a different direction.
