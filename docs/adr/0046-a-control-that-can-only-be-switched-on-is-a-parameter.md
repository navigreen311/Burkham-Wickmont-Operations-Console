# ADR-0046 — A control that can only be switched on is a parameter

**Status:** Accepted · **Date:** 2026-08-11 · **Modules:** 11.1 Identity & Access, 11.7 Admin
Configuration Center, 11.10 Client Portal

## Context

Multi-factor authentication has arrived in this system twice, and the two times reached opposite
answers.

**Staff MFA is mandatory** (ADR-0032). The internal Console is what makes a missing credential
exploitable, so there was never a tenant that should be allowed to be without it, and there is no
setting for it.

**Client MFA is optional** — a client may enrol an authenticator or a security key (ADR-0028), and
if they do not, a correct password issues a session. That was right when the portal had no
enrolment UI and would still be right for a firm that has not told its clients anything. It is
wrong as a permanent answer for a system holding SSNs, EINs, bank statements via Plaid, tax returns
and credit reports.

The gap is not "should clients have MFA". It is that the answer differs by firm and by month, and
neither `true` nor `false` compiled into `@bwc/identity` is the right constant.

### Which makes this ADR-0019's problem

ADR-0019 divides every tunable constant into a **parameter** (a policy choice with a defensible
range, bounded and audited) and an **invariant** (law, or something the architecture depends on),
and its central rule is that **configuration must not be able to turn a control off**. A firm-wide
authentication requirement sounds exactly like the kind of thing that rule exists to keep away from
an admin screen.

## Decision 1 — it is a parameter, because it can only turn a control ON

The reconciliation is a direction, not a category.

ADR-0019's rule bites on settings whose unsafe direction is **loosening**: a quiet-hours window
somebody widens to 24 hours, a minimum cohort somebody lowers to 1, an approval-rate denominator
somebody drops when the denominator is smallest and the temptation highest. In each, a control
exists in code and configuration is a way to weaken it.

This setting has no such direction. **It defaults OFF, and OFF is exactly today's behaviour.** With
it unset the system does what it did before this slice; there is no value of it that removes a
check which exists today. The only thing it can do is add one.

So the test ADR-0019 is really applying is not "does this touch security" but **"can a value of
this take away a protection the system already has?"** For quiet hours the answer is yes and it is
an invariant. Here the answer is no, and it is a parameter — `identity.CLIENT_MFA_REQUIRED`, kind
`flag`, bounds 0–1, compiled default 0.

It is registered **high-risk**, so switching it on is staged and takes a second deliberate act to
promote. ADR-0019 defines high risk as a change that alters what the system does to **clients**
rather than to internal queues, and this is the clearest case of that in the registry: it decides
whether a client can get into their own file.

**Off is the load-bearing part of this decision.** A mandate that arrived with a deployment rather
than with a decision is a lockout nobody chose, and the people it locks out are clients whose only
escalation path is a phone call to us. The default is not timidity; it is the difference between a
firm turning this on after telling its clients and a firm discovering it on a Monday morning.

### `flag` reuses the numeric pipeline

`Parameter` was numeric throughout. Rather than introduce a second value type, `flag` is carried as
0 or 1: bounds of 0–1 with the existing whole-number rule already refuse `2` and `0.5`, and the
audit trail, staging, promotion, rollback and history all keep working unchanged.

A `boolean` column beside `newValue` would have been a second representation of "the value" that
every reader of a change row has to remember to check, for one setting.

## Decision 2 — it is enforced at `issueSession`, and nowhere else

Every route into a client session — a password, an answered MFA challenge, a passkey used as first
factor — passes through `issueSession` in `@bwc/identity`. The check goes there.

**Not on the sign-in path.** `authenticateClientUser` answers "are these the right details", and
every one of its refusals is deliberately the same sentence, because an endpoint that distinguishes
a wrong password from an unknown address is an oracle telling an attacker which addresses are
clients of this firm. A mandate refusal there would be a different sentence returned on a **correct**
password, and would undo that. At `issueSession` the caller has already proved the credential, so
the refusal discloses nothing they did not already hold.

**Not an argument the caller passes.** ADR-0033 settled this shape: an option is a thing a caller
can pass, and the first caller who wants it out of the way will pass it. `issueSession` reads the
policy itself.

**A passkey is an active factor.** WebAuthn credentials are `clientMfaFactor` rows, so a
passwordless account (ADR-0030) already holds what the mandate asks for and is unaffected. That is
the correct answer rather than a convenient one: ADR-0028 chose passkeys _because_ they are
phishing-resistant, and demanding a second factor on top of one would be asking for less security
in more steps.

