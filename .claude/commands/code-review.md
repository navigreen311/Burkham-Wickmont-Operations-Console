# code-review — Structured, Example-Driven Review

Structured, example-driven review for architecture, correctness, security, performance, and maintainability.

## Arguments

- **paths**: `$ARGUMENTS` — files, directories, or a diff range to review
- **style_examples**: exemplar files whose design, style, and conventions the code should match
- **severity_threshold**: blocker | major | minor — report at and above this level

## Process

### 1. Learn Style From Examples
- Read `style_examples` first. If none given, read the nearest sibling module to the code under
  review, then `../capitalforge/src` for portfolio idiom.
- Identify the core design, style, naming, and error-handling conventions **before** judging the
  code. Review against what this codebase does, not against a generic ideal.

### 2. Review Against the Checklist

**Principle conformance** — the highest-severity class here:
- Does any change recharacterize Burkham Wickmont as a lender, advisor, or credit repair org?
- Is state changed directly instead of via an event?
- Is an Authority Level check reimplemented locally instead of using the middleware?
- Can data cross a tenant boundary?
- Is a placement path reachable without a Firewall check and a `Pass` / `Pass with Findings` state?
- Does a derived figure ship without provenance?
- Is there a silent no-op where an honest refusal belongs?

**Invariants:**
- `creditLimit` used where `approvedCreditLimit` was meant — **always a blocker**, it is a
  revenue-integrity defect.
- A lender rule written without a provenance tag.
- Compliance state treated as ordinal, averaged, or thresholded.
- PII in a log line, error message, or event payload.
- A direct external-service call bypassing the Integration Layer.

**Correctness:**
- Error and refusal paths, not just happy paths.
- **Widening a type or a value's range?** Check every downstream consumer that compares it to a
  threshold. The defect is never in the line that was edited.
- Hand-written types for installed libraries — derive the type instead; a hand-written model
  cannot catch itself being wrong.
- Tools that reimplement a rule rather than calling it will drift and keep answering.

**Security:** authz on every route, input validation, injection surfaces, secret handling.

**Performance:** N+1 queries, unbounded result sets, missing indexes on event-query paths.

**Maintainability:** file size (can it be rewritten in one pass?), naming that matches blueprint
vocabulary, module boundaries, dead code.

**Tests:** does each new invariant have a test? Does any test assert wording where it should
assert a property? Any assertion satisfiable by a transient?

### 3. Produce Issues
- Each issue: file:line, severity, what is wrong, why it matters, suggested patch.
- Separate **defects** from **preferences**. Say which is which.

### 4. Summarize by Severity
- Blocker → must fix before merge. Major → fix before merge or file a tracked follow-up.
  Minor → optional.

### 5. Output a Ready-to-Paste PR Comment
- Grouped by severity, with file links and concrete suggestions.

## Error Handling
- If a finding cannot be verified without running the code, label it `UNVERIFIED` and say what
  would confirm it. Do not present a hypothesis as a defect.

## Example Invocation

```
/code-review src/backend/services/funding-recommendation style_examples=src/backend/services/firewall/firewall.service.ts severity_threshold=major
```
