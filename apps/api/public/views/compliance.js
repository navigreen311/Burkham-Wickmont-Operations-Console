/**
 * 7.1 Compliance Evidence Vault, in the browser.
 *
 * **The rule this file exists to keep: `empty` is never `not_built`.**
 *
 * Both produce a section with no rows. One means the firm consulted the module and this client has
 * nothing in it; the other means the module does not exist. A page that showed "0 items" for both
 * would flatten the distinction the whole of 7.1 is built to preserve — and the reader most likely
 * to be misled by it is a regulator.
 *
 * So every coverage row on this page carries its verdict as a word, the four verdicts are counted
 * separately, and the two zeroes are described in different sentences. `itemCount` never appears
 * without the verdict beside it.
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

/**
 * What each verdict means, in the words 7.1 uses.
 *
 * Written beside the count rather than left as a bare identifier, because `not_built` and `empty`
 * are the two a reader most needs told apart and neither word says enough on its own.
 */
const COVERAGE_MEANING = {
  complete: 'consulted; returned everything it holds',
  empty: 'consulted; holds nothing for this client',
  not_built: 'the module does not exist yet — this is not an empty section',
  failed: 'consulted and errored; the section is missing rather than empty',
};

const loadFile = async (clientId) => {
  const [file, exports] = await Promise.all([
    call(`/api/console/evidence/clients/${encodeURIComponent(clientId)}/file`),
    call(`/api/console/evidence/clients/${encodeURIComponent(clientId)}/exports`),
  ]);

  if (!file.ok) {
    $('evidence-summary').textContent = file.reason;
    list('evidence-coverage', [], 'No coverage map.');
    return;
  }

  const data = file.data;

  $('evidence-summary').textContent =
    `${data.clientLegalName} — ${data.scope} scope — compliance state ${data.complianceState} — assembled ${data.assembledAt} — content hash ${data.contentHash}`;

  $('evidence-integrity').textContent = data.ledgerIntegrity.intact
    ? `Ledger chain verified across ${data.ledgerIntegrity.checked} entries. ${data.ledgerIntegrity.detail}`
    : `LEDGER CHAIN DID NOT VERIFY across ${data.ledgerIntegrity.checked} entries. ${data.ledgerIntegrity.detail}`;

  /**
   * **The four counts, named separately and never summed.**
   *
   * "18 sections, 6 with no rows" is the sentence this page must not produce: it merges a client
   * who has no complaints with a complaints module nobody built.
   */
  const by = data.byCoverage;
  $('evidence-coverage-summary').textContent =
    `${data.coverageTotal} source(s) consulted — ` +
    `${by.complete} complete, ` +
    `${by.empty} empty (${COVERAGE_MEANING.empty}), ` +
    `${by.not_built} not built (${COVERAGE_MEANING.not_built}), ` +
    `${by.failed} failed.`;

  list(
    'evidence-coverage',
    data.coverage.map(
      (entry) =>
        // The verdict, then its meaning, then the count. The count never stands on its own.
        `${entry.module} (${entry.key}) — ${entry.coverage}: ${COVERAGE_MEANING[entry.coverage] ?? 'unrecognised verdict'}` +
        ` — ${entry.itemCount} item(s) — ${entry.note}`,
    ),
    'No source was consulted.',
  );

  $('evidence-gaps-summary').textContent =
    data.gapsTotal === 0
      ? 'Every source contributed. Nothing in this file is missing because a module does not exist.'
      : `${data.gapsTotal} source(s) could not contribute. A file exported now would carry these gaps:`;
  list('evidence-gaps', data.gaps, 'None.');

  // The evidence itself is not on this page, and that is said rather than left to be inferred.
  $('evidence-sections-note').textContent = data.sectionsCarried
    ? 'The section contents are included above.'
    : data.sectionsNote;

  if (exports.ok) {
    $('evidence-exports-summary').textContent =
      exports.data.total === 0
        ? 'Nobody has taken a copy of this file.'
        : `${exports.data.total} export(s) of this file:`;

    openable(
      'evidence-exports',
      exports.data.exports.map((record) => ({
        label: record.exportedAt,
        detail:
          `${record.scope} scope — for ${record.requestedBy} — purpose: ${record.purpose}` +
          ` — hash ${record.contentHash}`,
        open: () => {
          void reconcile(record.id);
        },
      })),
      'Nobody has taken a copy of this file.',
    );

    $('evidence-export-unavailable').textContent = exports.data.exportAvailableHere
      ? ''
      : exports.data.exportUnavailableReason;
  } else {
    $('evidence-exports-summary').textContent = exports.reason;
    list('evidence-exports', [], 'No export history.');
    $('evidence-export-unavailable').textContent = '';
  }

  $('evidence-reconciliation').textContent = '';
};

/**
 * Compare a held copy against what the system would produce now.
 *
 * A mismatch is **expected and is not an error** — the file is assembled live, so anything added
 * since changes it. The page says which it is and what it means, and never calls it a failure.
 */
const reconcile = async (exportId) => {
  const result = await call(
    `/api/console/evidence/exports/${encodeURIComponent(exportId)}/reconciliation`,
  );

  $('evidence-reconciliation').textContent = result.ok
    ? `${result.data.matches ? 'Matches' : 'Differs'} — exported hash ${result.data.exportedHash}, current hash ${result.data.currentHash}. ${result.data.detail}`
    : result.reason;
};

$('form-evidence').addEventListener('submit', (event) => {
  event.preventDefault();
  const clientId = $('evidence-client').value.trim();
  if (clientId === '') {
    $('evidence-summary').textContent = 'Enter a client id to assemble their evidence file.';
    return;
  }
  void loadFile(clientId);
});
