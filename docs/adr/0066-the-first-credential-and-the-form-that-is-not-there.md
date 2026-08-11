# ADR-0066 - The first credential comes from outside, and the evidence form does not exist yet

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 11.1 Identity & Access, 11.5 Integration
Layer

Two decisions that share a shape: both are about a control with no base case, and in both the
honest answer was to build less than the obvious thing.

## Decision 1 - the bootstrap script exists, and closes behind itself

`inviteStaff` requires a Level 3 human who is already an Actor, because granting Console access
grants sight of every client file in the tenant. That rule is right and **it has no base case**: on
an empty database there is no Level 3 human to do the inviting, so the first credential cannot be
created from inside the authority model.

`scripts/bootstrap-console-admin.mjs` is the thing standing outside it, and standing outside the
authority model is precisely why it is dangerous. Three properties make it safe enough to exist:

**It refuses once anybody is enrolled.** The moment one Console credential has been enrolled, the
base case is over and the in-system path applies. Running it again would be a second door into a
system that already has a front one, and a second door is how an account gets taken over by
whoever can reach the shell. The refusal is on `enrolledAt`, not on the credential row existing -
an invitation issued and never accepted is a first run that did not finish, not a system with an
operator.

**It is idempotent up to that point.** Re-running before enrolment reuses the tenant and the actor
and re-issues the invitation. A half-finished first run is the normal case: somebody loses the
token before accepting it.

**It does not re-implement the credential path.** The invitation goes through `inviteStaff` from
`@bwc/identity`, so token generation, hashing and expiry are the same code the Console uses. A
second implementation of a credential path is a second thing to get wrong, and it would be the
one nobody tests.

The irregularity that remains is recorded rather than disguised: **the inviter and the invitee are
the same person**, because there is nobody else. The alternative was a fabricated `system` actor to
sign the invitation, which would put a Level 3 identity in the actor table that nobody can be held
to account for and that every later audit would have to explain.

## Decision 2 - there is no form for accepting vendor evidence

ADR-0065 requires a document reference on every piece of vendor evidence. The natural surface for
that is a form on the Console: four fields and a save button.

**That form is the thing this slice was told not to build**, and the reasoning survives inspection.
A text box beside the words "SOC 2 cleared" will have `SOC 2 cleared` typed into it. The
placeholder check catches `n/a` and `TBD`; it does not catch a plausible-looking invented
reference, and nothing on a web form can. What makes the reference real is that a human read the
actual document - and a form does not carry the document.

So `/api/integrations/activation` is **read-only**, and the page says where a form would be:

> Evidence is recorded through `recordEvidence`, not through this page. A text box on a screen is
> how "SOC 2 cleared" gets typed with nothing behind it; the recording path needs the document
> itself, which means routing it through the Vault first.

The surface still does the useful half: what is outstanding per vendor, who accepted what, when,
and when it expires - so an attestation running out is visible before it closes a gate rather than
after.

**What would change this.** 3.2 Secure Document Vault already stores documents under envelope
encryption. An acceptance flow that uploads the attestation into the Vault and records the
resulting document id as the reference would make the reference point at something the system
holds, rather than at a string somebody typed. That is a coherent slice and it is the right next
one; it is not this one, because doing it badly is how the checkbox arrives anyway.

## Consequences

**Activating a vendor currently takes an engineer**, calling `recordEvidence` deliberately. That is
worse ergonomics and better governance than a form, and it is temporary in the way a named
follow-up is temporary rather than the way a TODO is.

**The bootstrap script must be run before the Console is reachable by anybody**, and it prints the
invitation token once. The token is a credential in transit (ADR-0023): it is not written to a
file and does not reach the Ledger.

**Nothing stops an operator running the script against a tenant that has an invitation outstanding
but unaccepted**, and re-issuing invalidates the previous token. That is intended - the previous
token is the one somebody lost - but it does mean a running invitation can be cancelled by anybody
with shell access, which is a smaller version of the same trust the script already requires.

## Alternatives considered

**Seed the first admin in a migration.** Rejected: migrations run in every environment including
CI, and a known-email Level 3 actor in every database is a credential everybody has.

**Let the script run whenever, and rely on the audit trail.** Rejected. An audit trail records what
happened; it does not prevent it, and "we can see who bootstrapped a second admin" is not a
control.

**Build the evidence form with a mandatory-field check and ship it.** Rejected - see Decision 2.
The mandatory field is satisfied by any string.
