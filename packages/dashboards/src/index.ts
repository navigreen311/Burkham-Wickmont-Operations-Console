/**
 * @bwc/dashboards - 9.1 Executive KPI Dashboard and 9.2 Unit Economics Dashboard.
 *
 * Category 9's V1 scope. 9.3 Agent Productivity and 9.4 Lender Performance are V1.5.
 *
 * **No schema.** Nothing here is owned; everything is computed live from the modules that own it.
 * 11.6 Data Warehouse is not built, and even when it is, a stored snapshot would need a job - and
 * a job that stops leaves a dashboard showing last month's numbers with this month's date on them.
 * That failure is invisible, and it is invisible on the surface the company steers by.
 *
 * Three decisions worth knowing before reading further:
 *
 *   A METRIC IS A VALUE WITH ITS BASIS, OR IT IS NOTHING. Every figure carries its numerator,
 *   denominator, period and coverage; a rate below its minimum denominator is `null` with a note
 *   saying what would make it appear. `0` is a measurement, and there is often nothing to measure.
 *
 *   AN INCOMPLETE MARGIN IS NOT A MARGIN. 9.2 defines gross margin as including per-client vendor
 *   costs, and Plaid and the bureaus are ungated, so those cannot be measured. `grossMargin`
 *   refuses; `marginBeforeUnmeasuredCostsCents` gives the same arithmetic under a name that says
 *   what it excludes.
 *
 *   THE COMPLIANCE KPI IS A DISTRIBUTION, NEVER AN AVERAGE. Decision E, restated by blueprint 9.1
 *   as an explicit change from v1.
 */

export * from './metric.js';
export * from './compliance.js';
export * from './executive.js';
export * from './costs.js';
export * from './economics.js';
export * from './lenders.js';
export * from './productivity.js';
