# Changelog

All notable changes to the Burkham Wickmont Operations Console are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - moving the address a client's account lives at (`ai-feature/client-email-change`)

The bigger question #31 named, in one line: **the email address is where a reset link goes.** See
[docs/m11-email-change.md](docs/m11-email-change.md) and ADR-0027.

- **The strongest of the three credential operations.** Changing a password changes what an attacker
  must know; changing this changes WHERE RECOVERY GOES, and an attacker who moves it keeps the
  account after the client resets their password, because the reset arrives in the attacker's inbox.
- **It takes effect only when the new address answers**, not when the request is made. A change
  applied at request time moves recovery to whatever was typed, and a typo is then not a typo - it is
  a lockout the client discovers on the day they need to get back in.
- **Three decisions run OPPOSITE to change-password, and "be consistent with the last slice" is the
  tempting wrong answer in all three.** This revokes NO sessions and cancels NO outstanding resets:
  nothing about authentication changed, so revoking would remove the legitimate owner's access and
  leave the attacker - who holds the session doing the changing - exactly where they were. A reset in
  flight went to the OLD address, which an attacker does not have, so it is the owner's way back.
- **A staff-assisted move is a different fact and a column says which.** #28's staff route hands a
  token to a human to convey; that does not transfer here, because a token read over the phone proves
  the PERSON and proves nothing about the address - which is the only thing the token exists to
  establish. So the staff route hands out no token and stamps `verifiedBy: 'staff_assertion'` beside
  the `'email'` the self-service path produces.
- **Recovering the account cancels a pending move** - the interaction that would otherwise be
  invisible from either feature: an attacker requests a move, the client resets their password, and
  the attacker presents the token afterwards and takes the recovery channel anyway.
- **The seam that matters most is the one that is missing.** `notifyPreviousAddress` tells the old
  address its account has moved, and that notification is how a hijack is noticed at all.
  `oldAddressNotified` travels out to the caller and into the Ledger as `false` rather than being
  omitted.
- The delivery seam is **injectable**, following PR #9's lesson - it is how a provider gets wired in
  and how a test watches the one place the token legitimately travels to.
- An address already in use is refused **without saying why**; a consumed row is the history;
  confirmation is unauthenticated on purpose, because the link is opened from the new mailbox.

### Added - change password for a signed-in client (`ai-feature/client-password-change`)

Named as out of scope three slices running, each time for the same reason: changing a password you
know is a different act from recovering one you have lost. See
[docs/m11-password-change.md](docs/m11-password-change.md) and ADR-0026.

- **A credential change needs a credential** (ADR-0024). The current password is definitional; where
  a factor is enrolled a current code is required too, because **an attacker holding a session and a
  shoulder-surfed password is exactly the case a second factor exists for**. The code is SPENT - one
  that authorised a credential change and could still open a session would be a code used twice.
- **This revokes every session EXCEPT the caller's; a reset revokes all.** Read side by side these
  look inconsistent: a reset is completed by whoever holds a token, so the requester might be
  anybody; here they have proved a session, the current password and a code where one exists.
  **The difference is not inconsistency - the two paths know different things about who is asking.**
  Signing the caller out of the action they just took is how a button stops being used. Both
  behaviours are asserted in one test file so the difference reads as deliberate.
- **An outstanding reset dies with the change** - the interaction nothing else would have caught. A
  client who asks for a reset, then remembers their password and changes it from the portal instead,
  would otherwise leave a live token in an inbox that sets a password of the holder's choosing over
  the one just chosen. Superseded in the same transaction, and reported back.
- **Rate limited although it is authenticated**, which no other authenticated route is: per-account
  lockout counts sign-ins and does not apply here, so a caller holding a session could otherwise
  guess the current password from inside it. Counting the source means a hijacked session cannot
  become a guessing loop **and cannot lock the real owner out either**.
- The lockout clears, for the same reason it clears on a reset. `identity.client_user.password_changed`
  is its own event - one type for both acts would hide which happened.
- **No schema.** The same `passwordHash` column and the same session and reset tables.

**Changed - `ClientPrincipal` gained `sessionId`**, from `resolveSession`. The surviving session has
to be the one the cookie presented: a caller who could name a session id could name somebody else's
and keep it alive. **`verifySecondFactor` extracted in `@bwc/identity`** and now used by both factor
removal and this route - three copies of those ten lines is how one of them stops spending the step.

### Added - a shared rate-limit store (`ai-feature/shared-rate-limit`)

The last of the three gaps the transport slice named. See
[docs/m11-shared-rate-limit.md](docs/m11-shared-rate-limit.md) and ADR-0025.

- **Postgres, not Redis.** The instinct that a limiter must not touch the database is right for one
  protecting a static asset and wrong here: **this one protects a scrypt verification** costing a
  hundred milliseconds, and an indexed upsert costs one.
- **The decisive reason is not speed.** Every shared limiter must answer whether it fails open or
  closed when its store is unavailable, and with Redis both answers are bad because Redis can be
  down while Postgres is healthy. With Postgres the question dissolves: sign-in needs that same
  database to read the user and issue a session, so failing closed **costs nothing that was not
  already lost**. The dilemma is removed by the choice of store rather than papered over.
- **One statement, because a counter is a read-modify-write.** Two instances that both read 4 and
  both write 5 have let six requests through on a limit of five, and a SEQUENTIAL test cannot see
  it. `INSERT … ON CONFLICT DO UPDATE … RETURNING` is atomic; the window rolls inside the same
  statement. The test fires ten overlapping requests through two limiters and asserts exactly three
  were allowed - the read-then-write version reports **five allowed and ten attempts counted as six**.
- Timestamps bind as ISO strings cast to `::timestamp`, never as JS `Date`s - a `Date` goes as
  `timestamptz` against a naive `timestamp(3)` column and Postgres shifts the comparison by the
  session timezone.
- **The counter lives in the `identity` schema**, because 11.1 already owns the other half of this
  control: lockout counts the victim, rate limiting counts the attacker.
- **`PORTAL_RATE_LIMIT_STORE` has no default** and the app refuses to start without it, for the
  reason `PORTAL_TRUST_PROXY` has none - both are settings whose wrong value produces a system that
  looks like it is enforcing a control and is not. `memory` stays supported and correct for one
  instance. Both limiters are built by one factory from that one setting.
- **Semantics did not change** - fixed window, same boundary burst. Changing the algorithm and the
  storage in one slice would make it impossible to say which change caused a difference in behaviour.
- Swept on one write in a hundred rather than by a scheduled job: a job can stop, and **if this sweep
  stops the cost is disk rather than a broken limit**.

**Changed - `RateLimiter.check` is now async**, including the in-memory implementation. Two
interfaces, one per implementation, would mean the transport choosing between them.

### Added - multi-factor authentication for client users (`ai-feature/client-mfa`)

The second gap the transport slice named, and the larger one. See
[docs/m11-mfa.md](docs/m11-mfa.md) and ADR-0024.

- **TOTP, because it is the only second factor that can work here.** SMS needs an ungated provider,
  so it would report `not_built`, and SIM swap is the documented attack against this population.
  **Email OTP is worse than not doing it**: a second factor delivered to the channel that can reset
  the first factor is the same factor twice. TOTP needs no vendor - a shared secret and a clock.
- **The implementation is verified against RFC 6238's own test vectors**, not against itself. An
  off-by-one in the counter encoding produces six digits that look exactly right and match no
  authenticator app on earth.
- **The half-authenticated state is not a session.** The tempting build issues the session cookie
  after the password and marks it unsatisfied - then every route has to remember, and the one that
  forgets is a complete bypass. A correct password produces a `ClientMfaChallenge` with its own
  table and its own cookie; `issueSession` is not reached until a code verifies. `signIn` returns a
  UNION rather than gaining a boolean, so every call site is a compile error until it handles it.
- **A session is not a credential.** Confirming an enrolment takes the password; removing a factor
  takes the password AND a current code. Either alone is one of the two things the factor exists to
  require.
- **A factor nobody has proved they can use is not a factor**, it is a lockout waiting for the next
  sign-in - enrolment does not activate until a code from the new authenticator verifies.
- **The accepted time step is stored**, so a code observed inside its thirty-second window cannot be
  replayed and one code cannot open two sessions. Wrong codes are counted against the CHALLENGE,
  which dies at five: the brute-force defence for six digits is that failing them costs a password
  attempt, and locking the account instead would make six digits a denial-of-service weapon.
- **Recovery codes** - eight, shown once, hashed, single use. A recovery code satisfies one sign-in
  and does NOT disable the factor; its use is a Ledger event, because a run of them is the signal
  somebody has phished a printout. Removing a factor retires them with it.
- **The TOTP secret is field-encrypted under `MFA_SECRET_KEY`**, a different key from `VAULT_KEK`.
  Unlike a password hash it must be recoverable, so the protection cannot be a one-way function.
  **Enrolment refuses outright when the key is missing** - storing the secret in the clear would be
  worse, because nobody would know.
- **Password reset is not an MFA bypass**, asserted rather than assumed: a completed reset issues no
  session and leaves the factor in place. The two were built a slice apart.
- A staff-assisted removal needs a Level 3 human and a recorded verification basis, as a staff-issued
  reset does. It signs nobody in.

**Changed - envelope and field-level encryption moved from `@bwc/vault` to a new `@bwc/crypto`.**
`@bwc/vault` depends on `@bwc/identity`, so identity could not import it; the Vault re-exports
everything, so no existing caller moved. The same move `serialize.ts` made into `@bwc/http`.

### Added - password reset for client users (`ai-feature/client-password-reset`)

The first of the three gaps the transport slice named. See
[docs/m11-password-reset.md](docs/m11-password-reset.md) and ADR-0023.

- **A reset link is a credential in transit, so delivery does not go through 4.1.** `send` writes
  the message body into `Communication.body` - a table staff read, and one 7.1 assembles into the
  compliance evidence file. It also runs the middleware chain (recovery gated on a regulatory
  activation), the preference gate (**a client who opted out of email could never recover their
  account**) and the compliance scanner. `deliverPasswordResetLink` persists nothing, logs nothing
  and returns nothing, and reports `not_built` naming the email provider.
- **Requesting a reset changes nothing about the account.** Not the password - otherwise anybody who
  knows a client's email address ends their access by typing it into a form. **Not the lockout**:
  clearing it reads as kindness and is a lockout bypass, because an attacker who has burned five
  guesses would reset the counter and keep going. It clears on COMPLETION, where the caller has
  proved they hold the token.
- **Every address gets the same answer** - enrolled, unenrolled, disabled, locked, or not a user at
  all. The residual timing difference is one row insert, stated in the code rather than papered over.
