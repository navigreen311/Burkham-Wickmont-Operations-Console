# api-test — Generate API Contract and Integration Tests

Generate API contract + integration tests from OpenAPI/GraphQL specs or live endpoints.

## Arguments

- **spec_path_or_url**: `$ARGUMENTS` — OpenAPI/GraphQL spec path, or a base URL to probe
- **auth_mode**: none | bearer | session | mtls
- **env**: local | staging | prod-readonly
- **test_style**: contract | integration | both
- **load_smoke**: (optional) true | false — add a light load smoke pass

## Process

### 1. Parse Spec or Probe Endpoints
- Enumerate routes, methods, request/response schemas, and declared status codes.
- **Record which endpoints declare a refusal** (501 / explicit not-implemented). Those refusals
  are contract, and a test must assert they refuse — an endpoint that silently starts returning
  200 with empty data has broken the honest-refusal principle, not fixed a gap.

### 2. Generate Success Tests
- Happy path per endpoint, with schema validation on the response body.
- Version the contract: a breaking change must fail a test, not surprise a consumer.

### 3. Generate Error and Refusal Tests
- 4xx for bad input, missing auth, wrong tenant.
- **Cross-tenant access must be refused** — assert this on every client-scoped route.
- **Authority Level violations must be blocked and logged** — assert the block, and assert the
  log/event was written.
- Placement routes must refuse when the Firewall is triggered or compliance state is
  `Needs Review` / `Fail`, with an explicit reason.
- `not_built`, `no_data`, and `failed` must be distinguishable in the response.

### 4. Reusable Client & Helpers
- One typed client per service. Auth handled once, in a helper — not copy-pasted per test.
- Fixture builders for Client, Entity, Engagement, Application, Funding Event.
- Synthetic data only. Never real client data; never realistic SSNs or account numbers.

### 5. CLI for Environments
- One command, environment-switchable, reading base URL and credentials from env vars.
- Never accept a real production write target.

### 6. Optional Load Smoke
- If `load_smoke=true`, a short pass establishing latency baseline and error rate under
  modest concurrency. Not a load test — a regression tripwire.

### 7. Run & Summarize
- Run the suite and report real results with the exact command.
- Report failures plainly, with output.

## Outputs
- `tests/api/` with runnable suites
- Reusable client and fixture helpers
- Example commands per environment
- Report path

## Error Handling
- Spec missing or stale versus the live API: report the drift explicitly rather than testing the
  spec's fiction. A spec is a claim about the API, not the API.
- Endpoint unreachable: fail loudly; never skip silently into a green run.

## Example Invocation

```
/api-test http://localhost:4000/api/openapi.json auth_mode=bearer env=local test_style=both load_smoke=false
```
