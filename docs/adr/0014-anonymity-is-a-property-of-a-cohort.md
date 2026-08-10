# ADR-0014 — Anonymity is a property of a cohort, not of a record

**Status:** Accepted · **Date:** 2026-08-10 · **Module:** 8.1 Partner & Referrer Portal

## Context

Blueprint 8.1 lists "anonymized client status sharing" in the data model and "partner-facing portal
for referred-client status" in the key features. A partner who introduced a client reasonably wants
to know how they are getting on.

The straightforward build is: take the status rows for the clients a partner referred, remove the
client's name, and show the rest.

**That build is not anonymous, and the failure is not subtle.** A partner who referred one client
and is shown "1 client in underwriting" knows exactly whose status that is — they supplied the
client. At two referrals a two-row breakdown discloses both. The partner is not an arbitrary
observer; they are the one party in the world who already knows the membership of the set.

Removing the name removes nothing when the reader can reconstruct it.

## Decision

Two surfaces, deliberately not one.

**Aggregate.** Counts by stage across the partner's referrals, **suppressed entirely** below
`MINIMUM_COHORT` (5). The suppression is reported as itself — `released: false` with a reason —
rather than as zeros. `totalReferrals` is still released, because the partner already knows how
many clients they sent us and withholding it protects nobody while making the suppression look like
a bug.

**Identified.** One named client's status, which requires:

1. that the partner is the **current** referrer of record — resolved through 1.3's attribution and
   its corrections, never from the caller;
2. a live `partner_status_visibility` consent **from the client**, checked on every read;
3. and it returns compliance state and legal name only.

The read writes a ledger event. A client who authorized a partner to see their status is entitled
to know when the partner looked — the same reasoning behind 1.2's SSN/EIN reveal events.

## Consequences

**A partner with four referrals sees no breakdown at all.** That is the cost, and it is the right
one: the alternative discloses individual clients to a third party who can identify them.

**A "fewer than five" band was rejected too.** It still leaks. "Fewer than five, some in
underwriting" combined with the partner's own knowledge that they referred two is most of the way
to an answer.

**The threshold is a convention, not a derivation.** Five comes from statistical disclosure control
practice. It is a constant with a name so it can be argued with; what matters is that a threshold
exists and that falling below it produces silence rather than a smaller number.

**The consent kind is new** — `partner_status_visibility` in 1.5, and in the Prisma enum. A client
consenting to work with us is not consenting to be reported on to the accountant who introduced
them, and nothing in the existing consent vocabulary expressed that difference.

## Alternatives considered

**Strip the name and show the rows.** Rejected — see Context. This is the build the blueprint's
wording suggests, and it is the one this ADR exists to rule out.

**Let the partner see everything, on the theory that they introduced the client.** Rejected. The
introduction is not an ongoing relationship with the client's file, and a referral fee makes the
partner an interested party.

**Aggregate only, no identified surface.** Rejected as dishonest in the other direction. What
partners actually want is their client's status; refusing it entirely would push the request into
email, where it happens with no consent record and no log.
