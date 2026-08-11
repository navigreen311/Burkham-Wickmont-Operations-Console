# ADR-0064 — A surface over a historical store has no "today"

**Status:** accepted
**Date:** 2026-08-11
**Modules:** 11.6 Data Warehouse & Analytics Layer, on the internal Console
**Extends:** ADR-0020

## Context

ADR-0020 established that the warehouse answers about the past. `@bwc/warehouse` has no `current()`,
every read takes a period, and its own header says why: nothing can quietly start using the
warehouse as a faster read of what 9.1 already answers live, **because there is no function that
would serve it.**

A transport is where that gets rebuilt. `GET /warehouse/summary`, defaulting to the last thirty
days, is a `current()` written in Express — and every reader treats the answer as live, because that
is what a summary looks like. The module's refusal survives only if the surface refuses too.

## Decision

**Every route requires `from` and `to`, and refuses without them.**

No default period. Whatever a default was, a caller who did not think about time would get an answer
that looks like now. Refusing costs one round trip and buys that every figure on this surface is
about a period somebody chose. The refusal says so in the words the module would: _the warehouse
answers about a period you name — it has no notion of "now"._

The page carries the same shape: two required date fields, no "today" button, and a panel that will
not fetch until both are filled.

**An empty period is `no_data`, never a flat line at zero.** A zero-filled series is a claim that the
business did nothing; `no_data` is a claim that nobody captured an answer. Only the second is true.
The module returns `no_data` and the route forwards it unchanged — the transport adds nothing and,
more to the point, subtracts nothing.

**Gaps travel with every point.** A snapshot that could not capture engagements reads as a dip, and a
reader has no way to tell that from the number alone. The page renders a gapped point as
_incomplete_ with the recorded reason rather than plotting it, because a caveat drawn as a data
point is a caveat nobody sees.

**An unknown trend metric is refused with the list.** Returning nothing would be indistinguishable
from a period with no data, which is a different fact.

## Consequences

**Nothing in this repository captures a snapshot.** `captureSnapshot` is called by tests and by no
other code — no worker, no schedule, no route. So every period reports `no_data` today, and the
surface says that in an `etl` field carried on **every** answer rather than only the empty ones: a
period that happened to contain test-seeded rows would otherwise read as a working pipeline and the
next empty one as a quiet month.

That is also the honest justification for building this panel at all, and it was close. A screen
that will always be empty is a screen somebody maintains. It earns its place because **it is the
only place the missing ETL becomes visible** — the gap is otherwise a fact about a function nobody
calls, discoverable by grep and by nothing else.

**The ETL is the next slice, not this one.** It needs a schedule, an actor to attribute captures to,
and a decision about capture cadence and retention. All three are decisions rather than code.

**A defect this rule caught elsewhere in the same batch.** The intelligence route defaulted a missing
`phase` to 0 — the same failure shape as a defaulted period, in a different module: an answer to a
question nobody asked, indistinguishable in the reply from the one they did. Both now refuse.

## Alternatives considered

**Default the period to the last thirty days.** Every other dashboard in this Console does something
like it, and here it would be a `current()` with extra steps. The consistency argument is real and
it is the wrong one: 9.1 answers about now and is built to, 11.6 answers about the past and is built
not to.

**Render an empty period as a zero series so the chart is never blank.** A chart that is never blank
is a chart that cannot say "I do not know", which is the whole content of this module's answer today.

**Do not build the surface until an ETL exists.** Defensible, and it was the closer call in this
batch. Rejected because the absence of the ETL is itself worth surfacing, and because the panel is
small: three reads, no writes, and no state of its own to keep correct.