- **Completing a reset ends every session**, including one held by whoever the client is resetting
  against. A reset that left them running would leave the attacker with a valid cookie for twelve
  hours while the client believed they had shut them out.
- **A staff-issued reset requires a recorded verification basis**, because the attack on helpdesk
  password reset is social engineering rather than cryptography. It does not expand what Level 3 can
  already do - the same person can invite a client user at an address they control onto any client's
  file - it makes an existing power auditable. `issuedBy` is null for a self-service request,
  mirroring 6.4's `listedBy`.
- Sixty-minute window against the invitation's seventy-two hours; one live reset at a time; single
  use; the same password cannot be set back; consumed, superseded, expired and never-real answer
  identically.
- Transport: `POST /portal/password-reset` and `/portal/password-reset/complete`, on their **own**
  rate limiter. A shared bucket would let a reset flood lock legitimate clients out of signing in.

**Changed - `inviteClientUser`'s refusal for an already-enrolled user** no longer says a password
reset "is not built here". It now names the two functions that do it.

### Added - the Client Portal transport layer (`ai-feature/portal-transport`)

`apps/portal-api` - HTTP for 11.10, and the last thing standing between the portal and being
exposed. See [docs/portal-transport.md](docs/portal-transport.md) and ADR-0022.

- **A separate process, because `apps/api` trusts a header.** That app resolves the acting staff
  member from `x-actor-id`, which its own comment calls "a development seam, not authentication". A
  public surface in that process is a public surface with that header: a client reaching any
  internal route would send `x-actor-id: <any Level 3 actor id>` and act as staff. The portal app
  imports `@bwc/portal`, `@bwc/identity` and `@bwc/vault` and nothing that serves internal
  capability - **the isolation is structural, because there is no route to get wrong when the code
  is not in the process.**
- **Rate limiting is not lockout, and neither substitutes for the other.** 11.1's five-strike
  lockout protects an ACCOUNT and does nothing against password spraying: ten thousand addresses,
  one attempt each, no account reaches two failures. Per-IP limiting counts the ATTACKER. The test
  sprays ten addresses with one attempt each, precisely because lockout would sleep through it. The
  limiter runs **before the body is parsed**.
- **The limiter's limitation is stated in its own header:** the window is in process memory, so two
  instances means twice the limit. Honest for one instance, wrong behind replicas.
- **Three settings refuse to be guessed and the app throws without them.** `PORTAL_TRUST_PROXY`
  (unset behind a balancer collapses per-IP limiting into one bucket; **`true` is refused outright**
  because Express would take the client-written `X-Forwarded-For`), `PORTAL_COOKIE_SECURE`, and
  `PORTAL_TENANT_ID` - the tenant is deployment configuration, never a request value.
- **The session is an `httpOnly`, `Secure`, `SameSite=Strict` cookie**, never in the body and never
  in a URL. Returning the token would hand script the thing `httpOnly` exists to keep from script.
- **Errors carry no cause**, unlike the internal app: here a stack trace is reconnaissance.
  `/portal/health` is deliberately empty for the same reason, and a 404 does not enumerate routes.
- Uploads are **raw bytes** with metadata in the query string; downloads are `attachment` for both
  view and export, because a PDF rendered inline is one the browser may cache to disk.

**Changed - `serialize.ts` moved from `apps/api` to the new `@bwc/http` package.** Two apps
serialising the same union two ways is how `not_built` becomes a 200 on one of them.

### Added - client access to the Vault (`ai-feature/vault-client-access`)

The follow-on ADR-0021 named: `vault.store` and `vault.read` resolve an internal `Actor`, and a
client user deliberately is not one, so the portal's upload refused. See
[docs/m11-client-vault-access.md](docs/m11-client-vault-access.md) and ADR-0021's amendment.

- **`storeForClient` and `readForClient`, where OWNERSHIP replaces the authority level** and every
  other gate is unchanged - the same tenant check, scan-status rule, legal-hold rule, export
  watermark and pre-handover access log. Where the rules are the same they are the same CODE.
- **`MINIMUM_LEVEL_TO_READ.bank_statement` is 0**, so a build that reused the staff path would grant
  a client access to every other client's bank statements. That is the test this file is built
  around.
- **Another client's document answers exactly as one that does not exist**, and both refusals are
  logged - a pattern of attempts against documents a client does not own is the signal an audit
  wants.
- **A legal hold blocks export and not view**, for a client as for staff. **The client is not told a
  hold exists**: a litigation-hold notice is frequently confidential and may concern a dispute with
  the client asking, so the refusal is truthful, offers a route to the Concierge Desk, and declines
  to explain. The real reason goes to the access log. **ADR-0021 is amended to record this as an
  assumption for counsel** - it is the consistent reading of the staff rule, not a settled legal
  question.
- **Exports are watermarked with the client user's identity**; `uploadedBy` is the client user's own
  id rather than a service account.
- Which document kinds a client may upload stays in the **portal** - a policy about what a client
  supplies, not about how bytes are stored.

**Changed - `pdfText` moved to `tests/helpers/pdf.ts`.** A second copy written for this slice missed
pdf-lib's hex-string decoding and failed for a reason unrelated to what it asserts. Both tests now
share one.

**Changed - one assertion in `client-authentication.test.ts`.** It pinned upload as `refused`, which
was true when authentication shipped and is precisely what this slice fixes.

### Added - Client authentication for the Client Portal (`ai-feature/m11-client-authentication`)

Closes the gap 11.10 shipped with: **nothing authenticated a client user.** See
[docs/m11-client-authentication.md](docs/m11-client-authentication.md) and ADR-0021.

- **A client user is not an `Actor` with a low authority level** (ADR-0021), and the reason is
  concrete. `vault.read` checks the document's tenant and the actor's level against
  `MINIMUM_LEVEL_TO_READ` and performs **no ownership check** - correctly, because an internal
  analyst reads many clients' files. `MINIMUM_LEVEL_TO_READ` puts `bank_statement` at **level 0**.
  So a client holding a Level 0 Actor row could read **any client's bank statements in the tenant**,
  through the vault working exactly as designed for the principal type it was designed for.
- **`ClientUser` is its own table**, in the `identity` schema because 11.1 owns identity - a separate
  client-identity package would be the second permission model 11.10 already refused. It has no
  authority level, and `findActor` cannot resolve it.
- **`EventActor.kind` gains `'client'`.** A client uploading a statement and a staff member
  uploading one on their behalf are different acts, and recording both as `human` would blur the
  line `sign_for_client` - a Level 4 prohibited action - is drawn along.
- **Enrolment is an invitation, not a signup.** A Level 3 human issues it against a specific client;
  single-use, expiring, token stored **hashed**. One user, one client file.
- **Every authentication failure gives one answer.** Unknown email, wrong password, unenrolled and
  disabled are identical, and a verification runs against a decoy hash when the user does not exist
  so the timing does not answer what the message refuses to. Lockout after 5 failures for 15
  minutes; the lockout message differs deliberately, because the person being told just failed
  against that account five times.
- **Sessions carry two expiries** - absolute and idle - both checked on every resolve, and
  `resolveSession` **re-reads the user** rather than trusting sign-in, so disabling takes effect on
  the next request rather than whenever a session lapses.
- **scrypt with a length floor and no composition rules**; tokens are 256 bits stored as SHA-256.
  No credential material reaches a return value, a log, an error or a Ledger payload.

**Known, and named rather than half-done: client document upload still refuses.** `vault.store`
resolves an internal Actor and a client user deliberately is not one, so the portal refuses rather
than attributing the upload to somebody else. Wiring a client principal through the vault needs an
ownership-based path alongside the level-based one, on both `store` and `read`.

**Fixed while building - scrypt's cost parameters collided with a Node default.** scrypt needs
`128*N*r` bytes; at N=2^15 and r=8 that is exactly 32 MiB, and Node's default `maxmem` is 32 MiB
checked strictly. It failed at RUNTIME, not compile time, because the two numbers are unrelated and
happen to meet. `SCRYPT_MAX_MEMORY` is now explicit so the relationship is visible.

**A mutation found a real gap.** Removing the resolve-time user check broke nothing, because
`disableClientUser` also revokes sessions and the revocation alone caught it. A test now disables a
user without touching their sessions - the case any future admin path or partial failure produces.

### Fixed - the effective configuration value was non-deterministic (`ai-feature/fix-configuration-ordering`)

`effectiveValue` ordered configuration changes by `appliedAt` alone. **`appliedAt` collides whenever
a change and its rollback are recorded at the same logical instant** - which is the ordinary case
rather than a contrived one - and with a single sort key the winner was whichever row Postgres
happened to return.

Found by running `pnpm verify` on merged main: the same test **passed in CI and failed locally, on
the same code**, which is what a non-deterministic sort looks like from the outside. A test that
passes on one machine and fails on another is not a flake to re-run; it is a missing tie-break.

Two changes:

- **Ordering is now `appliedAt desc, createdAt desc`.** `createdAt` is the database's own insertion
  clock and is monotonic, so a rollback recorded at the same instant as the change it undoes wins.
- **`createdAt` is no longer set from the caller's `now`.** It is the audit record's insertion time,
  and a caller-supplied value would let a change be back-dated in the trail that exists to say when
  it happened. It is also what makes the tie-break work.

Pinned by a regression test that records two changes at the same instant and asserts the later
insert wins. Mutation-verified: reversing the tie-break produces 2 failures.

### Added - Data Warehouse, Client Portal and Founder Workbench (`ai-feature/m11-warehouse-portal-workbench`)

**11.6 Data Warehouse & Analytics Layer**, **11.10 Client Portal** and **11.11 Founder / Executive
Workbench** - the last three V1 modules. **With these, all 46 modules in the blueprint's V1 phasing
are built.** See [docs/m11-warehouse-portal-workbench.md](docs/m11-warehouse-portal-workbench.md)
and ADR-0020.

- **A warehouse answers about the PAST, not faster about the present** (ADR-0020). ADR-0017 decided
  the dashboards read live; this does not overturn it, it answers a different question. A live read
  tells you where clients stand today and cannot tell you where they stood in March, because those
  clients have moved. **Every read requires a historical period - there is no `current()`**, which
  is what stops this becoming the stale cache ADR-0017 ruled out, and is asserted structurally by
  grepping the module's exports.
- **A snapshot is never updated.** Re-capturing a date is refused: an overwritten snapshot is a
  rewritten history, and a trend over rewritten points is not a trend. A future `asOf` is refused
  too - capture records the state as it is when called.
- **Retention outlives the operational record**, so subject rows carry a keyed-hash PSEUDONYM
  rather than a client id. `PSEUDONYMISATION_NOTE` states the limit in exportable form: anybody
  holding both the client list and the derivation key can re-identify every row. **Claiming
  anonymity would be worse than not doing it**, because the claim is what somebody would rely on
  when deciding where an extract may go.
