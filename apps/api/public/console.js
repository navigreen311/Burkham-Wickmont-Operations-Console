/**
 * The DOM layer.
 *
 * **Deliberately thin**, for the reason the portal's is: everything worth deciding is on the server,
 * and what is here is read a field, call a route, put text on the page.
 *
 * **Every value that reaches the page goes through `textContent`**, so a client's legal name, a
 * refusal reason or a risk-event meaning cannot become markup. A test asserts that the
 * markup-assigning properties appear nowhere in this directory - including in a comment, which is
 * why this one describes the rule without naming them.
 *
 * Two rules this file follows that are worth stating because they are easy to break.
 *
 * **Nothing is rendered as a colour alone.** Health states and compliance states are written out as
 * words. A console that showed a green dot for `unmonitored` would be lying in the shortest possible
 * way.
 *
 * **Hiding a button is a courtesy, never a control.** `mayWrite` decides what is offered; the
 * middleware chain decides what happens, and it refuses whatever the page shows. The reason to hide
 * anything at all is that offering an action which will certainly be refused teaches people that
 * refusals are noise - which is the opposite of what a refusal is for here.
 */

import * as api from './api.js';

const $ = (id) => document.getElementById(id);

const VIEWS = ['view-sign-in', 'view-overview', 'view-clients', 'view-client'];

const show = (view) => {
  for (const name of VIEWS) $(name).hidden = name !== view;
  $('sign-out').hidden = view === 'view-sign-in';
  $('who').hidden = view === 'view-sign-in';
};

const notice = (text) => {
  const element = $('notice');
  element.textContent = text;
  element.hidden = text === '';
};

/** Put a list of strings on the page. `textContent`, never markup. */
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

/** How many rows a page of clients holds. The server caps this independently. */
const PAGE = 25;

let offset = 0;
let search = '';

/** What the signed-in actor's Authority Level permits, from `/api/console/me`. */
let mayWrite = {};

/** The client whose file is open, so a write knows what it is writing to. */
let openClientId = null;

/**
 * What a compliance state does, in the words of the modules that read it.
 *
 * Shown before the click. `fail` and `needs_review` both freeze placement, and a dropdown of five
 * lowercase identifiers does not say so - somebody would reasonably read `needs_review` as a note
 * to a colleague.
 */
const COMPLIANCE_CONSEQUENCE = {
  pending_assessment: 'Placement is blocked: an unassessed client is not a passing one.',
  pass: 'Placement may proceed, subject to every other gate.',
  pass_with_findings: 'Placement may proceed. The open findings travel with the file.',
  needs_review: 'FREEZES placement until a human resolves it in the Human Approval Console.',
  fail:
    'BLOCKS placement. Decision E routes a failed client to Do Not Fund Governance - but see the ' +
    'note in docs/m11-console-writes.md: the automatic listing is not wired to anything today, so ' +
    'this does not by itself list the client.',
};

/** Put the middleware trace on the page. Shown after a write, refused or not. */
const showTrace = (trace) => {
  const section = $('section-trace');
  if (!Array.isArray(trace) || trace.length === 0) {
    section.hidden = true;
    return;
  }
  list(
    'trace-list',
    trace.map((step) =>
      step.detail ? `${step.step}: ${step.outcome} — ${step.detail}` : `${step.step}: ${step.outcome}`,
    ),
    'No steps recorded.',
  );
  section.hidden = false;
};

// --- sign in ----------------------------------------------------------------

$('form-sign-in').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.signIn($('email').value, $('password').value, $('code').value);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  // The code is cleared whatever happens next: it is single-use by the time the server has seen it,
  // and a spent code left in the field looks like a field that still works.
  $('code').value = '';
  $('password').value = '';

  // Who this is, and what they may do, from `me` rather than from the sign-in reply.
  //
  // The sign-in route could carry it, and then two routes would compute the same thing - which is
  // one of them being wrong eventually. `me` is where the page's idea of its own permissions comes
  // from, on this path and on a reload alike.
  await identify();

  await enterOverview();
});

/** Read who is signed in and what they may write. The one source for both. */
const identify = async () => {
  const who = await api.me();
  if (!who.ok) return false;

  mayWrite = who.data.mayWrite ?? {};
  $('who').textContent = `${who.data.label} — Level ${who.data.authorityLevel}${
    who.data.department ? ` — ${who.data.department}` : ''
  }`;
  return true;
};

