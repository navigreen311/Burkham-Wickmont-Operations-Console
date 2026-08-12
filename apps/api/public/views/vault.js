/**
 * 3.2 Secure Document Vault on the page.
 *
 * **There is no download button, and that is a refusal rather than an unfinished screen.** Document
 * bytes reach a client through the Client Portal, a separate process on a separate trust boundary
 * (ADR-0022). A second download path here would be a second set of rules about watermarking, legal
 * hold and virus scanning to keep in step with 3.2's, and the one that drifts is the one nobody is
 * looking at. The panel says so where the button would be.
 *
 * **Refused accesses are counted separately from granted ones.** A log read as "twelve accesses"
 * hides that four of them were refused, and a refused access is the more interesting row.
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
 * Render the writes a surface cannot offer, with the reason.
 *
 * **Shown, not omitted.** A panel with no buttons is indistinguishable from one whose buttons were
 * forgotten, and the reason is the part an operator needs: "no declared action" is a decision
 * somebody can take, and "refused by design" is one they should not try to.
 */
const blocked = (parent, writes) => {
  parent.replaceChildren();
  for (const entry of writes?.blocked ?? []) {
    line(parent, `${entry.capability} - ${entry.missingAction} - ${entry.why}`);
  }
};


const loadDocuments = async () => {
  const clientId = $('vault-client-id').value.trim();
  const status = $('vault-status');
  const list = $('vault-documents');
  list.replaceChildren();

  if (clientId === '') {
    status.textContent = 'Give a client id.';
    return;
  }

  const result = await call(`/api/console/vault/clients/${encodeURIComponent(clientId)}`);
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  const { documents, summary } = result.data;

  if (documents.length === 0) {
    line(list, 'Nothing on this file. Uploaded-and-unscanned and never-uploaded are different states; this is the second.');
  }
  for (const document_ of documents) {
    // Legal hold and scan state are words, never a colour. An unscanned document is unreadable by
    // design until 3.2 clears it, and that is not a warning icon - it is the fact.
    line(
      list,
      [
        document_.kind,
        document_.filename ?? 'unnamed',
        document_.scannedAt ? 'scanned' : 'NOT SCANNED - unreadable until 3.2 clears it',
        document_.legalHold ? 'ON LEGAL HOLD - export blocked' : 'no hold',
      ].join(' - '),
    );
  }

  status.textContent = `${summary.total} document(s), ${summary.onLegalHold} on legal hold.`;
  blocked($('vault-blocked'), result.data.writes);
  renderAvailable('vault-available', result.data.writes?.available);
};

const loadAccessLog = async () => {
  const documentId = $('vault-document-id').value.trim();
  const status = $('vault-log-status');
  const list = $('vault-log');
  list.replaceChildren();

  if (documentId === '') {
    status.textContent = 'Give a document id.';
    return;
  }

  const result = await call(
    `/api/console/vault/documents/${encodeURIComponent(documentId)}/access-log`,
  );
  if (!result.ok) {
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  for (const entry of result.data.entries) {
    // Order is evidence: "refused, then admitted" and "admitted, then refused" are different
    // findings, so the module's order is rendered untouched.
    line(
      list,
      `${String(entry.at).slice(0, 19).replace('T', ' ')} - ${entry.actorId} - ${entry.action} - ${
        entry.granted ? 'granted' : 'REFUSED'
      }${entry.reason ? ` - ${entry.reason}` : ''}`,
    );
  }

  status.textContent =
    result.data.entries.length === 0
      ? 'Nobody has touched this document, or there is no such document.'
      : `${result.data.entries.length} entr(y/ies), ${result.data.refused} refused.`;
};

$('vault-load').addEventListener('click', () => void loadDocuments());
$('vault-log-load').addEventListener('click', () => void loadAccessLog());

/**
 * The document-level controls.
 *
 * `remove` is the one that destroys evidence, and the module refuses it while a legal hold is in
 * force - which is the check that matters, because the reason to destroy a document and the reason
 * somebody held it are usually the same reason.
 */
renderWrites('vault-writes', [
  {
    id: 'vault-hold',
    capability: 'Place a legal hold on a document',
    action: 'place_legal_hold',
    note: 'The same action 7.5 uses for a matter-wide hold, applied at file grain.',
    buttonLabel: 'Place the hold',
    done: 'Hold placed on the document.',
    fields: [
      { name: 'documentId', label: 'Document id' },
      { name: 'reason', label: 'Reason' },
    ],
    path: (v) => `/api/console/vault/documents/${encodeURIComponent(v.documentId)}/legal-hold`,
    body: (v) => ({ reason: v.reason }),
  },
  {
    id: 'vault-release',
    capability: 'Release a document hold',
    action: 'release_legal_hold',
    note: 'Puts the document back on a schedule that destroys it.',
    danger: true,
    buttonLabel: 'Release the hold',
    done: 'Hold released.',
    fields: [{ name: 'documentId', label: 'Document id' }],
    path: (v) =>
      `/api/console/vault/documents/${encodeURIComponent(v.documentId)}/legal-hold/release`,
    body: () => ({}),
  },
  {
    id: 'vault-retention',
    capability: 'Set a retention schedule',
    action: 'set_document_retention',
    note: 'One decision executed for years: after this date the document may be destroyed without anybody deciding again.',
    buttonLabel: 'Set the schedule',
    done: 'Retention schedule set.',
    fields: [
      { name: 'documentId', label: 'Document id' },
      { name: 'retainUntil', label: 'Retain until', type: 'date' },
    ],
    path: (v) => `/api/console/vault/documents/${encodeURIComponent(v.documentId)}/retention`,
    body: (v) => ({ retainUntil: v.retainUntil }),
  },
  {
    id: 'vault-remove',
    capability: 'Remove a document',
    action: 'remove_vault_document',
    note: 'IRREVERSIBLE, and it removes evidence. The artifact set here is what the firm would produce if asked to show its work. Refused while a legal hold is in force.',
    danger: true,
    buttonLabel: 'Remove the document',
    done: 'Document removed.',
    fields: [{ name: 'documentId', label: 'Document id' }],
    path: (v) => `/api/console/vault/documents/${encodeURIComponent(v.documentId)}/removal`,
    body: () => ({}),
  },
]);
