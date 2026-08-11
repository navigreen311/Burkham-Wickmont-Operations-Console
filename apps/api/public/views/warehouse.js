/**
 * 11.6 Data Warehouse on the page.
 *
 * **This panel cannot ask about now, and it says so where the "today" button would be.**
 *
 * The module has no `current()` and every read takes a period; a page that defaulted the period to
 * "the last 30 days" and called the answer a summary would reintroduce exactly what the module
 * refused to build. So the period is two required fields with no default, and the panel will not
 * fetch until both are filled.
 *
 * **An empty period renders as "no snapshot was captured", never as a zero.** A flat line at zero
 * is a claim that the business did nothing; `no_data` is a claim that nobody captured an answer.
 * Only the second is true, and the route sends `no_data` for exactly that reason.
 *
 * The ETL note is shown on every answer, not only the empty ones. Nothing in this repository
 * captures a snapshot outside tests, so a period that happened to contain seeded rows would read as
 * a working pipeline and the next empty one as a quiet month.
 *
 * Every value reaches the DOM through `textContent`.
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
};

const period = () => {
  const from = $('warehouse-from').value.trim();
  const to = $('warehouse-to').value.trim();
  return from === '' || to === ''
    ? null
    : `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
};

const loadSnapshots = async () => {
  const status = $('warehouse-status');
  const query = period();
  if (query === null) {
    // Refused here rather than defaulted. See the module header: a default period is a live read
    // wearing a historical label.
    status.textContent =
      'Enter both dates. The warehouse answers about a period you name — it has no notion of "now".';
    return;
  }

  status.textContent = 'Loading…';
  const result = await call(`/api/console/warehouse/snapshots?${query}`);

  const list = $('warehouse-snapshots');
  list.replaceChildren();

  if (!result.ok) {
    // `no_data` is the expected answer and its sentence is the content: it says an absence of
    // captures rather than a period in which nothing happened.
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const snapshot of result.data.snapshots) {
    line(
      list,
      `${snapshot.asOf}: ${snapshot.facts.clients} client(s), ${snapshot.facts.engagementsActive} active engagement(s), ${snapshot.subjects} subject row(s)${
        snapshot.gaps.length > 0 ? ` — GAPS: ${snapshot.gaps.join('; ')}` : ''
      }`,
    );
  }

  $('warehouse-etl').textContent = result.data.etl.detail;
  status.textContent = `${result.data.total} snapshot(s), ${result.data.withGaps} carrying a recorded gap.`;
};

const loadTrend = async () => {
  const status = $('warehouse-trend-status');
  const query = period();
  if (query === null) {
    status.textContent = 'Enter both dates first.';
    return;
  }

  const metric = $('warehouse-metric').value;
  status.textContent = 'Loading…';
  const result = await call(
    `/api/console/warehouse/trend?${query}&metric=${encodeURIComponent(metric)}`,
  );

  const list = $('warehouse-trend');
  list.replaceChildren();

  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const point of result.data.points) {
    line(
      list,
      // A point with gaps is a caveat, not a lower number, and it is labelled rather than plotted.
      `${point.asOf}: ${point.value}${point.gaps.length > 0 ? ` — incomplete: ${point.gaps.join('; ')}` : ''}`,
    );
  }

  status.textContent = `${result.data.total} point(s), ${result.data.pointsWithGaps} incomplete. ${result.data.detail}`;
};

const loadCohorts = async () => {
  const status = $('warehouse-cohort-status');
  const cohort = $('warehouse-cohort').value.trim();
  const query = period();

  // Listing the cohorts needs no period; retention for one does. Naming a cohort without dates
  // asks a question the route will refuse, so the panel says so first rather than showing its
  // refusal as an error.
  if (cohort !== '' && query === null) {
    status.textContent =
      'Retention for one cohort needs both dates. Leave the cohort blank to list them.';
    return;
  }

  const parts = [
    ...(query === null ? [] : [query]),
    ...(cohort === '' ? [] : [`cohort=${encodeURIComponent(cohort)}`]),
  ];

  status.textContent = 'Loading…';
  const result = await call(
    `/api/console/warehouse/cohorts${parts.length > 0 ? `?${parts.join('&')}` : ''}`,
  );

  const list = $('warehouse-cohorts');
  list.replaceChildren();

  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  if (result.data.cohorts.length === 0) {
    line(list, 'No cohort exists, because no snapshot has been captured.');
  } else {
    for (const name of result.data.cohorts) line(list, name);
  }

  if (result.data.retention === null) {
    status.textContent =
      result.data.retentionUnavailable === null
        ? `${result.data.total} cohort(s). Name one and give a period to see retention.`
        : `${result.data.total} cohort(s). Retention unavailable: ${result.data.retentionUnavailable.reason}`;
    return;
  }

  for (const point of result.data.retention.points ?? []) {
    line(
      list,
      `${cohort} at ${point.asOf}: ${point.stillEngaged} of ${point.members} still engaged`,
    );
  }
  status.textContent = `${result.data.total} cohort(s). Retention for ${cohort} over the period above.`;
};

$('warehouse-load').addEventListener('click', () => void loadSnapshots());
$('warehouse-trend-load').addEventListener('click', () => void loadTrend());
$('warehouse-cohort-load').addEventListener('click', () => void loadCohorts());
