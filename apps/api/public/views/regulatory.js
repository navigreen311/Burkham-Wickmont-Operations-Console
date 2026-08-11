/**
 * 7.2 State activation, in the browser.
 *
 * **Self-contained on purpose.** This slice owns four view modules and does not own `console.js` or
 * `api.js`, both of which another branch is editing. So each view carries its own `call` and its own
 * DOM wiring and touches only the ids in its own section. The duplication is a consequence of that
 * and should collapse into a shared module once one branch owns both.
 *
 * Rules this file follows, all of them easy to break:
 *
 * **Every value reaches the page through `textContent`.** Nothing is ever assigned to a
 * markup-writing property; a structural test asserts the alternatives appear nowhere in this
 * directory, which is why this comment describes the rule without naming them.
 *
 * **Nothing is rendered as a colour alone.** A state's status is the word `draft`,
 * `needs_counsel_review`, `active` or `withdrawn`, written out. Three of those four block client
 * work and they are cleared by different work, so a red dot would say less than nothing.
 *
 * **The date field carries no default.** Not today, not anything. It is the date counsel reviewed
 * the module, and a value this page supplied would be the system asserting when a person did their
 * professional work.
 */

const $ = (id) => document.getElementById(id);

/** The `Outcome` envelope, plus the gate the activation routes carry. */
const call = async (path, body) => {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));

  return payload.status === 'ok'
    ? { ok: true, data: payload.data, gate: payload.gate, gateNote: payload.gateNote }
    : {
        ok: false,
        reason: payload.reason ?? 'Something went wrong.',
        gate: payload.gate,
        gateNote: payload.gateNote,
      };
};

const list = (id, items, empty) => {
  const element = $(id);
  element.replaceChildren();

  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = empty;
    element.append(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    element.append(li);
  }
};

/** Rows that open something: a button plus text, both through `textContent`. */
const openable = (id, items, empty) => {
  const element = $(id);
  element.replaceChildren();

  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = empty;
    element.append(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'row';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.addEventListener('click', item.open);

    const detail = document.createElement('span');
    detail.className = 'state';
    detail.textContent = ` — ${item.detail}`;

    li.append(button, detail);
    element.append(li);
  }
};

/** The state whose panel is open, so a write knows what it is writing to. */
let openState = null;

/**
 * Show which checks ran on the last attempt.
 *
 * There is no middleware trace here because activation deliberately does not go through the chain
 * (ADR-0047), and rendering an empty trace would read as "no checks ran". The route sends the checks
 * it actually performed plus a sentence naming which machinery performed them, and both go on the
 * page together — the note is what stops a reader mistaking this for the chain.
 */
const showGate = (gate, note) => {
  $('regulatory-gate-note').textContent = typeof note === 'string' ? note : '';
  list(
    'regulatory-gate',
    Array.isArray(gate) ? gate.map((step) => `${step.check}: ${step.outcome} — ${step.detail}`) : [],
    'No checks recorded.',
  );
};

const loadCoverage = async () => {
  const result = await call('/api/console/regulatory/coverage');
  if (!result.ok) {
    $('regulatory-headline').textContent = result.reason;
    return;
  }

  const data = result.data;

  // The sentence the page leads with, written on the server. "We cannot serve anybody" is a
  // statement about the system, not a phrasing decision for the DOM layer.
  $('regulatory-headline').textContent = data.headline;

  const counts = Object.entries(data.byStatus)
    .map(([status, count]) => `${status}: ${count}`)
    .join(', ');
  $('regulatory-summary').textContent =
    `${data.total} state(s) with a module, ${data.activeTotal} active.${counts === '' ? '' : ` By status — ${counts}.`}`;

  openable(
    'regulatory-states',
    data.states.map((entry) => ({
      label: entry.state,
      detail:
        `${entry.status} — ${entry.permitsClientFacingAction ? 'permits client-facing action' : 'blocks client-facing action'}` +
        ` — module v${entry.currentVersion ?? 'none'}, reviewed v${entry.reviewedVersion ?? 'none'}` +
        ` — ${entry.explanation}`,
      open: () => {
        void openStatePanel(entry.state);
      },
    })),
    'No state has a regulatory module.',
  );

  // Priority states with no module at all are absent from coverage by construction. A map that
  // omitted them would read as complete.
  $('regulatory-priority-gap').textContent =
    data.priorityStatesWithoutModuleTotal === 0
      ? 'Every V1 priority state has a module.'
      : `${data.priorityStatesWithoutModuleTotal} V1 priority state(s) have no module at all: ${data.priorityStatesWithoutModule.join(', ')}.`;
};

