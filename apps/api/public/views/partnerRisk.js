/**
 * 8.4 Partner Risk on the page.
 *
 * **The one way to get this panel wrong is to help.** 8.4 asks for a score and the module refuses
 * to produce one, at length and for a stated reason: combining conduct with performance yields a
 * figure in which revenue contribution offsets an unauthorized promise. Every instinct a page has -
 * a headline number, a coloured badge derived from both, a queue sorted worst-first - performs that
 * combination in the layer where nobody is looking for it.
 *
 * So this renders standing and measures as two blocks that never touch, and the queue in the order
 * the module sent it.
 *
 * **A null measure prints its sentence, never a zero.** Below the minimum sample the module returns
 * null with the denominator; `0%` would be a complaint rate invented out of nothing, which is the
 * same failure 5.5's panel exists to avoid.
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

const loadPartner = async () => {
  const partnerId = $('partner-risk-id').value.trim();
  const status = $('partner-risk-status');
  const standing = $('partner-risk-standing');
  const measures = $('partner-risk-measures');
  standing.replaceChildren();
  measures.replaceChildren();

  if (partnerId === '') {
    status.textContent = 'Give a partner id.';
    return;
  }

  const result = await call(`/api/console/partners/${encodeURIComponent(partnerId)}/risk`);
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  const data = result.data;

  // --- Conduct. Categorical, worst-of, never averaged. -----------------------
  line(standing, `Standing: ${data.standing}`);
  for (const trigger of data.triggers ?? []) {
    line(standing, `${trigger.severity} - ${trigger.kind}: ${trigger.summary ?? ''}`);
  }
  if ((data.triggers ?? []).length === 0) {
    line(standing, 'No open conduct finding.');
  }

  // --- Performance. Numeric, each with its denominator, null below sample. ---
  for (const measure of data.measures ?? []) {
    // The withholding, rendered as the module's own sentence. `0%` here would be a rate nobody
    // measured, about a person whose livelihood partly depends on it.
    const value =
      measure.value === null || measure.value === undefined
        ? `withheld - ${measure.note ?? `${data.minimumReferralsForRate} referrals are needed`}`
        : String(measure.value);
    line(measures, `${measure.label ?? measure.key}: ${value} (over ${measure.denominator ?? '?'})`);
  }
  for (const absent of data.unmeasured ?? []) {
    line(measures, `${absent}: nothing produces this yet`);
  }

  // **The sentence that stops a reader combining them.** Somebody who sees a good conversion rate
  // beside a serious finding will average them in their head unless told not to.
  status.textContent = data.combinationRule;

  renderAvailable('partner-risk-available', data.writes?.available);
};

const loadReview = async () => {
  const status = $('partner-risk-review-status');
  const list = $('partner-risk-review');
  list.replaceChildren();

  const result = await call('/api/console/partners/risk/review');
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  // In the module's order, which is by name. Sorting this by anything numeric would rank conduct
  // against revenue, which is the combination the whole module refuses.
  for (const assessment of result.data.partners) {
    line(
      list,
      `${assessment.partnerId} - ${assessment.standing} - ${assessment.openFindings?.length ?? 0} open finding(s)`,
    );
  }

  const counts = Object.entries(result.data.byStanding ?? {})
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
  status.textContent = counts === '' ? result.data.detail : `${result.data.detail} ${counts}.`;

  renderAvailable('partner-risk-available', result.data.writes?.available);
};

$('partner-risk-load').addEventListener('click', () => void loadPartner());
$('partner-risk-review-load').addEventListener('click', () => void loadReview());

/**
 * The two controls.
 *
 * Recording says plainly that a critical finding suspends immediately. An operator who learns that
 * from the consequence rather than the button has been told too late.
 */
renderWrites('partner-risk-writes', [
  {
    id: 'risk-record',
    capability: 'Record a conduct finding',
    action: 'record_partner_finding',
    note: 'A CRITICAL severity SUSPENDS the partner immediately, from inside the module - automatic in, human out. Level 1 deliberately: a finding nobody recorded is a partner promising clients an approval, and one recorded in error takes a person to resolve.',
    danger: true,
    buttonLabel: 'Record the finding',
    done: 'Finding recorded. A critical one has already suspended the partner.',
    fields: [
      { name: 'partnerId', label: 'Partner id' },
      { name: 'kind', label: 'Kind', placeholder: 'unauthorized_promise' },
      { name: 'severity', label: 'Severity', placeholder: 'serious' },
      { name: 'summary', label: 'Summary' },
    ],
    path: (v) => `/api/console/partners/${encodeURIComponent(v.partnerId)}/risk/findings`,
    body: (v) => ({ kind: v.kind, severity: v.severity, summary: v.summary }),
  },
  {
    id: 'risk-resolve',
    capability: 'Resolve a finding',
    action: 'resolve_partner_finding',
    note: 'Level 3: resolving is the direction that RESTORES. An open finding suppresses a standing, and one resolved carelessly puts somebody back in front of clients. The note is required either way - upheld or not.',
    buttonLabel: 'Resolve it',
    done: 'Finding resolved.',
    fields: [
      { name: 'findingId', label: 'Finding id' },
      { name: 'upheld', label: 'Upheld? (true/false)', placeholder: 'true' },
      { name: 'note', label: 'What was looked into, and concluded' },
    ],
    path: (v) => `/api/console/partners/risk/findings/${encodeURIComponent(v.findingId)}/resolution`,
    body: (v) => ({ upheld: v.upheld === 'true', note: v.note }),
  },
]);