$('sign-out').addEventListener('click', async () => {
  await api.signOut();
  $('who').textContent = '';
  notice('Signed out.');
  show('view-sign-in');
});

// --- overview ---------------------------------------------------------------

const enterOverview = async (announce = '') => {
  const result = await api.overview();
  if (!result.ok) {
    notice(result.reason);
    show('view-sign-in');
    return;
  }

  const health = result.data.health;
  $('health-overall').textContent = `${health.overall} — ${health.detail}`;
  list(
    'health-components',
    health.components.map(
      (component) => `${component.label}: ${component.state} — ${component.detail}`,
    ),
    'No components reported.',
  );

  $('queue-summary').textContent =
    result.data.myOpenTasks === 0
      ? 'Nothing assigned to you is open.'
      : `${result.data.myOpenTasks} open.`;

  const queue = await api.queue();
  list(
    'queue-list',
    queue.ok ? queue.data.map((task) => `${task.kind}: ${task.summary}`) : [],
    'Nothing assigned to you is open.',
  );

  $('obligations-summary').textContent =
    result.data.openObligations === 0
      ? 'Nothing outstanding.'
      : `${result.data.openObligations} open, ${result.data.overdueObligations} overdue.`;

  const owed = await api.obligations();
  list(
    'obligations-list',
    owed.ok
      ? owed.data.map(
          (item) =>
            `${item.overdue ? 'OVERDUE — ' : ''}${item.severity} — ${item.excerpt} — owed by ${
              item.owedBy
            }, due ${item.dueAt}`,
        )
      : [],
    'Nothing outstanding.',
  );

  notice(announce);
  show('view-overview');
};

// --- clients ----------------------------------------------------------------

const renderClients = (page, append) => {
  const element = $('clients-list');
  if (!append) element.replaceChildren();

  if (page.clients.length === 0 && !append) {
    const li = document.createElement('li');
    li.textContent = search === '' ? 'No clients yet.' : 'No client matches that name.';
    element.append(li);
    return;
  }

  for (const client of page.clients) {
    const li = document.createElement('li');
    li.className = 'row';

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = client.legalName;
    button.addEventListener('click', () => {
      void enterClient(client.id);
    });

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = ` — ${client.complianceState}`;

    li.append(button, state);
    element.append(li);
  }
};

const loadClients = async (append) => {
  const result = await api.clients(search, PAGE, offset);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  renderClients(result.data, append);

  const shown = Math.min(offset + result.data.clients.length, result.data.total);
  // The total travels with the page for a reason: a list showing the first twenty-five of four
  // hundred would otherwise read as the whole book.
  $('clients-summary').textContent = `Showing ${shown} of ${result.data.total}.`;
  $('clients-more').hidden = shown >= result.data.total;
  offset = shown;
};

const enterClients = async () => {
  offset = 0;
  await loadClients(false);
  $('section-new-client').hidden = mayWrite.create_client_record !== true;
  notice('');
  show('view-clients');
};

$('form-new-client').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.createClient($('new-client-name').value.trim());
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  $('new-client-name').value = '';
  search = '';
  $('search').value = '';
  await enterClients();
  notice(`Opened a file for ${result.data.legalName}.`);
});

$('form-search').addEventListener('submit', async (event) => {
  event.preventDefault();
  search = $('search').value.trim();
  await enterClients();
});

$('clients-more').addEventListener('click', () => {
  void loadClients(true);
});

// --- one client -------------------------------------------------------------

