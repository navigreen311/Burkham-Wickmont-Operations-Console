# ADR-0002 — `Outcome<T>` as the type-level form of honest refusals

**Status:** Accepted
**Date:** 2026-08-09
**Context documents:** Specification v2 §3.9, §5.2; CapitalForge audit §5

## Context

Design principle 9 requires that `not_built`, `no_data` and `failed` be "distinguishable at a
glance", and that an endpoint which cannot fulfil its contract "refuse with an explicit reason
(following CapitalForge's 501 pattern). No silent no-ops."

Stated as a principle, this decays predictably. A function that cannot produce an answer returns
`[]` or `null` because that is what the signature allows, the caller treats it as an empty
result, and a readiness score gets computed from data that was never retrieved. Nothing errors.
The CapitalForge audit found ten endpoints that refuse explicitly — the discipline exists in the
portfolio precisely because the alternative is invisible.

## Decision

Introduce a discriminated union in `@bwc/core` with five variants and **no empty-success case**:

```ts
type Outcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'refused'; reason: string; principle: string }
  | { status: 'not_built'; module: string; reason: string }
  | { status: 'no_data'; reason: string }
  | { status: 'failed'; reason: string; cause?: string };
```

Module functions that can decline return `Outcome<T>`. The HTTP layer maps each variant to a
distinct status code (`ok` 200, `refused` 409, `not_built` 501, `no_data` 404, `failed` 500) and
carries the status name in the body, so a JSON client does not infer meaning from a number.

Two properties are load-bearing:

- **`refused` carries `principle`.** A refusal is traceable to the rule that produced it rather
  than to an anonymous guard, which is what makes an audit answerable.
- **Refusals propagate unchanged.** A caller forwards the inner refusal rather than rewording it.
  Rewording is where the reason gets lost and a Firewall freeze surfaces as "request failed".

## Consequences

**Good.** A silent no-op is not expressible: there is no empty success to return. `not_built`
survives to the API boundary as a 501 rather than being flattened into a 200. Refusal reasons are
already suitable for the Compliance Evidence Vault.

**Bad.** Callers must branch on `status` rather than using exceptions, which is more verbose at
each call site. Judged worth it: the verbosity is at exactly the places where a decision is being
made, and it makes ignoring a refusal a visible act rather than an omission.

**Observed in practice.** Running the walking-skeleton demo showed the placement path returning
`not_built` after the gate and authorization both passed — visibly different from the `refused`
responses above it in the same run, and different again from an empty recommendation, which is
what a boolean-returning design would have produced.
