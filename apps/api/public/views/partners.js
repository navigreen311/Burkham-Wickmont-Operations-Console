/**
 * 8.1 and 8.3 on the page.
 *
 * **The cohort suppression is what this file is for, and rendering it wrongly is easy.**
 *
 * Below five referrals `aggregateStatus` releases no stage breakdown, and the route omits
 * `countsByStage` entirely rather than sending an empty object. This file therefore has no branch
 * that could iterate zeros - there is nothing to iterate. What it renders instead is the module's
 * own sentence, which says the breakdown is withheld, says the threshold, and says why: a partner
 * who referred one client knows exactly whose status a count of one describes.
 *
 * `totalReferrals` IS shown at any size. The partner already knows how many clients they sent, so
 * withholding it protects nobody and makes the suppression look like a fault rather than a rule.
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

const renderBlockedWrites = (id, blocked) => {
  const element = $(id);
  element.replaceChildren();
  for (const entry of blocked ?? []) {
    const item = document.createElement('li');
    const what = document.createElement('strong');
    what.textContent = entry.capability;
    item.append(what);
    const why = document.createElement('div');
    why.textContent = `${entry.why} (${entry.module})`;
    item.append(why);
    element.append(item);
  }
};

const renderList = async () => {
  const status = $('partners-status');
  status.textContent = 'Loading…';

  const result = await call('/api/console/partners');
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  const list = $('partners-list');
  list.replaceChildren();

  if (result.data.partners.length === 0) {
    line(list, 'No partner is registered. Nothing on this Console can register one - see below.');
  } else {
    for (const partner of result.data.partners) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = partner.legalName;
      button.addEventListener('click', () => void renderOne(partner.id));
      item.append(button);
      const detail = document.createElement('span');
      detail.textContent = ` — ${partner.track}, ${partner.status}`;
      item.append(detail);
      list.append(item);
    }
  }

  const curriculum = $('partners-curriculum');
  curriculum.replaceChildren();
  if ((result.data.curriculum ?? []).length === 0) {
    line(curriculum, 'No curriculum module is published, so no partner can certify.');
  } else {
    for (const entry of result.data.curriculum) {
      line(curriculum, `${entry.key} — ${entry.title}${entry.required ? ' (required)' : ''}`);
    }
  }

  renderBlockedWrites('partners-blocked', result.data.writes?.blocked);
  renderAvailable('partners-available', result.data.writes?.available);
  status.textContent = `${result.data.partners.length} partner(s). Recertification cadence: ${result.data.recertificationCadenceDays} days.`;
};

const renderOne = async (partnerId) => {
  const status = $('partner-detail-status');
  status.textContent = 'Loading…';

  const result = await call(`/api/console/partners/${encodeURIComponent(partnerId)}`);
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  const data = result.data;
  $('partner-detail-name').textContent = data.partner.legalName;
  $('partner-detail-standing').textContent =
    `Track ${data.partner.track}, status ${data.partner.status}. Certification: ${data.standing.state}.`;

  const gate = $('partner-detail-refer');
  gate.textContent = data.mayRefer.permitted
    ? 'May refer a client today.'
    : `May NOT refer: ${data.mayRefer.reason}`;

  /**
   * The aggregate.
   *
   * Two states, and they render differently on purpose. Released: the stage counts. Suppressed:
   * the total, the threshold, and the module's explanation - never a zeroed breakdown, and never
   * silence.
   */
  const aggregate = $('partner-detail-aggregate');
  aggregate.replaceChildren();
  line(aggregate, `Referrals on record: ${data.aggregateStatus.totalReferrals}.`);
  if (data.aggregateStatus.released) {
    for (const [stage, count] of Object.entries(data.aggregateStatus.countsByStage ?? {})) {
      line(aggregate, `${stage}: ${count}`);
    }
  } else {
    line(
      aggregate,
      `Stage breakdown WITHHELD — fewer than ${data.aggregateStatus.minimumCohort} referrals.`,
    );
  }
  line(aggregate, data.aggregateStatus.detail);

  const outstanding = $('partner-detail-outstanding');
  outstanding.replaceChildren();
  if ((data.outstandingQualifications ?? []).length === 0) {
    line(outstanding, 'Every qualification for this track has been produced.');
  } else {
    for (const entry of data.outstandingQualifications) line(outstanding, entry);
  }

  const completions = $('partner-detail-completions');
  completions.replaceChildren();
  if ((data.completions ?? []).length === 0) {
    line(completions, 'No curriculum module completed.');
  } else {
    for (const entry of data.completions) {
      line(completions, `${entry.moduleKey ?? entry.moduleId} — completed ${entry.completedAt}`);
    }
  }

  // What they are owed, which is `not_built` until 8.2. Rendered rather than omitted: a partner
  // page with no payout section reads as a partner who is owed nothing.
  // 8.2 Partner Agreement & Payout Center exists as an engine and has no surface. A payout is an
  // act with a period and an approver, so it cannot be a line on a read page - see the note in
  // routes/partners.ts.
  $('partner-detail-payable').textContent =
    'Payout: no surface yet. 8.2 computes and records payouts; doing that needs a period and an approver, which a page that only reads cannot supply.';

  status.textContent = '';
  $('partner-detail').hidden = false;
};

let loaded = false;

$('panel-partners').addEventListener('toggle', () => {
  if ($('panel-partners').open && !loaded) {
    loaded = true;
    void renderList();
  }
});

$('partners-refresh').addEventListener('click', () => void renderList());

/**
 * Publishing a curriculum module.
 *
 * A MATERIAL republish decertifies every partner who completed the previous version, which is why
 * the change kind is asked for explicitly rather than defaulted. A default chosen once here would
 * decertify a network the first time somebody fixed a typo.
 */
renderWrites('partners-writes', [
  {
    id: 'partners-module',
    capability: 'Publish a curriculum module',
    action: 'publish_curriculum_module',
    note: 'A material republish DECERTIFIES every partner who completed the previous version. An editorial one does not.',
    danger: true,
    buttonLabel: 'Publish the module',
    done: 'Module published.',
    fields: [
      { name: 'key', label: 'Module key' },
      { name: 'title', label: 'Title' },
      { name: 'objective', label: 'Objective' },
      { name: 'changeKind', label: 'Change kind (material/editorial)', placeholder: 'editorial' },
    ],
    path: () => '/api/console/partners/curriculum',
    body: (v) => v,
  },
]);
