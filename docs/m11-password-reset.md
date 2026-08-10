# Password reset for client users

Module: 11.1 Identity & Access (for 11.10) · Package: `@bwc/identity` · Schema: `identity` ·
ADR: [0023](adr/0023-a-reset-link-is-a-credential-in-transit.md)

The first of the three gaps #27 named before the portal faces the internet.

---

## Why this endpoint is the dangerous one

Every other write path in the Console begins with somebody proving who they are. This one begins
with an anonymous person typing an email address into a form, and what it produces is a credential.

Three properties hold it together, and two of them are about what reset must **not** do.

---

## A reset link is a credential in transit, so 4.1 is not the path

`send` writes the message body into `Communication.body` — a table staff read, and one 7.1 assembles
into the compliance evidence file. It also runs the middleware chain (recovery gated on a regulatory
activation), the preference gate (**a client who opted out of email could never recover their
account**) and the compliance scanner (which exists for marketing claims).

Right for a communication. Wrong for account recovery.

`deliverPasswordResetLink` takes the token, **persists nothing, logs nothing, returns nothing**, and
reports `not_built` naming the email provider. Named for the one thing it carries, so a newsletter
cannot be routed through it later and skip 4.1's gate.

## Requesting a reset changes nothing about the account

| Property                                             | Why                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The current password keeps working                   | Otherwise anybody who knows a client's email address ends their access by typing it into a form                                                                                                                        |
| **`lockedUntil` and `failedAttempts` are untouched** | Clearing the lock reads as kindness and **is a lockout bypass** — an attacker who has burned five guesses resets the counter and keeps going. It clears on **completion**, where the caller proved they hold the token |
| Every address gets the same answer                   | Enrolled, unenrolled, disabled, locked, or not a user at all. Otherwise the endpoint is a list of who banks with this firm                                                                                             |

The residual timing difference between a known and an unknown address is one row insert. Stated in
the code rather than papered over.

## Completing a reset ends every session

Including the one held by whoever the client is resetting against. A reset that left sessions
running would leave the attacker with a valid cookie for twelve hours **while the client believed
they had shut them out** — worse than not offering the reset, because the client stops looking.

---

## The two routes

|                   | Self-service                                  | Staff-issued                      |
| ----------------- | --------------------------------------------- | --------------------------------- |
| Function          | `requestPasswordReset`                        | `issuePasswordReset`              |
| Who               | Anonymous                                     | Level 3 human                     |
| Needs             | An email address                              | A **recorded verification basis** |
| `issuedBy`        | `null` — automatic in, human out (6.4's rule) | The human                         |
| Returns the token | **Never**                                     | Once, to the issuer               |
| Works today       | No — nothing delivers it                      | Yes                               |

The staff route requires a verification basis because **the attack on helpdesk password reset is
social engineering, not cryptography**. It goes to the Ledger as well as the row.

**It does not expand what Level 3 can already do** — the same person can invite a client user at an
address they control onto any client's file. It makes an existing power auditable.

## Rules

- **Sixty minutes**, against the invitation's seventy-two hours. An invitation sits in an inbox; a
  reset is used within minutes, and every extra hour is an hour a forwarded email stays live.
- **One live reset at a time.** Issuing supersedes any outstanding one; completing supersedes the
  rest.
- **Single use.** Consumed, superseded, expired and never-real answer identically.
- **The same password cannot be set back.** Setting it back accomplishes nothing while looking like
  it accomplished something.
- **Completion re-checks standing** — a user disabled while the email sat in an inbox cannot
  complete.
- An **unenrolled** user cannot reset. Enrolment is what the invitation is for, and a reset here
  would bypass the invitation window.

## Transport

| Route                                  | Notes                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| `POST /portal/password-reset`          | `{ email }`. Rate limited on **its own counter**            |
| `POST /portal/password-reset/complete` | `{ token, password }` in the **body**, never a query string |

The reset limiter is separate from sign-in's and tighter (5 per 15 minutes, `PORTAL_RESET_*`).
Sharing one bucket would mean an attacker spraying resets from one address locks legitimate clients
out of signing in — a denial of service assembled from two individually correct controls.

The token travels in a URL exactly once, in the link the delivery seam would build, because email
leaves no alternative. It comes back in a body, so it does not reach this server's access logs.

---

## Tested

20 tests in `tests/integration/client-password-reset.test.ts`, 4 more over HTTP in
`portal-transport.test.ts`. Suite total **959**.

| Mutation                                        | Failures |
| ----------------------------------------------- | -------- |
| Clear the lockout on request                    | 1        |
| Leave sessions alive through a reset            | 2        |
| Tell an unknown address it is unknown           | 2        |
| Accept a staff reset with no verification basis | 1        |

## Not built

**MFA** — the next gap, and a larger one. **Change-password for a signed-in client**, which needs
the current password rather than a token. **Notifying a client that their password changed**, which
needs the delivery seam this slice proves is missing.
