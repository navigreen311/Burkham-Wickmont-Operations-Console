# deploy-prod — Prepare Production Deployment Assets

Prepare production deployment assets and a repeatable pipeline.

## Arguments

- **platform**: `$ARGUMENTS` — aws | gcp | azure | fly | render | vercel + container host
- **region**: target region (US only — client data residency)
- **runtime**: node version, container base image
- **database**: managed Postgres flavor and version
- **secrets_source**: env file | AWS Secrets Manager | GCP Secret Manager | Vault
- **zero_downtime**: true | false

## Process

### 1. Architecture Diagram
- Components, data flow, trust boundaries (Mermaid OK).
- Mark where the most sensitive data class lives: SSN, EIN, bank data, credit reports.

### 2. IaC or Platform Config
- Infrastructure as code where the platform supports it; committed, reviewable, idempotent.
- Encryption at rest and in transit is not optional. Field-level encryption keys are managed,
  never hardcoded.
- Network isolation for the database. No public database endpoint.

### 3. Build & Release Scripts
- Reproducible build. **Production installs omit devDependencies — verify every runtime import
  resolves against `dependencies` alone.** CI installs devDependencies and cannot see this
  difference by construction.
- Migrations run as an explicit, ordered, reversible step — never implicitly on boot.

### 4. Rollout Strategy
- Blue/green or rolling per `zero_downtime`.
- **A documented, tested rollback path.** A rollback that has never been run is a hope.
- Migration rollback is separate from code rollback and usually harder — state it explicitly.

### 5. Observability
- Health endpoints, structured logs, metrics, alerting thresholds.
- **Log scrubbing verified**: no SSN, EIN, account number, or tax ID reaches any log sink.
- Vendor API health (Plaid, bureau, personal credit) surfaced per Specification §5.8.
- Event Ledger integrity check schedulable and verifiable.

### 6. Staging Deploy & Smoke Tests
- Deploy to staging, run smoke tests, report real output.
- Verify the deployed build is the build you think it is (commit SHA surfaced at a health endpoint).

## Outputs
- Infrastructure or workflow files
- `docs/deploy.md` with environment matrix and env var table (placeholder values only)
- A "how to deploy" command block
- A "how to roll back" command block

## Gates — do not deploy past these
- No client onboards before **Plaid, business bureau, and personal credit providers** each have:
  Argus security review complete, DPA signed, SOC 2 Type II (or equivalent) verified, integration
  tested. Specification §11.4.
- No state comes online without documented counsel review of its Regulatory Engine module.
  Specification §11.2.
- Backups automated and **restore verified** — an unverified backup is not a backup.

## Error Handling
- Failed deploy: capture logs, roll back first, diagnose second.
- Never print real secret values in output, logs, or documentation.

## Example Invocation

```
/deploy-prod platform=aws region=us-east-1 runtime=node24 database=postgres17 secrets_source=aws-secrets-manager zero_downtime=true
```
