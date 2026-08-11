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

const VIEWS = [
  'view-sign-in',
  'view-enrol',
  'view-overview',
  'view-clients',
  'view-client',
  // The five surfaces this slice added. Still one document switched by a `hidden` attribute: nine
  // screens is more than three and it is not a routing library's worth of screens.
  'view-approvals',
  'view-contracts',
  'view-documents',
  'view-billing',
  'view-workbench',
];

const show = (view) => {
  for (const name of VIEWS) $(name).hidden = name !== view;
  const anonymous = view === 'view-sign-in' || view === 'view-enrol';
  $('sign-out').hidden = anonymous;
  $('who').hidden = anonymous;
  $('nav').hidden = anonymous;
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

/**
 * A list whose rows open something.
 *
 * The same shape the client list has always used - the label is a button, the rest is text beside
 * it - extracted because five more lists now need it. Both halves go on with `textContent`.
 */
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

/** How many rows a page of clients holds. The server caps this independently. */
const PAGE = 25;

let offset = 0;
let search = '';

/** What the signed-in actor's Authority Level permits, from `/api/console/me`. */
let mayWrite = {};

/** The client whose file is open, so a write knows what it is writing to. */
let openClientId = null;

/**
 * Its legal name, so the three client-scoped surfaces can say whose file they are showing.
 *
 * Carried rather than refetched: a page headed "Documents" with no name on it is a page somebody
 * reads while thinking of a different client.
 */
let openClientName = '';

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
    'BLOCKS placement, AND lists this client on Do Not Fund automatically (Decision E). Removing ' +
    'that listing afterwards takes a Level 3 human and a written justification - automatic in, ' +
    'human out - so this is not a state to pick in order to mean "needs work".',
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

/**
 * Fill the two selects from the server's own lists.
 *
 * Once per sign-in rather than per client: both are compile-time constants, and refetching them for
 * every file would be a request that can only ever return the same answer.
 */
const loadVocabulary = async () => {
  const consent = $('consent-kind');
  const need = $('placement-need');
  if (consent.options.length > 0) return;

  const vocabulary = await api.vocabulary();
  if (!vocabulary.ok) return;

  for (const kind of vocabulary.data.consentKinds) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    consent.append(option);
  }
  // `application` is the one a placement needs, and what an operator is usually here for.
  consent.value = 'application';

  for (const kind of vocabulary.data.capitalNeeds) {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = kind;
    need.append(option);
  }
  // Deliberately left on the empty "Choose…" option. See the note on the form.
};

/** Read who is signed in and what they may write. The one source for both. */
const identify = async () => {
  const who = await api.me();
  if (!who.ok) return false;

  mayWrite = who.data.mayWrite ?? {};
  $('who').textContent = `${who.data.label} — Level ${who.data.authorityLevel}${
    who.data.department ? ` — ${who.data.department}` : ''
  }`;
  await loadVocabulary();
  return true;
};

$('sign-out').addEventListener('click', async () => {
  await api.signOut();
  $('who').textContent = '';
  notice('Signed out.');
  show('view-sign-in');
});

// --- enrolment --------------------------------------------------------------

/** The actor whose enrolment is in progress, from the invitation just spent. */
let enrollingActorId = null;

$('go-enrol').addEventListener('click', () => {
  notice('');
  $('section-authenticator').hidden = true;
  show('view-enrol');
});

$('enrol-back').addEventListener('click', () => {
  notice('');
  show('view-sign-in');
});

$('form-enrol').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.enrol($('enrol-token').value.trim(), $('enrol-password').value);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  enrollingActorId = result.data.actorId;

  // Shown once, and the field that carried the token is cleared: it is spent, and a spent code
  // left on screen looks like one that still works.
  $('enrol-token').value = '';
  $('enrol-secret').textContent = result.data.secret;
  $('section-authenticator').hidden = false;
  notice('Add the secret below to your authenticator, then enter a code from it.');
});

$('form-confirm-enrol').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.confirmEnrolment(
    enrollingActorId,
    $('enrol-password').value,
    $('enrol-code').value,
  );
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  // Everything the enrolment touched is cleared before the sign-in view: the password, the code,
  // and above all the secret, which is not recoverable and should not sit on a screen.
  $('enrol-password').value = '';
  $('enrol-code').value = '';
  $('enrol-secret').textContent = '';
  $('section-authenticator').hidden = true;
  enrollingActorId = null;

  show('view-sign-in');
  notice('Enrolment complete. Sign in with your password and a code.');
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

  // Inviting is the same Level 3 decision the module enforces. Hidden below it as a courtesy; the
  // module refuses regardless of what the page offered.
  $('section-invite').hidden = mayWrite.transition_compliance_state !== true;

  notice(announce);
  show('view-overview');
};