const openStatePanel = async (state) => {
  const result = await call(`/api/console/regulatory/states/${encodeURIComponent(state)}`);
  const section = $('section-regulatory-state');

  if (!result.ok) {
    section.hidden = true;
    $('regulatory-headline').textContent = result.reason;
    return;
  }

  const data = result.data;
  openState = data.standing.state;

  $('regulatory-state-name').textContent = data.standing.state;
  $('regulatory-state-standing').textContent =
    `${data.standing.status} — ${data.standing.permitsClientFacingAction ? 'permits client-facing action' : 'blocks client-facing action'}. ${data.standing.explanation}`;

  const requires = data.activationRequires;
  $('regulatory-state-requires').textContent =
    `Activation requires a human actor at Authority Level ${requires.humanActorAtLevel},` +
    `${requires.counselName ? ' the name of the reviewing counsel,' : ''}` +
    `${requires.reviewDate ? ' the date of the review,' : ''}` +
    `${requires.documentReference ? ' and a document reference.' : ''}` +
    ` ${requires.note}`;

  $('regulatory-state-module').textContent =
    data.module === null
      ? data.moduleUnavailableReason
      : `Module v${data.module.version} (${data.module.changeKind}) by ${data.module.createdBy}: ${data.module.summary} — citations: ${data.module.citations.join('; ')}${
          data.module.changeRationale === null ? '' : ` — rationale: ${data.module.changeRationale}`
        }`;

  $('regulatory-state-history-summary').textContent = `${data.historyTotal} module version(s).`;
  list(
    'regulatory-state-history',
    data.history.map(
      (entry) =>
        `v${entry.version} — ${entry.changeKind} — ${entry.summary} — by ${entry.createdBy}` +
        `${entry.changeRationale === null ? '' : ` — ${entry.changeRationale}`}` +
        `${entry.supersededAt === null ? ' — in force' : ` — superseded ${entry.supersededAt}`}`,
    ),
    'No module version recorded.',
  );

  $('regulatory-state-disclosures-summary').textContent =
    `${data.disclosuresTotal} disclosure(s) obliged here.`;
  list(
    'regulatory-state-disclosures',
    // `source` says which layer obliges it: federal applies regardless, the state layer is local.
    data.disclosures.map(
      (entry) => `${entry.key} (${entry.source}, ${entry.productKind}) — ${entry.text} [${entry.citation}]`,
    ),
    'No disclosure is obliged here.',
  );

  $('regulatory-state-law-summary').textContent =
    data.outstandingLawChangesTotal === 0
      ? 'No law change is outstanding for this state.'
      : `${data.outstandingLawChangesTotal} law change(s) noticed and not yet folded into a module:`;
  list(
    'regulatory-state-law',
    data.outstandingLawChanges.map(
      (entry) =>
        `${entry.summary} [${entry.citation}] — noticed ${entry.noticedAt}` +
        `${entry.effectiveOn === null ? '' : ` — effective ${entry.effectiveOn}`}`,
    ),
    'None.',
  );

  showGate([], '');
  section.hidden = false;
};

$('regulatory-load').addEventListener('click', () => {
  void loadCoverage();
});

$('form-activate').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (openState === null) return;

  const result = await call(
    `/api/console/regulatory/states/${encodeURIComponent(openState)}/activation`,
    {
      reviewedBy: $('activate-counsel').value.trim(),
      // Sent as the operator typed it. The route parses and refuses what it cannot read rather
      // than substituting a date of its own.
      reviewedAt: $('activate-date').value,
      documentReference: $('activate-document').value.trim(),
      notes: $('activate-notes').value.trim(),
    },
  );

  showGate(result.gate, result.gateNote);

  if (!result.ok) {
    // A refusal here is an ordinary answer - the commonest is that the signed-in actor is not a
    // human at Level 3 - so it is shown as one, beside the checks that produced it.
    $('regulatory-headline').textContent = result.reason;
    return;
  }

  $('activate-counsel').value = '';
  $('activate-date').value = '';
  $('activate-document').value = '';
  $('activate-notes').value = '';

  await openStatePanel(openState);
  await loadCoverage();
  showGate(result.gate, result.gateNote);
  $('regulatory-headline').textContent = `${openState} is now ${result.data.status}. ${result.data.explanation}`;
});

$('form-withdraw').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (openState === null) return;

  const result = await call(
    `/api/console/regulatory/states/${encodeURIComponent(openState)}/withdrawal`,
    { reason: $('withdraw-reason').value.trim() },
  );

  showGate(result.gate, result.gateNote);

  if (!result.ok) {
    $('regulatory-headline').textContent = result.reason;
    return;
  }

  $('withdraw-reason').value = '';
  await openStatePanel(openState);
  await loadCoverage();
  showGate(result.gate, result.gateNote);
  $('regulatory-headline').textContent = `${openState} is now ${result.data.status}. ${result.data.explanation}`;
});
