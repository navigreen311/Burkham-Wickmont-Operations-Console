/**
 * 7.4 Marketing Claim Library and 4.5 Marketing Ops, in the browser.
 *
 * **`banned` is an outcome, not an error, and this page has to look like it means that.**
 *
 * A banned entry is the Compliance Review Board having been asked whether the firm may say
 * "guaranteed approval" and having answered no. It is the rule the Scanner then enforces on every
 * outbound message — the entry that stops something. So on this page it is counted beside
 * `approved` as a peer, it carries no warning styling, and the proposal queue says out loud that a
 * proposal has three outcomes rather than two.
 *
 * The failure this avoids is a library headed "4 approved, 14 problems", which would describe 7.4's
 * best work as a defect and would teach an operator to try to clear the banned list.
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

/**
 * What each disposition does, in the Scanner's terms.
 *
 * Written beside the word so nobody has to infer that `banned` is the useful one. All three are
 * described as things the library DOES, not as grades.
 */
const DISPOSITION_MEANING = {
  approved: 'may be used as written',
  banned: 'the Scanner blocks any message containing it',
  requires_disclaimer: 'may be used only with the disclosure it obliges travelling alongside',
};

const loadLibrary = async () => {
  const [claims, proposals, assets] = await Promise.all([
    call('/api/console/marketing/claims'),
    call('/api/console/marketing/proposals'),
    call('/api/console/marketing/assets'),
  ]);

  if (!claims.ok) {
    $('marketing-claims-summary').textContent = claims.reason;
    return;
  }

  const data = claims.data;
  const by = data.byDisposition;

  // Three peers, in the order the library defines them. No "problems" total exists to compute.
  $('marketing-claims-summary').textContent =
    `${data.total} active entr(ies)${data.jurisdiction === null ? ' across every jurisdiction' : ` for ${data.jurisdiction} plus global`} — ` +
    `${by.approved} approved, ${by.banned} banned, ${by.requires_disclaimer} requires a disclaimer.`;

  $('marketing-banned-note').textContent = data.bannedIsAnOutcome ? data.bannedNote : '';

  list(
    'marketing-claims',
    data.claims.map(
      (claim) =>
        `"${claim.phrase}" — ${claim.disposition}: ${DISPOSITION_MEANING[claim.disposition] ?? 'unrecognised disposition'}` +
        ` — ${claim.global ? 'every jurisdiction' : claim.jurisdiction}` +
        ` — approved by ${claim.approvedBy}, v${claim.version}` +
        ` — ${claim.rationale}` +
        `${claim.requiredDisclosure === null ? '' : ` — discloses: ${claim.requiredDisclosure}`}`,
    ),
    'The library is empty. The Scanner has nothing to enforce.',
  );

  if (proposals.ok) {
    $('marketing-proposals-summary').textContent =
      proposals.data.total === 0
        ? 'No claim is waiting on the Compliance Review Board.'
        : `${proposals.data.total} claim(s) waiting on the Board, which decides at Authority Level ${proposals.data.reviewAuthorityLevel}:`;

    list(
      'marketing-proposals',
      proposals.data.proposals.map(
        (proposal) =>
          // `intendedUse` is the point of the queue and travels with every row: the same phrase can
          // be fine on a landing page and a problem in a cold email mid-application.
          `"${proposal.phrase}" — intended use: ${proposal.intendedUse}` +
          ` — ${proposal.jurisdiction === null ? 'every jurisdiction' : proposal.jurisdiction}` +
          ` — ${proposal.status} — submitted ${proposal.submittedAt}`,
      ),
      'No claim is waiting on the Board.',
    );

    // Three outcomes, said explicitly so the queue is never read as approve-or-fail.
    $('marketing-outcomes-note').textContent = proposals.data.outcomesNote;
    $('marketing-decision-unavailable').textContent = proposals.data.decisionAvailableHere
      ? ''
      : proposals.data.decisionUnavailableReason;
  } else {
    $('marketing-proposals-summary').textContent = proposals.reason;
    list('marketing-proposals', [], 'No proposal queue.');
    $('marketing-outcomes-note').textContent = '';
    $('marketing-decision-unavailable').textContent = '';
  }

  if (assets.ok) {
    const state = assets.data.byState;
    $('marketing-assets-summary').textContent =
      `${assets.data.total} marketing asset(s)${assets.data.filteredTo === null ? '' : ` in state ${assets.data.filteredTo}`} — ` +
      `${state.draft} draft, ${state.in_review} in review, ${state.approved} approved, ${state.rejected} rejected, ${state.retired} retired.`;

    list(
      'marketing-assets',
      assets.data.assets.map(
        (asset) =>
          `${asset.key} (${asset.kind}) — ${asset.state} — ${asset.body}` +
          // A rejected asset with no reason is a decision its author cannot act on.
          `${asset.rejectionReason === null ? '' : ` — rejected because: ${asset.rejectionReason}`}`,
      ),
      'No marketing asset recorded.',
    );
  } else {
    $('marketing-assets-summary').textContent = assets.reason;
    list('marketing-assets', [], 'No marketing asset recorded.');
  }
};

$('marketing-load').addEventListener('click', () => {
  void loadLibrary();
});
