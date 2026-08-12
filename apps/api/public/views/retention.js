/**
 * 7.5 Legal Hold & Record Retention on the page.
 *
 * **An overdue hold keeps holding, and the panel says so.** ADR-0013's rule points the safe way
 * here: a hold whose review has lapsed does not expire, because the alternative is records being
 * destroyed because a date passed. Overdue is rendered as a fact to act on, not as an expiry.
 *
 * **Ineligible for deletion is shown with the hold that says so.** `deletable: false` on its own
 * leaves an operator with nothing to do; the module sends the holds in force as a sentence and this
 * prints it.
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

const blocked = (parent, writes) => {
  parent.replaceChildren();
  for (const entry of writes?.blocked ?? []) {
    line(parent, `${entry.capability} - ${entry.missingAction} - ${entry.why}`);
  }
};


const loadHolds = async () => {
  const status = $('retention-holds-status');
  const list = $('retention-holds');
  list.replaceChildren();

  const result = await call('/api/console/retention/holds');
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const hold of result.data.holds) {
    // Matter reference first: a hold is a matter, not a flag on a document (ADR-0042).
    line(
      list,
      [
        hold.matterReference,
        hold.scope,
        hold.clientId ? `client ${hold.clientId}` : 'tenant-wide',
        hold.reason,
        hold.reviewOverdue ? `REVIEW OVERDUE (due ${String(hold.reviewDueAt).slice(0, 10)})` : 'review current',
      ].join(' - '),
    );
  }
  status.textContent = result.data.detail;
  blocked($('retention-blocked'), result.data.writes);
};

const loadRequests = async () => {
  const status = $('retention-requests-status');
  const list = $('retention-requests');
  list.replaceChildren();

  const result = await call('/api/console/retention/requests');
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const request of result.data.requests) {
    line(
      list,
      `${request.clientId} - asked ${String(request.requestedAt).slice(0, 10)} by ${request.requestedBy} - ${request.requestDetail}`,
    );
  }
  status.textContent = result.data.detail;
  blocked($('retention-blocked'), result.data.writes);
};

const loadClient = async () => {
  const clientId = $('retention-client-id').value.trim();
  const status = $('retention-client-status');
  const list = $('retention-client-requests');
  list.replaceChildren();

  if (clientId === '') {
    status.textContent = 'Give a client id.';
    return;
  }

  const result = await call(`/api/console/retention/clients/${encodeURIComponent(clientId)}`);
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  const { eligibility, requests } = result.data;

  for (const request of requests) {
    line(
      list,
      `${request.status} - asked ${String(request.requestedAt).slice(0, 10)}${
        request.decisionReason ? ` - ${request.decisionReason}` : ''
      }`,
    );
  }

  // The sentence naming what holds the record, not a bare false.
  status.textContent = eligibility.deletable
    ? `Deletable. ${eligibility.note}`
    : `NOT deletable. ${eligibility.heldBy ?? eligibility.note}`;

  blocked($('retention-blocked'), result.data.writes);
};

$('retention-holds-load').addEventListener('click', () => void loadHolds());
$('retention-requests-load').addEventListener('click', () => void loadRequests());
$('retention-client-load').addEventListener('click', () => void loadClient());
