# 11.12 Disaster Recovery & Business Continuity

Packages: none · Schema: none · ADR: none · Blueprint: 11.12 (**V1.5**)

Runbooks, not implementation. Blueprint 11.12 says _"V1 ships foundational backup; full runbooks
including vendor outage scenarios build in V1.5."_ This document is the runbook half. **The backup
half does not exist yet**, and the sections below say so in each place it matters rather than once
at the top.

---

## What this document is honest about

Read this first, because every procedure below depends on it.

| Thing                                          | State                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Backup schedule, automated backup verification | **Not built.** No script, no cron, no `scripts/` entry, nothing in `apps/`                  |
| Restore tooling                                | **Not built.** No restore path has ever been executed against this system                   |
| RTO / RPO targets                              | **Not set.** No number has been agreed, so none is quoted here                              |
| DR drills                                      | **Never run.** Zero                                                                         |
| Runbook execution tracking                     | **Not built**                                                                               |
| Argus incident-response integration            | **Not built.** Argus has not reviewed this system                                           |
| `verifyIntegrity`                              | **Built and reachable** (`packages/ledger/src/index.ts`), and **nothing schedules it**      |
| Ledger high-water marks                        | **Not recorded anywhere**, which section 2 explains is the gap that makes truncation silent |

Everything below is therefore a **procedure somebody would follow**, not a procedure anybody has
followed. Where a step depends on a thing that does not exist, it is marked **[UNBUILT]**. Where a
step exists but has never been executed against real data, it is marked **[UNTESTED]**.

Specification v2 §10.1 asks for quarterly ledger verification. Nothing runs it on a schedule, so
the quarterly claim is currently a document rather than a control.

---

## 1. What has to survive

Two stores and three keys. Losing any one of the five loses something that cannot be reconstructed
from the others.

### The two stores

**Postgres** holds everything with a Prisma model — the Event Ledger, identity, tenancy, clients,
contracts, billing, the configuration audit trail, and the vault's document _metadata_.

**The vault blob store** holds the encrypted document _bytes_. Today that is
`LocalEncryptedStore(process.env['VAULT_BLOB_ROOT'] ?? './.vault')`, wired in
`apps/portal-api/src/server.ts` — **a filesystem directory, not object storage**. It is not in
Postgres, so a database backup does not contain it, and a system backed up by `pg_dump` alone has
backed up the index to the documents and none of the documents.

**They must be restored to a consistent point.** Metadata newer than blobs gives rows pointing at
files that are not there; blobs newer than metadata gives undiscoverable ciphertext. Neither
surfaces as an error at restore time — the first surfaces when a client opens a document and the
second never surfaces at all.

### The three keys

Each is an environment variable read by the package that owns it. **None is in a managed secret
store or an HSM today**, and `apps/portal-api/src/server.ts` says so in its own header about
`VAULT_KEK` and §6.2.

