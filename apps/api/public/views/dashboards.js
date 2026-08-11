/**
 * 9.1 and 9.2 on the page.
 *
 * **The rule this file exists to obey: a metric with no value is rendered, with its reason.**
 *
 * `Metric<T>` carries `value: T | null` and a `note` that says why when the value is null
 * (ADR-0017). Three renderings destroy that, and all three are what a careful person writes by
 * reflex:
 *
 *   coalescing a null value to zero    turns "we cannot measure gross margin" into "gross margin
 *                                      is zero", which is a claim about the business rather than
 *                                      about the system, and the only one of the two that is false
 *   returning early on a null value    hides the row, and a reader concludes there is nothing to
 *                                      report
 *   substituting a dash                teaches its reader to ignore dashes
 *
 * The first of those is deliberately described rather than written out: a test in
 * `console-capital.test.ts` asserts the coalescing operator followed by a zero appears nowhere in
 * this file, and a comment naming it would fail that test - the same reason `console.js` describes
 * the markup-assigning properties without naming them.
 *
 * So `renderMetric` always emits the label, always emits the note, and emits the words **"not
 * measured"** where the number would be. The note is the module's own sentence - "4 decided
 * placements, 10 needed before this is a rate" - which tells the operator what would make the
 * figure appear.
 *
 * Every value reaches the DOM through `textContent`. Nothing here builds markup from data.
 */

/**
 * Each panel carries its own fetch wrapper rather than importing one.
 *
 * `api.js` belongs to the Console's own page and this branch does not extend it. Ten duplicated
 * lines is the cost, and the thing bought is that these five panels cannot break each other: a
 * shared module here would make one panel's failure a blank page for the other four, on a surface
 * whose entire purpose is reporting what is and is not known.
 */
const call = async (path) => {
  const response = await fetch(path, { credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));
  return payload.status === 'ok'
    ? { ok: true, data: payload.data }
    : { ok: false, reason: payload.reason ?? 'Something went wrong.', status: payload.status };
};

const $ = (id) => document.getElementById(id);

const line = (parent, text) => {
  const li = document.createElement('li');
  li.textContent = text;
  parent.append(li);
  return li;
};

/**
 * Format a metric value for display without ever inventing one.
 *
 * Objects (the compliance distribution, the offer list) are not stringified here - the caller
 * renders those itself. This handles the scalar case and says so when it cannot.
 */
const valueText = (value) => {
  if (value === null || value === undefined) return 'not measured';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === 'string') return value;
  return 'see detail';
};

/**
 * One metric, whole.
 *
 * The basis travels with it always, not only when it is interesting: a numerator and denominator
 * beside a rate is how a reader checks the rate, and a rate without them is a number to be believed.
 */
const renderMetric = (parent, metric) => {
  const item = document.createElement('li');

  const label = document.createElement('strong');
  label.textContent = metric.label;
  item.append(label);

  const value = document.createElement('span');
  value.textContent = ` — ${valueText(metric.value)}`;
  item.append(value);

  const basis = document.createElement('div');
  const numerator = metric.basis?.numerator;
  const denominator = metric.basis?.denominator;
  basis.textContent =
    numerator === null ||
    numerator === undefined ||
    denominator === null ||
    denominator === undefined
      ? `Coverage: ${metric.basis?.coverage ?? 'unknown'}.`
      : `${numerator} of ${denominator}. Coverage: ${metric.basis?.coverage ?? 'unknown'}.`;
  item.append(basis);

  // The reason, always. This is the sentence that distinguishes "nothing happened" from "we do not
  // measure this", and it is the whole reason a null metric is worth rendering at all.
  const note = document.createElement('div');
  note.textContent = metric.note ?? '';
  item.append(note);

  const unmeasured = metric.basis?.unmeasured ?? [];
  if (unmeasured.length > 0) {
    const blocked = document.createElement('div');
    blocked.textContent = `Awaiting: ${unmeasured.join('; ')}`;
    item.append(blocked);
  }

  parent.append(item);
};

const METRIC_KEYS = [
  'complianceDistribution',
  'complianceMovement',
  'readinessImprovement',
  'placementApprovalRate',
  'internalGateRefusalRate',
  'firewallResolutionRate',
  'openCorrectionObligations',
  'partnerConversionRate',
  'refundRate',
  'revenuePerClientCents',
];

