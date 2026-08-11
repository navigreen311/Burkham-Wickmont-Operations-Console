# ADR-0042 — A hold is a matter, not a flag on a document

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 7.5 Legal Hold & Record Retention, with 3.2 Secure Document Vault

## Context

3.2 has refused to destroy documents since it was built, honestly, for two different reasons:

- under legal hold — a boolean on the document, set one document at a time by `setLegalHold`;
- with no resolved retention schedule — a `not_built` naming 7.2 and 7.5 as the modules that would
  resolve one.

Both refusals were correct. This ADR is about what happens to them now that 7.5 exists, and the
answer for each is different: the first one grows a second source, and the second one changes status
without changing behaviour.

## Decision

### 1. A hold covers a category of record, and is evaluated rather than propagated

**The obvious build is to set `legalHold = true` on every document in scope when a hold is placed.**
It is fast to query, it needs no new join, and it passes every test anybody would think to write.

It is also wrong, in the one way that matters. A litigation hold placed on Monday does not cover the
bank statement a client uploads on Tuesday, because nothing re-runs the propagation. The hold exists,
the document exists, and no row connects them. That is the classic way an organisation destroys
evidence while believing it preserved it, and it is invisible from every direction — the hold looks
placed, the document looks ordinary, and the deletion looks authorised.

So `holdsCovering` is a **query, asked at the moment of the decision**. It takes a tenant, a client
and a document kind — deliberately not a document id and not an upload date — and the vault asks it
before every export and every deletion. A document stored after the hold is covered by it without
anybody re-running anything.

This is the same move as 1.3's derived inactivity and 6.4's derived overdue review, and the argument
is stronger here. Those cases traded a stored value for a fresh one; this one trades a stored value
for evidence that would otherwise be gone.

**The vault now checks two sources**, its own per-document flag and 7.5's matter-level holds, and
keeps both. `setLegalHold` remains the right tool for "this one document, for this one reason", and
deleting it would have meant migrating a live column for no gain.

**The cost is an import in the wrong direction**: `@bwc/vault` (3.2, storage) now depends on
`@bwc/retention` (7.5, governance). Accepted knowingly, and for the reason ADR-0034 accepted the same
shape between `@bwc/clients` and `@bwc/risk`: **a hold the gate does not consult is not a hold.**
There is no cycle — `@bwc/retention` imports core, db, identity and ledger, and none of them reaches
back.

### 2. Absence of a hold means not held; absence of a schedule means not permitted

These look like the same rule and are opposite, and getting either backwards is silent.

A hold **restricts**, so no row means nothing is restricted. A schedule **permits** — it is an
authorisation to destroy — so no row means nothing is authorised. ADR-0007 and ADR-0009 already say
absence is not permission; this is that rule read carefully enough to notice which side of it each
record sits on.

`resolveRetention` therefore returns `no_data` rather than a default period. **A fallback invented
here would be indistinguishable from a researched one at the moment somebody destroys a record**,
which is Decision D's failure with shredded documents at the end of it rather than a disappointed
client.

### 3. `not_built` becomes `no_data`, and the behaviour does not change

`vault.remove` used to answer `not_built` for an unscheduled document, naming 7.2 and 7.5. That was
true and is now false: **7.5 exists, and a module that exists must stop claiming it does not.**
`empty` is never `not_built`.

The refusal itself is unchanged — the document still survives — and the new answer says what is
actually missing: nobody has recorded a retention period for this document kind. The test that
asserted `not_built` now asserts `no_data`, and its comment says why the status moved.

### 4. An unverified schedule does not authorise destruction

A retention period tagged `unresearched_default`, or an `issuer_rule` whose citation nobody has
checked in a year, does not authorise deletion. The period elapsing is a **necessary** condition for
destruction, not a sufficient one.

ADR-0013's question is "if this record is stale and wrong, which way is safe". For a provider
approval the safe direction was to stop using it; for a Do Not Fund listing it was to keep blocking.
Here it is to keep the record — this is the one operation in the system that cannot be undone.