| Key                  | Read by                                | What its loss costs                                                                                                                    |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_KEK`          | `@bwc/crypto` (`EnvKekProvider`)       | **Every document in the vault is unrecoverable.** The blobs survive the backup and decrypt to nothing                                  |
| `MFA_SECRET_KEY`     | `@bwc/identity` (`mfa.ts`, `staff.ts`) | Every TOTP secret is undecryptable. Nobody is locked out permanently, but every client and staff member must re-enrol an authenticator |
| `LEDGER_SIGNING_KEY` | `@bwc/ledger`                          | **The entire history becomes unverifiable** — see section 2, because this is worse than it first sounds                                |

`MFA_SECRET_KEY` is deliberately a different key from `VAULT_KEK`; `packages/identity/src/mfa.ts`
states the reason at the constant. Backing them up to the same place undoes that separation, so
they need separate custody, not one envelope with three keys in it.

---

## 2. The Event Ledger constrains what "restore" is allowed to mean

This is the section that makes ledger recovery different from ordinary database recovery, and it is
the one to read before touching a backup.

### How the chain is built

`packages/ledger/src/index.ts`. Per tenant, `seq` is monotonic from 1. Each entry's `prevHash` is
the **previous entry's signature**; the first is `GENESIS_HASH`. The signature is an HMAC-SHA256,
keyed by `LEDGER_SIGNING_KEY`, over the canonical form of `tenantId`, `seq`, `type`, `actorId`,
`clientId`, `payload` and `prevHash`. The database enforces `@@unique([tenantId, seq])`.

`verifyIntegrity(tenantId)` walks the chain and checks three things: sequence contiguity, `prevHash`
linkage, and every signature.

### Four consequences for recovery

**1. A truncated tail still verifies, and this is the trap.** `verifyIntegrity` checks that the
entries present form an unbroken chain from `seq 1`. It has no idea how long the chain is supposed
to be. Restore a backup that is missing the last four hours and the result is `intact: true` with a
lower `checked` — a **confident, green, wrong** answer. Principle 9's whole argument is that a
system should not report success it has not established, and this is the one place the ledger
cannot self-report.

The mitigation is cheap and **[UNBUILT]**: record `max(seq)` per tenant somewhere outside the
database — the same place the backup catalogue lives — every time a backup is taken, and compare
`checked` against it after every restore. `IntegrityResult.checked` is reported precisely so a
caller can tell "verified 400 entries" from "verified nothing"; nothing yet compares it to an
expectation.

**2. Do not replay writes into a restored tenant.** After a partial restore the tenant's `seq`
resumes from the restored tail. Any attempt to re-apply lost work writes new entries at sequence
numbers that already existed in the lost region, which `@@unique([tenantId, seq])` will refuse for
the overlap and silently accept beyond it — producing a chain that verifies and describes events
that did not happen in that order. **Lost ledger entries are lost.** Record the gap as a
compensating note in the incident record; do not attempt to reconstruct the tail.

**3. Rotating `LEDGER_SIGNING_KEY` invalidates all history.** `LedgerEvent` carries no key id or key
version (`prisma/schema.prisma`, `model LedgerEvent`), so there is no way to verify old entries
under an old key and new ones under a new key. After a rotation, `verifyIntegrity` reports
`signature does not verify` at `seq 1` for every tenant.

This means **key loss and total forgery are indistinguishable to the verifier**, and it means
rotation is not currently an available response to a suspected key compromise. That is a design
limitation worth an ADR and a schema change (a `keyId` column and a keyring) before this system
holds production data. It is named here rather than discovered during an incident.

**4. Restoring the ledger schema alone is not a restore.** `LedgerEvent.tenantId` is a plain
`Uuid` with no foreign key to `Tenant` — deliberately, so events outlive the records they describe.
The consequence for recovery is that the ledger will happily restore into a database with no
matching tenants, actors or clients, and every event will resolve to nothing.

---

## 3. Per-tenant recovery

Multi-tenant isolation is strict (principle 5), which makes single-tenant recovery a coherent
request: restoring one tenant should not touch another's rows.

**It is [UNBUILT] as tooling and [UNTESTED] as a procedure.** What exists is an enumeration of
every per-tenant table, in dependency order, with the ordering hazards commented — and it lives in
**test code**, at `cleanupTenant` in `tests/setup.ts`. That function is a delete, not a restore, but
its ordering is the same ordering a restore has to respect in reverse, and two of its comments are
load-bearing:

- Governance rows reference providers **across a schema boundary with no FK**, so nothing cascades
  and they must be handled explicitly.
- Graph edges reference nodes **polymorphically, without an FK**, so edges and nodes have no
  database-enforced ordering.

**That list being in `tests/setup.ts` is a finding, not a fact to be pleased about.** It is
maintained because tests fail when it drifts, which is a better guarantee than most documentation
gets — but a restore procedure that depends on reading a test fixture is one refactor away from
being wrong. Promoting it to a declared per-tenant table manifest that both the tests and a restore
tool consume is the fix.

Note also that `cleanupTenant` **deliberately does not delete ledger events**, because the ledger is
append-only. A per-tenant restore therefore cannot be done by delete-then-reload for the ledger; it
is either a full-database point-in-time restore or nothing.

### Procedure **[UNTESTED]**

1. Freeze writes for the tenant. There is no per-tenant write freeze; the only available lever is
   stopping the API and worker processes, which affects **every** tenant. **[UNBUILT]**
2. Take a fresh backup of the current state before restoring anything over it.
3. Restore Postgres to the target point in time, and the vault blob root to the **same** point.
4. Run `verifyIntegrity` for the tenant. Compare `checked` against the recorded high-water mark
   (section 2, mitigation 1) — `intact: true` on its own establishes nothing about completeness.
5. Reconcile the vault: every document row should have a blob and every blob a row. **[UNBUILT]** —
   no reconciliation tool exists.
6. Record the recovery point and the size of the gap in the incident record, and do not replay.

---

## 4. Key custody

**Current state: three environment variables, in a `.env` file, on whatever host runs the process.**
There is no key management system, no HSM, no rotation procedure, no escrow, and no test that any
key can be recovered independently of the machine it is on.

What custody has to provide, in the order these become painful:

**Separation.** `VAULT_KEK` and `MFA_SECRET_KEY` are separate keys on purpose. They need separate
custody or the separation is decorative.

**Escrow that survives the host.** A KEK that exists only in the environment of a running process
is one terminated instance away from a vault nobody can open. This is the single highest-severity
gap in this document, because it is the one where the data survives and is still lost.

**Rotation, which is only partly possible today.** `VAULT_KEK` is envelope encryption
(`packages/crypto/src/envelope.ts`), so rotating the KEK means re-wrapping data keys and is
tractable. `MFA_SECRET_KEY` rotation means re-enrolment for everybody, which is disruptive but
finite. `LEDGER_SIGNING_KEY` rotation is **not currently possible without invalidating history** —
section 2, consequence 3.

**A recovery test.** Restoring a vault document using only escrowed key material, on a host that
has never held the original key, is the only thing that establishes escrow works. **It has never
been done.**

---

## 5. Vendor outage

The blueprint names Plaid outage and bureau provider outage specifically. This is the area where the
system is in the **best** shape, because the behaviour was designed rather than left to chance.

`packages/integration/src/` gates every external vendor: `plaid`, `business_bureau`,
`personal_credit`, `capitalforge`. `INTEGRATION_MODE` is `stub | sandbox | live`, and a closed gate
returns an explicit refusal — `"INTEGRATION_MODE is stub. No external call was made and no data was
fabricated."` The gates are closed pending Argus security review and a DPA per vendor.

