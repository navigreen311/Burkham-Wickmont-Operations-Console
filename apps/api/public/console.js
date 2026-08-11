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
 * One rule this file follows that is worth stating because it is easy to break: **nothing is
 * rendered as a colour alone.** Health states and compliance states are written out as words. A
 * console that showed a green dot for `unmonitored` would be lying in the shortest possible way.
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

  $('who').textContent = `${result.data.label} — Level ${result.data.authorityLevel}${
    result.data.department ? ` — ${result.data.department}` : ''
  }`;

  await enterOverview();
});

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
  notice('');
  show('view-clients');
};

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

  notice('');
  show('view-client');
};

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
  const who = await api.me();
  if (!who.ok) {
    show('view-sign-in');
    return;
  }

  $('who').textContent = `${who.data.label} — Level ${who.data.authorityLevel}${
    who.data.department ? ` — ${who.data.department}` : ''
  }`;
  await enterOverview();
};

void start();
