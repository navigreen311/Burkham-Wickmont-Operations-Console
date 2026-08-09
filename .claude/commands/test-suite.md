# test-suite — Create or Extend an Automated Test Suite

Create or extend an automated test suite (unit, integration, e2e) and wire it into CI if requested.

## Arguments

- **target**: `$ARGUMENTS` — module, path, or feature area to cover (e.g. `m2-2-workflow-engine`, `src/backend/services/firewall`)
- **coverage_goal**: target coverage percentage or "meaningful coverage of listed behaviors"
- **test_kinds**: unit | integration | e2e | contract | all
- **ci_provider**: github-actions | none
- **seed_data**: (optional) fixtures or seed requirements

## Process

### 1. Inventory
- List existing tests covering the target. Report what is genuinely covered versus what merely
  has a file named after it.
- **Read each existing test as a claim to be checked, not as evidence.** A wrong behavior with an
  assertion behind it looks deliberate, and the next reader preserves it.

### 2. Identify Gaps
- Behaviors with no test.
- **Invariants with no test** — this is the priority gap class. Check each of:
  - provenance tag present on every lender rule (`issuer_rule` vs `unresearched_default`)
  - success fees compute from `approvedCreditLimit`, never `creditLimit`
  - compliance state is categorical and never coerced to a number
  - Authority Level 4 actions are blocked and logged, never executed
  - cross-tenant reads are refused
  - placement is refused unless Firewall clear AND state is Pass / Pass with Findings
  - endpoints that cannot fulfill their contract refuse explicitly rather than no-op
  - `not_built` / `no_data` / `failed` are distinguishable
  - PII never appears in logs or event payloads
- Error paths, refusal paths, and empty states — not just happy paths.

### 3. Add Tests
- Prefer asserting the **property** over the wording, so a test survives a rewrite and still
  fails if the property breaks.
- Anchor assertions about derived state to the derivation, not to the first moment the DOM or
  response happens to agree.
- Use retrying assertions (`expect(locator)`) over point-in-time counts in browser tests.

### 4. Fixtures & Teardown
- Deterministic seed data; no dependence on test execution order.
- Clean teardown so a failed run does not poison the next.
- Synthetic PII only — never real client data, never realistic-looking SSNs.

### 5. Test Scripts
- Wire into `package.json` scripts with clear names (`test:unit`, `test:integration`, `test:e2e`).

### 6. CI Config
- If `ci_provider=github-actions`, add or update the workflow.
- Named checks must match branch protection — a new unrequired job blocks nothing.

### 7. Run & Summarize
- Run the suite. Report pass/fail with the exact command and real output.
- If something fails, say so plainly with the output. Never report green over a red run.

## Outputs
- New or extended test files
- Updated test scripts in `package.json`
- CI configuration (if chosen)
- Coverage report path and a summary of which invariants are now guarded

## Error Handling
- Flaky test: fix the race, do not re-run until green. A flaky assertion guarding a real property
  is exactly the one that gets waved through.
- Cannot test a behavior: say why, and propose the seam that would make it testable.

## Example Invocation

```
/test-suite m6-2-funding-ethics-firewall coverage_goal="every trigger rule and every refusal path" test_kinds=unit,integration ci_provider=github-actions
```