**The continuity property that matters: an unavailable vendor produces a refusal, not a guess.**
Principle 9 and principle 8 between them mean a Plaid outage degrades to "we could not retrieve
this, and here is why" rather than to a stale or inferred figure presented as current. No module
calls a vendor directly — every integration routes through 11.5 — so there is one place where an
outage is handled and one place to change if that is ever wrong.

### Plaid outage **[UNTESTED]**

1. Confirm the scope: Plaid's own status page, then whether the failure is auth, Link, or Assets.
2. Nothing needs switching off. The gate already refuses and no fabricated balance enters the
   system.
3. Workflows waiting on bank data hold at their wait state — `@bwc/workflow` has durable wait
   states, retry with backoff, and a dead-letter path — so the work resumes rather than being lost.
   **[UNTESTED] against a real multi-hour vendor outage.**
4. Client-facing consequence: capital readiness and cost-of-capital figures that need statement data
   report `no_data` with the reason, not a stale number. Confirm that is what the client actually
   sees before telling them so.
5. Do not raise `INTEGRATION_MODE` to work around it, and do not hand-enter figures from a client
   screenshot — `fabricate_revenue` is on the Level 4 prohibited-action list.

### Bureau provider outage **[UNTESTED]**

Same shape, with one addition: bureau pulls are **per-pull client authorization** (Decision B). An
authorization obtained for a pull that then failed has been spent from the client's point of view
even though no data arrived. Re-pulling after the outage needs the authorization position checked
rather than assumed.

### CapitalForge platform outage **[UNTESTED]**

`capitalforge` is a gated vendor like the others. Decision C is the thing to hold onto: the
Console's own Workflow Engine (2.2) is the runner and **the Console never reads CapitalForge's
workflow store**, so a CapitalForge outage does not stop Console workflows.

### Ransomware / security incident **[UNBUILT]**

Argus is the named partner for incident response and has not been engaged with this system. There
is no incident-response runbook, no agreed contact path, and no forensic retention policy. Writing
one against a system with no backups to recover to would be theatre; the honest sequencing is
backups first, then escrow, then this.

The one system property worth noting for that eventual document: the Event Ledger is append-only and
signed, so it is the most tamper-evident record available — provided `LEDGER_SIGNING_KEY` was not
also taken, in which case section 2's consequence 3 applies and the ledger can no longer distinguish
itself from a forgery.

---

## 6. What to build first

In this order, because each depends on the one before it.

1. **A backup that includes both stores**, taken to a consistent point. Everything here is
   hypothetical until this exists.
2. **Key escrow**, tested by restoring one document on a host that never held the original key.
3. **Ledger high-water marks** recorded per tenant with each backup, and compared after each
   restore. Cheap, and it closes the silent-truncation hole in section 2.
4. **A per-tenant table manifest** promoted out of `tests/setup.ts` into something a restore tool
   and the tests both read.
5. **A scheduled `verifyIntegrity`** run, which §10.1 already asks for quarterly and which nothing
   currently performs.
6. **`keyId` on `LedgerEvent`** and a keyring, so that signing-key rotation stops being a
   history-invalidating event.
7. **RTO / RPO targets**, agreed with the founder, once 1–3 make a real number knowable. Setting
   them before that would be inventing a figure, which this document declines to do.
8. **A drill.** A runbook nobody has executed is a hypothesis. Every **[UNTESTED]** marker above is
   a step waiting on this.
