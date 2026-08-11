# ADR-0047 — The gate that was already stronger than the chain

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 7.2 State-by-State Regulatory Engine, and the four surfaces beside it

## Context

Every write in this Console goes through `chain()` with a declared action. ADR-0033 established
that, and it established it by finding the opposite: three writes that called their modules directly
with no Authority Level checked at all.

This slice surfaces five modules. **Every write all five expose lacks an action in
`ACTION_MINIMUM_LEVEL`**, and `decideAuthority` refuses an action absent from the catalogue — so
none of them can pass middleware step 3. `packages/core` belongs to another slice, so the rule this
branch was given is to stop and report.

That would have made 7.2 read-only, and 7.2 is the reason the batch exists. **No state is
activated**, so step 5 refuses every client-facing action; the firm cannot serve anybody in any
jurisdiction. A page that could show that and not fix it is a diagnosis, not a console.

## Decision

**State activation and withdrawal ship as writes that do not call `chain()`. Everything else in the
batch ships read-only and is reported.**

The distinction is not "7.2 is important". It is that **7.2 already has a gate, and it is stricter
than the one the chain would apply**:

|                  | what it checks                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain()` step 3 | `actor.authorityLevel >= ACTION_MINIMUM_LEVEL[action]` — a number                                                                                                          |
| ADR-0009         | re-reads the actor from the database, and requires `kind === 'human'` **and** Level 3 **and** a named reviewing counsel **and** a review date **and** a document reference |

**A Level 3 village agent passes the first and is refused by the second.** So routing activation
through the chain would not have added a check. It would have placed a weaker one beside a stronger
one — and the weaker one is what a future reader would take for the gate.

That is the whole argument, and it does not generalise. It does not apply to `exportEvidenceFile`,
which checks that a purpose and a requester were supplied and nothing about who is asking. It does
not apply to the 5.4 board writes, which check nothing. It does not even apply to 4.5's proposal
decisions, which do check Level 3 on the recorded actor but **do not require a human** — so for
those the chain's step 3 and the module's check are equivalent, and equivalent is not stronger.

### What the chain would have added, and what this route does instead

Step 2. `activateState` resolves the actor with `findActor(input.actor.id)` and **never compares
tenants**. The route performs the check explicitly.

Mutation testing says that check is currently redundant: `requireStaff` resolves the session against
the configured tenant, so no reachable request carries a foreign actor, and removing the check
leaves every test passing. It stays for the reason ADR-0039 gives about a different pair of guards —
the redundancy is a property of _this caller_, not of the module, and the module is what a second
caller would meet.

### The absence is named, not implied

`/api/console/evidence/clients/:clientId/exports` carries `exportAvailableHere: false` with the
reason and the action it would need; the marketing proposal queue carries the same for its two
decisions. A page with no button and no explanation reads as one somebody had not finished, which is
the distinction principle 9 draws between `not_built` and `no_data` applied to a control.

### What core needs

Levels are proposals with the reasoning written out, per ADR-0033's posture. **A person should
confirm each.**

| Action                                               | Module | Proposed | Why                                                                                                                                                                                            |
| ---------------------------------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activate_state`                                     | 7.2    | **3**    | So this route can stop being an exception. The module gate stays regardless — the catalogue entry would add tenant scope and a ledger event, not replace ADR-0009                              |
| `export_evidence_file`                               | 7.1    | **2**    | An export is a copy of a client's whole compliance history leaving the system. Not 3: assembling evidence for a regulator is ordinary compliance work, and friction here means it happens late |
| `publish_marketing_claim`                            | 7.4    | **3**    | The library is what the Scanner enforces on every outbound message. Publishing to it changes what the firm may say                                                                             |
| `govern_capital_provider`                            | 5.4    | **3**    | Approving, suspending or blacklisting a provider decides who may receive a client's application                                                                                                |
| `record_provider_complaint`                          | 5.4    | **1**    | Recording that somebody complained is not a determination. The asymmetry `trigger_firewall` uses: an unrecorded complaint is the harm                                                          |
| `approve_marketing_claim` / `reject_marketing_claim` | 4.5    | **3**    | The Board's decision. 4.5 already reads Level 3 from the recorded actor, so the catalogue entry would match what the module does                                                               |
| `approve_marketing_asset`                            | 4.5    | **2**    | Client-facing content clearing review, beside `send_client_communication`                                                                                                                      |

## Consequences

**A state can be brought online from a page today**, and the browser journey asserts exactly that:
sign in, find the state, type what the counsel memo says, watch the coverage headline stop saying
that no client can be served.

**One route in this Console does not go through the chain**, and that is a thing to keep true rather
than a thing that is true. The route's own header carries the argument, the response carries a
`gateNote` saying which machinery ran, and the transport test asserts the note — so a reader who
arrives at the response before the source still learns it.

**If `activate_state` is added to the catalogue, this route should be revisited rather than
mechanically converted.** Wrapping the module gate in the chain is right; replacing it is not.

## Alternatives considered

**Ship 7.2 read-only with the rest.** Consistent, and it leaves the firm unable to serve anybody
with a screen that explains why in detail. The whole point of a console is that the person reading
the diagnosis can act on it.

**Add `activate_state` to `packages/core` anyway.** One line, and it is somebody else's file on a
branch that will be merged alongside theirs — `authority.ts` is exactly the file two branches both
touch. It also picks an Authority Level for the most consequential gate in the system as a side
effect of building a page.

**Route activation through `chain()` with a borrowed action.** `transition_compliance_state` is
Level 3 and would technically pass. It would also record in the Ledger that somebody transitioned a
client's compliance state when they activated a jurisdiction, which is a false audit entry — worse
than the missing one.

**Ship every write on the same module-gate reasoning.** The reasoning is specific and does not
survive contact with the other four modules. Generalising it would turn a narrow, argued exception
into the thing ADR-0033 was written to stop.
