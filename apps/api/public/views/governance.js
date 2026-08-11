/**
 * 5.4 Capital Product Governance Board, in the browser.
 *
 * Two things this page is careful about.
 *
 * **Never governed is written out, not shown as blank.** A provider the board has never seen has no
 * governance record at all, and that is the answer rather than a missing value (ADR-0007). An empty
 * status field would read as a provider somebody looked at and left undecided.
 *
 * **An empty approved-states list means not limited, not limited to nothing.** Those are opposite
 * answers to "may this provider be recommended anywhere", and an empty list rendered as an empty
 * list gives the reader the wrong one.
 *
 * Self-contained for the reason `views/regulatory.js` gives.
 */

const $ = (id) => document.getElementById(id);

const call = async (path) => {
  const response = await fetch(path, { credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({ status: 'failed', reason: 'No response.' }));
  return payload.status === 'ok'
    ? { ok: true, data: payload.data }
    : { ok: false, reason: payload.reason ?? 'Something went wrong.' };
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

/** What each blocker means, so a verdict is readable without the module source beside it. */
const BLOCKER_MEANING = {
  never_governed: 'the board has never reviewed this provider',
  pending_review: 'submitted and not yet decided',
  under_review: 'flagged and being looked at',
  suspended: 'suspended by the board',
  blacklisted: 'blacklisted by the board',
  review_overdue: 'approved, but the review cadence has run out',
  state_restricted: 'the board has not permitted this provider in that state',
};

const loadQueue = async () => {
  const [queue, restrictions] = await Promise.all([
    call('/api/console/governance/review-queue'),
    call('/api/console/governance/restrictions'),
  ]);

  if (!queue.ok) {
    $('governance-queue-summary').textContent = queue.reason;
    return;
  }

  const data = queue.data;

  // The cadence ceiling travels with the queue: "overdue" says nothing without the number it is
  // overdue against.
  $('governance-queue-summary').textContent =
    `${data.headline} Blueprint 5.4 caps the cadence at ${data.maximumReviewCadenceDays} days. ${data.total} in the queue.`;

  openable(
    'governance-queue',
    data.providers.map((entry) => ({
      label: entry.providerId,
      detail:
        `${entry.verdict} — blockers: ${entry.blockers.map((blocker) => `${blocker} (${BLOCKER_MEANING[blocker] ?? 'unrecognised'})`).join('; ')}` +
        ` — ${entry.daysSinceReview === null ? 'never reviewed' : `${entry.daysSinceReview} day(s) since review`}` +
        ` — ${entry.explanation}`,
      open: () => {
        void openProvider(entry.providerId);
      },
    })),
    'No approved provider is overdue for review.',
  );

  if (restrictions.ok) {
    $('governance-restrictions-summary').textContent =
      `${restrictions.data.total} provider(s) have a governance record.`;
    list(
      'governance-restrictions',
      restrictions.data.restrictions.map(
        (entry) =>
          `${entry.providerId} — ${entry.status} — ` +
          // The distinction the note explains, applied per row rather than left to the reader.
          `${
            entry.limitedToStates
              ? `approved only in ${entry.approvedStates.join(', ')}`
              : 'approval not limited by state'
          }` +
          `${entry.restrictedStates.length === 0 ? '' : ` — restricted in ${entry.restrictedStates.join(', ')}`}` +
          `${entry.requiredDisclosures.length === 0 ? '' : ` — disclosures: ${entry.requiredDisclosures.join('; ')}`}`,
      ),
      'No provider has a governance record.',
    );
    $('governance-restrictions-note').textContent = restrictions.data.note;
  } else {
    $('governance-restrictions-summary').textContent = restrictions.reason;
    list('governance-restrictions', [], 'No governance record.');
    $('governance-restrictions-note').textContent = '';
  }
};

const openProvider = async (providerId) => {
  const result = await call(
    `/api/console/governance/providers/${encodeURIComponent(providerId)}`,
  );

  if (!result.ok) {
    $('governance-provider-standing').textContent = result.reason;
    return;
  }

  const data = result.data;

  $('governance-provider-standing').textContent =
    `${data.providerId} — ${data.standing.verdict} — blockers: ${
      data.standing.blockers.length === 0
        ? 'none'
        : data.standing.blockers
            .map((blocker) => `${blocker} (${BLOCKER_MEANING[blocker] ?? 'unrecognised'})`)
            .join('; ')
    } — ${data.standing.daysSinceReview === null ? 'never reviewed' : `${data.standing.daysSinceReview} day(s) since review`} — ${data.standing.explanation}`;

  // Absence is the answer, and it is written out.
  $('governance-provider-record').textContent = data.neverGoverned
    ? 'The board has never seen this provider. There is no governance record — which is not the same as a record showing no approval.'
    : `Status ${data.governance.status} — last reviewed ${data.governance.lastReviewedAt ?? 'never'}` +
      ` — cadence ${data.governance.reviewCadenceDays} day(s)` +
      ` — ${data.governance.approvedStates.length === 0 ? 'approval not limited by state' : `approved in ${data.governance.approvedStates.join(', ')}`}` +
      `${data.governance.restrictedStates.length === 0 ? '' : ` — restricted in ${data.governance.restrictedStates.join(', ')}`}` +
      ` — ${data.governance.complaintCount} complaint(s) counted` +
      `${data.governance.blacklistReason === null ? '' : ` — blacklisted: ${data.governance.blacklistReason}`}`;

  $('governance-decisions-summary').textContent = `${data.decisionsTotal} board decision(s).`;
  list(
    'governance-decisions',
    data.decisions.map(
      (entry) =>
        `${entry.decidedAt} — ${entry.fromStatus ?? 'no prior status'} to ${entry.toStatus} — by ${entry.decidedBy} — ${entry.rationale}`,
    ),
    'No decision recorded.',
  );

  $('governance-complaints-summary').textContent = `${data.complaintsTotal} complaint(s) on record.`;
  list(
    'governance-complaints',
    data.complaints.map(
      (entry) => `${entry.receivedAt} — ${entry.severity} — from ${entry.source} — ${entry.summary}`,
    ),
    'No complaint recorded.',
  );
};

$('governance-load').addEventListener('click', () => {
  void loadQueue();
});

$('form-governance-provider').addEventListener('submit', (event) => {
  event.preventDefault();
  const providerId = $('governance-provider').value.trim();
  if (providerId === '') {
    $('governance-provider-standing').textContent = 'Enter a provider id.';
    return;
  }
  void openProvider(providerId);
});
