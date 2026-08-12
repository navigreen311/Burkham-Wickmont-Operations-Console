/**
 * 5.5 Funding Outcome Ledger on the page.
 *
 * **The whole job of this panel is to render a withheld rate as withheld.** Below the minimum
 * sample the module sends `rate: null` and a sentence saying how many more decided attempts would
 * produce a figure. `null` is not zero, and `0%` is a claim nobody made - so the null path prints
 * the sentence and never a number.
 *
 * The counts are shown either way, because they are real. A page that hid them along with the rate
 * would be withholding measurements as well as the thing derived from them.
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

const blocked = (parent, writes) => {
  parent.replaceChildren();
  for (const entry of writes?.blocked ?? []) {
    line(parent, `${entry.capability} - ${entry.missingAction} - ${entry.why}`);
  }
};


const percent = (rate) =>
  typeof rate === 'number' ? `${(rate * 100).toFixed(1)}%` : null;

const loadRate = async () => {
  const from = $('outcomes-from').value.trim();
  const to = $('outcomes-to').value.trim();
  const status = $('outcomes-rate-status');
  const list = $('outcomes-counts');
  list.replaceChildren();

  if (from === '' || to === '') {
    status.textContent = 'Give both dates. A rate over an unstated period is a figure nobody can check.';
    return;
  }

  const result = await call(
    `/api/console/outcomes/rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  const data = result.data;

  // Counts first, always. They are measurements and they are real whether or not a rate exists.
  line(list, `submitted ${data.submitted}`);
  line(list, `approved ${data.approved}`);
  line(list, `declined ${data.declined}`);
  line(list, `withdrawn ${data.withdrawn}`);
  line(list, `pending ${data.pending}`);
  line(list, `decided ${data.decided} (the denominator)`);

  const shown = percent(data.rate);
  // The module's own sentence when there is no rate. Never "0%", which is a claim nobody made.
  status.textContent = shown === null ? data.note : `Approval rate ${shown}. ${data.note}`;

  blocked($('outcomes-blocked'), data.writes);
  renderAvailable('outcomes-available', data.writes?.available);
};

const loadUnfunded = async () => {
  const status = $('outcomes-unfunded-status');
  const list = $('outcomes-unfunded');
  list.replaceChildren();

  const result = await call('/api/console/outcomes/approved-unfunded');
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const attempt of result.data.attempts) {
    // An approval that never became money counts as a success in every percentage. This is the
    // read that shows it.
    line(
      list,
      `${attempt.clientId} - approved ${String(attempt.decidedAt).slice(0, 10)} - ${
        attempt.daysToApproval ?? '?'
      } day(s) to approval - still unfunded`,
    );
  }
  status.textContent = result.data.detail;
};

const loadClient = async () => {
  const clientId = $('outcomes-client-id').value.trim();
  const status = $('outcomes-client-status');
  const list = $('outcomes-attempts');
  list.replaceChildren();

  if (clientId === '') {
    status.textContent = 'Give a client id.';
    return;
  }

  const result = await call(`/api/console/outcomes/clients/${encodeURIComponent(clientId)}`);
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const attempt of result.data.attempts) {
    line(
      list,
      `${attempt.productKind} - ${attempt.outcome}${
        attempt.declineReason ? ` (${attempt.declineReason})` : ''
      } - submitted ${String(attempt.submittedAt).slice(0, 10)}`,
    );
  }

  const { total, approved, declined, pending } = result.data.summary;
  // Spelled out so "three attempts" cannot be read as three approvals.
  status.textContent = `${total} attempt(s): ${approved} approved, ${declined} declined, ${pending} pending.`;

  blocked($('outcomes-blocked'), result.data.writes);
  renderAvailable('outcomes-available', result.data.writes?.available);
};

$('outcomes-rate-load').addEventListener('click', () => void loadRate());
$('outcomes-unfunded-load').addEventListener('click', () => void loadUnfunded());
$('outcomes-client-load').addEventListener('click', () => void loadClient());

/**
 * The outcome controls.
 *
 * Marking an attempt funded is its own control at its own level, and it says why: it is the act
 * that stops a refund clock, and the harm from a wrong one arrives sixty days later in the form of
 * a refund a client never receives.
 */
renderWrites('outcomes-writes', [
  {
    id: 'outcomes-approve',
    capability: 'Record a provider approval',
    action: 'record_funding_outcome',
    note: 'The approved credit limit is the figure a success fee computes against - never the requested one.',
    buttonLabel: 'Record the approval',
    done: 'Approval recorded.',
    fields: [
      { name: 'attemptId', label: 'Attempt id' },
      { name: 'approvedCreditLimitCents', label: 'Approved limit in CENTS' },
      { name: 'decidedAt', label: 'Decided at', type: 'date' },
    ],
    path: (v) => `/api/console/outcomes/attempts/${encodeURIComponent(v.attemptId)}/approval`,
    body: (v) => ({
      approvedCreditLimitCents: Number(v.approvedCreditLimitCents),
      decidedAt: v.decidedAt,
    }),
  },
  {
    id: 'outcomes-decline',
    capability: 'Record a provider decline',
    action: 'record_funding_outcome',
    note: 'The half that makes an approval rate honest. A decline nobody records is a rate that reads better than the firm performed.',
    buttonLabel: 'Record the decline',
    done: 'Decline recorded.',
    fields: [
      { name: 'attemptId', label: 'Attempt id' },
      { name: 'reason', label: 'Reason as the provider gave it' },
      { name: 'decidedAt', label: 'Decided at', type: 'date' },
    ],
    path: (v) => `/api/console/outcomes/attempts/${encodeURIComponent(v.attemptId)}/decline`,
    body: (v) => ({ reason: v.reason, decidedAt: v.decidedAt }),
  },
  {
    id: 'outcomes-funded',
    capability: 'Mark an attempt funded',
    action: 'mark_attempt_funded',
    note: 'Level 3, and separate from every other outcome: this STOPS the sixty-day approved-but-unfunded refund trigger. A wrong one denies a refund the client is owed, and does it silently.',
    danger: true,
    buttonLabel: 'Mark it funded',
    done: 'Funding recorded. The refund trigger no longer runs against this attempt.',
    fields: [
      { name: 'attemptId', label: 'Attempt id' },
      { name: 'fundedCents', label: 'Amount funded in CENTS' },
      { name: 'fundedOn', label: 'Funded on', type: 'date' },
    ],
    path: (v) => `/api/console/outcomes/attempts/${encodeURIComponent(v.attemptId)}/funding`,
    body: (v) => ({ fundedCents: Number(v.fundedCents), fundedOn: v.fundedOn }),
  },
]);
