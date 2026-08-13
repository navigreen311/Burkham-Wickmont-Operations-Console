# Counsel packet — state activation review

**Prepared for outside counsel. This document is not legal advice and does not assert a legal
conclusion.** It is a scaffold: seven draft state modules with the citations they were drafted
against, and the questions each one needs answered before the firm may operate in that state.

Every module below is in `draft`. **No state is active.** The seeding function that produced them
has no code path that activates anything — activation requires a documented review recorded by a
named person, which is what this packet exists to obtain.

---

## 1. What is being asked

For each of the seven states: **may the firm operate there, and under what conditions?**

Answering means confirming or correcting three things per state:

1. **The statutory position** as summarised — including, for three states, an asserted _absence_ of
   a statute, which is the item most in need of checking.
2. **The disclosure obligations** the module records, and whether the firm's role is described
   correctly. Every disclosure here is drafted on the basis that **the provider originates the
   statutory disclosure and Burkham Wickmont does not substitute for it**. If that characterisation
   is wrong in a given state, the module is wrong.
3. **Referral-fee treatment**, which is recorded separately and is currently blank for all seven —
   see §5.

---

## 2. What activation does, mechanically

A state is activated by `activateState`, which requires all of:

| Requirement                                  | Enforcement                                              |
| -------------------------------------------- | -------------------------------------------------------- |
| A human actor at **Authority Level 3**       | Read from the database, not trusted from the caller      |
| `reviewedBy` — the reviewing counsel, named  | Required, non-empty                                      |
| `reviewedAt` — the date of review            | Required                                                 |
| `documentReference` — where the review lives | Required: _"a review nobody can produce did not happen"_ |

The activation is recorded against the module **version** reviewed. That matters for §4.

Until a state is activated, every client-facing action for a client in that state is refused by the
jurisdiction check. With none activated, **the firm currently has no state in which it may act.**

---

## 3. The seven modules

Numbered as a schedule so items can be referred to individually in correspondence.

### Item 1 — California (CA)

Provider-side disclosures under SB 1235 and its implementing regulations; UDAAP standards applied to
small-business financing conduct. **Broker conduct and compensation disclosure are flagged in the
module itself as requiring counsel attention.**

_Citations drafted against:_ California SB 1235 (2018), Fin. Code §22800 et seq. · 10 C.C.R. §900
et seq. (DFPI commercial financing disclosure regulations) · California Consumer Financial
Protection Law (UDAAP), Fin. Code §90000 et seq.

_Disclosures recorded (2):_

- **Commercial financing disclosure** — the provider must furnish a standardised disclosure stating
  total amount funded, total dollar cost, term, payment amount and frequency, prepayment policy and
  an annualised rate. The firm does not originate these and does not substitute for them.
- **Broker compensation** — any compensation received in connection with a placement is disclosed
  to the client before an application is submitted.

_Marketing note carried:_ UDAAP standards under the CCFPL reach small-business financing conduct, so
marketing review for California should be at least as strict as the national claim library.

### Item 2 — New York (NY)

Commercial Finance Disclosure Law; Attorney General enforcement on merchant cash advance conduct;
confession-of-judgment practice restricted.

_Citations drafted against:_ N.Y. Fin. Serv. Law §801 et seq. · 23 N.Y.C.R.R. Part 600 (DFS
commercial financing disclosure) · N.Y. C.P.L.R. §3218 (confession of judgment restrictions).

_Disclosures recorded (2):_

- **Commercial financing disclosure** — finance charge, annual percentage rate and payment terms,
  furnished by the provider; the firm does not substitute for them.
- **MCA conduct** — a merchant cash advance presented to a New York client is accompanied by the
  true cost of capital as an annualised rate alongside any factor rate.

_Marketing note carried:_ enforcement has focused on cost presentation; any material naming an MCA
should carry the annualised cost, not only the factor.

### Item 3 — Utah (UT)

Registration for commercial financing providers, and disclosures on covered transactions.

_Citation drafted against:_ Utah Commercial Financing Registration and Disclosure Act, Utah Code
§7-27-101 et seq.

_Disclosure recorded (1):_ total repayment amount and payment terms, furnished by the provider.

**Question for counsel:** the Act imposes _registration_ obligations. The module records a
disclosure requirement and does not record whether the firm's own activity triggers registration.

### Item 4 — Florida (FL)

Disclosures on covered commercial financing transactions, and regulation of broker conduct.

_Citation drafted against:_ Fla. Stat. §559.9611 et seq.

_Disclosures recorded (2):_

- **Commercial financing disclosure** — total funds provided, total repayment amount, payment terms.
- **Broker conduct** — the firm does not accept an advance fee for arranging commercial financing in
  Florida.

**Question for counsel:** the advance-fee position is stated as a rule the firm follows. Confirm it
matches the statutory prohibition, and whether the firm's retainer model falls within it.

### Items 5–7 — Texas (TX), Arizona (AZ), Nevada (NV)

**These three assert an absence, and an absence is the hardest thing to be confident about.**

Each records: _no general commercial financing disclosure statute identified as at drafting; federal
baseline applies._ None carries a disclosure requirement. Each module says in its own marketing note
that **the absence of a statute is a finding for counsel to confirm, not a conclusion the module
asserts.**

Additional citations flagged for scope confirmation:

- **Texas** — Tex. Fin. Code general lending and brokerage provisions; scope to be confirmed.
- **Nevada** — Nev. Rev. Stat. ch. 675 (installment loans); applicability to the firm's specific
  activities to be confirmed.
- **Arizona** — no secondary provision flagged.

The drafting note on Texas records the reason for caution: _several states have adopted regimes
recently._ These three items are where the packet is most likely to be out of date, and where a
negative finding is worth the least without a date attached to it.

---

## 4. Review is not one-time

A state's activation is recorded **against the module version reviewed**. If that module is later
republished as a **material** change, the state returns to `needs_counsel_review` automatically and
client-facing action stops until a fresh review is recorded.

An **editorial** change — a corrected section number, a reworded summary — carries the activation
forward. The distinction is declared on each publication rather than inferred.

Practically: **counsel is asked to review a version, not a state.** A later amendment to the
underlying law, recorded as a material change, will bring the same state back for review.

---

## 5. The second gap: referral fees are unrecorded everywhere

Separate from activation, and currently blank for all seven states.

A state can be activated and still have no recorded rule about what it permits by way of referral
fees. Where that is so, the module **refuses** rather than assuming permission, and says why:

> That is a gap in our research and not a permission: a state nobody has asked about is not a state
> that allows everything.

Until a rule is recorded per state, no partner payout may include that jurisdiction. This is a
distinct question from activation and can be answered separately, but it gates partner compensation
in the same way activation gates client work.

---

## 6. What the firm is asking counsel to produce

For each state, to permit activation:

1. Confirmation or correction of the statutory summary — **with a date**, given §3's caution about
   recent adoptions.
2. Confirmation that the disclosure obligations recorded are complete, and that the firm's role is
   correctly described as not originating and not substituting for the provider's disclosure.
3. A view on the state-specific questions flagged in items 3, 4 and 5–7.
4. A document reference the firm can record — a memo, an opinion, a dated file note. The system
   requires one and rejects placeholders (`n/a`, `tbd`, `pending` and similar are refused).
5. Separately, the referral-fee position per state (§5).

---

## 7. Standing of this document

Every summary, citation and disclosure in §3 was drafted by the firm as a **starting point for
review**, not as a legal conclusion, and is recorded in the system as a draft for exactly that
reason. Where counsel disagrees, the module is what changes.

No state has been activated. No client-facing work is permitted in any jurisdiction today.