**The consequence is real and is accepted**: a document whose retention period has run cannot be
destroyed until somebody re-verifies the rule that authorises it. That is a queue
(`unverifiedSchedules`) rather than a dead end, and it is the correct direction of inconvenience.

The staleness window is 365 days, against 5.2's 14-day appetite window and 6.4's 90-day listing
cadence. Statutory periods move slowly; "somebody checked this at some point" is still not the same
claim as "this is current".

### 5. A state rule beats the default, and not "the longest wins"

`stateCode IS NULL` is the default, stored as a sentinel row on the same table rather than in a
second one, so "what applies in Texas" is one query and an ordering rather than two queries and a
merge somebody gets wrong in one direction.

A state-specific rule wins even when it is **shorter**. Taking the longer of the two would look
conservative and would be wrong about the law, which is a worse place to be than wrong and obviously
so.

### 6. This module does not delete anything

7.5 records requests, decides eligibility and records decisions. The vault owns the bytes and owns
the destruction. A second deletion path here would be exactly the second door ADR-0034 is about, on
the one operation that cannot be undone.

`assessEligibility` answers only the hold half, and says so. **Retention cannot be answered per
client**: one client's file holds a signed authorization whose period ran out years ago and a tax
return whose period has not, so a single client-level "retention says yes" would be false about half
the file and there is no honest way to average it.

## Consequences

**A deletion request is recorded even when it will be refused, and especially then.** "We received
your request on the 3rd and refused it on the 5th because these records are under litigation hold
LIT-2026-014" is the sentence a data-subject-rights regime asks for. A request rejected at intake
leaves no evidence it was ever made, and looks identical to one that never arrived.

**A hold outranks an approval, including one a Level 3 human has already granted.** Eligibility is
re-checked at the moment of the decision rather than trusted from the moment of the request, because
a hold placed between the two is exactly the case that matters.

**`vault.remove` takes an input object rather than four positional arguments.** It grew a fifth
(`stateCode`) and a positional list that long is where somebody eventually passes the actor id as
the document id. Four call sites changed, all in tests.

**The client's state is passed in, not looked up.** 7.2's activation model and 1.1's client record
disagree about which state a client "is in" often enough that guessing would silently apply the wrong
statute to a destruction. A caller that knows says so; one that does not gets the default, which is
the conservative rule.

**Ten CHECK constraints**, and the scope one is load-bearing in both directions: a `client` hold with
no client falls through to the tenant-wide branch and holds everyone, and a `tenant` hold carrying a
client id reads as narrower than it is. Mutation-tested — dropping it fails four invariants;
stubbing out the vault's `holdsCovering` call fails the two tests that distinguish this design from
the propagating one.

**Placing a hold takes a Level 3 human, unlike 6.4's automatic listing.** The asymmetry is
deliberate. A Do Not Fund listing has to be automatic because the safe state is blocked and nobody
should have to be awake for it; nothing is preserved by a hold that a machine invented and no lawyer
can explain.

## Alternatives considered

**Propagate on placement, and re-propagate on upload.** Keeps the fast query and closes the gap, by
adding a second thing that has to run. It fails the same way the first version does the moment the
re-propagation is skipped for one code path — and the failure is still silent. A query cannot be
skipped for one code path.

**Put holds on the vault's own table as rows rather than a boolean.** Tempting, and it would avoid
the wrong-direction import. Rejected because a hold is not a property of a document: it belongs to a
matter, it has a review cadence, it is placed and released by named humans with reasons, and half of
7.5's data model would end up living in 3.2's schema.

**Let `resolveRetention` fall back to a conservative default — say, seven years.** Rejected, and this
is the one worth restating. Seven years is a real answer somebody might defend, and stored as a
resolution it becomes indistinguishable from a period read out of a statute. Every consumer would
treat the two identically, which is precisely what Decision D's provenance discipline exists to
prevent.
