/**
 * 3.1 Document & Deliverable Management on the page.
 *
 * **Every version is listed, with its own status.** A "latest only" list makes the delivered
 * version disappear the moment somebody starts a draft - and "what does the client actually have"
 * is the question an operator opens this panel to answer.
 *
 * **A deliverable resting on an unresearched figure says so, in words.** The module's own predicate
 * decides, and the module's own label is used, so the Console and the PDF renderer cannot disagree
 * about whether a brief carries an assumption. A subtler treatment - a shade, an icon - would mean
 * the printed brief and the screen said different things about the same document.
 *
 * Compliance state renders as a CATEGORY using the module's labels, never as a number
 * (Decision E).
 *
 * Every value reaches the DOM through `textContent`.
 */

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

let loaded = false;

const loadTemplates = async () => {
  const status = $('deliverables-status');
  status.textContent = 'Loading…';

  const result = await call('/api/console/deliverables/templates');
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  const templates = $('deliverables-templates');
  templates.replaceChildren();
  for (const template of result.data.templates) {
    line(
      templates,
      `${template.key} v${template.version} — ${template.title ?? template.name ?? ''}`,
    );
  }

  const blocked = $('deliverables-blocked');
  blocked.replaceChildren();
  for (const entry of result.data.writes?.blocked ?? []) {
    const item = document.createElement('li');
    const what = document.createElement('strong');
    what.textContent = entry.capability;
    item.append(what);
    const why = document.createElement('div');
    why.textContent = entry.why;
    item.append(why);
    blocked.append(item);
  }

  status.textContent = `${result.data.total} shipped template(s).`;
  loaded = true;
};

const loadForClient = async () => {
  const status = $('deliverables-client-status');
  const clientId = $('deliverables-client-id').value.trim();
  if (clientId === '') {
    status.textContent = 'Enter a client id.';
    return;
  }

  status.textContent = 'Loading…';
  const result = await call(`/api/console/clients/${encodeURIComponent(clientId)}/deliverables`);
  if (!result.ok) {
    status.textContent = result.reason;
    return;
  }

  const list = $('deliverables-list');
  list.replaceChildren();

  if (result.data.deliverables.length === 0) {
    line(list, 'No deliverable has been drafted for this client.');
  } else {
    for (const deliverable of result.data.deliverables) {
      const item = document.createElement('li');

      const label = document.createElement('strong');
      // Template AND version AND status, together. The approval belongs to the version.
      label.textContent = `${deliverable.templateKey} v${deliverable.version} (template v${deliverable.templateVersion}) — ${deliverable.status}`;
      item.append(label);

      const detail = document.createElement('div');
      detail.textContent = `${deliverable.title}. ${
        deliverable.deliveredAt === null
          ? 'Not delivered.'
          : `Delivered ${deliverable.deliveredAt}.`
      }${deliverable.reviewedBy === null ? '' : ` Reviewed by ${deliverable.reviewedBy}.`}`;
      item.append(detail);

      if (deliverable.carriesUnverifiedFigures) {
        // In words, using the renderer's own label, so the screen and the PDF agree.
        const warning = document.createElement('div');
        warning.textContent = `Carries at least one figure marked "${result.data.unverifiedLabel}" — an unresearched default reaches the client on this document.`;
        item.append(warning);
      }

      const hash = document.createElement('div');
      hash.textContent = `Content hash ${deliverable.contentHash}`;
      item.append(hash);

      list.append(item);
    }
  }

  status.textContent = `${result.data.total} version(s) across all templates. ${result.data.delivered} delivered, ${result.data.withUnverifiedFigures} carrying an unverified figure.`;
};

$('panel-deliverables').addEventListener('toggle', () => {
  if ($('panel-deliverables').open && !loaded) void loadTemplates();
});

$('deliverables-refresh').addEventListener('click', () => void loadTemplates());
$('deliverables-client-load').addEventListener('click', () => void loadForClient());
