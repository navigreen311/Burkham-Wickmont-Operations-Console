# Architecture Decision Records

Every architectural decision in this system, numbered 0001 upward. **One directory — this one.**

The first eleven were originally written to `docs/decisions/ADR-NNNN-<slug>.md` and everything from
0012 went to `docs/adr/NNNN-<slug>.md`. The two sat side by side long enough that the older set was
reported as missing and eleven replacements were nearly written. This index exists so that cannot
happen again: if a number is not here, look at the gaps below before concluding it was never written.

## Gaps, and why they are gaps

`0037`, `0038`, `0039` were reserved for a branch that was closed as superseded (PR #48, rebuilt as
PR #57). `0045` was allocated to a batch that used 0040–0044 and stopped. **No decision record is
missing** — these numbers were never used.

## The records

| #    | Decision                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | [Modular monolith with a Postgres schema per module](0001-modular-monolith-with-schema-per-module.md)                                                           |
| 0002 | [`Outcome<T>` as the type-level form of honest refusals](0002-outcome-type-for-honest-refusals.md)                                                              |
| 0003 | [Postgres-backed task queue for the Workflow Engine](0003-postgres-backed-task-queue.md)                                                                        |
| 0004 | [`cron-parser` for schedule evaluation, and timezone as a stored field](0004-cron-parser-for-schedule-evaluation.md)                                            |
| 0005 | [The deliverable content model is the artifact; the PDF is a rendering](0005-content-model-is-the-artifact.md)                                                  |
| 0006 | [Envelope encryption and a ciphertext-only blob store](0006-envelope-encryption-for-the-vault.md)                                                               |
| 0007 | [Governance status lives outside the provider record, and standing is derived](0007-governance-status-lives-outside-the-provider-record.md)                     |
| 0008 | [Relationship detection produces questions, and the graph risk rating carries no number](0008-relationship-detection-produces-questions.md)                     |
| 0009 | [State activation requires a Level 3 human and a document, and only material changes revoke it](0009-state-activation-requires-a-human-and-a-document.md)       |
| 0010 | [An issued contract is frozen; "auto-update" means the next one](0010-an-issued-contract-is-frozen.md)                                                          |
| 0011 | [Money is integer cents, rounding goes to the client, and refund entitlement is derived](0011-money-is-cents-and-refunds-are-derived.md)                        |
| 0012 | [A Do Not Fund override permits one action; it does not delist](0012-do-not-fund-override-permits-one-action.md)                                                |
| 0013 | [Staleness moves toward the safe answer, which is not always "stop"](0013-staleness-moves-toward-the-safe-answer.md)                                            |
| 0014 | [Anonymity is a property of a cohort, not of a record](0014-anonymity-is-a-property-of-a-cohort.md)                                                             |
| 0015 | [A control that runs after the fact produces an obligation, not a verdict](0015-an-after-the-fact-control-produces-an-obligation.md)                            |
| 0016 | [Every A/B variant must scan clean before the test runs](0016-every-ab-variant-must-scan-clean-before-the-test-runs.md)                                         |
| 0017 | [A metric is a value with its basis, or it is nothing](0017-a-metric-is-a-value-with-its-basis.md)                                                              |
| 0018 | [Generating a disclosure is not disclosing, and arm's length is the price strangers pay](0018-generating-a-disclosure-is-not-disclosing.md)                     |
| 0019 | [Configuration must not be able to turn a control off, and `unmonitored` is not green](0019-configuration-must-not-be-able-to-turn-a-control-off.md)            |
| 0020 | [A warehouse answers about the past; a portal decides nothing; a queue states the cost of inaction](0020-a-warehouse-answers-about-the-past.md)                 |
| 0021 | [A client user is not an Actor with a low authority level](0021-a-client-user-is-not-an-actor.md)                                                               |
| 0022 | [The Client Portal is a separate process, and rate limiting is not lockout](0022-the-portal-is-a-separate-process.md)                                           |
| 0023 | [A reset link is a credential in transit, and an unauthenticated endpoint must not change the account](0023-a-reset-link-is-a-credential-in-transit.md)         |
| 0024 | [The half-authenticated state is not a session, and a session is not a credential](0024-the-half-authenticated-state-is-not-a-session.md)                       |
| 0025 | [A shared counter is one statement, and the store that removes the fail-open question is the one already there](0025-a-shared-counter-is-one-statement.md)      |
| 0026 | [A change is not a reset, and the two revoke different sessions on purpose](0026-a-change-is-not-a-reset.md)                                                    |
| 0027 | [The address is where recovery goes, so moving it is the strongest act of the three](0027-the-address-is-where-recovery-goes.md)                                |
| 0028 | [Phishing resistance is the property, and a reviewed verifier is how you get it](0028-phishing-resistance-is-the-property.md)                                   |
| 0029 | [A passkey beside a live password is a convenience; the security property is turning the password off](0029-a-passkey-beside-a-password-is-a-convenience.md)    |
| 0030 | [A passwordless account has no password, and one function decides what confirmation means](0030-a-passwordless-account-has-no-password.md)                      |
| 0031 | [The API serves the page, and the policy relaxes only for the page](0031-the-api-serves-the-page.md)                                                            |
| 0032 | [A console is what makes a missing credential exploitable](0032-a-console-is-what-makes-a-missing-credential-exploitable.md)                                    |
| 0033 | [The gate must not block the act that clears it](0033-the-gate-must-not-block-the-act-that-clears-it.md)                                                        |
| 0034 | [A control a caller can skip is not a control](0034-a-control-a-caller-can-skip-is-not-a-control.md)                                                            |
| 0035 | [A defaulted input is a confident answer to a question nobody asked](0035-a-defaulted-input-is-a-confident-answer-to-a-question-nobody-asked.md)                |
| 0036 | [The granter must not hold the credential](0036-the-granter-must-not-hold-the-credential.md)                                                                    |
| 0040 | [The tie-break has to carry the meaning the caller is relying on](0040-the-tie-break-has-to-carry-the-meaning.md)                                               |
| 0041 | [A decline has to be a row](0041-a-decline-has-to-be-a-row.md)                                                                                                  |
| 0042 | [A hold is a matter, not a flag on a document](0042-a-hold-is-a-matter-not-a-flag-on-a-document.md)                                                             |
| 0043 | [A partner standing is not a score](0043-a-partner-standing-is-not-a-score.md)                                                                                  |
| 0044 | [The safe answer is not always "stop"](0044-the-safe-answer-is-not-always-stop.md)                                                                              |
| 0046 | [A control that can only be switched on is a parameter](0046-a-control-that-can-only-be-switched-on-is-a-parameter.md)                                          |
| 0047 | [The gate that was already stronger than the chain](0047-the-gate-that-was-already-stronger-than-the-chain.md)                                                  |
| 0048 | [Two zeroes that mean opposite things](0048-two-zeroes-that-mean-opposite-things.md)                                                                            |
| 0049 | [A second branch is a constraint on the design](0049-a-second-branch-is-a-constraint-on-the-design.md)                                                          |
| 0050 | [A refusal has to survive the transport and the page](0050-a-refusal-has-to-survive-the-transport-and-the-page.md)                                              |
| 0051 | [A surface with no declared action gets no write](0051-a-surface-with-no-declared-action-gets-no-write.md)                                                      |
| 0052 | [An absent field cannot be rendered as zeros](0052-an-absent-field-cannot-be-rendered-as-zeros.md)                                                              |
| 0053 | [A payout is refused by the state that cannot answer, and by every state beside it](0053-a-payout-is-refused-by-the-state-that-cannot-answer.md)                |
| 0054 | [A lender comparison is a set, not a ranking](0054-a-lender-comparison-is-a-set-not-a-ranking.md)                                                               |
| 0055 | [The tiers are a judgement, and an alert does not age out](0055-the-tiers-are-a-judgement-and-an-alert-does-not-age-out.md)                                     |
| 0056 | [Five productivity figures are refused, and the refusal is the module](0056-five-productivity-figures-are-refused.md)                                           |
| 0057 | [There is no estimated cost, and platform spend is not divided into clients](0057-there-is-no-estimated-cost.md)                                                |
| 0058 | [Consent is not a column, and Gardner's approval is not the client's](0058-consent-is-not-a-column.md)                                                          |
| 0059 | [A staff key that sits beside a password is decoration](0059-a-staff-key-that-sits-beside-a-password-is-decoration.md)                                          |
| 0060 | [One kind of staff key, and an origin nobody can choose](0060-one-kind-of-staff-key-and-an-origin-nobody-can-choose.md)                                         |
| 0061 | [The password is kept so recovery is one act, and refused so it cannot be one](0061-the-password-is-kept-so-recovery-is-one-act-and-refused-so-it-cannot-be.md) |
| 0062 | [An invariant has no control beside it](0062-an-invariant-has-no-control-beside-it.md)                                                                          |
| 0063 | [Two reasons a button is absent, and only one of them is temporary](0063-two-reasons-a-button-is-absent.md)                                                     |
| 0064 | [A surface over a historical store has no "today"](0064-a-surface-over-a-historical-store-has-no-today.md)                                                      |
| 0065 | [Vendor activation is a recorded governance act, not a constant](0065-vendor-activation-is-a-recorded-governance-act.md)                                        |
| 0066 | [The first credential comes from outside, and the evidence form does not exist yet](0066-the-first-credential-and-the-form-that-is-not-there.md)                |
| 0067 | [A playbook is a proposal about how a firm works, so it says which parts nobody proposed](0067-a-playbook-is-a-proposal-about-how-a-firm-works.md)              |
| 0068 | [One new template, because the playbooks produce one](0068-one-template-because-the-playbook-produces-one.md)                                                   |
| 0069 | [Nothing here happens by itself, including being recorded](0069-nothing-here-happens-by-itself-including-being-recorded.md)                                     |
| 0070 | [A seed may ban a claim and may not approve one](0070-a-seed-may-ban-a-claim-and-may-not-approve-one.md)                                                        |
| 0071 | [A phrase that begins with a symbol is a rule that never fires](0071-a-phrase-that-begins-with-a-symbol-is-a-rule-that-never-fires.md)                          |
| 0072 | [A template is scanned before it is stored, and carries its own disclosure](0072-a-template-is-scanned-before-it-is-stored.md)                                  |
| 0073 | [A published draft ladder beats an empty one, and round numbers beat researched-looking ones](0073-a-published-draft-ladder-beats-an-empty-one.md)              |
| 0074 | [A curriculum seed must not decertify the network, and it does not assert a sensitivity](0074-a-curriculum-seed-must-not-decertify-the-network.md)              |
| 0075 | [A seed runs twice, because that is what people do](0075-a-seed-runs-twice-because-that-is-what-people-do.md)                                                   |