- **The portal decides nothing.** A portal permission model would drift from 3.2's document
  classes, 11.1's access model and 1.5's consent records - and the drifted copy is the one that
  would be enforced. So upload goes to 3.2 (which holds the document **unreadable until scanned** -
  proved by asking the VAULT to read it, not by checking a portal flag), signing to 1.5 (a
  signature IS a consent record), messaging to 4.1's deliberately-ungated inbound path, and Plaid
  Link to `not_built` per Decision A.
- **There is no outbound message path in the portal.** A reply that skipped 4.1's preference gate,
  the middleware chain and the scanner would be the one piece of client-facing text nobody checked.
- **A client acts on their own file**, checked against the resolved principal rather than a
  caller-supplied id. A missing document and someone else's document return the SAME answer -
  distinguishing them would confirm an id belongs to somebody.
- **Only delivered deliverables appear**, so what a client reads is what 3.4 approved. **Blocked
  outbound messages do not appear**: the client never received them, and showing them would be
  arguing with a client about a preference they set.
- **A founder decision states what happens if nobody acts.** A workbench listing everything becomes
  a second inbox, and two inboxes means both get ignored. An item appears only if it requires a
  Level 3 human, is blocking something, and carries the cost of inaction - plus `resolveIn`,
  because a decision with no route is an anxiety.
- Portal and workbench store **nothing**; the test asserts no `portal` or `workbench` schema exists.

**A mutation test found a real gap.** Emptying the Do Not Fund branch's cost-of-inaction changed no
test, because the fixture had no overdue listing and the branch never ran. The fixture now creates
one. A surviving mutation is either a missing assertion or a missing case - this was the second.

### Added - Admin Configuration Center and System Health (`ai-feature/m11-admin-and-observability`)

**11.7 Admin Configuration Center** with **11.8 System Health & Observability**. Two of Category
11's five remaining V1 modules; **11.6 Data Warehouse, 11.10 Client Portal and 11.11 Founder /
Executive Workbench remain**. See
[docs/m11-admin-and-observability.md](docs/m11-admin-and-observability.md) and ADR-0019.

- **A configuration surface must not be able to turn a control off** (ADR-0019). Blueprint 11.7
  lists "authority levels" and "state rules" among the configurable things - taken literally, a
  screen where somebody sets TCPA quiet hours to 24 hours or adds `guarantee_approval` to the
  permitted-action list. So every tunable constant is a **parameter** (a policy choice, with
  declared bounds, the basis for those bounds, an owner, a Level 3 human, a readable reason and an
  audit trail) or an **invariant** (law, or something the architecture depends on).
- **Invariants are absent, not permission-gated.** A "Level 4 required" flag would be a permission
  somebody eventually holds, and the person most likely to hold it is the one under pressure to
  make a number move. There is no code path that writes them. They are listed as fixed with a
  `whyFixed` line, because "I couldn't find the setting" and "the setting does not exist because it
  is the law" are different answers and only one stops somebody looking for a workaround.
- **Cadences the specification states as minimums become ceilings.** 5.4's quarterly review and
  8.3's annual recertification may be tightened by a tenant, never loosened; 9.1's 90% compliance
  target is a floor for the same reason.
- **There is no table of current values.** The effective value is the latest applied change or the
  compiled default, so the audit trail IS the store and nothing keeps two copies in step.
  `rollback` writes a NEW change restoring the prior value - an undo that deleted the row would
  answer "what is it now" and lose "what happened".
- **Staging is real, not a label.** A high-risk change is recorded with `appliedAt: null`, and
  `effectiveValue` reads applied changes only, so the value does not move until promotion. A second
  approver is deliberately not required: staging makes a change deliberate and visible, and
  four-eyes approval is something this codebase does elsewhere by name.
- **`unmonitored` is a state, and it is not green** (ADR-0019). 9.1 established that `null` is not
  zero; the argument lands harder on a health dashboard, where the default rendering of "no data"
  is a green tick and the reader is deciding whether to go home. `unmonitored` ranks BETWEEN
  `degraded` and `healthy` - not worse than degraded, because nobody watching is not evidence of a
  problem; worse than healthy, because "we are not looking" cannot be reported as "it is fine".
- **The `healthy` constructor takes a measurement as a required argument**, so a component nobody
  probed cannot be reported as working - there is no way to build the value. An empty check returns
  `unmonitored`, because a system nobody checked is not a healthy system. Overall is the WORST
  component, never an average.
- **Four components are genuinely measured** from 11.3 and 11.4: queue depth (counting work that is
  DUE - a follow-up booked for next month is not backlog; **dead letters fail at one**, because a
  threshold would be a decision that some abandoned work is acceptable), the Ledger hash chain (no
  degraded case; an EMPTY ledger is `unmonitored`, not intact), workflow failure share (**no
  activity is `unmonitored`, not clean**), and SLA breaches.
- **A gated vendor never shows green.** Zero calls is not zero errors, and a healthy Plaid row on a
  system that has never called Plaid is the most confidently wrong thing the module could produce.
  Each names the Decision that gates it.

### Added - Inter-Venture Commerce Hooks (`ai-feature/m10-inter-venture-commerce`)

**10.1 Inter-Venture Commerce Hooks** - Category 10's V1 scope. 10.2 Cross-Portfolio Opportunity
Engine is V1.5. See [docs/m10-inter-venture-commerce.md](docs/m10-inter-venture-commerce.md) and
ADR-0018.

- **Generating a disclosure is not disclosing** (ADR-0018). Blueprint 10.1's "conflict-of-interest
  disclosures auto-generated and filed", read as one step, describes the conflicted party writing a
  document, filing it with itself, and proceeding - a record of a control that did not happen. The
  **artifact** is generated automatically, because a hand-written conflict disclosure varies with
  how the writer feels about the conflict. The **disclosure** completes only on acknowledgement by
  parties that are not us: the venture's own representative and Gardner. `mayProceed` refuses until
  both exist, and names which is missing.
- **The acknowledged text is hashed and checked**, because acknowledging means acknowledging a
  specific document - 7.3's frozen-contract rule applied to a disclosure. The venture's
  representative is recorded as a **name, not an actor id**: they are on the other side of the
  transaction, and an actor record would make their acknowledgement look like an internal approval.
- **Arm's length is the price we charge strangers**, not a price we compute. 1.4's published ladder
  is what unrelated clients actually pay, which is arm's length by the only definition that survives
  an audit. **Any deviation needs Gardner approval IN EITHER DIRECTION** - a discount moves profit
  out of Burkham Wickmont, a premium moves it in, and a system that questioned only discounts would
  police one direction of the same thing while ignoring the one that flatters our own numbers.
  `mayCharge` permits an off-ladder price only for the exact approved amount.
- **A Collingswood handoff needs that individual's own per-handoff consent.** The data subject
  changes: personal-side complexity means the founder's own finances, not the business's. `scope` is
  named before the client is asked - consent to "a referral" is not informed - and the consent's
  scope is compared against the handoff's, because a mismatch is invisible unless somebody compares
  them. **Consent is re-checked live at transfer**, not trusted from the state field: people change
  their minds about personal financial information, and the gap between consenting and transferring
  is exactly where they do it. First use of the `cross_portfolio_handoff` consent kind, which has
  existed in 1.5 since the walking skeleton.
- **Detection refuses on ambiguity.** A name containing a token that appears in a venture name
  without identifying one returns `possible` and refuses until a person confirms. Both wrong answers
  are expensive in opposite directions: a false tag blocks a stranger behind a conflict process
  nobody can complete, and a missed one is an undisclosed related-party transaction.
- **Gardner visibility is derived, never set.** A settable flag would eventually be set on a normal
  client, at which point the portfolio's common owner is reading the file of somebody with no
  relationship to them.
- **Intercompany invoices never reach `settled`.** Routing to the Gardner-level ledger is a
  `not_built` seam; the invoice moves to `routed_pending` so the queue is visible. A settled invoice
  nobody routed would read as money that moved between two entities when none did, in two sets of
  accounts, one of which is not ours.
- Each venture carries its **own** conflict basis rather than a generic one - Argus performs the
  security reviews that gate our vendor integrations, and Collingswood receives our handoffs.

### Added - KPI Dashboards (`ai-feature/m9-kpi-dashboards`)

**9.1 Executive KPI Dashboard** with **9.2 Unit Economics Dashboard** - Category 9's V1 scope. 9.3
Agent Productivity and 9.4 Lender Performance are V1.5. See
[docs/m9-kpi-dashboards.md](docs/m9-kpi-dashboards.md) and ADR-0017.

- **A metric is a value with its basis, or it is nothing** (ADR-0017). Every figure carries its
  numerator, denominator, period and coverage. `null` is never zero: zero is a measurement, and
  `null` means there was nothing to measure, with a note saying what would make a number appear.
  Rates below a minimum denominator of 10 - matching 5.2 and 1.3 - still show their **counts**,
  because those are real, and withhold the rate.
- **`compare` refuses across unequal or unfinished periods.** Month-to-date against a completed
  month is the most common way a dashboard misleads without anybody intending it: the arithmetic is
  fine, it describes nothing, and it always flatters the past.
- **The placement approval rate is refused**, and this is the slice's finding. `FundingOutcome`
  records approvals only - denials and adverse-action notices belong to **5.5 Funding Outcome
  Ledger, which is V1.5** - so a rate computed from what exists would read **100% forever**:
  arithmetically correct, extremely reassuring, and the exact claim the Marketing Claim Library
  bans. What is measurable - how many placements our own gate stopped - is reported as
  `internalGateRefusalRate`, named so nobody reads it as the metric 9.1 asked for.
- **Gross margin is refused.** 9.2 defines it as including per-client Plaid and bureau costs, and
  both vendors are ungated under Decisions A and B. A margin without them is wrong in a **known
  direction by an unknown amount** on the surface the founder steers by. `offerEconomics` gives the
  same arithmetic as `marginBeforeUnmeasuredCostsCents`; the awkward name is the point.
  `vendorCostForClient` returns `not_built` rather than `0`, because zero would flow into a margin
  as a measurement.
- **Projected LTV is refused**, naming what it would need - an observed churn rate, an observed
  expansion rate and a chosen discount rate. `realisedRevenuePerClient` reports what has actually
  been billed per client, with **mean tenure alongside** so a reader can see how much of a lifetime
  the figure covers.
- **Compliance is a distribution, never an average** - Decision E, restated by blueprint 9.1 as an
  explicit change from v1. Every state appears including those at zero, because a dashboard that
  omits `fail` when empty teaches its reader that a missing row means no problem. Transition
  direction comes from a hard-coded pairwise table rather than an ordering: the moment an ordering
  exists somebody averages it.
