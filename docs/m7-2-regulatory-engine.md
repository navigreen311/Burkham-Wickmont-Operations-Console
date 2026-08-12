# 7.2 State-by-State Regulatory Engine

**Package:** `@bwc/regulatory` · **Schema:** `regulatory`
**ADR:** [ADR-0009](adr/0009-state-activation-requires-a-human-and-a-document.md)

---

## The sentence this module makes true

> "The Regulatory Engine is not a post-hoc check. No client-facing action fires without state
> compliance checks having passed. State activation itself is gated."

Step 5 of the middleware chain has existed since the walking skeleton and returned `not_built` for
every client-facing action. It now performs the check — which makes this **the last `not_built` in
the fixed seven-step chain**, and the reason `notBuilt` is no longer imported by `@bwc/middleware`
at all.

Ungated vendors still report `not_built`, from `@bwc/integration`. That remains the honest use of
the status.

---

## The activation gate is the module

Everything else here is a lookup table. The gate is what makes the table worth reading.

| Condition                              | Status                 | Servable |
| -------------------------------------- | ---------------------- | -------- |
| No module published                    | `no_module`            | no       |
| Module published, never reviewed       | `draft`                | no       |
| Activated, then materially republished | `needs_counsel_review` | no       |
| Deliberately taken offline             | `withdrawn`            | no       |
| Reviewed version is current            | `active`               | **yes**  |

**A state with no activation row is not active.** Absence resolves to the safe answer — the same
structural default ADR-0007 established for governance standing. There is no "pending" value
anyone can edit into "active".

**Only a Level 3 human can activate**, and the level is read from the recorded actor rather than
from the `EventActor` the caller passed: a gate that believes its caller about whether the caller
is allowed through is not a gate.

**A counsel review needs a named reviewer, a date and a document reference.** Requiring the
document does not make the review good; it makes the claim falsifiable, which is the most a data
model can do.

### The cost, stated plainly

A client in a state we have not activated **cannot be served**. This refusal will block real work.
That is the intended behaviour — the alternative is serving them while the module sits unreviewed,
which reads as normal operation right until a regulator asks who reviewed it.

---

## Material versus editorial

`changeKind` is a **required** argument on every publish. A default would be chosen once by whoever
wrote the first call site and inherited silently by every later change — which is exactly how a
material change ships as editorial.

- **Material** → an activated state returns to `needs_counsel_review`.
- **Editorial** → activation carries forward, and the publish needs a stated rationale, because
  declaring a change non-material suppresses a review.
- **Version 1 cannot be editorial** — there is no prior version for it to differ from, and the
  claim is precisely the one that would let a whole state module skip its first review.

The rule is _"any material version since the one reviewed"_, not _"the latest version differs"_ and
not _"the latest change was material"_. **An editorial patch on top of an unreviewed rewrite must
not launder it**, and that case is pinned by its own test.

---

## Correction the tests forced

The first implementation compared version numbers alone, so **every** republish deactivated. A test
named `leaves activation intact for an editorial change` asserted `needs_counsel_review` — agreeing
with the code and contradicting its own name.

Stricter, and still wrong. It made `changeKind` decorative, and a rule that punishes a typo fix
exactly as hard as a rewrite teaches people to batch their typo fixes into rewrites. The lesson is
narrower than "test your code": **a test whose name disagrees with its assertion is a design
question, not a typo.**

---

## Disclosures carry their citations

A requirement with no cited basis cannot be reviewed by counsel, argued with when an agent thinks
it is wrong, or revisited when the statute changes. It calcifies into folklore — the same reasoning
the Marketing Claim Library (7.4) applies to a banned phrase. `publishStateModule` refuses a module
with no citations, and refuses any disclosure requirement without one.

**The federal baseline is returned alongside the state layer, never instead of it.** A state with
no product-specific rule does not mean "nothing must be disclosed"; an empty list would read as
exactly that. Federal first, because those obligations apply regardless:

- `not_a_lender` — the company does not make credit decisions
- `no_guarantee` — no approval, limit, rate or amount is guaranteed
- `not_credit_repair` — CROA, and principle 1's hardest line
- `application_authorization` — 18 U.S.C. §1014/§1344
- `business_purpose` — Regulation Z's business-purpose exemption

`missingDisclosures` matches on an explicit attachment **key**, not by searching the text. Substring
matching would report a disclosure present because a paraphrase shared a few words, and a
disclosure that is nearly there is not there — it is the specific language that discharges the
obligation.

---

## 5.4's state restrictions arrive by pull

Blueprint 5.4 calls it "state-restriction propagation to Regulatory Engine". ADR-0007 chose a pull
over a push because a push needs a retry and a reconciliation job, each of which can lag — so a
provider restricted on Monday might still be recommendable on Tuesday. `checkJurisdiction` is the
reader that choice was made for.

Withdrawing a state has the same property: it takes effect on the next action, with no cache to
invalidate and no job whose failure would leave a withdrawn state serving clients.

---

## The seeded states are a scaffold, not legal advice

The seven V1 priority states — NV, CA, NY, TX, FL, AZ, UT — ship as **drafts** citing the statutes
the specification names: California SB 1235 and the DFPI regulations, New York's Commercial Finance
Disclosure Law and 23 NYCRR 600, Utah's registration and disclosure act, Florida's disclosure law.

**Where a state's obligations are genuinely uncertain to a non-lawyer, the module says so rather
than inventing a requirement.** Texas, Arizona and Nevada seed with no state-specific disclosures
and a summary telling counsel to confirm current status — several states have adopted regimes
recently. An invented rule is worse than a missing one: it looks reviewed.

Nothing seeded can serve a client. The seeding function has no path to activation, which is what
makes "scaffold, not advice" enforceable rather than a disclaimer in a comment.

---

## The state-law change tracker

Recording a change deliberately does **not** alter the module or the activation. Noticing that
California amended its regulations is not the same as knowing what our module should now say, and
auto-deactivating on a notice would let anyone with write access take a state offline by filing a
bulletin.

The backlog — changes with no module version addressing them — is the useful output.

---

## Known gaps

- **7.3 Contract & Disclosure Builder** generates documents _from_ these rules. Its own slice.
- **43 states** remain. V1 covers the priority seven per the blueprint; V1.5 and V2 add the rest.
- **No automated ingestion** of state-law changes. The tracker records what a human enters.
- **The seeded content has not been reviewed by counsel**, and by construction cannot be used until
  it is.
