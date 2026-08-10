# ADR-0001 — Modular monolith with a Postgres schema per module

**Status:** Accepted
**Date:** 2026-08-09
**Context documents:** Specification v2 §5.1, §5.7

## Context

Specification v2 §5.1 describes the runtime model as "a multi-service architecture. Each
functional category (or subcategory) is a distinct service with its own optimized data store,"
communicating through the Event Ledger, versioned APIs, and the Notification & Task Queue.

The constraint it actually states — the one that carries the architectural weight — is the
sentence that follows: _"No service reaches directly into another service's database. All
cross-service reads go through APIs; all cross-service writes go through events."_

V1 is 46 modules in 150–180 days. Standing up eleven independently deployed services in that
window spends a large share of the budget on deployment topology, service discovery, distributed
tracing, and cross-service transaction handling — none of which is the risk this build actually
faces. The risk is that the compliance and provenance discipline erodes.

## Options considered

**1. Eleven services from the start.** Literal reading. Boundaries are physically enforced;
nothing can accidentally join across a module. Costs a large fraction of V1 to operational
overhead, makes local development heavyweight, and makes the walking-skeleton feedback loop slow
enough that it stops being run.

**2. Single application, single schema, boundaries by convention.** Fastest. The boundary is a
code review norm, and the first cross-module `include` that ships is invisible in a diff. Given
that the isolation requirement here protects SSNs and bank data, convention is too weak.

**3. Modular monolith, one Postgres schema per module.** _(chosen)_ One deployable unit. Each
module is a workspace package owning a named Postgres schema; a cross-module query is visible in
review as a cross-schema reference rather than as an ordinary join. Package dependency edges are
declared in `package.json`, so an unintended dependency fails the build rather than passing
review.

## Decision

Option 3. Each module is a package under `packages/` owning a Postgres schema declared in
`prisma/schema.prisma` (`tenancy`, `identity`, `ledger`, `clients`, `consent`, `firewall`, and
one per module added later). `@bwc/db` owns the Prisma client; no other package constructs one.

The specification's actual constraint is satisfied on day one. What is deferred is _process
separation_, not _boundary enforcement_ — and any package can be extracted into a service later
without rewriting its callers, because they already talk to it through its declared exports and
receive events rather than reading its tables.

## Consequences

**Good.** Boundaries enforced by the build and visible in the schema. One deployable to run
locally, so the walking skeleton stays fast enough to run on every change. Extraction path
preserved.

**Bad.** A determined author can still cross a boundary by importing another package's
repository; this is caught in review rather than by the compiler. Prisma's `multiSchema` is a
preview feature — pinned, and the schema separation would survive its removal since the SQL is
ordinary.

**Revisit when:** a single module's load profile diverges sharply from the rest (the Workflow
Engine's scheduler is the likely first candidate), or team size makes one deployable a release
bottleneck.
