/**
 * 3.3 Document Intelligence Pipeline on the page.
 *
 * **No finding is rendered without the confidence behind it.**
 *
 * Every derived fact in the pipeline is a value with its provenance, and the readable half on its
 * own is an assertion: "revenue averaged X" rather than "Plaid says revenue averaged X, over three
 * of the twenty-four months we asked for". So every finding row carries its provenance tag, whether
 * that tag counts as verified, and the retrieval timestamp when there is one.
 *
 * An unverified finding is labelled UNVERIFIED in words. Not a colour, not a subdued row - a
 * console that distinguished a bureau-sourced finding from an assumed one by shade would be
 * indistinguishable from one that did not distinguish them at all, to anybody reading a printout or
 * using a screen reader.
 *
 * Coverage is shown with the line the module draws, so a reader sees the ratio and the threshold
 * together rather than being asked to judge a bare number.
 *
 * Every value reaches the DOM through `textContent`.
 */

import { renderAvailable, renderWrites } from './writes.js';
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
};

/**
 * One finding, with the confidence the pipeline actually has.
 *
 * The provenance line is not optional and is not abbreviated. A finding whose provenance is missing
 * says so, because that absence is itself the thing to act on.
 */
const renderFinding = (parent, finding) => {
  const item = document.createElement('li');

  const label = document.createElement('strong');
  label.textContent = `${finding.kind} (${finding.severity})${
    finding.confidence.verified ? '' : ' — UNVERIFIED'
  }`;
  item.append(label);

  const summary = document.createElement('div');
  summary.textContent = finding.summary;
  item.append(summary);

  const provenance = document.createElement('div');
  provenance.textContent = `Basis: ${finding.confidence.basis}${
    finding.confidence.retrievedAt === null ? '' : `, retrieved ${finding.confidence.retrievedAt}`
  }. ${finding.confidence.verified ? 'Sourced from a feed.' : 'Not independently verified — treat as a lead, not a fact.'}`;
  item.append(provenance);

  parent.append(item);
};

const render = (data) => {
  const findings = $('intelligence-findings');
  findings.replaceChildren();
  if (data.findings.length === 0) {
    line(findings, 'No finding is recorded for this client.');
  } else {
    for (const finding of data.findings) renderFinding(findings, finding);
  }

  const runs = $('intelligence-runs');
  runs.replaceChildren();
  if (data.runs.length === 0) {
    // Distinct from "no findings": a client with no run and one whose every ingestion was refused
    // look identical in a findings list, and only the runs tell them apart.
    line(runs, 'No ingestion has been attempted for this client.');
  } else {
    for (const run of data.runs) {
      line(runs, `${run.source}: ${run.status}${run.detail ? ` — ${run.detail}` : ''}`);
    }
  }

  const coverage = $('intelligence-coverage');
  coverage.replaceChildren();
  line(
    coverage,
    `Phase ${data.coverage.phase}: ${data.coverage.held?.length ?? 0} of ${data.coverage.required?.length ?? 0} required document kind(s) held.`,
  );
  if ((data.coverage.missing ?? []).length === 0) {
    line(coverage, 'Nothing required for this phase is missing.');
  } else {
    for (const kind of data.coverage.missing) line(coverage, `Missing: ${kind}`);
  }
  line(
    coverage,
    `The pipeline treats coverage below ${data.minimumCoverage} as insufficient to reconcile against.`,
  );

  renderAvailable('intelligence-available', data.writes?.available);
  const blocked = $('intelligence-blocked');
  blocked.replaceChildren();
  for (const entry of data.writes?.blocked ?? []) {
    const item = document.createElement('li');
    const what = document.createElement('strong');
    what.textContent = entry.capability;
    item.append(what);
    const why = document.createElement('div');
    why.textContent = entry.why;
    item.append(why);
    blocked.append(item);
  }

  $('intelligence-status').textContent =
    `${data.findingsTotal} finding(s), of which ${data.findingsUnverified} rest on something unverified. ${data.runsTotal} ingestion run(s).`;
};

const load = async () => {
  const status = $('intelligence-status');
  const clientId = $('intelligence-client-id').value.trim();
  if (clientId === '') {
    status.textContent = 'Enter a client id.';
    return;
  }

  status.textContent = 'Loading…';
  const phase = $('intelligence-phase').value;
  const result = await call(
    `/api/console/clients/${encodeURIComponent(clientId)}/intelligence?phase=${encodeURIComponent(phase)}`,
  );

  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  render(result.data);
  $('intelligence-detail').hidden = false;
};

$('intelligence-load').addEventListener('click', () => void load());

/** Internal intelligence. Nothing here reaches a client or commits the firm. */
renderWrites('intelligence-writes', [
  {
    id: 'intel-ingest',
    capability: 'Start an ingestion run',
    action: 'record_market_intelligence',
    note: 'Level 1. Writes a feed that other reads treat as given.',
    buttonLabel: 'Ingest',
    done: 'Ingestion run started.',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'source', label: 'Source' },
      { name: 'scope', label: 'Scope' },
      { name: 'monthsRequested', label: 'Months requested' },
    ],
    path: (v) => `/api/console/intelligence/clients/${encodeURIComponent(v.clientId)}/ingest`,
    body: (v) => ({
      source: v.source,
      scope: v.scope,
      monthsRequested: Number(v.monthsRequested),
    }),
  },
]);
