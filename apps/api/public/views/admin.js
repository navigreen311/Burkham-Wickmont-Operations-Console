/**
 * 11.7 Admin Configuration Center on the page.
 *
 * **Invariants are rendered as fixed, with the reason they are fixed, and there is no code path
 * here that could render an input for one.**
 *
 * That is structural rather than careful. The route sends parameters and invariants as two
 * collections with two shapes; `renderParameter` reads bounds and `renderInvariant` reads
 * `whyFixed`, and neither can be called with the other's data and produce something sensible.
 * A single list with an `editable` flag would have one renderer and one branch - and a branch is a
 * thing that can be taken wrongly.
 *
 * The `whyFixed` line is the point of the whole panel. "I could not find the setting" and "the
 * setting does not exist because it is the law" are different answers, and only the second one
 * stops somebody looking for a workaround. So it is rendered in full, never truncated, next to the
 * value.
 *
 * **A staged change is shown apart from the value in force.** `effectiveValue` reads applied
 * changes only, so a staged change genuinely is not in force; showing it in the parameter row
 * would be the staging mechanism working in the store and lying on the screen.
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
 * A configurable parameter: what it is, what it is now, and the range it may move in.
 *
 * `boundsBasis` travels because a range with no reasoning is a guess with a fence, and an operator
 * asking to go outside it deserves the argument rather than a validation error.
 */
const renderParameter = (parent, parameter) => {
  const item = document.createElement('li');

  const label = document.createElement('strong');
  label.textContent = parameter.label;
  item.append(label);

  const value = document.createElement('span');
  value.textContent = ` — ${parameter.value} ${parameter.kind} (${parameter.source})`;
  item.append(value);

  const range = document.createElement('div');
  range.textContent = `Range ${parameter.minimum}–${parameter.maximum}. Default ${parameter.compiledDefault}. Owner: ${parameter.owner}.${
    parameter.highRisk ? ' High risk: a change is staged rather than applied.' : ''
  }`;
  item.append(range);

  const basis = document.createElement('div');
  basis.textContent = parameter.boundsBasis;
  item.append(basis);

  parent.append(item);
};

/**
 * An invariant: the value, and why it cannot be changed.
 *
 * **No input, no button, no `editable` branch.** This function has no parameter that could make it
 * render a control, which is the difference between a rule and a habit.
 */
const renderInvariant = (parent, invariant) => {
  const item = document.createElement('li');

  const label = document.createElement('strong');
  label.textContent = `${invariant.label} — FIXED`;
  item.append(label);

  const value = document.createElement('div');
  value.textContent = invariant.value;
  item.append(value);

  // The sentence the panel exists for. Never truncated.
  const why = document.createElement('div');
  why.textContent = invariant.whyFixed;
  item.append(why);

  parent.append(item);
};

const render = (data) => {
  const parameters = $('admin-parameters');
  parameters.replaceChildren();
  if (data.parameters.length === 0) {
    line(parameters, 'No parameter resolved a value, which is a defect rather than a state.');
  } else {
    for (const parameter of data.parameters) renderParameter(parameters, parameter);
  }

  const invariants = $('admin-invariants');
  invariants.replaceChildren();
  for (const invariant of data.invariants) renderInvariant(invariants, invariant);

  const staged = $('admin-staged');
  staged.replaceChildren();
  if (data.staged.length === 0) {
    line(staged, 'No change is staged.');
  } else {
    for (const change of data.staged) {
      line(
        staged,
        `${change.key}: ${change.previousValue} → ${change.newValue} — STAGED, NOT IN FORCE. ${change.reason} (by ${change.changedBy})`,
      );
    }
  }

  const history = $('admin-history');
  history.replaceChildren();
  if (data.history.length === 0) {
    line(history, 'No configuration change has been recorded.');
  } else {
    for (const change of data.history) {
      line(
        history,
        `${change.key}: ${change.previousValue} → ${change.newValue} — ${
          change.inForce ? `in force from ${change.appliedAt}` : 'staged, not in force'
        }. ${change.reason} (by ${change.changedBy})`,
      );
    }
  }

  renderAvailable('admin-available', data.writes?.available);
  const blocked = $('admin-blocked');
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

  // Totals, because a list without one is a list a reader has to count to trust.
  $('admin-status').textContent =
    `${data.totals.parameters} of ${data.totals.parametersInRegistry} parameter(s) configurable, ${data.totals.invariants} fixed and not configurable, ${data.totals.staged} staged, ${data.totals.history} change(s) recorded.`;
};

let loaded = false;

const load = async () => {
  $('admin-status').textContent = 'Loading…';
  const result = await call('/api/console/admin/configuration');
  if (!result.ok) {
    $('admin-status').textContent = result.reason;
    return;
  }
  render(result.data);
  loaded = true;
};

$('panel-admin').addEventListener('toggle', () => {
  if ($('panel-admin').open && !loaded) void load();
});

$('admin-refresh').addEventListener('click', () => {
  loaded = false;
  void load();
});

/**
 * The parameter controls.
 *
 * There is deliberately no control for an invariant. Not a disabled one, not a hidden one - none.
 * A "Level 4 required" input would be a permission somebody eventually holds, and the person most
 * likely to hold it is the one under pressure to make a number move.
 */
renderWrites('admin-writes', [
  {
    id: 'admin-set',
    capability: 'Change a parameter',
    action: 'change_system_parameter',
    note: 'A parameter is the number every file is computed against, so a wrong one is wrong retroactively and everywhere at once. The module holds the bounds and refuses outside them.',
    buttonLabel: 'Change the parameter',
    done: 'Change recorded.',
    fields: [
      { name: 'key', label: 'Parameter key' },
      { name: 'value', label: 'New value' },
      { name: 'reason', label: 'Reason' },
    ],
    path: () => '/api/console/admin/parameters',
    body: (v) => ({ key: v.key, value: Number(v.value), reason: v.reason }),
  },
  {
    id: 'admin-promote',
    capability: 'Promote a staged change',
    action: 'change_system_parameter',
    note: 'A staged change is real and is NOT in force. Promoting is what puts it in force.',
    buttonLabel: 'Promote',
    done: 'Change promoted and in force.',
    fields: [{ name: 'changeId', label: 'Change id' }],
    path: (v) => `/api/console/admin/changes/${encodeURIComponent(v.changeId)}/promotion`,
    body: () => ({}),
  },
  {
    id: 'admin-rollback',
    capability: 'Roll a change back',
    action: 'change_system_parameter',
    note: 'Recorded as a change in its own right rather than as an undo, so the history reads as what happened.',
    buttonLabel: 'Roll back',
    done: 'Rollback recorded.',
    fields: [
      { name: 'changeId', label: 'Change id' },
      { name: 'reason', label: 'Reason' },
    ],
    path: (v) => `/api/console/admin/changes/${encodeURIComponent(v.changeId)}/rollback`,
    body: (v) => ({ reason: v.reason }),
  },
]);
