/**
 * 10.1 Inter-Venture Commerce Hooks on the page.
 *
 * **There is no acknowledge button, and its absence is the feature.**
 *
 * A conflict disclosure completes only on acknowledgement by parties who are not us: the venture's
 * own representative and Gardner. A control here that recorded either would manufacture the exact
 * evidence the disclosure exists to require, and afterwards it would be indistinguishable from the
 * real thing. So the panel shows the state, names who is outstanding, and offers nothing.
 *
 * That is a different absence from the rest of this Console's blocked writes, and the panel renders
 * it differently: the other entries are waiting on a declared action, and this one is waiting on a
 * counterparty. `unblockedBy` carries the distinction so the page can say which.
 *
 * **The content hash is shown.** An operator chasing an acknowledgement needs to be able to say
 * which version they are chasing - the hash is checked when the acknowledgement lands, and a
 * template change after generation cannot rewrite what was acknowledged.
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

const renderBlocked = (id, blocked) => {
  const element = $(id);
  element.replaceChildren();
  for (const entry of blocked ?? []) {
    const item = document.createElement('li');
    const what = document.createElement('strong');
    // The two kinds read differently on purpose: one is waiting on a decision, the other on a
    // party who is not us and never will be.
    what.textContent = `${entry.capability} — unblocked by ${entry.unblockedBy ?? 'a declared action'}`;
    item.append(what);
    const why = document.createElement('div');
    why.textContent = entry.why;
    item.append(why);
    element.append(item);
  }
};

let loaded = false;

const loadRelationships = async () => {
  const status = $('interventure-status');
  status.textContent = 'Loading…';

  const result = await call('/api/console/interventure/relationships');
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  const list = $('interventure-relationships');
  list.replaceChildren();
  if (result.data.relationships.length === 0) {
    line(list, 'No client is tagged as a Green Companies venture.');
  } else {
    for (const relationship of result.data.relationships) {
      line(
        list,
        `${relationship.ventureKey} — client ${relationship.clientId}, tagged ${relationship.taggedAt}`,
      );
    }
  }

  const ventures = $('interventure-ventures');
  ventures.replaceChildren();
  for (const venture of result.data.ventures) {
    line(ventures, `${venture.key} — ${venture.legalName ?? venture.name ?? ''}`);
  }

  const routing = $('interventure-routing');
  routing.replaceChildren();
  if (result.data.awaitingRouting.length === 0) {
    line(routing, 'No intercompany invoice is waiting to be routed.');
  } else {
    for (const invoice of result.data.awaitingRouting) {
      line(routing, `${invoice.id} — ${invoice.state}, raised ${invoice.raisedAt}`);
    }
  }

  renderBlocked('interventure-blocked', result.data.writes?.blocked);
  renderAvailable('interventure-available', result.data.writes?.available);

  status.textContent = `${result.data.total} tagged relationship(s), ${result.data.awaitingRoutingTotal} invoice(s) awaiting routing.`;
  loaded = true;
};

const loadEngagement = async () => {
  const status = $('interventure-engagement-status');
  const engagementId = $('interventure-engagement-id').value.trim();
  const clientId = $('interventure-client-id').value.trim();

  if (engagementId === '' || clientId === '') {
    status.textContent = 'Both an engagement id and a client id are needed.';
    return;
  }

  status.textContent = 'Loading…';
  const result = await call(
    `/api/console/interventure/engagements/${encodeURIComponent(engagementId)}?clientId=${encodeURIComponent(clientId)}`,
  );

  const detail = $('interventure-disclosure');
  detail.replaceChildren();

  if (!result.ok) {
    // The refusal IS the content: it names which acknowledgement is missing, which is what tells
    // an operator whom to chase.
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  if (!result.data.intercompany) {
    status.textContent = result.data.detail;
    return;
  }

  const disclosure = result.data.disclosure;
  if (disclosure === null) {
    line(detail, 'This is an intercompany engagement and no disclosure has been generated.');
    status.textContent = result.data.detail;
    return;
  }

  line(
    detail,
    `State: ${disclosure.state}${disclosure.complete ? ' — complete' : ' — NOT complete'}`,
  );
  line(detail, `Content hash: ${disclosure.contentHash}`);
  line(
    detail,
    disclosure.ventureAcknowledgedAt === null
      ? "The venture's own representative has not acknowledged."
      : `The venture acknowledged on ${disclosure.ventureAcknowledgedAt}.`,
  );
  line(
    detail,
    disclosure.gardnerAcknowledgedAt === null
      ? 'Gardner has not acknowledged.'
      : `Gardner acknowledged on ${disclosure.gardnerAcknowledgedAt}.`,
  );
  if (disclosure.outstanding.length > 0) {
    line(
      detail,
      `Outstanding: ${disclosure.outstanding.join(' and ')}. Neither can be recorded here.`,
    );
  }
  line(detail, disclosure.body);

  status.textContent = result.data.detail;
};

$('panel-interventure').addEventListener('toggle', () => {
  if ($('panel-interventure').open && !loaded) void loadRelationships();
});

$('interventure-refresh').addEventListener('click', () => void loadRelationships());
$('interventure-engagement-load').addEventListener('click', () => void loadEngagement());

/**
 * Three controls at three levels.
 *
 * Acknowledging a disclosure is NOT among them, at any level. A control for it here would let a
 * staff member produce the counterparty's acknowledgement - manufacturing the very evidence the
 * disclosure exists to require (ADR-0063).
 */