const enterClient = async (clientId) => {
  const result = await api.client(clientId);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  const { client, findings, firewall, doNotFund } = result.data;
  openClientId = client.id;
  $('client-name').textContent = client.legalName;
  $('client-compliance').textContent = `Compliance state: ${client.complianceState}`;

  const listing = $('client-do-not-fund');
  listing.hidden = doNotFund === null;
  if (doNotFund !== null) {
    // `listedBy` is null on an automatic listing, deliberately: 6.4 refuses to name an approver
    // who does not exist, because a fiction in the field a reviewer reads is indistinguishable
    // from a real approval.
    listing.textContent = `DO NOT FUND — listed ${doNotFund.listedAt} (${
      doNotFund.automatic ? 'automatic' : 'by a person'
    }): ${doNotFund.justification}${doNotFund.reviewOverdue ? ' — REVIEW OVERDUE' : ''}`;
  }

  list(
    'client-findings',
    findings.map((finding) => `${finding.code}: ${finding.summary}`),
    'No open findings.',
  );

  $('client-firewall').textContent =
    firewall.state === 'clear' ? 'Clear.' : `${firewall.state}: ${firewall.reason ?? 'No reason recorded.'}`;

  const risk = await api.clientRisk(clientId);
  if (risk.ok) {
    // `worst` is null for a clean timeline, and "none" is the honest word for that - not "context",
    // which is a real severity and would read as a finding.
    $('client-risk-summary').textContent = `Worst severity: ${risk.data.worst ?? 'none'}.`;
    list(
      'client-risk',
      risk.data.entries.map((entry) => `${entry.at} — ${entry.severity} — ${entry.meaning}`),
      'No risk events on record.',
    );
    // Carried on every timeline including empty ones. No entries and no caveat reads as a clean
    // client, and 6.5 refuses to let it.
    $('client-risk-unproduced').textContent =
      risk.data.unmonitored.length === 0
        ? ''
        : `Not produced by anything connected: ${risk.data.unmonitored
            .map((gap) => `${gap.fact} (awaiting ${gap.awaiting})`)
            .join('; ')}.`;
  } else {
    $('client-risk-summary').textContent = risk.reason;
    list('client-risk', [], 'No risk events on record.');
    $('client-risk-unproduced').textContent = '';
  }

  $('section-compliance').hidden = mayWrite.transition_compliance_state !== true;
  $('section-firewall-trigger').hidden = mayWrite.trigger_firewall !== true;
  $('section-consent').hidden = mayWrite.record_client_consent !== true;
  // The trace belongs to one write attempt, not to the file. Opening a file clears it.
  $('section-trace').hidden = true;

  // The dropdown starts on the state the client is already in, so the commonest mistake - reading
  // the first option as the current value - is not available.
  $('compliance-to').value = client.complianceState;
  describeComplianceChoice();

  notice('');
  show('view-client');
};

/* --- writes ---------------------------------------------------------------- */

const describeComplianceChoice = () => {
  const to = $('compliance-to').value;
  $('compliance-consequence').textContent = COMPLIANCE_CONSEQUENCE[to] ?? '';
  // The button says what it will do. "Record" beside a dropdown reading `fail` is not the same
  // sentence as "Record: fail".
  $('compliance-submit').textContent = `Record: ${to}`;
};

$('compliance-to').addEventListener('change', describeComplianceChoice);

$('form-compliance').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const code = $('finding-code').value.trim();
  const summary = $('finding-summary').value.trim();
  // Both halves or neither: a finding with a code and no summary is a row nobody can act on, and
  // one with a summary and no code cannot be resolved by anything that looks findings up.
  if ((code === '') !== (summary === '')) {
    notice('A finding needs both a code and a summary, or neither.');
    return;
  }

  const result = await api.transitionCompliance(
    openClientId,
    $('compliance-to').value,
    $('compliance-reason').value.trim(),
    code === '' ? [] : [{ code, summary }],
  );

  showTrace(result.trace);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  $('compliance-reason').value = '';
  $('finding-code').value = '';
  $('finding-summary').value = '';
  const announce = `Compliance state recorded: ${result.data.complianceState}.`;
  await enterClient(openClientId);
  notice(announce);
});

$('form-firewall').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.triggerFirewall(openClientId, $('firewall-reason').value.trim());

  showTrace(result.trace);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  $('firewall-reason').value = '';
  await enterClient(openClientId);
  notice('Firewall triggered. Placement is frozen for this client.');
});

$('form-consent').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.recordConsent(
    openClientId,
    $('consent-kind').value.trim(),
    $('consent-scope').value.trim(),
  );

  showTrace(result.trace);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  $('consent-kind').value = '';
  $('consent-scope').value = '';
  notice('Consent recorded.');
});

// --- navigation -------------------------------------------------------------

for (const id of ['nav-overview', 'nav-overview-2']) {
  $(id).addEventListener('click', () => {
    void enterOverview();
  });
}

for (const id of ['nav-clients', 'nav-clients-2']) {
  $(id).addEventListener('click', () => {
    void enterClients();
  });
}

$('nav-back').addEventListener('click', () => {
  void enterClients();
});

// --- start ------------------------------------------------------------------

/**
 * A reload should not ask somebody to sign in again while their session is live.
 *
 * `me` is the cheapest question that answers it, and a refusal here is not an error worth showing:
 * "you are not signed in" on first load is the ordinary case.
 */
const start = async () => {
  if (!(await identify())) {
    show('view-sign-in');
    return;
  }
  await enterOverview();
};

void start();
