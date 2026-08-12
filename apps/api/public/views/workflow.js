/**
 * 2.2 Workflow Engine on the page, and what 2.4 is not.
 *
 * **There is no list of running instances, and that is a gap in the module rather than in this
 * panel.** `@bwc/workflow` exposes `findInstance(id)` and nothing that answers "what is running for
 * this tenant". A page that built the list from a table query would be a module read living in the
 * transport. So this asks for one id, and says why there is no list.
 *
 * **2.4's approval queue is 11.4's and it is already on the Overview.** A second list here would be
 * a second answer to "what is waiting on me", and the two would disagree the first time one of them
 * was filtered.
 *
 * **The definition shown is the version the instance PINNED at start**, not the current one: a
 * playbook republished today does not change what a running instance is doing.
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


const loadInstance = async () => {
  const instanceId = $('workflow-instance-id').value.trim();
  const status = $('workflow-status');
  const list = $('workflow-detail');
  list.replaceChildren();

  if (instanceId === '') {
    status.textContent = 'Give a workflow instance id.';
    return;
  }

  const result = await call(
    `/api/console/workflow/instances/${encodeURIComponent(instanceId)}`,
  );
  if (!result.ok) {
    // `no_data` covers both "no such instance" and "an instance in another tenant", deliberately -
    // a caller must not learn that an id exists somewhere else.
    status.textContent = `${result.status}: ${result.reason}`;
    return;
  }

  const { instance, definition } = result.data;

  line(list, `playbook ${instance.playbookKey} v${instance.playbookVersion} (pinned at start)`);
  line(list, `state ${instance.state}`);
  line(list, `current step ${instance.currentStepKey ?? 'none'}`);
  if (instance.clientId) line(list, `client ${instance.clientId}`);

  for (const step of definition?.steps ?? []) {
    line(list, `step ${step.key} - ${step.kind ?? ''}`);
  }

  status.textContent = definition
    ? `Instance found. Definition v${instance.playbookVersion} as pinned.`
    : 'Instance found. Its pinned definition version could not be read, which is worth investigating rather than ignoring.';

  blocked($('workflow-blocked'), result.data.writes);
};

$('workflow-load').addEventListener('click', () => void loadInstance());
