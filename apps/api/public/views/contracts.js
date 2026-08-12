/**
 * 7.3 Contract & Disclosure Builder on the page.
 *
 * **A jurisdiction is required and there is no default.** "We could not tell which state" and "no
 * state rule applies" are different statements and only one of them is a check, so the field is
 * empty until somebody fills it and the panel refuses rather than guessing.
 *
 * **The fee exhibit is keyed by ENGAGEMENT, not by client.** A client with two engagements has two
 * exhibits, and each reads the offer version its own engagement started on - a repricing must not
 * change what an existing client agreed to pay.
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

/**
 * Render the writes a surface cannot offer, with the reason.
 *
 * **Shown, not omitted.** A panel with no buttons is indistinguishable from one whose buttons were
 * forgotten, and the reason is the part an operator needs: "no declared action" is a decision
 * somebody can take, and "refused by design" is one they should not try to.
 */
const blocked = (parent, writes) => {
  parent.replaceChildren();
  for (const entry of writes?.blocked ?? []) {
    line(parent, `${entry.capability} - ${entry.missingAction} - ${entry.why}`);
  }
};


const loadClauses = async () => {
  const jurisdiction = $('contracts-jurisdiction').value.trim();
  const tier = $('contracts-tier').value.trim();
  const status = $('contracts-clause-status');
  const list = $('contracts-clauses');
  list.replaceChildren();

  const query = new URLSearchParams({ jurisdiction });
  if (tier !== '') query.set('offerTier', tier);

  const result = await call(`/api/console/contracts/clauses?${query.toString()}`);
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  for (const clause of result.data.clauses) {
    line(list, `${clause.key} v${clause.version} - ${clause.jurisdiction} - ${clause.title ?? ''}`);
  }
  status.textContent =
    result.data.clauses.length === 0
      ? `No clause applies in ${result.data.jurisdiction}. That is a clause set nobody has published, not a jurisdiction with no rules.`
      : `${result.data.clauses.length} clause(s) in force in ${result.data.jurisdiction}.`;

  blocked($('contracts-blocked'), result.data.writes);
};

const loadHistory = async () => {
  const key = $('contracts-clause-key').value.trim();
  const status = $('contracts-history-status');
  const list = $('contracts-history');
  list.replaceChildren();

  if (key === '') {
    status.textContent = 'Give a clause key.';
    return;
  }

  const result = await call(`/api/console/contracts/clauses/${encodeURIComponent(key)}/history`);
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const clause of result.data) {
    // Superseded versions included, deliberately: what governs a March contract is the version in
    // force in March, and a list of current clauses cannot answer that.
    line(
      list,
      `v${clause.version} - ${clause.jurisdiction} - ${clause.supersededAt ? 'superseded' : 'in force'}`,
    );
  }
  status.textContent = `${result.data.length} version(s), oldest first.`;
};

const loadExhibit = async () => {
  const engagementId = $('contracts-engagement-id').value.trim();
  const status = $('contracts-exhibit-status');
  const list = $('contracts-exhibit');
  list.replaceChildren();

  if (engagementId === '') {
    status.textContent = 'Give an engagement id. An exhibit belongs to an engagement, not to a client.';
    return;
  }

  const result = await call(
    `/api/console/contracts/engagements/${encodeURIComponent(engagementId)}/fee-exhibit`,
  );
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const entry of result.data.lines ?? []) {
    line(list, `${entry.label} - ${entry.amount}`);
  }
  // A success fee before any approval is CONTINGENT, not an estimate against the requested limit.
  // That is the Seek Capital lesson and it is the sentence worth surfacing.
  status.textContent = result.data.contingentNote ?? `${(result.data.lines ?? []).length} fee line(s).`;
};

$('contracts-clause-load').addEventListener('click', () => void loadClauses());
$('contracts-history-load').addEventListener('click', () => void loadHistory());
$('contracts-exhibit-load').addEventListener('click', () => void loadExhibit());