- **The Gardner rollup strips PII structurally** - the type has no field a client identifier could
  occupy, rather than a redaction pass over a richer object, which works until somebody adds a
  field. It carries a `withheld` list so a portfolio view cannot read as complete.
- **CAC takes spend from the caller.** No module owns marketing spend, and inventing a store for it
  in a dashboard package would make the company's cost base a second source of truth. A channel
  with no supplied spend is reported with its conversion count and a null CAC rather than dropped -
  a channel missing from a CAC report reads as a channel that acquired nobody.
- **Nothing is stored.** No snapshot table: a snapshot needs a job, and a job that stops leaves a
  dashboard showing last month's numbers under this month's date. 11.6 Data Warehouse changes where
  the reads come from, not this argument.
- Revenue is **billed, not collected** - only `charge` lines count, so a payment cannot
  double-count what a charge already recorded.

### Added - Call Promise Tracking and Marketing Ops (`ai-feature/m4-calls-and-marketing-ops`)

**4.3 Call Recording, Summaries & Promise Tracking** with **4.5 Marketing Ops**, completing
Category 4 - and with it **every V1 module in the blueprint's phasing**. See
[docs/m4-calls-and-marketing-ops.md](docs/m4-calls-and-marketing-ops.md), ADR-0015 and ADR-0016.

- **A control that runs after the fact produces an obligation, not a verdict** (ADR-0015). 4.2
  returns `blocked` because it runs before a message is sent. A call has already happened and the
  client already heard the sentence, so a detected promise becomes a **correction obligation** -
  what was said, who owes the correction, by when, and, to close it, the correction itself.
  Closing with a tick is refused: it would record that a client was corrected when nobody had told
  them anything, which is worse than an open obligation because it stops anyone looking.
- **Detection matches the SHAPE of a statement, not its wording.** The Claim Library is
  exact-phrase and the promise varies by amount - "$100K", "a hundred grand" and "six figures" are
  one promise and would need three entries. Kept in its own file so loosening one mechanism cannot
  silently loosen the other. False positives are accepted deliberately; dismissal takes a Level 3
  human and a reason.
- **Recording consent is a jurisdiction question.** About eleven states require ALL parties to
  consent, and recording a client there without their consent is a crime **in the state where the
  client is sitting**. New consent kind `call_recording` in 1.5; the all-party list carries
  citations and an `openQuestion` where the position is genuinely unsettled. An **unclassified**
  state requires consent - it is not a one-party state, it is a state nobody looked at.
- **A refused recording is still a call record**, with a ledger event. "We wanted to record this
  and the client's state would not let us" is evidence, as a blocked send is in 4.1.
- **VoiceForge reports `not_built`**, and `analyseCall` on a transcript-less call does too, naming
  the seam rather than returning a clean analysis. The AI summary is carried **inside** the
  analysis result as its own `not_built` value rather than omitted - a caller who received an
  analysis with no summary field would conclude the call did not need one.
- **Every A/B variant must scan clean before the test runs** (ADR-0016). An A/B test optimises for
  a metric; if one arm may say something banned and the other may not, the test measures whether
  non-compliant language converts better, and it does. A failing variant is **refused**, not
  registered as the arm we expect to lose - while the test runs, real clients read every arm.
  Declaring a winner adopts nothing: a conversion number is a reason to consider a claim, not a
  review of it.
- **Claim proposals are the intake 7.4 never had.** Approval publishes into the Library in the same
  call, so there is no window where a proposal reads approved and the Library does not have it.
  Rejected proposals keep their phrase - "we considered saying this and decided not to" is the more
  useful half of the record.
- **A campaign cannot activate into a state 7.2 has not activated**, and the refusal names which.
  `sourceChannel` is fixed at creation, and **4.5 never writes attribution** - it hands out the
  value and 1.3 writes it once, because a referral fee is owed on it.
- **Marketing assets are scanned on the way INTO review**, since 4.5 governs content produced by
  Forge cascades that nobody read. A blocked asset goes to `rejected` with the reason rather than
  back to `draft`.

**Fixed - the promise detector missed the form people actually speak.** The money pattern matched
digits only, so "we should be able to secure a hundred grand for you" produced no finding. Caught
by a test written from spoken phrasings rather than written ones. A detector that catches only the
written form of a spoken promise catches the promises nobody makes.

### Added - Partner & Referrer Portal with Training & Certification (`ai-feature/m8-partner-portal`)

**8.1 Partner & Referrer Portal (Core)** with **8.3 Partner Training & Certification** - Category
8's V1 scope. 8.2 Partner Agreement & Payout Center and 8.4 Partner Risk Score are V1.5. See
[docs/m8-partner-portal.md](docs/m8-partner-portal.md) and ADR-0014.

- **Both modules in one slice**, because 8.3's headline requirement is a gate on 8.1 - "required
  completion before partner can refer / co-brand / white-label". Built separately, 8.1 would ship a
  referral path nothing gates.
- **Anonymity is a property of a cohort, not of a record** (ADR-0014). Blueprint 8.1's "anonymized
  client status sharing", built as written, strips the client's name off a status row - and a
  partner who referred one client and is shown "1 client in underwriting" knows exactly whose
  status that is, because they supplied the client. Stage breakdowns are **suppressed entirely**
  below a cohort of five, with the suppression stated rather than shown as zeros. A "fewer than
  five" band was rejected too: it still leaks against the partner's own knowledge of their count.
- **A named client's status requires that client's own consent** - new consent kind
  `partner_status_visibility` in 1.5 - checked live on every read, and the read is **logged**,
  because a client who authorized a partner to look is entitled to know when they did.
- **A lapsed certification removes the capability**, applying ADR-0013 a third time. The stale
  record here is "this partner knows what they may claim"; if it is wrong the harm is a false
  statement made in our name, so staleness points the same way as 5.4 and opposite to 6.4.
- **An empty curriculum does not certify.** "Nothing to complete" and "completed everything" both
  produce an empty outstanding list, and treating them alike would certify the whole network the
  moment a tenant forgot to publish a curriculum.
- **Completion is recorded against a module VERSION**, which is the mechanism behind "annual
  recertification with change delta training". `changeKind` is required on publish, as in 7.2;
  editorial republishes carry completions forward **keeping their original dates**, because
  stamping today would extend every certification by a year on a typo fix.
- **Approved claims resolve to 7.4 by id.** "Approved-claims library per partner" read literally is
  a second claim store that would drift - and the drifted copy is the one the partner would say out
  loud. A claim banned later stops being approved with nobody coming here.
- **Partner brand material goes through the 4.2 scanner**, with a _stricter_ disclosure rule than
  the send path: the disclosure must be in the material, because we do not control what a partner
  adds after approval. White label carries two extra rules co-brand does not.
- **Termination takes a Level 3 human.** A "termination trigger" that fired on its own would end a
  commercial relationship, and cut off referred clients' visibility, with nobody answerable.
- `payableToPartner` returns **`not_built`** naming 8.2, and `referralSummary` produces **no
  conversion rate** - a partner-facing performance judgement belongs to 8.4, which is V1.5.

**Changed - 1.3 attribution now carries a typed partner identity.** `Lead.referrerPartnerId` is
written once with the rest of the attribution group, and `correctAttribution` moves the name and
the id **together** - a correction that moved one without the other would leave them disagreeing,
and the portal reads the id while a person reads the name. Every partner-facing read resolves
**current** attribution rather than the lead's original column, because that column is never
updated by design: reading it would show a partner a client that is no longer theirs and hide one
that now is.

### Added - Risk & Defense: Do Not Fund Governance and the Risk Event Timeline (`ai-feature/m6-risk-and-defense`)

**6.4 Do Not Fund Governance** with **6.5 Risk Event Timeline**, completing Category 6's V1 scope
(6.2 Funding Ethics Firewall shipped with the walking skeleton; 6.1 and 6.3 are V1.5). See
[docs/plans/m6-risk-and-defense.md](docs/plans/m6-risk-and-defense.md), ADR-0012 and ADR-0013.

- **Both modules in one slice**, because a Do Not Fund listing _is_ a risk event, and a timeline
  omitting the most consequential determination the company makes about a client would be a
  timeline nobody trusted.
- **An override permits one action; it does not delist** (ADR-0012). The obvious build - a switch
  that turns the listing off - conflates "this application may proceed despite the listing" with
  "this client should no longer be listed". Merging them lets one considered exception become a
  permanent state nobody revisits, and the person granting it would not know that is what they did.
  An override names one action, is consumed on use, and leaves the listing in force.
- **The chain carries the override id out rather than spending it.** A caller that checks and then
  abandons the action would otherwise have burned an exception a Level 3 human granted.
- **An overdue review keeps blocking** (ADR-0013). 5.4 made a stale provider approval stop being
  usable; this does the opposite, from the same rule - staleness moves toward the answer that is
  safe if the stale record is wrong, and the safe answer is opposite because the direction of harm
  is. Expiring a listing would let the most serious determination in the system lapse in silence.
- **The gate is fail-closed**: an allow-list of actions that remain available while listed, so an
  action added next year cannot move capital toward a listed client because nobody remembered to
  block it. Reading, drafting and contacting stay open - over-blocking would make the determination
  unsayable.
- **Compliance `fail` lists automatically** per Decision E, and `listedBy` is **null** rather than
  an invented approver. Naming one would put a fiction in the field a reviewer reads to find out
  who decided, indistinguishable from a real approval. Automatic in, **human out**.
- **Do Not Fund is reported ahead of the Firewall** inside step 4. Both are principle 7; the
  precedence is about which true statement to lead with, since "the Firewall is triggered" sends an
  operator to resolve the wrong thing when the real answer is a standing determination.
- **The timeline is assembled at read time and stores nothing.** Severity is categorical and the
  module produces no risk _score_ - the same argument Decision E makes about compliance state.
- **The timeline says what it does not watch.** Missed payments, NSF events, utilisation changes,
  credit-line decreases, adverse actions, disputes and complaints have no producer; each names the
  integration that would fill it. Carried on an **empty** timeline too, because a timeline with no
  entries and no caveat reads as a client with no risk history.
- **7.1 carries the timeline as a source**, with the listing surfaced in the coverage note.

### Added - Communications Hub and Preference Center (`ai-feature/m4-1-communications-hub`)

**4.1 Communications Hub** with **4.4 Client Notification Preference Center**. See
[docs/m4-1-communications-hub.md](docs/m4-1-communications-hub.md).

- **Both modules in one slice**, because the preference record is the gate rather than a
  convenience. A send path accepting `smsAllowed: true` from its caller would let code assert
  consent the client never gave.
- **Urgency overrides preference, never prohibition.** It moves a message between channels the
  client _permits_; it cannot create permission, reach past do-not-call, or move a message into
  quiet hours. A flag that could would be a documented mechanism for breaking the law.