const renderExecutive = (data) => {
  const list = $('dash-executive-list');
  list.replaceChildren();

  for (const key of METRIC_KEYS) {
    const metric = data[key];
    if (metric === undefined) continue;
    renderMetric(list, metric);
  }

  // The compliance distribution is a shape, not a scalar, so its counts are written out state by
  // state - including the states at zero. A missing row reads as no problem.
  const distribution = data.complianceDistribution?.value;
  const counts = $('dash-compliance-counts');
  counts.replaceChildren();
  if (distribution === null || distribution === undefined) {
    line(counts, data.complianceDistribution?.note ?? 'Not measured.');
  } else {
    for (const [state, count] of Object.entries(distribution.counts ?? {})) {
      line(counts, `${state}: ${count}`);
    }
    line(
      counts,
      distribution.healthyShare === null
        ? 'Healthy share: not measured.'
        : `Healthy share: ${(distribution.healthyShare * 100).toFixed(1)}% — target met: ${
            distribution.meetsTarget ? 'yes' : 'no'
          }.`,
    );
  }

  const withheld = $('dash-executive-withheld');
  withheld.replaceChildren();
  if ((data.withheld ?? []).length === 0) {
    line(withheld, 'Every metric on this dashboard was measured.');
  } else {
    for (const entry of data.withheld) line(withheld, `${entry.label}: ${entry.note}`);
  }

  const unproduced = $('dash-executive-unproduced');
  unproduced.replaceChildren();
  for (const entry of data.unproduced ?? []) {
    line(unproduced, `${entry.domain} — ${entry.awaiting}`);
  }
};

const renderUnitEconomics = (data) => {
  const list = $('dash-economics-list');
  list.replaceChildren();
  for (const key of ['offerEconomics', 'acquisitionCost', 'realisedRevenuePerClient']) {
    const metric = data[key];
    if (metric !== undefined) renderMetric(list, metric);
  }

  /**
   * The two figures 9.2 refuses outright.
   *
   * Rendered as refusals with their stated reason and their governing principle - not omitted, and
   * emphatically not as zero. Gross margin at zero would be a claim about the business; "gross
   * margin cannot be computed while the vendor COGS lines are ungated" is a claim about the system,
   * and only the second one is true.
   */
  const refused = $('dash-economics-refused');
  refused.replaceChildren();
  for (const entry of data.refusedOutright ?? []) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = `${entry.label} — refused (${entry.status})`;
    item.append(label);
    const why = document.createElement('div');
    why.textContent = entry.why;
    item.append(why);
    if (entry.principle) {
      const principle = document.createElement('div');
      principle.textContent = entry.principle;
      item.append(principle);
    }
    refused.append(item);
  }

  const costs = $('dash-economics-costs');
  costs.replaceChildren();
  for (const entry of data.unmeasuredCostLines ?? []) {
    line(costs, `${entry.line} — ${entry.gate}`);
  }

  const withheld = $('dash-economics-withheld');
  withheld.replaceChildren();
  if ((data.withheld ?? []).length === 0) {
    line(withheld, 'Every metric on this dashboard was measured.');
  } else {
    for (const entry of data.withheld) line(withheld, `${entry.label}: ${entry.note}`);
  }
};

let loaded = false;

const load = async () => {
  const status = $('dash-status');
  status.textContent = 'Loading…';

  const [executive, economics] = await Promise.all([
    call('/api/console/dashboards/executive'),
    call('/api/console/dashboards/unit-economics'),
  ]);

  if (!executive.ok) {
    status.textContent = executive.reason;
    return;
  }
  if (!economics.ok) {
    status.textContent = economics.reason;
    return;
  }

  renderExecutive(executive.data);
  renderUnitEconomics(economics.data);

  status.textContent = `Period ${executive.data.period?.from?.slice(0, 10) ?? '?'} to ${
    executive.data.period?.to?.slice(0, 10) ?? '?'
  }${executive.data.period?.partial ? ' (partial — not comparable with a completed period)' : ''}.`;
  loaded = true;
};

$('panel-dashboards').addEventListener('toggle', () => {
  if ($('panel-dashboards').open && !loaded) void load();
});

$('dash-refresh').addEventListener('click', () => {
  loaded = false;
  void load();
});