$('form-invite').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');

  const result = await api.inviteStaff($('invite-actor').value.trim(), $('invite-email').value.trim());

  const banner = $('invite-result');
  if (!result.ok) {
    banner.hidden = true;
    notice(result.reason);
    return;
  }

  $('invite-actor').value = '';
  $('invite-email').value = '';

  // The code is shown here because there is nobody else to hand it to yet - no email provider is
  // gated. It is single-use and expires, and it can only be spent to SET a credential.
  banner.hidden = false;
  banner.textContent = `Invitation code for ${result.data.email}, valid until ${result.data.expiresAt}: ${result.data.token} — pass it to them directly. Anyone holding it can spend it.`;
  notice('Invitation issued.');
});

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
  openClientName = client.legalName;
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
  $('section-placement').hidden = mayWrite.draft_recommendation !== true;
  clearPlacement();
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

const clearPlacement = () => {
  $('placement-summary').textContent = '';
  $('placement-rejected-summary').textContent = '';
  $('placement-missing').textContent = '';
  $('placement-recommendations').replaceChildren();
  $('placement-rejected').replaceChildren();
};

$('form-placement').addEventListener('submit', async (event) => {
  event.preventDefault();
  notice('');
  clearPlacement();

  const result = await api.requestPlacement(
    openClientId,
    $('placement-ref').value.trim(),
    $('placement-need').value,
    Number.parseInt($('placement-amount').value, 10),
  );

  showTrace(result.trace);

  if (!result.ok) {
    // **A refusal is the ordinary outcome here and is shown as an answer, not an error.** The chain
    // refuses a client who is not assessed; 5.3 refuses one who has not authorised this
    // application; the Entity Graph refuses when nobody has said which company is applying; the
    // catalogue returns nothing when no approved provider fits. Each says which, and the operator's
    // next move differs in every case.
    $('placement-summary').textContent = result.reason;
    notice(result.reason);
    return;
  }

  const set = result.data.recommendations;

  $('placement-summary').textContent =
    set.recommendations.length === 0
      ? 'No provider survived governance, eligibility and suitability.'
      : `${set.recommendations.length} recommendation${set.recommendations.length === 1 ? '' : 's'}.`;

  list(
    'placement-recommendations',
    set.recommendations.map((item) => {
      const parts = [
        `${item.provider.value} — ${item.product.value}`,
        `limit ${item.requestedCreditLimit}`,
        item.rationale,
      ];
      // A caution is surfaced, never filtered: the easiest product to qualify for is often the
      // worst fit, and a list that quietly dropped it would be recommending by omission.
      if (item.suitability.caution) parts.push(`CAUTION: ${item.suitability.rationale}`);
      if (item.containsUnverifiedInputs) parts.push('rests on an unresearched default');
      if (item.requiredDisclosures.length > 0) {
        parts.push(`disclosures: ${item.requiredDisclosures.join('; ')}`);
      }
      return parts.join(' — ');
    }),
    'No provider survived.',
  );

  $('placement-rejected-summary').textContent =
    set.rejected.length === 0
      ? ''
      : `${set.rejected.length} alternative${set.rejected.length === 1 ? '' : 's'} rejected, and why:`;
  list(
    'placement-rejected',
    set.rejected.map(
      (item) => `${item.providerName} — ${item.offeringName} — ${item.stage} — ${item.reason}`,
    ),
    '',
  );
  if (set.rejected.length === 0) $('placement-rejected').replaceChildren();

  $('placement-missing').textContent =
    set.missingProfileFields.length === 0
      ? ''
      : `Record these and more providers resolve: ${set.missingProfileFields.join(', ')}.`;

  notice('Recommendation ready.');
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

// --- 2.4 Human Approval Console ---------------------------------------------

/** The queue last asked about, so returning to this view does not blank the field. */
let approvalsQueue = '';

const enterApprovals = async () => {
  const result = await api.approvals(approvalsQueue);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  const data = result.data;
  $('approvals-queue').value = data.queue;

  $('approvals-summary').textContent = data.queueAsked
    ? `${data.total} open in ${data.queue}.`
    : 'Name a queue to see what is open in it. The SLA list below needs no queue.';

  openable(
    'approvals-list',
    data.items.map((item) => ({
      label: item.summary,
      detail:
        `${item.status} — assigned to ${item.assignedTo}` +
        `${item.clientId === null ? '' : ` — client ${item.clientId}`}` +
        ` — SLA ${item.slaDueAt ?? 'none set'}`,
      open: () => {
        // An assignment can exist without a workflow task behind it. Saying so beats a button that
        // opens nothing and looks broken.
        if (item.workflowTaskId === null) {
          notice('That assignment is not attached to a workflow task.');
          return;
        }
        void openApproval(item.workflowTaskId);
      },
    })),
    data.queueAsked ? 'Nothing open in that queue.' : 'No queue named yet.',
  );

  $('approvals-breached-summary').textContent =
    data.breachedTotal === 0
      ? 'No human checkpoint is past its SLA.'
      : `${data.breachedTotal} past their SLA, across every queue.`;

  openable(
    'approvals-breached',
    data.breached.map((task) => ({
      label: task.nodeKey,
      detail:
        `${task.status} — ${task.department ?? 'no department'}` +
        ` — due ${task.slaDueAt ?? 'none set'}` +
        ` — ${task.escalatedAt === null ? 'not escalated' : `escalated ${task.escalatedAt}`}`,
      open: () => {
        void openApproval(task.id);
      },
    })),
    'No human checkpoint is past its SLA.',
  );

  $('section-approval').hidden = true;
  notice('');
  show('view-approvals');
};

const openApproval = async (taskId) => {
  const result = await api.approval(taskId);
  const section = $('section-approval');

  if (!result.ok) {
    section.hidden = true;
    notice(result.reason);
    return;
  }

  const { task, instance, siblings, notifications, resolution } = result.data;

  $('approval-task').textContent =
    `${task.nodeKey} — ${task.kind} — ${task.status} — ${task.department ?? 'no department'}` +
    ` — attempt ${task.attempts} of ${task.maxAttempts}` +
    ` — SLA ${task.slaDueAt ?? 'none set'}` +
    ` — ${task.escalatedAt === null ? 'not escalated' : `escalated ${task.escalatedAt}`}` +
    `${task.lastError === null ? '' : ` — last error: ${task.lastError}`}`;

  $('approval-instance').textContent =
    `Playbook ${instance.playbookKey} v${instance.playbookVersion} — ${instance.status}` +
    ` — at node ${instance.currentNodeKey} — client ${instance.clientId ?? 'none'}`;

  $('approval-siblings-summary').textContent = `${result.data.siblingsTotal} task(s) in this workflow.`;
  list(
    'approval-siblings',
    siblings.map((sibling) => `${sibling.nodeKey} — ${sibling.kind} — ${sibling.status}`),
    'No task recorded.',
  );

  $('approval-notifications-summary').textContent =
    `${result.data.notificationsTotal} assignment(s) raised for it.`;
  list(
    'approval-notifications',
    notifications.map((item) => `${item.assignedTo} — ${item.status} — ${item.summary}`),
    'No assignment raised.',
  );

  // **Named, not implied by an absent control.** A page that simply had no button here would read
  // as one somebody had not finished; this says the act exists and what stands in front of it.
  $('approval-resolution').textContent = resolution.available
    ? `Resolving is available as ${resolution.requiredAction}.`
    : `No resolve control on this page. ${resolution.reason}`;

  section.hidden = false;
  notice('');
};

$('form-approvals').addEventListener('submit', (event) => {
  event.preventDefault();
  approvalsQueue = $('approvals-queue').value.trim();
  void enterApprovals();
});

// --- 7.3 Contract & Disclosure Builder --------------------------------------

const enterContracts = async () => {
  if (openClientId === null) {
    notice('Open a client file first.');
    return;
  }

  const [issued, staleness] = await Promise.all([
    api.contracts(openClientId),
    api.contractStaleness(),
  ]);

  if (!issued.ok) {
    notice(issued.reason);
    return;
  }

  $('contracts-client').textContent = `File: ${openClientName}`;
  $('contracts-summary').textContent = `${issued.data.total} issued to this client.`;

  openable(
    'contracts-list',
    issued.data.contracts.map((record) => ({
      label: record.kind,
      detail:
        `${record.state} — template ${record.templateKey} v${record.templateVersion}` +
        ` — state module v${record.stateModuleVersion} — issued ${record.issuedAt}` +
        ` — ${record.clauseKeys.length} clause(s), ${record.disclosureKeys.length} disclosure(s)` +
        ` — hash ${record.contentHash}`,
      open: () => {
        void openContract(record.id);
      },
    })),
    'No contract has been issued to this client.',
  );

  if (staleness.ok) {
    const data = staleness.data;
    // Firm-wide, and said so: this report is not scoped to the open file, and a reader who assumed
    // it was would draw the wrong conclusion from a count of one.
    $('contracts-stale-summary').textContent =
      data.staleTotal === 0
        ? 'Firm-wide: no issued document is behind its state module.'
        : `Firm-wide: ${data.staleTotal} issued against a state module that has since moved.`;
    list(
      'contracts-stale',
      data.stale.map(
        (item) =>
          `${item.kind} — client ${item.clientId} — ${item.state} — generated against v${item.generatedAgainstVersion}, current is v${item.currentVersion} — issued ${item.issuedAt} — ${item.reason}`,
      ),
      'None.',
    );

    $('contracts-superseded-summary').textContent =
      data.onSupersededTemplatesTotal === 0
        ? 'Firm-wide: no issued document is on a superseded template.'
        : `Firm-wide: ${data.onSupersededTemplatesTotal} on a template we have since replaced.`;
    list(
      'contracts-superseded',
      data.onSupersededTemplates.map(
        (item) => `${item.templateKey} — v${item.from} superseded by v${item.to} — contract ${item.id}`,
      ),
      'None.',
    );
  } else {
    $('contracts-stale-summary').textContent = staleness.reason;
    list('contracts-stale', [], 'None.');
    $('contracts-superseded-summary').textContent = '';
    list('contracts-superseded', [], 'None.');
  }

  $('section-contract').hidden = true;
  notice('');
  show('view-contracts');
};

const openContract = async (contractId) => {
  const result = await api.contract(contractId);
  const section = $('section-contract');

  if (!result.ok) {
    section.hidden = true;
    notice(result.reason);
    return;
  }

  const data = result.data;

  $('contract-title').textContent = data.document.title;
  $('contract-meta').textContent =
    `${data.kind} — ${data.state} — issued ${data.issuedAt}` +
    ` — tier ${data.document.offerTier ?? 'none'} — channel ${data.document.channel ?? 'none'}`;

  // The class follows the words rather than carrying the meaning on its own: the sentence says
  // which it is, and would still say so with every stylesheet in the world switched off.
  $('contract-integrity').className = data.integrity.intact ? 'muted' : 'alarm';
  $('contract-integrity').textContent = data.integrity.intact
    ? `Integrity intact. ${data.integrity.detail}`
    : `INTEGRITY FAILURE. ${data.integrity.detail}`;

  $('contract-placeholders').textContent =
    data.unresolvedPlaceholdersTotal === 0
      ? 'No unresolved placeholder: every substitution resolved at generation.'
      : `${data.unresolvedPlaceholdersTotal} unresolved placeholder(s) — this document went out with a blank in it: ${data.unresolvedPlaceholders.join(', ')}`;

  $('contract-provenance').textContent =
    `Generated from template ${data.document.provenance.templateKey} v${data.document.provenance.templateVersion}` +
    ` against state module v${data.document.provenance.stateModuleVersion}` +
    ` at ${data.document.provenance.generatedAt}.`;

  $('contract-sections-summary').textContent = `${data.document.sectionsTotal} section(s).`;
  list(
    'contract-sections',
    data.document.sections.flatMap((section_) => [
      `${section_.heading}: ${section_.body}`,
      // Each insertion carries the citation that put it there. A clause with no provenance is a
      // clause nobody can defend.
      ...section_.clauses.map((clause) => `    clause ${clause.key} (${clause.citation}): ${clause.text}`),
      ...section_.disclosures.map(
        (disclosure) =>
          `    disclosure ${disclosure.key} (${disclosure.source}, ${disclosure.citation}): ${disclosure.text}`,
      ),
    ]),
    'No section.',
  );

  section.hidden = false;
  notice('');
};

// --- 3.2 Secure Document Vault ----------------------------------------------

const enterDocuments = async () => {
  if (openClientId === null) {
    notice('Open a client file first.');
    return;
  }

  const result = await api.documents(openClientId);
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  const data = result.data;

  $('documents-client').textContent = `File: ${openClientName}`;
  $('documents-bytes-notice').textContent = data.bytesAvailableHere
    ? 'This surface can fetch document content.'
    : 'Metadata and the access log only. No route on this page returns document content — not to view, not to export.';

  $('documents-summary').textContent =
    `${data.total} document(s). You hold Authority Level ${data.actorAuthorityLevel}.`;

  openable(
    'documents-list',
    data.documents.map((document_) => ({
      label: document_.filename,
      detail:
        `${document_.kind} — ${document_.contentType} — ${document_.byteSize} bytes` +
        // `pending` and `scan_unavailable` are written out. Neither means clean, and a tick beside
        // either would be the shortest possible lie.
        ` — scan ${document_.scanStatus}` +
        ` — ${document_.legalHold ? 'LEGAL HOLD, export locked out' : 'no legal hold'}` +
        ` — retain until ${document_.retainUntil ?? 'no schedule resolved'}` +
        ` — reading it needs Authority Level ${document_.minimumLevelToRead}` +
        ` — sha256 ${document_.sha256}`,
      open: () => {
        void openAccessLog(document_.id);
      },
    })),
    'No document on this file.',
  );

  $('section-access-log').hidden = true;
  notice('');
  show('view-documents');
};

const openAccessLog = async (documentId) => {
  const result = await api.documentAccessLog(documentId);
  const section = $('section-access-log');

  if (!result.ok) {
    section.hidden = true;
    notice(result.reason);
    return;
  }

  const data = result.data;

  $('access-log-summary').textContent =
    `${data.total} access attempt(s): ${data.grantedTotal} granted, ${data.refusedTotal} refused.`;

  list(
    'access-log-list',
    data.entries.map(
      (entry) =>
        `${entry.at} — ${entry.actorId} — ${entry.action} — ${entry.granted ? 'granted' : 'REFUSED'}` +
        `${entry.reason === null ? '' : ` (${entry.reason})`}` +
        ` — ${entry.watermarked ? 'watermarked' : 'not watermarked'}`,
    ),
    'Nobody has attempted to read this document.',
  );

  section.hidden = false;
  notice('');
};

// --- 1.4 Pricing, Billing & Offer Management --------------------------------

const enterBilling = async () => {
  if (openClientId === null) {
    notice('Open a client file first.');
    return;
  }

  const [bill, ladder] = await Promise.all([api.billing(openClientId), api.offers()]);
  if (!bill.ok) {
    notice(bill.reason);
    return;
  }

  const data = bill.data;

  $('billing-client').textContent = `File: ${openClientName}`;
  $('billing-summary').textContent = `${data.total} engagement(s).`;

  openable(
    'billing-engagements',
    data.engagements.map((engagement) => ({
      label: engagement.id,
      detail:
        `${engagement.status} — started ${engagement.startedOn}` +
        ` — committed through ${engagement.committedThrough ?? 'no commitment'}` +
        ` — ${engagement.annualPrepay ? 'annual prepay' : 'not prepaid'}` +
        ` — outstanding ${engagement.outstandingDisplay ?? 'unavailable'}` +
        ` — ${
          engagement.meetsMinimum === null
            ? 'minimum not determinable'
            : engagement.meetsMinimum
              ? 'meets the minimum'
              : 'below the minimum'
        }` +
        ` — ${engagement.unresolvedRefundTotal} unresolved of ${engagement.refundTotal} refund entitlement(s)` +
        `${engagement.cancelledOn === null ? '' : ` — cancelled ${engagement.cancelledOn}`}`,
      open: () => {
        void openEngagement(engagement.id);
      },
    })),
    'No engagement on this file.',
  );

  $('billing-credit-summary').textContent =
    `${data.credit.availableDisplay} unspent across ${data.credit.sourcesTotal} payment(s).`;
  list(
    'billing-credit',
    data.credit.sources.map(
      (source) =>
        `${source.occurredOn} — engagement ${source.engagementId} — paid ${source.paidDisplay}, drawn ${source.alreadyDrawnDisplay}, available ${source.availableDisplay}`,
    ),
    'No unspent payment.',
  );

  if (ladder.ok) {
    $('offers-summary').textContent = `${ladder.data.total} offer(s) on the ladder.`;
    list(
      'offers-list',
      ladder.data.offers.map(
        (offer) =>
          `Rung ${offer.rung}: ${offer.name} (${offer.key} v${offer.version}) — retainer ${offer.retainerDisplay}` +
          `, monthly ${offer.monthlyDisplay} for ${offer.committedMonths} month(s)` +
          `, minimum ${offer.minimumDisplay}` +
          // Basis points, not a percentage. The stored figure is what the fee is computed from.
          `, success fee ${offer.successFeeBasisPoints} basis points`,
      ),
      'No offer published.',
    );
  } else {
    $('offers-summary').textContent = ladder.reason;
    list('offers-list', [], 'No offer published.');
  }

  $('section-engagement').hidden = true;
  notice('');
  show('view-billing');
};

const openEngagement = async (engagementId) => {
  const result = await api.engagement(engagementId);
  const section = $('section-engagement');

  if (!result.ok) {
    section.hidden = true;
    notice(result.reason);
    return;
  }

  const data = result.data;

  $('engagement-meta').textContent =
    `${data.engagement.id} — ${data.engagement.status} — started ${data.engagement.startedOn}` +
    ` — committed through ${data.engagement.committedThrough ?? 'no commitment'}` +
    ` — ${data.engagement.annualPrepay ? 'annual prepay' : 'not prepaid'}` +
    `${data.engagement.cancelledOn === null ? '' : ` — cancelled ${data.engagement.cancelledOn}`}`;

  // Four numbers, then the fifth that follows from them. A single net figure would answer less than
  // the components, and a client disputing an invoice is asking about one of the four.
  $('engagement-balance').textContent =
    data.balance === null
      ? data.balanceUnavailableReason
      : `Charged ${data.balance.chargedDisplay}, paid ${data.balance.paidDisplay}, refunded ${data.balance.refundedDisplay}, credited ${data.balance.creditedDisplay} — outstanding ${data.balance.outstandingDisplay}.`;

  $('engagement-minimum').textContent =
    data.balance === null
      ? ''
      : `Engagement minimum ${data.balance.minimumDisplay} — ${data.balance.meetsMinimum ? 'met' : 'not met'}.`;

  $('engagement-records-summary').textContent = `${data.recordsTotal} billing record(s).`;
  list(
    'engagement-records',
    data.records.map(
      (record) =>
        `${record.occurredOn} — ${record.kind} — ${record.amountDisplay} — ${record.description}` +
        // The APPROVED limit. There is no field anywhere in 1.4 for a requested one, which is the
        // Seek Capital lesson expressed as an absence rather than as a warning.
        `${
          record.approvedCreditLimitDisplay === null
            ? ''
            : ` — against approved credit limit ${record.approvedCreditLimitDisplay}`
        }`,
    ),
    'No billing record.',
  );

  $('engagement-refunds-summary').textContent =
    `${data.refundsTotal} entitlement(s), ${data.unresolvedRefundTotal} neither paid nor declined.`;
  list(
    'engagement-refunds',
    data.refunds.map(
      (refund) =>
        `${refund.trigger} — ${refund.amountDisplay} — ${refund.resolved ?? 'unresolved'} — ${refund.basis}`,
    ),
    'No refund entitlement.',
  );

  if (data.exhibit === null) {
    $('engagement-exhibit-summary').textContent = data.exhibitUnavailableReason;
    list('engagement-exhibit', [], 'No exhibit.');
    $('engagement-exhibit-contingent').textContent = '';
  } else {
    $('engagement-exhibit-summary').textContent =
      `${data.exhibit.linesTotal} line(s). Known total $${data.exhibit.knownTotalDollars} (dollars, not cents). ${data.exhibit.summary}`;
    list(
      'engagement-exhibit',
      data.exhibit.lines.map(
        (line) =>
          `${line.label} — ${
            // A contingent fee has no amount, and "contingent" is the honest word. Rendering it as
            // $0 would state that the client owes nothing, which is a different claim.
            line.amount === null ? 'contingent, not yet determinable' : `$${line.amount}`
          } — ${line.basis} — ${line.whenCharged}`,
      ),
      'No line.',
    );
    $('engagement-exhibit-contingent').textContent =
      data.exhibit.contingentLinesTotal === 0
        ? 'No contingent line.'
        : `${data.exhibit.contingentLinesTotal} contingent line(s), excluded from the total: ${data.exhibit.contingentLines.join('; ')}`;
  }

  section.hidden = false;
  notice('');
};

// --- 11.11 Founder / Executive Workbench ------------------------------------

const enterWorkbench = async () => {
  const result = await api.workbench();
  if (!result.ok) {
    notice(result.reason);
    return;
  }

  const data = result.data;

  $('workbench-decisions-summary').textContent =
    `${data.decisionsTotal} decision(s), ${data.overdueTotal} overdue. Assembled ${data.generatedAt}.`;
  list(
    'workbench-decisions',
    data.decisions.map(
      (decision) =>
        `${decision.urgency} — ${decision.kind} — ${decision.summary}` +
        // The field that makes this a queue rather than a feed.
        ` — if nobody acts: ${decision.costOfInaction}` +
        ` — resolve in ${decision.resolveIn}` +
        `${decision.dueAt === null ? '' : ` — due ${decision.dueAt}`}`,
    ),
    'Nothing needs a founder decision.',
  );

  $('workbench-period').textContent =
    `Period ${data.rollup.periodFrom} to ${data.rollup.periodTo}${
      data.rollup.periodPartial ? ' (partial — the window is not closed)' : ''
    }.`;

  $('workbench-clients').textContent =
    `${data.rollup.clients} client(s).` +
    // `null` is written as "not measured" everywhere below. A missing measurement is not a
    // measurement of zero, and zero is the value that would read as a finding.
    ` Healthy share ${data.rollup.healthyShare ?? 'not measured'}.` +
    ` Compliance target ${
      data.rollup.meetsComplianceTarget === null
        ? 'not measured'
        : data.rollup.meetsComplianceTarget
          ? 'met'
          : 'not met'
    }.` +
    ` Placement approval rate ${data.rollup.placementApprovalRate ?? 'not measured'}.` +
    ` Revenue per client ${
      data.rollup.revenuePerClientCents === null
        ? 'not measured'
        : `${data.rollup.revenuePerClientCents} cents`
    }.` +
    ` ${data.rollup.openCorrectionObligations} open correction obligation(s).`;

  list(
    'workbench-compliance',
    Object.entries(data.rollup.complianceCounts).map(([state, count]) => `${state}: ${count}`),
    'No compliance distribution produced.',
  );

  $('workbench-withheld-summary').textContent =
    data.rollup.withheldTotal === 0
      ? 'Every metric in the rollup produced a value.'
      : `${data.rollup.withheldTotal} metric(s) withheld — a metric with no value is not a value of zero:`;
  list(
    'workbench-withheld',
    data.rollup.withheld.map((metric) => `${metric.key}: ${metric.note}`),
    'None.',
  );

  $('workbench-health').textContent =
    `${data.health.overall} — ${data.health.detail} (checked ${data.health.checkedAt})` +
    // `unmonitored` is counted out loud. Nobody looking is not evidence of health.
    ` — ${data.health.counts.unmonitored} of ${data.health.componentsTotal} component(s) unmonitored.`;
  list(
    'workbench-health-components',
    data.health.components.map(
      (component) => `${component.label}: ${component.state} — ${component.detail}`,
    ),
    'No component reported.',
  );

  $('workbench-departments-summary').textContent = `${data.crossDepartmentTotal} department(s).`;
  list(
    'workbench-departments',
    data.crossDepartment.map((entry) => `${entry.department}: ${entry.status}`),
    'No department reported.',
  );

  notice('');
  show('view-workbench');
};

// --- navigation -------------------------------------------------------------

$('nav-overview').addEventListener('click', () => {
  void enterOverview();
});

$('nav-clients').addEventListener('click', () => {
  void enterClients();
});

$('nav-approvals').addEventListener('click', () => {
  void enterApprovals();
});

$('nav-workbench').addEventListener('click', () => {
  void enterWorkbench();
});

$('nav-back').addEventListener('click', () => {
  void enterClients();
});

$('nav-contracts').addEventListener('click', () => {
  void enterContracts();
});

$('nav-documents').addEventListener('click', () => {
  void enterDocuments();
});

$('nav-billing').addEventListener('click', () => {
  void enterBilling();
});

// The three client-scoped surfaces return to the file they were opened from, not to the list.
for (const id of ['contracts-back', 'documents-back', 'billing-back']) {
  $(id).addEventListener('click', () => {
    void enterClient(openClientId);
  });
}

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