- **Absence of permission is not permission** - every channel defaults to false.
- **Quiet hours are computed in the recipient's IANA zone**, and a missing timezone **refuses**
  rather than defaulting. Defaulting sends at the wrong hour for exactly the clients furthest away,
  and the failure is invisible from the sending side.
- **A blocked send is still logged.** A log holding only what went out would answer a regulator
  with the half that flatters us.
- **The send returns `not_built` at the provider seam**, not `ok`. Nothing delivered it, and saying
  otherwise would put "the client was told" in a compliance log when they were not.
- **7.1's `communications` gap is closed** - the Evidence Vault now reports real coverage, carrying
  metadata while the bodies stay in the log.

**Fixed - step 7 of the middleware chain was a no-op.** Its comment said the Communication
Compliance Scanner "is not built" and the step was "unreachable while step 5 refuses every
client-facing action". Both were true when written and **both stopped being true when 7.2 made step
5 pass** - and nothing failed, because the step reported `skipped` with the detail "no client-facing
content in scope" even when there was content. Found by a test that sent a banned phrase to a client
and watched it go. Step 7 now runs the scanner, blocks banned language, and blocks a
`requires_disclosure` phrase whose disclosure is absent.

> **Consequence:** the scanner refuses rather than certifying content clean against an **empty**
> library, so any tenant sending client-facing content must have the claim library seeded. "We
> checked nothing and found nothing" is not a pass.

**Fixed - the claim library banned one word order and not the other.** "Your approval is guaranteed
once you sign" passed cleanly, because the library held the noun phrase "guaranteed approval" and
not the inversion a person actually writes. The scanner is exact-phrase by design, so covering a
paraphrase means adding it - two variants added with the discovery recorded in their rationale.

**Tests:** 624 pass (36 new). Do-not-call and the scanner block were mutation-verified - disabling
either produces 6 failures.

### Added - Compliance Evidence Vault (`ai-feature/m7-1-compliance-evidence-vault`)

**7.1 Compliance Evidence Vault** - regulator-ready file assembly with coverage reporting. See
[docs/m7-1-compliance-evidence-vault.md](docs/m7-1-compliance-evidence-vault.md).

- **This module owns almost nothing, deliberately.** Every line of blueprint 7.1's data model names
  a fact another module already holds, so it assembles from live sources. A version that copied
  them into its own tables would produce a second version of each, drifting from the first - and
  the copy is the one a regulator would be shown. One table exists: the record that an export
  happened, which is a fact that lives nowhere else.
- **The file names what it could not include.** Every source reports a coverage verdict, and
  `empty` is distinguished from `not_built`: "this client has no complaints" and "we have no
  complaints module" both produce zero rows, and a reader shown the first when the second is true
  has been misled by an omission nobody intended. Design principle 9 applied to a whole document.
