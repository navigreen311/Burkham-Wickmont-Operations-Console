# ADR-0067 — A playbook is a proposal about how a firm works, so it says which parts nobody proposed

**Status:** accepted
**Date:** 2026-08-12
**Modules:** 2.2 Workflow Engine

## Context

The Workflow Engine has been complete since it landed: seven components, validation at publish, a
scheduler, an event listener, retry and dead-letter handling. It has also been **empty**.
`publishPlaybook` was called only by tests, so no client workflow could start, and the blueprint's
V1 goal — "execute Phases 0–2 end-to-end" — was unreachable for want of content rather than
machinery.

Writing that content is not like writing the engine. The engine is right or wrong against a
specification. **A playbook is a claim about how this firm serves clients**, and the blueprint does
not contain one:

- it names "the 5-phase service delivery model" and never defines a phase;
- Appendix B assigns "Phase 0 workflow" to Capital Readiness and "Phase 4"/"Phase 5" to two other
  departments, saying nothing about 1, 2 or 3;
- section 6 defers "Phases 3–5 playbooks" to V1.5, which bounds the problem without describing it;
- flows 5.1, 5.2 and 5.3 give three sequences that look exactly like three phases.

So every node in the seed is either read off a flow diagram or invented by somebody who has never
run this firm. Both look identical once they are TypeScript.

## Decision

**The seed ships as a draft, and every node carries where it came from as data.**

The posture is the regulatory seed's, which said it best about counsel:

> a scaffold for counsel, not legal advice … something concrete to correct rather than a blank page.

The mechanism is new. `PlaybookSeed.provenance` maps every node key to either
`{basis: 'blueprint', source}` or `{basis: 'inferred', reasoning}`, and `inferredSteps()` derives
the review list from it.

### Why it is data rather than a comment

A comment saying "this step is inferred" is true when written and silent afterwards. Retarget a
`next`, add a node, split a task in two — the comment stays where it was and the review list in a
pull request describes a playbook that has moved on.

An invariant test asserts the node set and the provenance set are **equal in both directions**. A
node with no entry fails; an entry naming no node fails. The list a human reviews therefore cannot
drift from the thing being reviewed, and adding a step without saying where it came from is not
something the suite lets through.

That is the difference between documenting an inference and being unable to hide one.

### The reasoning is the thing to argue with

An `inferred` entry carries reasoning, not a label, and the invariant test requires it to be longer
than a phrase. The point is that a reviewer disagreeing with `await_documents` should be able to see
that it rests on 3.2 storing tax returns Plaid cannot supply and 4.1 owning document chase
workflows — and disagree with _that_, rather than with a bare assertion that a step is needed.

### The phase mapping is the load-bearing guess and it is written down

`PHASE_IDENTITY` records why each phase carries its number, from three converging sources per phase.
It is the first thing a reviewer should check, because if it is wrong the node content is mostly
still right and belongs to a differently numbered phase — a cheap correction that becomes an
expensive one after clients are running on it.

## Consequences

**Sixteen of forty-two nodes are inferred** - six in Phase 0, seven in Phase 1, three in Phase 2 -
and the PR lists every one. The proportion is the useful signal: had it been zero, the seed would be
claiming a transcription that was not available; had it been everything, these would not be this
firm's playbooks.

That count was wrong in the first draft of this ADR, which said nine of thirty-eight because it was
written before the list was generated. The number here is now read off `inferredSteps()`, which is
the whole argument for the scheme arriving as a small embarrassment: prose about a graph goes stale
faster than anybody expects, including in the document explaining why prose about a graph goes
stale.

**The invariant tests run without a database.** A broken graph fails at authoring time rather than at
publish time, which is one step earlier than `validate` already achieves — and `validate` needs a
decision to publish, which is exactly when nobody wants to discover a dangling `next`.

**Every wait names an event type that exists**, asserted against `EVENT_TYPES`. A wait on a string
that is not an event type parks forever with nothing able to wake it, and the listener reports
nothing because it only matches events that were appended. That failure is indistinguishable from
patience.

**Every task and checkpoint carries an SLA.** `breachedSlas` is what surfaces a stalled workflow, so
a node without one can sit indefinitely and never appear in anybody's overdue list.

## Alternatives considered

**Write the playbooks and describe the inferences in the pull request.** What was asked for, and it
is what this does — plus a guarantee that the description stays true. The prose version is correct
exactly once.

**Only encode the steps the blueprint states.** Produces a Phase 0 that asks a client to connect a
bank and then enriches documents nobody requested. The gaps are where the real proposals are; hiding
them would make the seed look more authoritative than it is.

**Invent nothing and ship a comment listing what is missing.** The blank page the regulatory seed
argues against. A firm correcting a draft moves faster than a firm authoring one, and the draft is
what surfaces the questions.

**Mark inferences with a naming convention, like an `x_` prefix on node keys.** Visible in the graph
and invisible in the reasoning, and it would put the review status into an identifier that ends up
in the Ledger, in task rows, and in a compliance reviewer's export.
