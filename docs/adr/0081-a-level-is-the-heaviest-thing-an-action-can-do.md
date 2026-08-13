# 0081 - A level is the heaviest thing an action can do

- Status: accepted
- Date: 2026-08-12
- Context: `packages/core/src/authority.ts`, `apps/api/src/routes/{sales,intelligence}.ts`

## Context

Batch C was scoped as "the Level 1 casework": the sales lead lifecycle and the market-intelligence
pipeline. Nothing in either reaches a client or commits the firm, and putting ordinary prospecting
behind Level 3 would mean the firm's most senior person logging every enquiry.

One of the four lead-lifecycle functions is not lifecycle work.

## Decision

**`convertLead` is Level 3, and everything else in its line is Level 1.**

Reading the module: converting creates a client through 1.1 and, when an offer key is given, starts
an engagement through 1.4. Those two acts are already declared — `create_client_record` at Level 2
and `manage_engagement` at Level 3.

So a lead conversion declared at Level 1 would have been **a lower-level path to both of them**. Not
a loophole anybody would have to find deliberately: it is what "convert this lead" does, and the
name gives no hint that a Level 1 holder would be creating a client and starting a fee.

This is ADR-0034's rule in a new shape. There it was "a control a caller can skip by calling a
different function is not a control". Here it is: **the level of an action is the level of the
heaviest thing it can do, not the level of what it is usually used for.**

`manage_lead` covers create, qualify and close at Level 1. Qualification decides whether the firm
should take somebody on, which sounds weightier than 1 — but the act it gates is conversion, and
conversion carries the level. A Level 1 holder can qualify all day and still not convert.

`record_market_intelligence` is Level 1 rather than 0. It writes a stored feed other reads treat as
given, which is more than `generate_internal_report` does; and `analyze_file` at Level 0 was the
wrong label for a different reason the old refusal already stated — it authorises reading a file,
not creating findings about a client.

## Consequences

**Five roadmap-blocked writes remain**, all in Batch D, and four of the five still bundle acts of
different weight.

**Three batches, three times the same finding.** Batch A: seventeen lines were sixty-one functions.
Batch B: three "Level 2" lines were six actions at three levels. Batch C: four lifecycle functions
were two actions two levels apart. A capability line describes a surface an operator uses; an
Authority Level describes what an act can do. They were never going to be the same shape, and the
blocked list was organised by the first.

**The test asserts the reason, not the number.** `expect(convert?.note).toMatch(/creates a client/)`
rather than a level: a future policy could move both actions and the reason this one is higher than
its siblings would still hold.
