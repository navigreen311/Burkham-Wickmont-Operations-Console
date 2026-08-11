# Operating the Console: first run to first client

What actually happens, in order, and where it stops. Written to be read by somebody who has to
decide whether this system can serve a client next month.

**The short answer: it cannot, and nothing an engineer does changes that.** The blockers are
signatures, audits and a vendor selection. They are listed in section 5.

---

## 1. First run

You need Postgres, Node 22 and pnpm.

```bash
cp .env.example .env          # fill DATABASE_URL, LEDGER_SIGNING_KEY, VAULT_KEK, MFA_SECRET_KEY
pnpm install
pnpm db:deploy                # applies every migration to an empty database
pnpm build
```

`LEDGER_SIGNING_KEY` must be at least 32 characters. Losing it makes the entire Event Ledger
unverifiable and is indistinguishable from total forgery - see `docs/m11-disaster-recovery.md`,
which also explains why there is currently no key escrow.

## 2. The first Console credential

`inviteStaff` requires a Level 3 human who is already an Actor, so on an empty database there is
nobody to do the inviting. One script stands outside the authority model to create the base case:

```bash
node scripts/bootstrap-console-admin.mjs \
  --email founder@yourfirm.example \
  --name "A Founder"
```

It prints an invitation token **once**. Open the Console, accept it, set a password, enrol a second
factor.

After that the script **refuses to run against this tenant** and says so - the base case is over,
and adding a second operator is `inviteStaff`, performed by the enrolled Level 3 human. Re-running
before anybody has enrolled is safe and re-issues the invitation, because losing the token before
accepting it is the normal way a first run fails.

If the only enrolled person loses access, the path is a credential reset, not a second bootstrap.
There is no code that will let the script open a second door.

## 3. What works today

Everything below runs, is tested, and does not depend on a vendor:

- **Console sign-in** with password plus TOTP or a passkey, staff enrolment by invitation, email
  and password change, password reset.
- **Client records**, the compliance categorical state, the entity graph, consent capture.
- **The seven-step middleware chain** - authentication, tenant scope, authority level, Firewall,
  regulatory check, Ledger event, compliance scan - on every route that acts on a client.
- **The Event Ledger**: append-only, hash-chained, signed, verifiable per tenant.
- **The Workflow Engine** with schedules, wait states, retries and SLA escalation.
- **Deliverables, the document Vault, contracts and disclosures, billing and refunds.**
- **Regulatory state modules** with counsel review and activation.
- **The Client Portal**, behind its own authentication.

## 4. What is gated, and what that means in practice

Four vendor gates control whether client financial data may leave this firm. **None is open.**

| Vendor          | Carries                                 | Outstanding                                        |
| --------------- | --------------------------------------- | -------------------------------------------------- |
| Plaid           | Bank statements, balances, transactions | vendor selection, Argus review, DPA, SOC 2 Type II |
| Business bureau | Business credit reports                 | **the vendor has not been chosen**, plus all three |
| Personal credit | Personal credit reports                 | **the vendor has not been chosen**, plus all three |
| CapitalForge    | Cross-venture workflow data             | all four                                           |

Activation is not a config change. It is a recorded governance act (ADR-0065): each precondition
needs a **document reference** accepted by a named Level 3 human on a date, and a security
attestation must carry the date it stops describing the vendor. Evidence that expires closes the
gate on its own.

Until then, every adapter reports `not_built` naming what is outstanding, and
`mayOnboardClients()` refuses. That refusal is the system enforcing CLAUDE.md's standing
constraint, not a bug.

**What this means for a client.** Capital readiness, cost-of-capital and placement recommendations
all read bank and bureau data. With the gates closed they report `no_data` with the reason rather
than a number. The system will not fabricate a figure, and it will not let one be entered by hand
to fill the gap - `fabricate_revenue` is on the Level 4 prohibited-action list.

To see the board: sign in and read the **Vendor activation** panel, or
`GET /api/integrations/activation`. It shows what is outstanding per vendor, who accepted what,
when, and when it expires.

**There is no form for accepting evidence**, deliberately (ADR-0066). A text box beside "SOC 2
cleared" is how this control becomes a checkbox. Recording goes through `recordEvidence`, called
deliberately, until there is a flow that carries the document itself into the Vault.

## 5. What stands between this system and a first client

**Every item is something no engineer can do.**

1. **Choose the business credit bureau.** Nav for Partners, Experian Business or D&B Direct+.
   Nothing can be reviewed until somebody picks a counterparty.
2. **Choose the personal credit provider.** Array or equivalent. Same.
3. **Argus security review of Plaid**, and a report number to record.
4. **Argus security review of the chosen business bureau.**
5. **Argus security review of the chosen personal credit provider.**
6. **A signed DPA with each of the three**, executed by both parties.
7. **A SOC 2 Type II report for each of the three**, verified, with the period it covers.
8. **Counsel review of at least one state's regulatory module**, with a document reference - no
   state comes online without it, and no client-facing action fires in a state that is not online.
9. **A Level 3 human to accept all of the above**, on the record, one document at a time.

Two more that are not vendor gates and are equally outside engineering:

10. **Key escrow for `VAULT_KEK`, `MFA_SECRET_KEY` and `LEDGER_SIGNING_KEY`**, tested by restoring
    a document on a host that never held the original key. Today these are environment variables
    and losing one loses the vault.
11. **A referral-fee rule per state** before any partner can be paid (ADR-0053), each citing the
    statute.

## 6. Honest gaps a reader should know about

- **No backups exist.** No schedule, no restore path, no RTO/RPO, no drill. See
  `docs/m11-disaster-recovery.md`, which also explains why a truncated ledger restore still
  verifies.
- **`@bwc/intelligence` reads the old synchronous gate**, so it will keep refusing even after a
  vendor's evidence is complete, until it moves to `activationStanding` (ADR-0065).
- **Vendor evidence acceptance emits no Ledger event.** The row is the record; the Ledger is where
  an audit looks first, and the event type needs adding by a slice that owns
  `packages/core/src/events.ts`.
- **Nothing is monitored.** 11.8 reports `unmonitored` for most components, which is the honest
  state of a system with no metrics backend.

## 7. Commands

```bash
pnpm verify                  # lint, typecheck, full test suite
pnpm db:deploy               # migrations onto an empty database
pnpm build && pnpm test:e2e  # browser suite
pnpm dev:api                 # Console API
pnpm worker                  # workflow worker
node scripts/bootstrap-console-admin.mjs --email <you> --name "<name>"
```