renderWrites('interventure-writes', [
  {
    id: 'iv-tag',
    capability: 'Tag a client as an inter-venture relationship',
    action: 'tag_venture',
    note: 'A determination about who this client is to the firm, and what turns the conflict machinery on. Idempotent - an existing tag is returned rather than duplicated.',
    buttonLabel: 'Tag the client',
    done: 'Tagged.',
    fields: [{ name: 'clientId', label: 'Client id' }],
    path: (v) => `/api/console/interventure/clients/${encodeURIComponent(v.clientId)}/tag`,
    body: () => ({}),
  },
  {
    id: 'iv-disclosure',
    capability: 'Generate a conflict disclosure',
    action: 'generate_conflict_disclosure',
    note: 'Generated mechanically, on purpose: a hand-written disclosure varies with how the writer feels about the conflict. GENERATING IS NOT DISCLOSING - it is complete only when the counterparty acknowledges, and there is no control here for that.',
    buttonLabel: 'Generate',
    done: 'Disclosure generated. It is not disclosed until acknowledged.',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'engagementId', label: 'Engagement id' },
      { name: 'engagementDescription', label: 'What the engagement is' },
    ],
    path: (v) => `/api/console/interventure/clients/${encodeURIComponent(v.clientId)}/disclosure`,
    body: (v) => ({
      engagementId: v.engagementId,
      engagementDescription: v.engagementDescription,
    }),
  },
  {
    id: 'iv-invoice',
    capability: 'Raise an intercompany invoice',
    action: 'raise_intercompany_invoice',
    note: 'Level 3. Money between related parties - the point at which an inter-venture conflict stops being a disclosure question and becomes a transaction somebody could be asked to justify. Integer CENTS.',
    danger: true,
    buttonLabel: 'Raise the invoice',
    done: 'Invoice raised.',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'engagementId', label: 'Engagement id' },
      { name: 'amountCents', label: 'Amount in CENTS' },
      { name: 'description', label: 'Description' },
      { name: 'periodFrom', label: 'Period from', type: 'date' },
      { name: 'periodTo', label: 'Period to', type: 'date' },
    ],
    path: (v) => `/api/console/interventure/clients/${encodeURIComponent(v.clientId)}/invoices`,
    body: (v) => ({
      engagementId: v.engagementId,
      amountCents: Number(v.amountCents),
      description: v.description,
      periodFrom: v.periodFrom,
      periodTo: v.periodTo,
    }),
  },
]);
