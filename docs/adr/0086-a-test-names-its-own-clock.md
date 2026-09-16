# ADR-0086 — A test names its own clock, and a red main blocks every merge

**Status:** accepted
**Date:** 2026-09-16
**Modules:** the test suite, and the merge process around it
**Decided by:** Ivan Green

## Context

`main` was green on 2026-08-13 and red on 2026-09-16, at the same commit, with no change to the
tree in between. Three tests failed. Nobody had merged anything: the last CI run on `main` was the
push that merged #81, and CI does not run on a schedule, so nothing looked.

All three failures had one shape. Each test mixed two clocks — an instant it named, and an instant
it took from whenever it happened to run — and the two agreed for a while.

- **`legal-hold-and-retention`.** The retention period runs from the vault row's `createdAt`, which
  `store` sets from the wall clock and cannot be told otherwise. The test asked to delete on
  `2026-10-11`, a fixed date that was two months after "now" when it was written and one month
  after "now" by 2026-09-11.
- **`kpi-dashboards`.** Every fixture in the file carries an explicit date except one: `trigger`
  and `clear` in 6.2 take no time, and `firewallResolutionRate` counts their Event Ledger entries
  by the ledger's `createdAt`. The ledger is append-only and hash-chained, so that timestamp is
  insert time by construction. The test's period ended `2026-08-14`, and on that date the only
  event that arrives by running fell outside the only window that was looking for it.
- **`client-password-change`.** `resolveSession` slides the idle window, writing
  `lastSeenAt = now`. The test resolved once at a named instant in August and twice more at the
  wall clock. Thirty minutes of real time after that August instant, `SESSION_IDLE_MINUTES` had
  elapsed _between two consecutive lines of one test_.

None of the three was a defect in the code under test. Each metric and each control did exactly
what it claims, on the clock it was given. What rotted was the tests' assumption that the day they
were written and the day they run are close enough.

The failure mode worth naming is not the rot. It is that the suite stayed green for a month on a
branch nobody pushed to, and a test that fails on a date rather than on a change reports a defect
that is not there — which is the same cost as a test that passes when one is.

## Decision

**A test that reasons about time names the instant it reasons about.** Either every clock in the
test is injected, or every date in it derives from a single anchor taken at run time. A test may
not hold one instant it named beside one it inherited.

A fixed calendar date is permitted only where nothing else in the assertion comes from the wall
clock. The moment a row's `createdAt`, a ledger entry or a session timestamp enters the assertion,
the named date has to be derived from _that_ value, not written beside it.

**Where the value cannot be injected, the anchor is the run.** The Event Ledger will not be given
an `occurredAt`, and the vault will not be given a creation date — an append-only record that
accepts a backdated entry is not an append-only record, and a document store that accepts an
arbitrary creation date accepts a backdated one. So the test moves instead: its period is a window
around this run, and its other fixtures are expressed against the same anchor at the spacing the
calendar gave them.

**A red `main` is fixed before any pull request merges.** Not merged around, not merged past with
a note. A red baseline means no PR can show that it is green, and the next failure lands in a
suite that is already failing.

**No test is skipped, weakened, or narrowed to get green.** Not `.skip`, not a loosened matcher,
not a smaller assertion. A test that cannot pass is either testing something real that is broken —
fix the code — or testing wrongly — fix the test, and say which in the commit. The three fixes
here changed no production code, and that is the claim being made about them, not a convenience.

## Consequences

The three tests assert exactly what they asserted before, on a clock they name. No production file
changed.

A test anchored to the run is harder to read than one with a calendar date in it: the reader has to
hold "fourteen days before this run" instead of "2026-08-01". That is the cost, and it is paid once
per file at the anchor, where a comment explains which value could not be injected and why.

This does not stop the class. A test can still bake a date in, and CI will not notice for as long
as nobody pushes. What would notice is running the suite against a clock set forward, and that is
not built here — it is the obvious next control, and naming it is not the same as having it.