### The gate does not block the act that clears it

ADR-0033's rule, and the reason this decision is not a trap. A client refused a session for having
no factor can still enrol one: `beginMfaEnrolment` and `confirmMfaEnrolment` take the **password**
and a code from the new authenticator, and neither needs a session. The way out is open to exactly
the person who has just proved they own the account, and **the refusal says so** rather than
leaving them to guess — an honest refusal names the reason and the remedy (principle 9).

### Why `@bwc/identity` reads the value itself

`@bwc/admin` already depends on `@bwc/identity` — it resolves the Level 3 actor making a change — so
importing the registry back would be a package cycle, and `turbo run build`'s `dependsOn: ["^build"]`
would refuse to order it.

The key and the compiled default are therefore declared in `packages/identity/src/mfaPolicy.ts`,
beside the code they govern, and **`@bwc/admin`'s registry imports them**. There is one key, in one
place, so the registry entry and the enforcement cannot come to mean two different settings. The
duplicated part is the query, and `tests/integration/client-mfa-mandate.test.ts` asserts that this
reader and `effectiveValue` return the same answer for the same tenant — two readers of one setting
being the shape that goes quietly wrong.

It uses the same two-key ordering (`appliedAt desc, createdAt desc`) `effectiveValue` uses, for the
reason recorded there: `appliedAt` can legitimately collide, and with a single sort key the winner
is whichever row Postgres happens to return.

## Consequences

**Nothing changes for any existing tenant.** The default is off and no tenant has a
`ConfigurationChange` row for this key, so every current sign-in path behaves exactly as it did.
That is what makes this shippable ahead of the portal UI work rather than behind it.

**Turning it on strands nobody at the identity layer, and may strand people at the transport.**
Enrolment needs no session in `@bwc/identity`. Whether `apps/api` **exposes** an enrolment route to
a caller who has no session is a separate question, and this slice did not touch `apps/**` and has
not verified it. **A firm turning this on before that is confirmed should expect support calls.**
This is named rather than assumed, and it is the first thing to check before the parameter is used
in anger.

**A live session outlives the change.** The mandate is enforced when a session is issued, not when
one is resolved. A client already signed in without a factor keeps that session until it expires —
bounded by `SESSION_ABSOLUTE_HOURS` (12) and `SESSION_IDLE_MINUTES` (30). This is deliberate:
turning the mandate on raises the bar for the next sign-in rather than ejecting clients mid-upload,
and a mandate is not a revocation. If a firm needs immediate effect, revoking sessions is the act
that means that, and it already exists.

**The refusal is not in the Event Ledger.** `EVENT_TYPES` in `packages/core/src/events.ts` is a
closed catalogue and adding a type was outside this slice's file ownership, so a session refused for
want of a second factor is currently invisible to an audit. It is a real gap — this is the one
refusal on the sign-in path with no event beside it — and it wants
`identity.client_user.mfa_mandate_refused` in the slice that can edit that file.

**The staged change surfaces in the founder's workbench.** `stagedChanges` already feeds
`@bwc/workbench`'s decision queue, so a mandate staged and forgotten shows up as an open decision
rather than sitting in a table nobody reads. No work was needed for this; it is a consequence of
registering the parameter as high-risk.

## Alternatives considered

**Make it an invariant — mandatory for everyone, like staff.** Rejected on sequencing rather than
on principle. The end state is probably right; arriving at it by deployment, for existing clients
who were told MFA was optional, converts a security improvement into a support incident and
teaches clients that our sign-in is unreliable. A parameter that defaults off is how a firm gets to
the same place having told people first.

**Leave it optional and rely on encouragement.** What exists today. It makes the firm's security
posture the sum of individual client choices, which is not a posture.

**Enforce it in `authenticateClientUser`.** The obvious place, and it would turn a carefully uniform
refusal into an account-existence oracle. Discussed above.

**Enforce it in `@bwc/portal`'s `signIn`.** Where the composition already lives, and it would work
for the password path. Rejected: it would need repeating on the passkey and challenge paths, which
is three implementations of one control and, per `packages/core/src/authority.ts`, "a local check is
a second implementation that will drift from this one, and the drift will be silent."

**Pass `requireSecondFactor` into `issueSession`.** Rejected by ADR-0033's reasoning: an option is a
thing a caller can pass.

**Enforce on `resolveSession` as well, so it bites immediately.** Rejected, with the exposure stated
above rather than hidden. Ejecting a client mid-session is what revocation is for.
