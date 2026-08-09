# Changelog

All notable changes to the Burkham Wickmont Operations Console are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Repository initialized for AI-assisted development.
- `CLAUDE.md` — global AI development context: persona, interaction mode, version control
  conventions, the nine design principles, the five locked decisions (A–E), hard invariants,
  the fixed middleware order, and the six-step delivery recipe.
- `.claude/commands/` — five reusable commands: `impl-feature`, `test-suite`, `deploy-prod`,
  `code-review`, `api-test`, each adapted to the Console's compliance and provenance discipline.
- `docs/reference/blueprint-v2.md` — canonical module-by-module specification (58 modules).
- `docs/reference/specifications-v2.md` — canonical cross-cutting architecture specification.
- `scripts/setup.ps1` — idempotent repository setup and verification script.
- `README.md` — scope, architectural position, locked decisions, workflow, security notice.

### Notes
- No application code scaffolded. Stack selection pending.
