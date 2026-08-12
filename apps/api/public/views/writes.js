/**
 * The write controls, built from a declaration rather than written out twelve times.
 *
 * Batch A gave eight Console surfaces their first buttons. Hand-writing a form per action would
 * have produced twelve near-copies of the same markup, and the copy that drifts is the one nobody
 * is looking at - the same argument the route modules make about a rule with two homes.
 *
 * So a panel declares what it can do and this renders it. The declaration is also what the panel
 * SHOWS: the capability, the action name the chain will check, and the note saying what the act
 * costs. An operator reading a button learns which authority it needs before pressing it.
 *
 * ## Three rules this file keeps
 *
 * **Every value reaches the DOM through `textContent`.** No `innerHTML`, anywhere, ever. A reason
 * string comes from a module, a module reads rows a client filled in, and a client is a stranger.
 *
 * **The trace is rendered on refusal as well as success.** "Which step blocked this" is the first
 * question anybody asks, and on a page it is the difference between a dead end and an instruction.
 *
 * **An irreversible act says so beside its button, not in a tooltip.** ADR-0079 records that the
 * owner chose controls for acts that cannot be undone; a control that cannot be undone and does not
 * say so is one somebody presses to find out.
 */

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
};

const post = async (path, body) => {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response
    .json()
    .catch(() => ({ status: 'failed', reason: 'No response.' }));
  return {
    ok: payload.status === 'ok',
    status: payload.status,
    reason: payload.reason,
    data: payload.data,
    trace: payload.trace,
  };
};

/**
 * Render the middleware trace for one attempt.
 *
 * A refusal without the trace tells an operator they may not do something; the trace tells them
 * which of authentication, tenant scope, Authority Level, the Firewall or the compliance state
 * said no - and only one of those is something they can act on.
 */
const renderTrace = (into, trace) => {
  into.replaceChildren();
  if (!Array.isArray(trace) || trace.length === 0) return;

  into.append(el('li', 'Middleware chain:', 'muted'));
  for (const step of trace) {
    const detail = step.detail ? `${step.step}: ${step.outcome} - ${step.detail}` : `${step.step}: ${step.outcome}`;
    into.append(el('li', detail));
  }
};

/**
 * Build the controls for one panel.
 *
 * `specs` is an array of:
 *   {
 *     id,        unique within the page. Every generated id is prefixed `write-`, because
 *                these panels already have elements named after the same things - `contracts-clause-status`
 *                existed before this file did, and two elements sharing an id is a page where a
 *                selector silently picks the wrong one.
 *     capability what the operator is doing, in their words
 *     action     the declared action the chain will check, shown so the level is not a surprise
 *     note       what it costs. Prefixed IRREVERSIBLE where it cannot be undone.
 *     danger     true to mark the control as one that cannot be taken back
 *     fields     [{ name, label, type, placeholder }]
 *     path       (values) => string
 *     body       (values) => object
 *   }
 */
export const renderWrites = (containerId, specs) => {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.replaceChildren();

  for (const spec of specs) {
    const box = el('div', undefined, spec.danger ? 'write write-danger' : 'write');

    box.append(el('h4', spec.capability));
    box.append(el('p', `Requires: ${spec.action}`, 'muted'));
    if (spec.note) box.append(el('p', spec.note, spec.danger ? 'danger-note' : 'muted'));

    const values = {};
    for (const field of spec.fields ?? []) {
      const inputId = `write-${spec.id}-${field.name}`;
      const label = el('label', field.label);
      label.htmlFor = inputId;

      const input = document.createElement('input');
      input.id = inputId;
      input.name = field.name;
      input.type = field.type ?? 'text';
      if (field.placeholder) input.placeholder = field.placeholder;

      box.append(label, input);
      values[field.name] = input;
    }

    const button = el('button', spec.buttonLabel ?? spec.capability);
    button.type = 'button';
    button.id = `write-${spec.id}-submit`;

    const status = el('p', '', 'muted');
    status.id = `write-${spec.id}-status`;

    const trace = document.createElement('ul');
    trace.id = `write-${spec.id}-trace`;

    button.addEventListener('click', () => {
      const read = Object.fromEntries(
        Object.entries(values).map(([name, input]) => [name, input.value.trim()]),
      );

      status.textContent = 'Working...';
      trace.replaceChildren();

      void post(spec.path(read), spec.body(read)).then((result) => {
        // The module's own sentence on refusal, never a rewritten one: it names the rule, and a
        // page that paraphrased it would drift from the system that enforced it.
        status.textContent = result.ok
          ? (spec.done ?? 'Done.')
          : `${result.status}: ${result.reason}`;
        renderTrace(trace, result.trace);
      });
    });

    const actions = el('p');
    actions.append(button);

    box.append(actions, status, trace);
    container.append(box);
  }
};

/**
 * List what this surface can do, beside what it cannot.
 *
 * The available list carries the action name and the note. Before Batch A every panel had only a
 * `blocked` list, and a reader could not tell a capability that was coming from one that was
 * refused on principle - which is what ADR-0063 gave `unblockedBy` to fix on the other side.
 */
export const renderAvailable = (listId, available) => {
  const list = document.getElementById(listId);
  if (!list) return;

  list.replaceChildren();
  for (const entry of available ?? []) {
    const item = document.createElement('li');
    item.append(el('strong', entry.capability));
    item.append(el('div', `Requires: ${entry.action}`, 'muted'));
    if (entry.note) item.append(el('div', entry.note, /IRREVERSIBLE|DANGEROUS/.test(entry.note) ? 'danger-note' : 'muted'));
    list.append(item);
  }
};
