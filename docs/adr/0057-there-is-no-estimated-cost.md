# ADR-0057 - There is no estimated cost, and platform spend is not divided into clients

**Status:** Accepted - **Date:** 2026-08-11 - **Modules:** 11.9 Cost & Performance Governance

## Context

Blueprint 11.9 wants per-agent model costs, vendor costs from Decisions A and B as per-client COGS,
cost anomaly detection, and a per-client unit-economics feed into 9.2.

Two implementations look obvious and are both wrong.

## Decision 1 - `CostProvenance` has two members and no third

The tempting implementation multiplies token counts by a published model price and calls the result
cost. That figure would sit in the same column as a vendor invoice, and **the moment two
provenances share a column somebody sums them** - at which point a unit-economics number that looks
measured is partly a guess about a price list that changed last quarter.

So provenance is `observed` (counted by us at the time of the call) or `vendor_invoice`. There is
no `estimated`, and no code path writes one. Principle 8, applied to money we spend.

## Decision 2 - platform cost is reported beside per-client cost, never inside it

A per-client unit cost is honest only for spend actually incurred on that client. Dividing a
subscription across active clients produces an allocation with the shape of a measurement - and the
per-client figure would move when a _different_ client signed up.

`unitCostFor` returns `attributableCents` and `unattributedPlatformCents` as separate fields and
merges them nowhere.

## Decision 3 - a gated vendor is unobservable, not zero

Plaid, the business bureau and the personal credit provider are gated behind Argus review and a DPA
(Decisions A and B). `recordCost` **refuses** a cost against them - recording one would put a figure
in the unit-economics feed for a vendor that has never been called - and `costCoverage` reports them
as `observable: false` with the reason. A zero beside Plaid reads as a vendor we are not spending
money on, rather than one we have not switched on.

## Consequences

**Most of what 11.9 is supposed to track cannot be measured yet.** Model API metering is the only
source currently switched on. `requireCosts` returns `no_data` naming that, so a client with no cost
records is distinguishable from a client who cost nothing to serve.

**Anomaly detection reports direction only, with no threshold.** A threshold is a number under which
nobody looks, and a drift that stays just under it every month is exactly what this is for. Sources
below `MINIMUM_RECORDS_TO_COMPARE` in either window are omitted rather than reported as steady. The
module cannot see volume, so it cannot say whether a rise is an anomaly - only that it happened, and
a cost that doubled because the work doubled is not one.

**The unit-economics feed into 9.2 is therefore partial**, and says which part. That is better than
the alternative, which is a complete-looking COGS figure with three gated vendors silently absent
from it.

## Alternatives considered

**Add `estimated` and filter it at read time.** Rejected - the filter is one forgotten `where`
clause away from being a sum.

**Allocate platform cost pro rata and label the allocation.** Rejected - see Decision 2. The label
does not travel with the number into a spreadsheet.

**Record gated-vendor costs at zero so the row exists.** Rejected. That is the specific confusion
Decision 3 exists to prevent.
