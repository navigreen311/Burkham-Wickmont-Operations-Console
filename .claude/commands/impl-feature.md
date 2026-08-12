# impl-feature — Plan and Implement a Complete Feature

Plan and implement a complete feature end-to-end (design → code → tests → docs → demo) in its own branch.

## Arguments

- **feature_name**: `$ARGUMENTS` — kebab-case short name, prefixed with the blueprint module number where one applies (e.g. `m11-3-event-ledger`)
- **scope**: ui | api | fullstack | agent | infra
- **acceptance_criteria**: bullet list or Gherkin-style text
- **tech_constraints**: (optional) stack limits, integrations, compliance requirements
- **priority**: p0 | p1 | p2
- **perf_targets**: (optional) performance goals (latency, throughput, etc.)
- **security_notes**: (optional) security or compliance considerations

## Process

### 1. Understand & Plan
- Read the module's section in `docs/reference/blueprint-v2.md` and any cross-cutting rules in
  `docs/reference/specifications-v2.md` **before** designing. Do not design from the feature name alone.
- Summarize inputs and clarify ambiguities (batch 3–5 questions max).
- Write a **mini-PRD**: problem statement, target users, success metrics, constraints, risks.
- Outline **architecture**: components, data model, APIs, sequence diagrams (Mermaid OK).
- **Declare the principle surface**: which of the nine design principles constrain this module,
  which hard invariants it touches, and which events it emits and consumes.
- Define **acceptance tests** derived from criteria.
- Save the plan to `docs/plans/${feature_name}.md` for review before implementing.

### 2. Branch & Optional Worktree
- Create and checkout branch: `ai-feature/${feature_name}`
- If parallel work benefits, create a git worktree and work inside it.
- Explain all git commands run.

### 3. Implementation
- Modify all necessary layers according to **scope** (ui, api, fullstack, agent, infra).
- Keep atomic **Conventional Commits** (`feat:`, `fix:`, `refactor:`, etc.).
- Prefer small, modular files with clear naming and boundaries.
- Emit events for every state change; never mutate shared state directly.
- Route every external call through the Integration Layer.

### 4. Tests
- Create or extend **unit + integration tests** aligned with acceptance criteria.
- **Add an explicit test for every hard invariant this feature touches** — provenance tagging,
  `approvedCreditLimit` vs `creditLimit`, categorical compliance state, Level 4 hard block,
  tenant isolation, honest refusal over silent no-op.
- Ensure the test command passes: provide the exact command.
- Target meaningful coverage — not just line count.

### 5. Verification
- Build and run the app locally.
- Confirm the running processes are current code before trusting the result.
- Perform local smoke tests.
- Write a short **demo script** (commands + URLs).

### 6. Docs
- Update `README.md` with new feature info.
- Add `docs/${feature_name}.md` (overview, architecture, endpoints, env vars).
- Add an ADR under `docs/adr/` if an architectural choice was made. One directory; number it after the highest already there.
- Update `CHANGELOG.md`.

### 7. Deliverables
- Summary of changes, how to run, test results, known tradeoffs.
- Final output block:

```
## IMPLEMENTED
<what was built>

## TESTED
<test results and commands>

## HOW TO RUN
<exact steps to run locally>
```

## Error Handling
- On failures: show logs, propose fixes, retry.
- For missing info: make clearly labeled `ASSUMPTION`s and explain how to change later.
- If the feature as specified would violate a design principle, **stop and say so** before
  implementing. A principle conflict is a design bug, not an implementation detail.

## Example Invocation

```
/impl-feature m6-2-funding-ethics-firewall scope=api acceptance_criteria="Given a client whose compliance state transitions to Fail, When any placement workflow is requested, Then the request is refused with an explicit reason and a firewall_triggered event is written" priority=p0 security_notes="Refusal reason must not leak finding details to client-facing surfaces"
```
