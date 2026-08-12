/**
 * 1.2 Client Household / Entity Graph on the page.
 *
 * **Nothing here can reveal an identifier, and nothing here asks to.**
 *
 * The route sends owners with a display last-4 and no ciphertext, because that is all the module
 * will hand out. There is no reveal button: a reveal is an act that discloses a government
 * identifier and writes an access event, so it needs `chain()` with a declared action, and none
 * exists. The gap is rendered from `writes.blocked` where an operator will see it, rather than left
 * as an absence they would read as an oversight.
 *
 * **The client id is typed into a field, not carried in the address.** The panel never changes the
 * URL. A last-4 or an owner id in a query string reaches access logs, browser history and
 * `Referer`, and the point of keeping the plaintext out of the payload is lost if the display value
 * ends up in a proxy log instead.
 *
 * The risk band is rendered as a WORD with its components. `graphRisk` returns
 * `low`/`elevated`/`high` and the reasons behind it; a coloured dot would be the shortest possible
 * way to lie about an elevated one.
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

const render = (data) => {
  $('graph-summary').textContent = data.isEmpty
    ? data.emptyNote
    : `${data.entities.length} entit(ies), ${data.owners.length} owner(s), ${data.edges.length} edge(s).`;

  const entities = $('graph-entities');
  entities.replaceChildren();
  for (const entity of data.entities) {
    line(
      entities,
      `${entity.legalName} — ${entity.role}${entity.id === data.primaryEntityId ? ' (primary)' : ''}${
        data.isolatedEntityIds.includes(entity.id) ? ' — no recorded relationship' : ''
      }`,
    );
  }
  if (data.entities.length === 0) line(entities, 'None recorded.');

  /**
   * Owners, with the last four digits and nothing else.
   *
   * `ssnLast4` is a display field the module computed at write time; the plaintext is envelope-
   * encrypted and was never sent here. A null reads as "no SSN on file", which is a different fact
   * from "not shown" and is written out as such.
   */
  const owners = $('graph-owners');
  owners.replaceChildren();
  for (const owner of data.owners) {
    line(
      owners,
      `${owner.fullName} — SSN ${owner.ssnLast4 === null ? 'not on file' : `ending ${owner.ssnLast4}`}`,
    );
  }
  if (data.owners.length === 0) line(owners, 'None recorded.');

  const exposures = $('graph-exposures');
  exposures.replaceChildren();
  for (const exposure of data.exposures) {
    line(
      exposures,
      `${exposure.ownerName} — guarantees ${exposure.guaranteedPositions ?? exposure.guaranteedDebts ?? 0} position(s), exposure ${exposure.exposureAmount.value}${
        exposure.hasUnlimitedGuarantee ? ' (UNLIMITED guarantee)' : ''
      }`,
    );
  }
  if (data.exposures.length === 0) line(exposures, 'No guaranteed exposure recorded.');
  $('graph-concentration').textContent =
    data.guarantorConcentration === null
      ? 'Guarantor concentration: not measured — no guaranteed exposure is recorded.'
      : `Guarantor concentration: ${(data.guarantorConcentration * 100).toFixed(1)}% on the largest guarantor.`;

  const findings = $('graph-findings');
  findings.replaceChildren();
  for (const finding of data.findings) {
    line(findings, `${finding.kind} — ${finding.question ?? finding.summary ?? ''}`);
  }
  if (data.findings.length === 0) line(findings, 'No hidden-relationship question raised.');

  // A band and its reasons. Never a score, never a colour on its own.
  $('graph-risk-band').textContent = `Graph risk: ${data.risk.band}${
    data.risk.leadingConcern ? ` — leading concern: ${data.risk.leadingConcern}` : ''
  }`;
  const components = $('graph-risk-components');
  components.replaceChildren();
  for (const component of data.risk.components) {
    line(
      components,
      `${component.name ?? component.kind}: ${component.band} — ${component.detail ?? ''}`,
    );
  }

  renderAvailable('graph-available', data.writes?.available);
  const blocked = $('graph-blocked');
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
};

const load = async () => {
  const status = $('graph-status');
  const clientId = $('graph-client-id').value.trim();

  if (clientId === '') {
    status.textContent = 'Enter a client id.';
    return;
  }

  status.textContent = 'Loading…';
  const result = await call(`/api/console/clients/${encodeURIComponent(clientId)}/graph`);
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  render(result.data);
  status.textContent = '';
  $('graph-detail').hidden = false;
};

$('graph-load').addEventListener('click', () => void load());

/**
 * The reveal, which is not a write.
 *
 * It is here because the authority model is the only thing that can gate a READ, and an ungated
 * read of the most sensitive field in the system was reachable by anyone the session let in.
 *
 * The value is shown once, in the status line, and goes nowhere else - not into a field a browser
 * would remember, not into the console, not into the panel's own lists.
 */
renderWrites('graph-writes', [
  {
    id: 'graph-entity',
    capability: 'Record an entity',
    action: 'record_entity_graph',
    note: 'A structural fact the risk and readiness engines read as given.',
    buttonLabel: 'Record the entity',
    done: 'Entity recorded.',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'legalName', label: 'Legal name' },
      { name: 'role', label: 'Role', placeholder: 'operating' },
    ],
    path: (v) => `/api/console/clients/${encodeURIComponent(v.clientId)}/graph/entities`,
    body: (v) => ({ legalName: v.legalName, role: v.role }),
  },
  {
    id: 'graph-revenue',
    capability: 'Record stated revenue',
    action: 'record_entity_graph',
    note: 'STATED, and the word is load-bearing: this writes down a claim somebody made. Changing it into a more useful number is fabricate_revenue, which is Level 4 - blocked for every actor, with no approval that unlocks it.',
    buttonLabel: 'Record it',
    done: 'Stated revenue recorded.',
    fields: [
      { name: 'clientId', label: 'Client id' },
      { name: 'entityId', label: 'Entity id' },
      { name: 'annualRevenueCents', label: 'Annual revenue in CENTS' },
    ],
    path: (v) => `/api/console/clients/${encodeURIComponent(v.clientId)}/graph/stated-revenue`,
    body: (v) => ({ entityId: v.entityId, annualRevenueCents: Number(v.annualRevenueCents) }),
  },
  {
    id: 'graph-ssn',
    capability: 'Reveal an owner SSN',
    action: 'reveal_protected_identifier',
    note: 'A purpose is required and is recorded against the reveal. "Why did you look at this" is the question the access log exists to answer, and one that records only that somebody looked answers half of it.',
    danger: true,
    buttonLabel: 'Reveal',
    fields: [
      { name: 'ownerId', label: 'Owner id' },
      { name: 'purpose', label: 'Purpose', placeholder: 'Verifying identity for the lender packet' },
    ],
    path: (v) => `/api/console/graph/owners/${encodeURIComponent(v.ownerId)}/ssn`,
    body: (v) => ({ purpose: v.purpose }),
  },
  {
    id: 'graph-ein',
    capability: 'Reveal an entity EIN',
    action: 'reveal_protected_identifier',
    note: 'A company identifier is no less protected, and the same purpose rule applies.',
    danger: true,
    buttonLabel: 'Reveal',
    fields: [
      { name: 'entityId', label: 'Entity id' },
      { name: 'purpose', label: 'Purpose' },
    ],
    path: (v) => `/api/console/graph/entities/${encodeURIComponent(v.entityId)}/ein`,
    body: (v) => ({ purpose: v.purpose }),
  },
]);
