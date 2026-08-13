/**
 * C8. Resolving a Needs Review compliance state.
 *
 * **The act this role exists to perform.** Decision E makes the state categorical and 3.7 keeps
 * placement frozen while a client sits in Needs Review - so the client is waiting on precisely this
 * decision, and nothing downstream moves until somebody makes it.
 *
 * Two destinations and not three. `pass` is deliberately absent: a file only reaches Needs Review
 * because a finding was raised, and moving it to Pass would discard that finding rather than
 * acknowledge it. Pass with Findings keeps it on the record; Fail routes to Do Not Fund Governance.
 *
 * The findings load first because a resolution recorded without reading them is a verdict on
 * something unseen. The reason is required by the module, not by this page.
 */

const $ = (id) => document.getElementById(id);

const line = (parent, text) => {
  const li = document.createElement('li');
  li.textContent = text;
  parent.append(li);
};

const loadFindings = async () => {
  const clientId = $('resolve-client').value.trim();
  const status = $('resolve-status');
  const list = $('resolve-findings');
  list.replaceChildren();

  if (clientId === '') {
    status.textContent = 'Give a client id.';
    return;
  }

  const response = await fetch(`/api/console/clients/${encodeURIComponent(clientId)}`, {
    credentials: 'same-origin',
  });
  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));
  if (payload.status !== 'ok') {
    status.textContent = `${payload.status}: ${payload.reason ?? 'Something went wrong.'}`;
    return;
  }

  const { client, findings } = payload.data;
  for (const finding of findings ?? []) {
    line(list, `${finding.code} — ${finding.summary}`);
  }

  // The state is named, never scored. An operator resolving a file has to know it is actually in
  // Needs Review - resolving one that is not is a transition nobody asked for.
  status.textContent =
    (findings ?? []).length === 0
      ? `Compliance state: ${client.complianceState}. No open finding is recorded, which is a fact about the file rather than a clean bill.`
      : `Compliance state: ${client.complianceState}. ${findings.length} open finding(s), listed as recorded.`;
};

const submit = async () => {
  const clientId = $('resolve-client').value.trim();
  const to = $('resolve-decision').value;
  const reason = $('resolve-reason').value.trim();
  const result = $('resolve-result');
  const trace = $('resolve-trace');
  trace.replaceChildren();

  if (clientId === '' || to === '' || reason === '') {
    result.textContent =
      'A client, a resolution and a reason are all required. The reason is what the Event Ledger records, and a transition nobody explained is one nobody can review.';
    return;
  }

  result.textContent = 'Working…';
  const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}/compliance`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, reason }),
  });
  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));

  result.textContent =
    payload.status === 'ok'
      ? `Recorded. The client is now ${to.replace(/_/gu, ' ')}, and the transition is in the Event Ledger against your actor id.`
      : `${payload.status}: ${payload.reason ?? 'Something went wrong.'}`;

  // The chain trace, refusals included: which step blocked this is the first question anybody asks.
  for (const step of payload.trace ?? []) {
    line(trace, step.detail ? `${step.step}: ${step.outcome} — ${step.detail}` : `${step.step}: ${step.outcome}`);
  }
};

$('resolve-load').addEventListener('click', () => void loadFindings());
$('resolve-submit').addEventListener('click', () => void submit());