- **Three sources are `not_built` and stay in the registry** - Communications Hub, client
  complaints (with an explicit warning that 5.4's provider complaints are not a substitute), and
  adverse-action notices.
- **One failing source does not empty the file.** A failure becomes a coverage entry; abandoning
  the assembly would make the file unavailable exactly when something is already wrong.
- **The Ledger integrity result travels with the file**, so its claims can be checked rather than
  trusted. A broken chain is reported rather than blocking.
- **The export record carries ids, a purpose and a hash - never the file.** Coverage is stored
  rather than recomputed, because coverage _at the time_ is the fact a reader needs.
- **Three owning modules gained a client-scoped read** rather than this one reaching into their
  schemas: `consent.forClient`, `contracts.contractsForClient`, `billing.engagementsForClient`.
  Each includes revoked, superseded and cancelled records - a client's file is the history.

**Fixed during the slice:** the content hash covered the whole file including the Ledger integrity
count, **which the act of exporting increments** - so a file could not match itself a second after
it was written and reconciliation was useless. The hash now covers the client's evidence, excluding
`assembledAt` and `ledgerIntegrity`, which are statements about the system rather than the client.
Coverage stays in: if a `not_built` module gets built, a held file is out of date in a way that
matters.

**Tests:** 588 pass (14 new). The `not_built` verdict and the failure-isolation guard were
mutation-verified - disabling either produces 5 failures.

### Added - Sales Motion & Engagement Tracking (`ai-feature/m1-3-sales-motion`)

**1.3 Sales Motion & Engagement Tracking** - leads, attribution, inactivity escalation, conversion,
expansion. See [docs/m1-3-sales-motion.md](docs/m1-3-sales-motion.md).

**Category 1's V1 modules are now complete** (1.1, 1.2, 1.3, 1.4, 1.5).

- **Attribution is a financial fact**, so it is written once at creation and this package exposes
  no path that updates it. A correction is a separate row with the original intact - a payout
  dispute asks "who was this attributed to when the fee was calculated", and overwriting destroys
  the only evidence. **First touch, not last**, stated rather than picked silently. Correcting
  requires a Level 3 human and a reason.
- **`sourceChannel` is required, not defaulted.** "Unknown" would be indistinguishable from a real
  answer the moment anyone ran a channel report.
- **Conversion cannot outrun compliance.** It creates a client through 1.1, which starts in
  `pending_assessment` - the state the gate refuses - and that is **tested** rather than asserted,
  because the day somebody adds a second path to a client record is the day a comment stops being
  true and nothing notices.
- **Inactivity is derived, not scheduled** (fifth appearance of that reasoning). Stale on day 46;
  `lastActivityAt` moves only forward, so a back-dated note cannot make an escalation disappear.
  The escalation raises a 2.4 task and is idempotent - a version that re-raised every pass would
  queue the same lead daily until somebody stopped reading the queue.
- **Expansion signals are prompts, not instructions.** Each carries what moved and by how much;
  `readiness_improved` and `blueprint_aged` are reported separately because they call for different
  conversations. Readiness readings live in their own table, since comparing across time against an
  overwritten column is a comparison with itself.
- **`at_risk` is separated from `lapsed`** - the difference is whether anybody is still in time to
  have the conversation.
- **Loss reasons are categorical**, and conversion rate returns `null` below 10 decided leads: a
  channel report ranking partners on three leads each would send a marketing budget onto noise.

**Fixed:** conversion created the client _before_ validating the offer, so a bad offer key left an
orphan client and a retry created a second. **A function whose refusal path leaves a partial write
is not refusing.** Caught by a test named for the property the code was failing to honour.

**Tests:** 574 pass (28 new). The inactivity clock guard and the double-conversion guard were
mutation-verified - disabling either produces 2 failures.

### Added — Pricing, Billing & Offer Management (`ai-feature/m1-4-pricing-billing-offers`)

**1.4 Pricing, Billing & Offer Management** — the offer ladder, engagements, the credit chain and
objective refund triggers. See [docs/m1-4-pricing-billing-offers.md](docs/m1-4-pricing-billing-offers.md)
and [ADR-0011](docs/decisions/ADR-0011-money-is-cents-and-refunds-are-derived.md).

- **Closes 7.3's last Fact Check row.** The fee exhibit is now built from the engagement record
  rather than from figures a caller asserts, so the tier and the retainer are the ones actually
  sold. The Seek Capital lesson now holds on both sides: 7.3 makes it impossible to _state_ a
  success fee on a requested limit, 1.4 makes it impossible to _charge_ one.
- **Money is integer cents**, rates are basis points, and `fromDollars` throws on a fraction of a
  cent rather than truncating. Four failures this makes unreachable: `(0.615).toFixed(2)` is
  `'0.61'`; 8.5% of $1,040.11 drifts; `paid - earned` can produce a sub-cent or **negative** refund;
  a hundred subtractions do not return to zero.
- **Rounding goes to the client** — fees round down, refunds round up, as a named parameter at
  every call site rather than a convention. At most a cent per line, and no client is overcharged
  by rounding.
- **Refund entitlement is derived, and the default is to pay.** Granting a triggered refund needs
  no approval; **declining one needs a Level 3 human and a recorded reason**, written to the Ledger
  as well as the refund record. `payRefund` refuses to record a payment the record cannot explain —
  an ex-gratia payment is legitimate and belongs in a path that says so.
- **The 60-day trigger fires on day 61**, matched to the fee by its approved credit limit rather
  than by amount or date, which breaks the moment two approvals land in one engagement.
- **"Engagement quality failure" is not objective as the blueprint writes it.** Given a measurable
  definition (committed window ended with no approval obtained) and flagged for review, rather than
  implementing a judgement call as though it were a fact.
- **Credit draws on a specific billing record**, so double-crediting is arithmetically impossible
  rather than procedurally discouraged. Refunded money is not offered as credit, and `applyCredit`
  refuses rather than clamping — a smaller credit reported as success leaves an unexplained
  difference on an invoice a client reads.
- **The sign of a billing line is carried by its kind, not by the number**; a negative charge is
  refused. The balance names its four components, and `outstanding` never goes negative.

**Corrected:** the module header and plan illustrated the float hazard with "8.5% of $47,300",
which is exact — as were two further attempts. Writing the assertion caught it. An illustrative
example in a comment is a claim, and nothing checks a claim in a comment.

> **Observed once, unreproduced:** a single full-suite run failed where four subsequent runs
> passed. It occurred in one command that restored source files, ran the formatter and ran the
> tests — and tests resolve to source, so prettier was rewriting files vitest was reading. Recorded
> rather than passed over, because a green re-run proves nothing on its own.

**Tests:** 546 pass (41 new). The decline gate and the double-credit guard were mutation-verified —
disabling either produces 3 failures.

### Added — Contract & Disclosure Builder (`ai-feature/m7-3-contract-disclosure-builder`)

**7.3 Contract & Disclosure Builder** — the documents a client signs. See
[docs/m7-3-contract-disclosure-builder.md](docs/m7-3-contract-disclosure-builder.md) and
[ADR-0010](docs/decisions/ADR-0010-an-issued-contract-is-frozen.md).

- **An issued contract is frozen.** Blueprint 7.3 lists "auto-updates when Regulatory Engine flags
  rule changes"; read literally that reaches into signed agreements and changes their terms. A
  signed agreement is the only evidence of what was agreed. "Auto-update" is implemented as the
  content of the **next** document plus a **derived staleness report** over what was issued —
  nothing rewrites one.
- **Staleness is deliberately stricter than 7.2's gate.** A state stays online through an editorial
  module change; a document generated against any superseded version is flagged, editorial
  included — but the report says which kind it was. A report that cannot tell "the law changed"
  from "we fixed a typo" gets ignored wholesale.
- **Generation is gated three ways**: the Regulatory Engine activation gate, counsel review of the
  exact template version, and clause resolution. A template naming a clause that does not resolve
  is a **refusal** — generating without it produces an agreement silently missing a term.
- **Banned language is a refusal, not a finding.** The same phrase that is a compliance finding in
  a marketing email is a _term of the contract_ in a signed agreement. `requires_disclosure` is
  checked against what the document actually carries rather than taken at face value.
- **The fee exhibit has nowhere to put a requested limit.** `FeeExhibitInput` carries no
  applied-for field and the computation goes through `successFeeBasis`, which takes a single
  numeric argument — so there is no second figure for the arithmetic to reach for. With no
  approval the fee is **contingent, not estimated**: an estimate in a fee exhibit reads as a price.
- **Disclosure wording has one home.** `not_a_lender` and `no_guarantee` are inserted by key from
  7.2's federal baseline. A second copy would not become wrong so much as become ambiguous.
- **An empty clause scope means "applies to all", not "applies to none"** — read the other way, an
  omitted field silently drops a required term from every document. A state-scoped clause beats a
  global one of the same key, because two versions of one term in a document is worse than the
  wrong version.
- **Unresolved placeholders stay visible.** `{{clientLegalName}}` in a contract is obviously broken
  and gets caught; an empty gap looks like a formatting slip and gets signed.
- **Template review mirrors 7.2's discipline rather than sharing its code** — different subject,
  different blocking effect, and sharing would couple state activation to template publishing. The
  trigger to extract is a third reviewable artifact type, recorded so the decision reads as made
  rather than missed.

> **No contract language ships in this slice.** 7.2's state modules could be scaffolded from
> published statutes; a service agreement is drafting, and drafting a contract is not something to
> scaffold from a specification.

**Tests:** 505 pass (30 new). The template-review gate and the fee basis were mutation-verified —
disabling either produces 3 failures.

### Added — State-by-State Regulatory Engine (`ai-feature/m7-regulatory-engine`)

**7.2 State-by-State Regulatory Engine**, which makes step 5 of the middleware chain a real check.
See [docs/m7-2-regulatory-engine.md](docs/m7-2-regulatory-engine.md) and
[ADR-0009](docs/decisions/ADR-0009-state-activation-requires-a-human-and-a-document.md).

- **There is now no `not_built` in the fixed seven-step chain.** Step 5 was the last, and
  `notBuilt` is no longer imported by `@bwc/middleware` at all. Ungated vendors still report it
  from `@bwc/integration`, which remains the honest use of the status.
- **The activation gate is the module.** A state with no activation row is not active; only a
  **Level 3 human** can change that; and the level is read from the recorded actor rather than from
  the `EventActor` the caller supplied, because a gate that believes its caller about whether the
  caller is allowed through is not a gate.
- **A counsel review needs a named reviewer, a date and a document reference.** Requiring the
  document does not make the review good — it makes the claim falsifiable, which is the most a data
  model can do.
- **`changeKind` is required on every publish, not defaulted.** Material changes return an
  activated state to review; editorial ones carry activation forward and need a stated rationale;
  version 1 cannot be editorial. The rule is "any material version since the one reviewed", so an
  editorial patch on top of an unreviewed rewrite cannot launder it.
- **Disclosures carry citations, and the federal baseline is returned alongside the state layer,
  never instead of it.** An empty list would read as "nothing must be disclosed here", which is
  never true. `missingDisclosures` matches on an attachment key rather than by searching text: a
  disclosure that is nearly there is not there.
- **5.4's state restrictions arrive by pull**, per ADR-0007 — `checkJurisdiction` is the reader
  that choice was made for. Withdrawing a state likewise takes effect on the next action, with no
  cache to invalidate and no job whose failure would leave it serving clients.
- **An undeterminable jurisdiction is a refusal, not a pass.** "We could not tell which state" and
  "no state rule applies" are different statements, and the value of a pre-action check is that a
  pass means something was checked.
- **The seven V1 priority states seed as drafts** citing the statutes the specification names.
  Where a state's obligations are genuinely uncertain to a non-lawyer the module says so rather
  than inventing a requirement — an invented rule is worse than a missing one, because it looks
  reviewed. Nothing seeded can serve a client; the seeding function has no path to activation.

**Corrected:** the first implementation deactivated on _any_ republish, making `changeKind`
decorative. A test named `leaves activation intact for an editorial change` asserted the opposite —
agreeing with the code and contradicting its own name. A test whose name disagrees with its
assertion is a design question, not a typo.

> **Operational note:** a client in a state that has not been activated cannot be served, and this
> refusal will block real work. That is the intended behaviour. The seeded state modules have not
> been reviewed by counsel and by construction cannot be used until they are.

**Tests:** 475 pass (41 new). The authority check and the material-change rule were
mutation-verified — disabling either produces 5 failures.

### Fixed — PII value-shape detector destroyed identifiers ending in digits (`ai-feature/fix-listener-intermittent`)

Diagnosis and fix for the intermittent flagged during 1.2. **It was not a test defect and not in
the workflow listener** — it was silent data loss in the Event Ledger.

- **Root cause.** `redactPii`'s value-shape rule was `/\b\d{8,17}\b/`. `\b` sits between a word and
  a non-word character, and `-` and `_` are non-word characters — so it matched the digit run
  _inside_ an identifier. Tenant slugs end in eight hex characters, which are all digits **2.34%**
  of the time, so `playbookKey: 'escalate-test-wf-listen-12345678'` was replaced wholesale with
  `[REDACTED]` on its way into an append-only store. Every payload field carrying a slug —
  `playbookKey`, `scope`, `applicationRef` — was affected at the same rate.
- **The listener was innocent.** The test matched a fired trigger by `playbookKey` and found
  `[REDACTED]`, roughly one run in forty. Reverting the regex reproduces the CI failure verbatim,
  including its message.
- **Second occurrence of the same defect**, previously fixed for full UUIDs by stripping them
  before shape-matching. That does nothing for a truncated UUID, or for any identifier that merely
  ends in digits — the first fix listed a shape where it should have fixed the boundary. Now
  `/(?<![A-Za-z0-9_-])\d{8,17}(?![A-Za-z0-9_-])/`: `Account 123456789012 was debited` still
  redacts, `order-123456789012` does not.
- **Accepted false negative, stated rather than buried:** an account number glued to a text prefix
  (`acct-123456789012`) under a non-PII field name is no longer caught by shape. The field-name
  list and `assertNoPii` are the primary defences and are unchanged; value-shape matching is a
  backstop, and a backstop that destroys 2.3% of identifiers costs more than it saves.
- **The module doc now records that a false positive is not cheap.** The same redactor runs on
  Ledger payloads, so it destroys an identifier in the same uneditable store — both directions are
  data loss, and only one announces itself.
- **Regression guards are deterministic, not probabilistic.** A fixed all-digit playbook key in
  `workflow-listener.test.ts` fails every time rather than 2.3% of the time, plus a generative test
  over 10,000 generated slugs that asserts the failing case is actually exercised.

> **Not repairable:** any Ledger row already written with `[REDACTED]` in place of an identifier
> stays that way. The store is append-only by design, so this fix stops the loss rather than
> reversing it.

**Tests:** 434 pass (4 new). Mutation-verified — restoring the old regex fails all three new guards.

### Added — Client Household / Entity Graph (`ai-feature/m1-2-entity-graph`)

**1.2 Client Household / Entity Graph**, which closes the last `not_built` in the funding path. See
[docs/m1-2-entity-graph.md](docs/m1-2-entity-graph.md) and
[ADR-0008](docs/decisions/ADR-0008-relationship-detection-produces-questions.md).

- **The question it answers**: a client guarantees a facility for their operating company, another
  for the real-estate entity that leases them premises, another for a partner's DBA. Each was
  reasonable alone; nobody holds the total, including the client. The first lender to ask gets a
  wrong answer.
- **Detection produces questions, not conclusions.** Every signal has an innocent explanation that
  is usually the true one, so a `RelationshipFinding` carries the question to put to the client and
  has no field in which a verdict could be recorded. The value survives the reframing intact — an
  underwriter runs the same checks, so the client should hear the question from us first. The
  common-control threshold is 25%, the FinCEN line a lender's own KYC uses.
- **The risk rating is categorical with no number at all**, deliberately not following 5.1's
  precedent: a health score summarises measured quantities, a graph rating summarises structural
  facts, and a number there would be arithmetic performed on judgements. The band is the **worst**
  component, not an average — averaging is what lets a cross-guarantee ring be diluted into
  "elevated" by three tidy components.
- **Exposure distinguishes a guarantee of an entity from a guarantee of a facility.** The first
  picks up debt signed after it was given; the second does not. Collapsing them overstates or hides,
  and both produce a confident number. Limits cap the guarantor's contribution per guarantee;
  obligations with no recorded amount are counted, not zeroed.
- **`EDGE_RULES` recovers the type safety a single edge table gives up.** A reversed `ownership`
  edge produces numbers rather than errors, so every kind's legal endpoints are declared as data a
  test can iterate.
- **Cycles are the thing being looked for**, not a hazard to guard against: rings are deduplicated
  by rotation so one ring is not reported three times.
- **The derived profile closes 5.3.** Tenure is derived from the formation date every time and
  counted the way a lender counts. What the graph cannot know stays `null` — a credit score needs an
  ungated bureau vendor — which is exactly what 5.2's three-valued eligibility was built for.
- **SSN and EIN never enter a `Graph` value.** Envelope-encrypted at rest, display last-4 only, so
  no traversal, finding or ledger payload can carry one. `revealSsn`/`revealEin` require a stated
  purpose and write an access event.
- **`client_stated` is a new provenance tag in core.** A self-reported revenue is neither a vendor
  feed nor our assumption, and storing it as either is Decision D's failure in different clothing.
  `fromProvenance` in `@bwc/lenders` throws on it — a lender rule cannot be client-stated.

**There is no `not_built` left in the funding path.** The assertion in `placement-gate.test.ts` has
moved twice, each time because a module named in a refusal got built; it is now `no_data`.
`notBuilt` is no longer imported by `@bwc/placement`.

**Corrected:** an entity with debt and no recorded owner produced no finding, though "who owns this
company?" is a lender's first question. Surfaced by a test that expected findings and got none.

**Fixed (pre-existing):** `vault-encryption.test.ts` tampered with an auth tag by overwriting its
first two hex characters with `00`, which is a no-op roughly once in 256 runs. It failed once during
a full-suite run on unrelated work — the only way a 0.4% flake ever surfaces. The tampered value is
now derived from the real one.

**Tests:** 430 pass (57 new). The guarantee-cap arithmetic and the SSN payload discipline were
mutation-verified; the SSN leak was caught twice, once by the payload assertion and once by the
Ledger's own redactor.

### Added — Lender Intelligence & Capital Product Governance (`ai-feature/m5-lender-intelligence-and-governance`)

**5.2 Lender Intelligence Database**, **5.4 Capital Product Governance Board**, and the
**completion of 5.3 Funding Recommendation Engine**. See
[docs/m5-lender-intelligence-and-governance.md](docs/m5-lender-intelligence-and-governance.md) and
[ADR-0007](docs/decisions/ADR-0007-governance-status-lives-outside-the-provider-record.md).

- **5.2 pulled forward from V1.5.** The blueprint defers 5.2 while putting 5.3 and 5.4 in V1 — two
  V1 modules whose stated function is reading from and writing to it. What Decision D actually
  defers is credit-union _research scope_, not the existence of a catalogue, so the database comes
  forward and **the restriction is enforced in code**.
- **Decision D is enforced at approval, not registration.** Recording what we know about a deferred
  credit union is the V1.5 research work; deciding agents may place clients there is a different
  act, and it is the one V1 restricts. `approve()` refuses a non–Navy Federal credit union by name,
  citing the decision.
- **Governance status lives in its own schema.** A provider the board has never seen has no
  governance row, and absence resolves to _not approved_ — the Lender Intelligence Database has no
  field with which to say otherwise.
- **Standing is derived at read time, never stored.** A nightly staleness job that stops leaves
  every stale provider reading as approved with no signal at all; deriving it means a provider
  reviewed 91 days ago is overdue on every machine, including one switched off for a month. State
  restrictions are pulled by the Regulatory Engine for the same reason — a push can lag.
- **Provenance on every rule, structurally.** `recordRule` takes a `Provenance` value, not loose
  columns, and stores it as queryable columns so _"what are we telling clients that nobody
  verified?"_ is one query. Rules **supersede rather than overwrite**, in one transaction, and the
  superseded version keeps its own provenance — it was an assumption at the time.
- **Eligibility has three verdicts.** `unknown` is its own answer naming the missing field:
  collapsing it into `ineligible` hides every good provider until a file is complete, and into
  `eligible` fabricates a recommendation. Ineligible outranks unknown. A null threshold is not a
  threshold of zero.
- **Suitability is separate from eligibility**, because the products easiest to qualify for are
  frequently the worst fit. Poor fits are surfaced as **cautions, never filtered out**.
- **Approval rate returns `null` below 10 decided applications.** Withdrawals are excluded from the
  denominator; profile cohorts are coarse so no client becomes a cohort of one.
- **Complaints are severity-weighted and flag rather than suspend.** One severe complaint reaches
  the threshold and moves the provider to `under_review`; auto-suspension would let one complaint
  remove a provider without a human weighing it.
- **5.3 now recommends.** Its `not_built` named 5.2, which had become a false statement about
  itself. Rejected alternatives carry the rule that produced them; options below the presentation
  limit are still counted as considered. `placement.recommended` carries offering ids and never
  client attributes.
- **The three empty states are now all reachable and distinct**: `not_built` (1.2 Entity Graph
  holds no underwriting profile), `no_data` for an empty catalogue, `no_data` with a per-stage tally
  when nothing survives.

**Corrected:** `no_data` said "none survived" when an incomplete file was the cause, reading as
_there is nothing for this client_ when providers were one recorded field away. It now names the
fields to record.

**Tests:** 373 pass (86 new). Decision D and the derived review cadence were mutation-verified —
disabling either produces 9 failures.

### Added — Capital Stack & Cost of Capital (`ai-feature/m5-capital-stack-and-cost-of-capital`)

**5.1 Capital Stack & Monitoring** and **5.6 Cost of Capital Calculator** — the two modules that
answer what capital a client has and what it is actually costing them. (5.3 needs the Lender
Intelligence Database and 5.4 governs providers inside it; both belong with 5.2 in a later slice.)

- **The cost engine solves the real cash flows** rather than approximating. A "1.4 factor" sounds
  like 40%; repaid daily over six months it is an APR well north of 140%, because principal is
  repaid from day one. Closed-form approximations err in the direction that flatters exactly those
  products. **Bisection, not Newton–Raphson** — Newton needs a derivative that is easy to get
  subtly wrong and diverges on precisely the steep curves this module exists to expose.
- **Details that change the answer:** compounding annualization, 252 banking days for daily
  cadence, origination fees netted from proceeds rather than added to repayment, `factorRate` and
  `annualRate` separately named and mutually exclusive, blended cost weighted by outstanding
  balance, undrawn limits excluded, refinance compared on **total cost** with an explicit caveat
  when a lower APR carries a higher one.
- **An uncostable stack returns `null`, never `0`** — zero would read as "this stack is free".
- **The health score carries its components** and has no constructor that omits them: Decision E's
  lesson applied without contradicting blueprint 5.1's named score. Over-limit zeroes utilization
  outright; an uncosted stack scores 50 rather than 100, because an unknown must not read as good
  news.
- **Monitoring:** over-limit flagged not clamped; limitless positions excluded from the aggregate
  utilization denominator; PG exposure aggregated per owner and capped per limited guarantee; promo
  alerts fire on exact threshold days (90/60/30) rather than every day below them; payment calendar
  normalizes mixed cadences to a monthly equivalent. Scheduling stays with the Workflow Engine.
- 40 new tests (287 total), anchored on known answers rather than self-consistency.

### Fixed

- **The IRR solver's NPV tolerance was absolute where it had to be relative.** An absolute
  threshold is unreachable at double precision on flows of hundreds of thousands and far too loose
  on a small advance; it now scales to the initial flow. Surfaced by a test assertion that had the
  same flaw and failed at a relative error of 2e-10.
- **Under-repayment has a real negative IRR.** The solver documented and a test asserted that no
  rate existed; both were wrong. The negative rate is returned, because a negative effective APR is
  a data-quality signal and suppressing it would hide bad inputs behind an empty result.

### Added — Document Intelligence Pipeline (`ai-feature/m3-3-document-intelligence-pipeline`)

**3.3 Document Intelligence Pipeline. Completes Category 3.**

Every vendor in 3.3's eight-step flow is ungated (§11.4, §12.3), so the module is split along the
line the gates draw: ingestion is consent-gated seams reporting `not_built`, while normalization,
enrichment and correlation are pure functions over a shape we own — fully built and fully tested.

- **Normalized on our own shape**, not Plaid's. It is the only way to build this today, Decision
  A's V2 roadmap replaces Plaid for parsing, and bureau and bank data have to meet somewhere.
- **Consent is checked before the vendor gate.** If the client has not authorized the pull, that
  is the accurate reason — our vendor gate is a fact about us. Every attempt is recorded, so
  "tried and could not" stays distinguishable from "never tried".
- **Deterministic categorization with a stated basis per category**, not a model: a category feeds
  a funding recommendation, and "the classifier said so" is not a derivation anyone can audit.
  `uncategorized` share is reported rather than hidden.
- **Coverage travels with every claim.** Thin coverage downgrades severity rather than suppressing
  a finding.
- **Anomalies relative to the client**, not fixed thresholds — a large deposit is 3× that client's
  own median, because $80k is unremarkable for one client and the event of the year for another.
- **No finding contains a transaction description.** Descriptions carry counterparty names and
  findings reach the Ledger.
- **Correlation refuses rather than inventing agreement** — an absent side returns `no_data`
  naming which side, because an empty correlation result reads downstream as "checked, no
  disagreement".
- **Missing-document detection** over the Vault, one finding per missing document since each is
  independently actionable. `classifyByFilename` returns `null` rather than `other` when it cannot
  tell.
- 41 new tests (247 total). The analysis suite needs no database and no vendor.

### Fixed

- Tax-return filename classification never matched a real IRS form. `\b1120\b` fails on `1120S`,
  because the word boundary needs a non-word character after the `0` — and every real form carries
  a letter suffix.

### Added — Secure Document Vault (`ai-feature/m3-2-secure-document-vault`)

**3.2 Secure Document Vault.** Encrypted storage for the most sensitive data class in the
portfolio. Everything before this protected decisions, which can be corrected; this protects
documents, and a leaked tax return cannot be.

- **Envelope encryption, AES-256-GCM** (ADR-0006). A random DEK per document, wrapped by a KEK.
  GCM authenticates, so tampering fails loudly rather than decrypting to plausible garbage. KEK
  rotation re-wraps DEKs instead of re-encrypting every document. `KekProvider` is the seam for
  the HSM §6.2 wants.
- **The blob store handles ciphertext only.** "The store never receives plaintext" holds even if
  the store is wrong; "the store encrypts things" would not. Blob keys carry no filename, client
  name or document kind.
- **Two independent integrity checks** — the GCM tag catches tampering with the ciphertext, a
  sha256 of the plaintext catches a blob that decrypts perfectly but is the wrong document.
- **Least privilege by document class** — government IDs at level 3, tax returns and credit
  reports at 2, ordinary financial statements at 0.
- **Access logged before bytes are returned**, refusals included. If the log write fails, the
  caller gets nothing.
- **Watermarking on the bytes** — `pdf-lib` stamps viewer identity, timestamp and document id
  into every exported PDF. Non-PDF exports report `watermarked: false` rather than implying a stamp.
- **Legal hold** blocks export and deletion while still permitting viewing; a human actor is
  required to set or release it.
- **Field-level encryption** for SSN / EIN / account / tax ID, non-deterministic so read access
  cannot become an equality oracle.
- 37 new tests (203 total). The encryption-at-rest test reads the actual file from disk; the
  watermark test inflates content streams and decodes hex text operands.

### Fixed

- **PII redaction was silently destroying UUIDs in the Event Ledger.** The value-shape detector
  matched "8-17 consecutive digits", which also matches a UUID whose first group happens to be all
  digits - roughly 2.3% of them. Instance, document and task ids travel in ledger payloads, so
  about one in forty was replaced with `[REDACTED]` in an append-only store that cannot be
  corrected, and code reading the id back got that string. Surfaced only as an unrelated Prisma
  error ("invalid character ... found `[`") in a workflow test. Identifiers are now stripped
  before shape-matching, so a real SSN beside a UUID is still caught.

**Honest gaps, not silent ones.** No virus scanner exists, so documents land `pending` and are
unreadable until scanned — defaulting to `clean` would assert a check that never ran. Retention
rules come from 7.2/7.5, neither built, so deletion without a resolved schedule returns
`not_built`: over-retention is a liability, but destroying a document a regulator was entitled to
see is irreversible.

### Added — Deliverables, approval pipeline and the Compliance Scanner (`ai-feature/m3-deliverables-and-compliance-scanner`)

Category 3 slice A. **3.1** Document & Deliverable Management, **3.4** Deliverable Approval
Workflow, **4.2** Communication Compliance Scanner, **7.4** Marketing Claim Library. The first
slice that produces something a client receives.

4.2 and 7.4 are included because blueprint 3.4 puts the Scanner in the middle of the approval
pipeline. Without them the pipeline could never complete, on top of middleware step 5 already
refusing every client-facing action — one honest blockage is discipline, two stacked is a system
that cannot be demonstrated.

- **The content model is the artifact** (ADR-0005). A deliverable is a structured document,
  versioned and hashed over canonical JSON, anchored in the Ledger; the PDF is a rendering. Hashing
  bytes would let a font substitution change the evidence while every word stayed the same.
- **Provenance cannot be omitted** — `KeyFigure.value` is `Sourced<T>`, so a figure cannot be
  constructed without it. Unresearched defaults render as `[Unverified assumption]` plus a
  document-level notice (Decision D).
- **Compliance state has no numeric field**, so no renderer can print a score (Decision E).
- **Approval ordering is enforced by state**, not call order: `deliver()` requires `approved`,
  reachable only from `scanned`, reachable only from `qa_checked`. Approval requires a human actor.
- **The Scanner blocks, and scans the content model** — so banned language cannot enter during
  rendering, and a phrase interpolated from client data is checked as thoroughly as the template.
  Word-boundary matching: "guaranteed approval" blocks, "no guarantee of approval" does not.
  An empty claim library **refuses rather than reporting clean**.
- **Claim library entries carry a rationale and are deprecated, never deleted.** Jurisdiction uses
  a `*` sentinel rather than NULL, because `NULL != NULL` in Postgres would have let the unique
  constraint accept two global entries for the same phrase.
- Two real templates (Capital Command Brief, Funding Suitability Memo), both carrying the
  not-a-lender and no-guarantee disclosures.
- ADR-0005, `docs/m3-deliverables-and-compliance-scanner.md`, plan doc.
- 57 new tests (165 total).

### Fixed

- **Any stored deliverable would have failed to render.** `Provenance` carried `Date` objects, but
  deliverable content is stored as JSON — so timestamps came back as strings and
  `describeProvenance` threw on `.toISOString()`. Invisible to unit tests, which never persist.
  Provenance timestamps are now `IsoTimestamp` (ISO strings): a type that crosses a JSON boundary
  should be JSON-native. Guarded by a test that re-reads a deliverable from the database before
  rendering it.

### Added — Workflow Engine scheduler, listener and worker (`ai-feature/m2-2-workflow-scheduler-listener`)

Completes module 2.2. All seven components of Specification v2 §5.3 now exist, and the Engine runs
on its own rather than only when a test calls it.

- **Scheduler** — cron-driven recurring workflows with a stored IANA timezone. Claiming is a
  conditional update on `nextRunAt`, so concurrent workers produce exactly one winner. Catch-up
  fires **once** after an outage rather than once per missed window, recording the gap as
  `workflow.schedule_late`. A schedule that cannot be evaluated, or whose playbook is missing, is
  disabled and logged rather than retried forever.
- **Event listener** — Ledger-triggered workflow initiation and event-wait resolution. Triggers
  carry optional declarative conditions (the playbook predicate language). `seekToLatest()` skips
  existing history so registering a trigger does not fire it retroactively.
- **Worker runtime** (`packages/workflow/src/worker.ts`, `apps/worker`) — scheduler → listener →
  engine on an interval, non-overlapping passes, graceful shutdown, and a loop that survives a
  throwing pass. `pnpm dev:worker` / `pnpm worker`.
- ADR-0004 — `cron-parser` over a hand-rolled evaluator, with the DST case verified before
  adopting; timezone as a stored field rather than a silent UTC default.
- `docs/m2-2-scheduler-listener.md`, `docs/plans/m2-2-scheduler-listener.md`.
- 24 new tests (108 total).

**Exactly-once is enforced by a unique constraint on `(triggerId, ledgerEventId)`, not by the
cursor.** A crash between starting an instance and advancing the cursor replays the event, the
insert conflicts, and nothing starts twice — a duplicated workflow here means duplicated client
outreach, and both instances would look legitimate.

### Fixed

- **Concurrent Event Ledger appends to the same tenant threw instead of ordering.** `append` ran
  under `Serializable` with a monotonic per-tenant `seq`, so two appends racing — two workers, or
  a worker and the API — aborted one with a serialization failure. Surfaced by the concurrent
  scheduler test on CI's faster machine while passing locally.

  The fix is a per-tenant transaction-scoped advisory lock **plus `ReadCommitted`**. An advisory
  lock alone was not enough: under `Serializable` the snapshot is fixed at transaction start, so
  the waiter acquired the lock and still read a tail from before the other commit. A lock
  serializes entry; it cannot refresh a snapshot. Guarded by a test that fires 12 concurrent
  appends and asserts a contiguous sequence and an intact chain.

- **Event-waits could never advance.** The listener set a resolved wait back to `pending`, but the
  engine's `wait` handler re-parks any event-wait it claims — so the task ping-ponged between
  `pending` and `waiting` forever and the workflow never progressed, with nothing failing.
  Resolution now goes through `resolveEventWait()` in the engine, which owns graph advancement.
- `@bwc/db` exported `Prisma` type-only, so `Prisma.DbNull` — a runtime sentinel needed to write a
  nullable JSON column — was unavailable to consumers.

### Added — Workflow Engine core (`ai-feature/m2-2-workflow-engine-core`)

- **2.2 Workflow Engine** — playbooks as versioned node graphs, instance lifecycle, and the worker
  tick. Decision C: the Console is the runner for all workflows.
  - Durable Postgres task queue with `FOR UPDATE SKIP LOCKED`, claim leases and reclaim-on-expiry
    for crash recovery (ADR-0003).
  - Retry with exponential backoff capped at 24h, then dead-letter. Every failure, retry and
    dead-letter writes a ledger event — §10.5 requires zero silent workflow failures.
  - Wait states: a row with a future `runAt`, so 90 days is the same code path as 90 seconds.
  - Decision points via a declarative predicate language — no `eval`, three reachable roots,
    prototype keys rejected, ordered comparison restricted to numbers and dates.
  - SLA breach escalation, exactly once per task, notifying Compliance & Evidence.
  - Playbooks validated at publish (dangling `next`, unreachable nodes, no terminal), and versions
    pinned at instance start so publishing a new version does not re-route work in flight.
- **11.4 Notification & Task Queue** — the assignment record the Engine dispatches through.
- ADR-0003 — Postgres-backed queue over BullMQ/Redis: one durability domain, so task state,
  instance state and the ledger commit together.
- `docs/m2-2-workflow-engine.md`, `docs/plans/m2-2-workflow-engine.md`.
- 31 new tests (84 total).

### Fixed

- **Raw SQL timestamp comparisons shifted by the local UTC offset.** Prisma maps `DateTime` to a
  naive `timestamp(3)` holding UTC, but a JS `Date` bound into `$queryRaw` is sent as
  _timestamptz_, so Postgres converted through the session timezone. The task-queue claim query
  returned the wrong rows with no error — and would have looked correct on a UTC machine.
  Timestamps now cross into raw SQL as ISO strings cast to `timestamp`; guarded by
  `tests/invariants/raw-sql-timestamps.test.ts`, which asserts raw SQL and Prisma agree.
- **`start()` ignored the injected clock**, stamping the first task's `runAt` and `slaDueAt` from
  wall-clock time while every other engine function took `now`. Instances started under a test
  clock got SLA deadlines already breached.

### Added — Walking Skeleton on the Spine (`ai-feature/walking-skeleton-spine`)

- **pnpm + Turborepo monorepo**, TypeScript end-to-end. Eleven workspace packages named for the
  blueprint modules they implement, plus `apps/api`.
- **11.3 Event Ledger** — append-only, hash-chained, HMAC-signed, with `verifyIntegrity` that
  reports how many entries it checked. UPDATE, DELETE and TRUNCATE are rejected by database
  triggers, not by repository convention.
- **11.1 Identity & Access** — actors, Authority Levels 0–3, and the Level 4 prohibited-action
  perimeter that no actor can cross at any level.
- **11.2 Tenant / Organization Model** — the isolation check, called once by the chain.
- **Middleware chain** — the seven steps of Specification v2 §5.5 in fixed order, not
  per-route configurable, returning a step trace on every response including refusals.
- **1.1 Client Lifecycle & CRM** — client record and compliance categorical state; findings
  travel with each transition into the ledger event.
- **1.5 Consent & Authorization Center** — per-application, per-pull and per-connection consent;
  an unscoped consent is refused rather than stored.
- **6.2 Funding Ethics Firewall** — trigger, human-only clear, and the placement gate that
  couples Firewall state to compliance state per Decision E.
- **11.5 Integration Layer** — gated adapters. All V1 vendors report `not_built` with their
  outstanding preconditions named; none fabricate data.
- **5.3 Funding Recommendation Engine** — the refusal path. The recommendation itself awaits the
  Lender Intelligence Database (5.2, V1.5).
- **`Outcome<T>`** — five variants with no empty-success case, mapped to distinct status codes
  (200 / 409 / 501 / 404 / 500). See ADR-0002.
- **53 tests** — an invariant suite with one test per hard invariant, plus middleware-order
  integration tests. Mutation-checked: widening the placement-eligible states turns it red.
- **CI** — four jobs: lint & types, tests, a separately named invariants check, and secret
  hygiene (tracked secret-shaped files, SSN-shaped literals in source).
- `scripts/demo-walking-skeleton.mjs` — one runnable command that drives the whole path.
- ADR-0001 (modular monolith with a Postgres schema per module) and ADR-0002 (`Outcome<T>`).
- `docs/walking-skeleton-spine.md`, `docs/plans/walking-skeleton-spine.md`.

### Fixed

- Placement requests that were refused after the middleware chain (missing per-application
  authorization, or the lender catalogue not existing) left `placement.requested` in the Ledger
  with no terminal event. The Compliance Evidence Vault generates regulator-ready files from that
  history, and a request with no recorded outcome cannot be explained after the fact. Found by
  running the demo; now covered by a test.

### Added — repository setup

- Repository initialized for AI-assisted development.
- `CLAUDE.md` — global AI development context: persona, interaction mode, version control
  conventions, the nine design principles, the five locked decisions (A–E), hard invariants,
  the fixed middleware order, and the six-step delivery recipe.
- `.claude/commands/` — five reusable commands: `impl-feature`, `test-suite`, `deploy-prod`,
  `code-review`, `api-test`, each adapted to the Console's compliance and provenance discipline.
- `docs/reference/blueprint-v2.md` — canonical module-by-module specification (58 modules).
- `docs/reference/specifications-v2.md` — canonical cross-cutting architecture specification.
- `scripts/setup.ps1` — idempotent repository setup and verification script.
- `README.md` — scope, architectural position, locked decisions, workflow, security notice.

### Notes

- No application code scaffolded. Stack selection pending.
