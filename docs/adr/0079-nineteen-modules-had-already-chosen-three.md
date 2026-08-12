# 0079 - Nineteen modules had already chosen three

- Status: accepted
- Date: 2026-08-12
- Context: `packages/core/src/authority.ts`, `apps/api/src/routes/*`

## Context

Seventeen Console capabilities had a working module function and no declared action in
`ACTION_MINIMUM_LEVEL`. The surface could read them and could not offer them, and each route said
so in its own `blocked` list rather than leaving a page to wonder.

Batching them for a single decision turned up the thing that made the decision easy: **nineteen
modules had each already picked an Authority Level for their own most consequential act, and every
one chose 3.** `CHANGE_AUTHORITY_LEVEL`, `HOLD_AUTHORITY_LEVEL`, `DELETION_AUTHORITY_LEVEL`,
`TERMINATION_AUTHORITY_LEVEL`, `PAYOUT_AUTHORITY_LEVEL`, `MFA_REMOVAL_AUTHORITY_LEVEL` and the rest
— chosen independently, by different people, in different packages, all landing on the ceiling a
human can hold.

So the interesting question was never "what level for the dangerous ones". It was **which of the
seventeen are routine enough to sit below 3** — and that question could not be answered as asked,
because the seventeen were surfaces rather than acts.

## Decision

### Twelve actions from eight capability lines

The seventeen lines bundle roughly sixty-one functions, and several bundle a routine act with an
irreversible one. Batch A took the eight that are irreversible, firm-wide, or move money, and split
them where a single level would have been wrong either way:

`change_system_parameter` · `publish_offer` · `manage_engagement` · `publish_contract_clause` ·
`generate_client_contract` · `reveal_protected_identifier` · `place_legal_hold` ·
`release_legal_hold` · `decide_deletion_request` · `remove_vault_document` ·
`set_document_retention` · `publish_curriculum_module`

**Placing and releasing a hold are two actions, not one.** Both are Level 3 today. They are
different acts with different consequences — a hold in force costs storage, a hold released early
is what lets records be destroyed while they were still wanted — and the Ledger has to be able to
say which was taken. Splitting also leaves room for a later policy to lower placing without
lowering releasing.

**`reveal_protected_identifier` is not a write.** It is declared because the authority model is the
only place that can gate a READ, and a read nobody had to hold a level for was reachable by anyone
the session let in.

### Three of them are governance actions

`place_legal_hold`, `release_legal_hold` and `decide_deletion_request` skip middleware step 4.

**A hold is placed on exactly the client step 4 refuses.** Litigation is anticipated because
something went wrong, so the client is very often in `fail`, on the Do Not Fund list, or behind a
triggered Firewall. A gate that blocked the hold would mean the firm could not preserve records
precisely when it most needs to — and would go on destroying them on schedule while somebody worked
out why the button did nothing.

Releasing is here too, and that is the uncomfortable half: the same skip that lets a hold be placed
on a failing client lets one be lifted from them. The alternative is worse — a hold nobody can
release is a retention schedule permanently suspended by whoever placed it.

### The irreversible acts got controls, and that was the owner's call

ADR-0032 and ADR-0033 are why these were blocked: a console is what makes a missing credential
exploitable, and a button is what makes an unchecked Authority Level one click away. The
recommendation was to keep deletion completion, vault removal and SSN reveal API-only.

**The owner was shown that argument and chose controls for all of them.** That is theirs to choose,
and it is recorded here rather than quietly softened. The mitigation is that each act is gated at
Level 3, runs through the chain, is attributable to a recorded actor, writes a Ledger event, and is
**named as irreversible on the panel** — not that it is hidden. A control that cannot be undone and
does not say so is a control somebody presses to find out.

## Consequences

**Ten roadmap-blocked writes remain**, plus three that are blocked by design. Batches B, C and D
are the rest, and four of those lines still need splitting before a level means anything.

**`routes/context.ts` exists at last.** Four route modules carried an identical `ConsoleRouteContext`
and a comment saying it should collapse "the moment anybody owns both"; twenty-two copies existed by
the time anybody owned all of them. Seven adopt the shared one here — the ones gaining writes.
The other fifteen are read-only and were left alone rather than swept into a change about something
else.

**Six existing tests failed when this landed, and all six were right to.** They asserted that these
capabilities were blocked and said why. Each was rewritten to assert the new state and to keep the
part that has not changed — that an invariant is absent rather than permission-gated, that the page
still renders no SSN, that the retention panel still grows no control for a deletion.

**The page controls are not in this change.** The actions are declared, the API routes are gated and
tested, and the panels no longer claim these writes are impossible. No view renders an `available`
list yet, so nothing on screen has grown a button. That is the second half of Batch A.
